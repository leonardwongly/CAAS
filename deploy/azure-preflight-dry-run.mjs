#!/usr/bin/env node
// Azure go/no-go preflight: runnable-but-inert by default.
//
// Issue #22. Prints the preflight checklist (PF-01..PF-12) and the exact
// read-only commands that constitute the go/no-go gate, without executing
// anything. `--live` executes only the read-only `az` commands listed in
// docs/operations/azure-preflight-and-bootstrap.md; it still writes no
// cloud resource, registers no provider, and creates no secret.
//
// Authorization: `--live` requires the same explicit authorization as the
// preflight itself (release path P-3 / gate PG04-AUTHORIZATION). Dry-run
// needs no authorization and executes nothing.
//
// Usage:
//   node deploy/azure-preflight-dry-run.mjs [--live] [--prefix NAME] [--rg NAME]

import { spawn } from "node:child_process";

// Usage errors fail closed before anything is printed or spawned (exit 2).
const failUsage = (message) => {
  console.error(`azure-preflight-dry-run: ${message}`);
  console.error("usage: node deploy/azure-preflight-dry-run.mjs [--live] [--prefix NAME] [--rg NAME]");
  process.exit(2);
};

const KNOWN_FLAGS = new Set(["--live", "--prefix", "--rg"]);
for (const token of process.argv.slice(2)) {
  if (typeof token === "string" && token.startsWith("--") && !KNOWN_FLAGS.has(token)) {
    failUsage(`unknown flag "${token}"`);
  }
}

// Interpolated values land inside printed `az` command strings and inside the
// argv of live spawns, so only unambiguous resource-name characters are
// admitted: shell metacharacters, quotes, whitespace, and flag-looking values
// can never produce executable-looking mutations.
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
const prefix = flagValue("prefix") ?? "PREFIX";
const rg = flagValue("rg") ?? "RG";
const live = process.argv.includes("--live");

