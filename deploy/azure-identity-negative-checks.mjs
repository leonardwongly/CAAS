#!/usr/bin/env node
// Azure deployment-identity negative checks: runnable-but-inert by default.
//
// Issue #23. Verifies the least-privilege shape of the deployment identity:
//   NEG-01  deployment identity is absent from allowedPrincipals.identities
//   NEG-02  deployment identity cannot read Key Vault secrets (403/denied)
//   NEG-03  deployment identity has exactly AcrPush + exact-app role, no
//           Owner/Contributor/role-assignment admin
//
// Dry-run prints the checks and the exact commands, executing nothing.
// `--live` executes only read-only `az` commands and requires the same
// explicit authorization as the deployment procedure itself (Phase D,
// PG-04). No cloud write is ever performed by this script.
//
// Usage:
//   node deploy/azure-identity-negative-checks.mjs [--live]
//     [--app NAME] [--rg RG] [--vault NAME] [--principal OBJECT_ID]
//     [--allowed-user OBJECT_ID]

import { spawn } from "node:child_process";

// Usage errors fail closed before anything is printed or spawned (exit 2).
const failUsage = (message) => {
  console.error(`azure-identity-negative-checks: ${message}`);
  console.error("usage: node deploy/azure-identity-negative-checks.mjs [--live] [--app NAME] [--rg RG] [--vault NAME] [--principal OBJECT_ID] [--allowed-user OBJECT_ID]");
  process.exit(2);
};

const KNOWN_FLAGS = new Set(["--live", "--app", "--rg", "--vault", "--principal", "--allowed-user"]);
for (const token of process.argv.slice(2)) {
  if (typeof token === "string" && token.startsWith("--") && !KNOWN_FLAGS.has(token)) {
    failUsage(`unknown flag "${token}"`);
  }
}

// Interpolated values land inside printed `az` command strings and inside the
// argv of live spawns, so only unambiguous identifier characters are admitted:
// shell metacharacters, quotes, whitespace, and flag-looking values can never
// produce executable-looking mutations.
const VALUE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/u;
const flagValue = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const value = process.argv[i + 1];
  if (value === undefined || value.startsWith("--")) failUsage(`--${name} requires a value`);
  if (!VALUE_PATTERN.test(value)) {
    failUsage(`--${name} must match ${VALUE_PATTERN} (letters, digits, "-", "_"; no shell metacharacters)`);
  }
  return value;
};
const app = flagValue("app") ?? "PREFIX-app";
const rg = flagValue("rg") ?? "RG";
const vault = flagValue("vault") ?? "PREFIX-kv";
const principal = flagValue("principal") ?? "DEPLOYMENT-IDENTITY-OBJECT-ID";
const allowedUser = flagValue("allowed-user") ?? "ALLOWED-USER-OBJECT-ID";
const live = process.argv.includes("--live");

// Write-inertia backstop: even under --live this script may only execute
// read-only inspection commands; any mutating verb fails closed before spawn.
const MUTATING_AZ_VERBS = new Set([
  "add", "apply", "assign", "backup", "clear", "create", "deactivate", "delete", "disable",
  "enable", "import", "invoke", "lock", "move", "purge", "recover", "regenerate",
  "remove", "reset", "restore", "restart", "revoke", "rotate", "scale", "set",
  "start", "stop", "swap", "undelete", "unlock", "up", "update",
]);
const run = (cmd) =>
  new Promise((resolvePromise) => {
    const tokens = cmd.split(" ").filter(Boolean);
    if (tokens[0] === "az" && tokens.slice(2).some((token) => MUTATING_AZ_VERBS.has(token))) {
      throw new Error(`refusing to execute mutating az command: ${cmd}`);
    }
    const [bin, ...args] = tokens;
    const child = spawn(bin, args, { stdio: "pipe" });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { out += d; });
    child.once("error", (e) => resolvePromise(`ERROR: ${e.message}`));
    child.once("exit", (code) => resolvePromise(`${out.trim() || "(no output)"} [exit ${code}]`));
  });

const checks = [
  {
    id: "NEG-01",
    name: "Deployment identity absent from allowedPrincipals.identities",
    command: `az containerapp auth show --name "${app}" --resource-group "${rg}" --query "properties.identityProviders.azureActiveDirectory.validation.defaultAuthorizationPolicy.allowedPrincipals.identities" --only-show-errors`,
    expect: `The identities array contains exactly one entry (the allowed user object ID, supplied outside Git) and does NOT contain ${principal}.`,
  },
  {
    id: "NEG-02",
    name: "Deployment identity cannot read Key Vault secrets",
    command: `az keyvault secret list --vault-name "${vault}" --query "length(@)" --only-show-errors`,
    expect: `The deployment identity receives 403/AuthorizationFailed. A successful listing or show means the least-privilege shape is broken: ABORT before any further write.`,
  },
  {
    id: "NEG-03",
    name: "Deployment identity role assignments are exactly the minimal set",
    command: `az role assignment list --assignee "${principal}" --include-inherited --query "[].{role:properties.roleDefinitionId,scope:properties.scope}" --only-show-errors`,
    expect: `Only AcrPush (registry scope) + the exact-app role (app scope) + any verified minimal grant recorded in the preflight. No Owner, Contributor, or Microsoft.Authorization/roleAssignments-capable role at any scope.`,
  },
];

console.log(`Azure deployment-identity negative checks (NEG-01..NEG-03) — app "${app}", rg "${rg}", vault "${vault}"`);
console.log(`Mode: ${live ? "LIVE read-only checks (requires deployment-procedure Phase D authorization)" : "DRY-RUN (nothing executed)"}`);
console.log("Documentation: docs/operations/azure-deployment-procedure.md Phase D\n");

for (const check of checks) {
  console.log(`[${check.id}] ${check.name}`);
  console.log(`    $ ${check.command}`);
  console.log(`    expect: ${check.expect}`);
  if (live) {
    const output = await run(check.command);
    console.log(`    live output: ${output}`);
    console.log(`    INTERPRET: compare against the expectation above; record result and evidence (PG-04).`);
  }
  console.log("");
}

console.log("All three checks must pass with retained evidence before external ingress is enabled (Phase E).");
if (live) {
  console.log("Live run completed: read-only only. No cloud resource was created, changed, or deleted.");
  console.log("This output is not evidence; retain it per the gate-manifest rules during an authorized check.");
} else {
  console.log("Dry run completed: no command was executed. Re-run with --live during an authorized Phase D check.");
}
