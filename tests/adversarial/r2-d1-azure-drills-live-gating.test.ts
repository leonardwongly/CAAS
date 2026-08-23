// R2-D1 — Azure drill scripts
//
// --live gating and write-inertia execution proofs for all three
// deploy/azure-*.mjs drill scripts. Round-1 lanes never touch deploy/*.mjs;
// the per-script dry-run/injection/exit-code lanes live in the sibling
// r2-d1-azure-drills-{preflight,negative-checks,abort-rollback}.test.ts
// files, so nothing here duplicates them.
//
// Hermetic technique: a PATH shim directory carries fake `az`/`gh`
// executables that append one line per invocation to a log file instead of
// contacting Azure. Assertions then prove WHAT was spawned (or not):
//   - dry-run spawns nothing at all;
//   - --live spawns only the documented read-only verbs;
//   - WRITE-marked drill steps are printed but never executed;
//   - a mutating-verb backstop exists in every live spawn path.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const REPO_ROOT = new URL("../..", import.meta.url).pathname;
const SCRIPTS = {
  preflight: new URL("../../deploy/azure-preflight-dry-run.mjs", import.meta.url).pathname,
  negative: new URL("../../deploy/azure-identity-negative-checks.mjs", import.meta.url).pathname,
  abort: new URL("../../deploy/azure-abort-rollback-dry-run.mjs", import.meta.url).pathname,
} as const;

// az verbs that mutate cloud state. Every assertion in this file treats any
// of these appearing in a spawned argv as a fail-closed violation.
const MUTATING_VERBS = new Set([
  "add", "apply", "assign", "backup", "clear", "create", "deactivate", "delete", "disable",
  "enable", "import", "invoke", "lock", "move", "purge", "recover", "regenerate",
  "remove", "reset", "restore", "restart", "revoke", "rotate", "scale", "set",
  "start", "stop", "swap", "undelete", "unlock", "up", "update",
]);

interface ShimInvocation {
  bin: string;
  args: string[];
}

function makeShimDir(): { dir: string; logPath: string } {
  // Under the repo's git-ignored tmp/ so sandboxed runners (write access
  // limited to the workspace) can create the shim executables.
  const base = join(REPO_ROOT, "tmp");
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, "r2-d1-azure-shims-"));
  const logPath = join(dir, "invocations.log");
  const shim = "#!/bin/sh\nprintf '%s\\n' \"$0 $*\" >> \"$LOG\"\n";
  for (const name of ["az", "gh"]) {
    const path = join(dir, name);
    writeFileSync(path, shim);
    chmodSync(path, 0o755);
  }
  return { dir, logPath };
}

function readInvocations(logPath: string): ShimInvocation[] {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, "utf8").split("\n").filter(Boolean).map((line) => {
    const [cmd = "", ...args] = line.split(" ");
    return { bin: cmd.split("/").pop() ?? cmd, args };
  });
}

