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

const live = process.argv.includes("--live");
const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const app = arg("app") ?? "PREFIX-app";
const rg = arg("rg") ?? "RG";
const vault = arg("vault") ?? "PREFIX-kv";
const principal = arg("principal") ?? "DEPLOYMENT-IDENTITY-OBJECT-ID";
const allowedUser = arg("allowed-user") ?? "ALLOWED-USER-OBJECT-ID";

const run = (cmd) =>
  new Promise((resolvePromise) => {
    const [bin, ...args] = cmd.split(" ").filter(Boolean);
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