const checks = [
  {
    id: "PF-01",
    capability: "Subscription/tenant/region context",
    commands: [
      "az account show --only-show-errors",
      `az account list-locations --query "[?name=='southeastasia']"`,
    ],
    pass: "Enabled subscription supports southeastasia; tenant context matches the out-of-Git tenant reference (compare hashes only)",
    evidence: "Subscription/tenant hashes, location metadata, authorization record",
    fail: "ABORT: no writes without the expected tenant/subscription",
  },
  {
    id: "PF-02",
    capability: "Provider-registration authority",
    commands: [
      "az provider show --namespace Microsoft.App --query registrationState --only-show-errors",
    ],
    pass: "Microsoft.App is NotRegistered or Registered AND the user (bootstrap authority) explicitly confirms authority to register it as the first bootstrap write",
    evidence: "Provider state + written authority statement",
    fail: "ABORT: registration authority absent means no Container Apps writes",
  },
  {
    id: "PF-03",
    capability: "Resource name/quota availability",
    commands: [
      `az acr check-name-availability --name "${prefix}acr" --only-show-errors`,
      `az resource show --resource-group "${rg}" --name "${prefix}-app" --resource-type Microsoft.App/containerApps --only-show-errors`,
    ],
    pass: "All names unique; no quota blockers reported for the Consumption profile in southeastasia",
    evidence: "Name-availability outputs",
    fail: "ABORT and rename/replan",
  },
  {
    id: "PF-04",
    capability: "Budget capability",
    commands: [
      `az budget show --name "${prefix}-budget" --only-show-errors`,
    ],
    pass: "Zero existing budgets; user confirms create/delete authority for budgets and the mandatory contact (email or action group)",
    evidence: "Budget inventory, authority statement",
    fail: "ABORT: budget governance cannot be established",
  },
  {
    id: "PF-05",
    capability: "RBAC capability",
    commands: [
      `az role definition list --query "[?contains(roleName,'Container App')].{name:roleName,id:name}" --only-show-errors`,
    ],
    pass: "Candidate exact-app role resolves (built-in Container Apps Contributor 358470bc-b998-42bd-ab17-a7e34c199c0f or verified custom role) with actions including Microsoft.App/containerApps/write and no Key Vault data or role-assignment actions; user confirms create/delete role-assignment authority",
    evidence: "Role definition IDs/actions, authority statement",
    fail: "ABORT: least-privilege grant design cannot be realized",
  },
  {
    id: "PF-06",
    capability: "Deployment-identity federation",
    commands: [
      "gh environment list",
      `gh secret list -e poc-deploy`,
    ],
    pass: "Protected environment name and subject format repo:<owner>/<repo>:environment:<env> match githubRepository/githubEnvironment",
    evidence: "Environment/subject references (no tokens)",
    fail: "ABORT until the protected environment matches",
  },
  {
    id: "PF-07",
    capability: "ACR push capability",
    commands: [
      `az acr check-name-availability --name "${prefix}acr" --only-show-errors`,
    ],
    pass: "Registry name available; digest format sha256:<64 hex>; user confirms the protected job may push only the verified subject",
    evidence: "Name/digest references",
    fail: "ABORT: no push before digest verification",
  },
  {
    id: "PF-08",
    capability: "Key Vault secret-write capability",
    commands: [
      `az keyvault check-name-availability --name "${prefix}kv" --only-show-errors`,
    ],
    pass: "Bootstrap authority confirms write authority for both named secrets caas-api-key and entra-client-secret and the version-pinned reference policy; no secret value is ever materialized here",
    evidence: "Secret-name policy, authority statement",
    fail: "ABORT: secret path policy not fixed",
  },
  {
    id: "PF-09",
    capability: "Container App + authConfig capability",
    commands: [
      `az provider show --namespace Microsoft.App --query "resourceTypes[?resourceType=='containerApps']|length(@)" --only-show-errors`,
      `az provider show --namespace Microsoft.App --query "resourceTypes[?resourceType=='containerApps/authConfigs']|length(@)" --only-show-errors`,
    ],
    pass: "Required resource types and the Consumption workload profile expose metadata; user confirms app-creation and authConfigs authority",
    evidence: "Metadata check summary",
    fail: "ABORT",
  },
  {
    id: "PF-10",
    capability: "User-auth Entra app credential + redirect",
    commands: [
      "az ad app list --query \"[?contains(appId,'').].{appId:appId,displayName:displayName}\" --only-show-errors",
    ],
    pass: "Single-tenant issuer https://login.microsoftonline.com/<tenant>/v2.0 context and planned redirect URI https://<app-fqdn>/auth/login/aad/callback confirmed; user confirms Entra app/credential create-delete authority and expiry rotation plan (FQDN derivable only after apply 2)",
    evidence: "Authority statement, redirect URI plan",
    fail: "ABORT until Entra authority is confirmed",
  },
  {
    id: "PF-11",
    capability: "Cleanup capability",
    commands: [
      `az resource list --query "[?resourceGroup=='${rg}']" --only-show-errors`,
    ],
    pass: "User confirms delete authority for the resource group, app registration, identities, federated credential, budgets, and alerts; teardown target within 24 hours of the demonstration",
    evidence: "Cleanup authority statement + empty inventory",
    fail: "ABORT: no write without cleanup authority",
  },
  {
    id: "PF-12",
    capability: "Cost forecast and buffer",
    commands: [
      "az costmanagement query --type ActualCost --timeframe MonthToDate --dataset-filter \"{}\" --only-show-errors",
    ],
    pass: "Forecast/actual below USD 45; measured deployment/smoke/abort/rollback buffers fit the authorized window (seven-day forecast USD 34.66, ceiling USD 50, alert thresholds 25 / 37.50 / 45)",
    evidence: "Cost numbers, measured deadlines",
    fail: "ABORT and reschedule; at or above USD 45 request teardown/retention authority",
  },
];

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
    // The binary comes from the command itself: PF-06 runs `gh`, everything
    // else runs `az`. (Regression: this used to hardcode spawn("az", ...),
    // which would have invoked `az environment list` in live mode.)
    const [bin, ...args] = tokens;
    const child = spawn(bin, args, { stdio: "pipe" });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { out += d; });
    child.once("error", (e) => resolvePromise(`ERROR: ${e.message}`));
    child.once("exit", (code) => resolvePromise(`${out.trim() || "(no output)"} [exit ${code}]`));
  });

console.log(`Azure go/no-go preflight (PF-01..PF-12) — prefix "${prefix}", resource group "${rg}"`);
console.log(`Mode: ${live ? "LIVE read-only checks (requires explicit preflight authorization)" : "DRY-RUN (nothing executed)"}`);
console.log("Documentation: docs/operations/azure-preflight-and-bootstrap.md\n");

for (const check of checks) {
  console.log(`[${check.id}] ${check.capability}`);
  for (const cmd of check.commands) console.log(`    $ ${cmd}`);
  console.log(`    pass criterion: ${check.pass}`);
  console.log(`    evidence: ${check.evidence}`);
  console.log(`    fail action: ${check.fail}`);
  if (live) {
    const results = [];
    for (const cmd of check.commands) results.push(await run(cmd));
    console.log(`    live output: ${results.join(" | ")}`);
  }
  console.log("");
}

console.log(`All ${checks.length} checks must pass with retained evidence before the first write; any fail action aborts.`);
if (live) {
  console.log("Live run completed: read-only only. No resource was created, no provider registered, no secret materialized.");
  console.log("The result above is NOT evidence; retain it per the gate-manifest rules (PG-04) during an authorized preflight.");
} else {
  console.log("Dry run completed: no command was executed. Re-run with --live during an authorized preflight to capture evidence.");
}