interface ScriptResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runScript(scriptPath: string, args: readonly string[], shimDir: string, logPath: string): Promise<ScriptResult> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [scriptPath, ...args], {
      env: { ...process.env, PATH: `${shimDir}:/usr/bin:/bin`, LOG: logPath },
      timeout: 60_000,
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

function azVerbs(invocations: ShimInvocation[]): string[] {
  // The az verb is 2-3 tokens ("account show", "role definition list",
  // "containerapp auth show"): take every token before the first flag.
  return invocations
    .filter((i) => i.bin === "az")
    .map((i) => {
      const verb: string[] = [];
      for (const token of i.args) {
        if (token.startsWith("-")) break;
        verb.push(token);
      }
      return verb.join(" ");
    });
}

test("R2-D1 live gating: dry-run spawns nothing at all (no az, no gh)", async () => {
  const cases: Array<readonly [string, string, string[]]> = [
    ["preflight", SCRIPTS.preflight, ["--prefix", "p1", "--rg", "r1"]],
    ["negative checks", SCRIPTS.negative, ["--app", "a1", "--rg", "r1", "--vault", "v1"]],
    ["abort drill A", SCRIPTS.abort, ["--drill", "A"]],
    ["abort drill B", SCRIPTS.abort, ["--drill", "B"]],
  ];
  for (const [label, scriptPath, args] of cases) {
    const { dir, logPath } = makeShimDir();
    const { code } = await runScript(scriptPath, args, dir, logPath);
    assert.equal(code, 0, `${label}: dry-run succeeds`);
    assert.equal(readInvocations(logPath).length, 0, `${label}: dry-run must spawn neither az nor gh`);
  }
});

test("R2-D1 live gating: argument failures spawn nothing even with az resolvable on PATH", async () => {
  const cases: Array<readonly [string, string, string[]]> = [
    ["preflight injection", SCRIPTS.preflight, ["--prefix", "x; az group delete"]],
    ["preflight unknown flag", SCRIPTS.preflight, ["--liv"]],
    ["negative injection", SCRIPTS.negative, ["--vault", "$(az keyvault purge)"]],
    ["abort bad drill", SCRIPTS.abort, ["--drill", "C"]],
    ["abort injection", SCRIPTS.abort, ["--revision", "x; az containerapp delete"]],
  ];
  for (const [label, scriptPath, args] of cases) {
    const { dir, logPath } = makeShimDir();
    const { code } = await runScript(scriptPath, args, dir, logPath);
    assert.equal(code, 2, `${label}: fails closed with exit 2`);
    assert.equal(readInvocations(logPath).length, 0, `${label}: validation fails before any spawn`);
  }
});

test("R2-D1 live gating: preflight --live executes exactly the documented read-only az/gh commands", async () => {
  const { dir, logPath } = makeShimDir();
  const { code, stdout } = await runScript(SCRIPTS.preflight, ["--live", "--prefix", "p1", "--rg", "r1"], dir, logPath);
  assert.equal(code, 0, "--live completes (against shims)");
  assert.match(stdout, /LIVE read-only checks/u, "live banner requires explicit authorization");

  const invocations = readInvocations(logPath);
  const azCalls = azVerbs(invocations);
  assert.equal(azCalls.length, 14, `preflight live runs the 14 documented az commands, got: ${azCalls.join("; ")}`);
  assert.deepEqual(azCalls, [
    "account show",
    "account list-locations",
    "provider show",
    "acr check-name-availability",
    "resource show",
    "budget show",
    "role definition list",
    "acr check-name-availability",
    "keyvault check-name-availability",
    "provider show",
    "provider show",
    "ad app list",
    "resource list",
    "costmanagement query",
  ], "the live az verb sequence matches the PF-01..PF-12 checklist order");
  assert.equal(invocations.filter((i) => i.bin === "gh").length, 2, "PF-06 runs the two gh inventory commands");
  for (const verb of azCalls) {
    for (const token of verb.split(" ")) {
      assert.ok(!MUTATING_VERBS.has(token), `no mutating verb may be spawned, got "${verb}"`);
    }
  }
  assert.match(stdout, /No resource was created, no provider registered, no secret materialized\./u, "completion statement affirms write-inertia");
});

test("R2-D1 live gating: negative checks --live executes exactly NEG-01..NEG-03 read-only verbs", async () => {
  const { dir, logPath } = makeShimDir();
  const { code } = await runScript(SCRIPTS.negative, ["--live", "--app", "a1", "--rg", "r1", "--vault", "v1", "--principal", "p1"], dir, logPath);
  assert.equal(code, 0);
  const azCalls = azVerbs(readInvocations(logPath));
  assert.deepEqual(azCalls, [
    "containerapp auth show",
    "keyvault secret list",
    "role assignment list",
  ], "live mode spawns only the three negative-check inspection commands");
});

test("R2-D1 live gating: drill A --live executes only read-only steps; WRITE steps are printed, never spawned", async () => {
  const { dir, logPath } = makeShimDir();
  const { code, stdout } = await runScript(SCRIPTS.abort, ["--drill", "A", "--live", "--app", "a1", "--rg", "r1", "--revision", "rev-01"], dir, logPath);
  assert.equal(code, 0);
  assert.deepEqual(azVerbs(readInvocations(logPath)), [
    "containerapp show",
    "containerapp revision list",
  ], "ingress disable and revision deactivate are never executed");

  assert.match(stdout, /\[run\] \$ az containerapp show/u, "read-only steps carry the run marker in live mode");
  assert.match(stdout, /\[WRITE\] \$ az containerapp ingress disable/u, "write steps keep the WRITE marker even in live mode");
  assert.match(stdout, /\[WRITE\] \$ az containerapp revision deactivate --revision rev-01/u, "the failing revision substitutes into the printed WRITE step");
  assert.match(stdout, /\(write steps printed only - this script never executes writes\)/u, "the write-inertia disclaimer is printed");
  assert.match(stdout, /No revision was deactivated, no update applied, no resource deleted\./u, "completion statement affirms write-inertia");
});

test("R2-D1 live gating: drill B --live executes only the record/inspect reads; restore writes stay printed-only", async () => {
  const { dir, logPath } = makeShimDir();
  const { code, stdout } = await runScript(SCRIPTS.abort, ["--drill", "B", "--live", "--app", "a1", "--rg", "r1", "--revision", "rev-02"], dir, logPath);
  assert.equal(code, 0);
  assert.deepEqual(azVerbs(readInvocations(logPath)), [
    "containerapp revision list",
    "containerapp ingress show",
  ], "containerapp update / auth update / revision deactivate are never executed");
  assert.match(stdout, /\[WRITE\] \$ az containerapp update/u, "the restore write stays printed-only");
  assert.match(stdout, /\[WRITE\] \$ az containerapp auth update/u, "the authConfigs restore stays printed-only");
});

test("R2-D1 live gating: every script gates spawns on --live and carries the mutating-verb backstop in its spawn path", () => {
  for (const scriptPath of Object.values(SCRIPTS)) {
    const source = readFileSync(scriptPath, "utf8");
    assert.match(source, /const live = process\.argv\.includes\("--live"\)/u, `${scriptPath}: live is only set by the explicit --live flag`);
    assert.match(source, /if \(live\)/u, `${scriptPath}: spawning is gated on the live flag`);
    assert.match(source, /MUTATING_AZ_VERBS = new Set\(\[/u, `${scriptPath}: the mutating-verb deny-list exists`);
    assert.match(source, /throw new Error\(`refusing to execute mutating az command/u, `${scriptPath}: the deny-list fails closed inside the spawn helper`);
    assert.ok(!source.includes("child.kill"), `${scriptPath}: no process-control side effects`);
  }
});
