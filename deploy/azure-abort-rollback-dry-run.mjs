#!/usr/bin/env node
// Azure abort/rollback drills: runnable-but-inert by default.
//
// Issue #24. Prints Drill A (first-deployment abort, 8-minute threshold, no
// rollback target) or Drill B (later revision/config rollback, 5-minute
// objective) with exact commands and stop conditions, executing nothing.
// `--live` executes only the read-only commands of the selected drill
// (revision list/show, ingress show, config show) and requires the same
// explicit authorization as the drills document. No deactivation, update,
// delete, or any other write is ever performed by this script.
//
// Usage:
//   node deploy/azure-abort-rollback-dry-run.mjs [--drill A|B] [--live]
//     [--app NAME] [--rg RG] [--revision FAILING]

import { spawn } from "node:child_process";

const live = process.argv.includes("--live");
const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const drill = (arg("drill") ?? "A").toUpperCase();
const app = arg("app") ?? "PREFIX-app";
const rg = arg("rg") ?? "RG";
const revision = arg("revision") ?? "REVISION-SUFFIX";

if (drill !== "A" && drill !== "B") throw new Error(`Unknown drill "${drill}"; use --drill A or --drill B`);

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

const readOnly = (cmd) => ({ cmd, readOnly: true });
const write = (cmd) => ({ cmd, readOnly: false });

const drillA = [
  { title: "1. Stop the protected job / automated descendants", steps: [] },
  { title: "2. Verify and keep ingress disabled", steps: [
    readOnly(`az containerapp show --name "${app}" --resource-group "${rg}" --query "properties.configuration.ingress.external" --only-show-errors`),
    write(`az containerapp ingress disable --name "${app}" --resource-group "${rg}"`),
  ]},
  { title: "3. Deactivate/remove the failed candidate (8-minute abort line)", steps: [
    readOnly(`az containerapp revision list --name "${app}" --resource-group "${rg}" --query "[?properties.healthState!='Healthy'].name" -o tsv --only-show-errors`),
    write(`az containerapp revision deactivate --revision ${revision} --name "${app}" --resource-group "${rg}"`),
  ]},
  { title: "4. Clear temporary credentials (bootstrap session tokens, in-flight OIDC tokens)", steps: [] },
  { title: "5. Record evidence (failure signatures, timestamps vs 8-minute threshold, stop condition)", steps: [] },
  { title: "6. Decide within the window: repair+reschedule, or teardown; clean up partial resources in reverse DAG order unless teardown authority covers them", steps: [] },
];

const drillB = [
  { title: "1. Record failing state (revision list + config snapshot; configuration state only, never data snapshots)", steps: [
    readOnly(`az containerapp revision list --name "${app}" --resource-group "${rg}" --query "sort_by([].{name:name,active:properties.active,health:properties.healthState,created:properties.createdTime},&created)" -o table --only-show-errors`),
  ]},
  { title: "2. Restore prior known-good revision + complete app-scoped config (5-minute objective)", steps: [
    write(`az containerapp update --name "${app}" --resource-group "${rg}" --revision-suffix PRIOR-GOOD-SUFFIX --image PRIOR-GOOD-IMAGE --min-replicas 0 --max-replicas 1 --active-revisions-mode Single --identity RUNTIME-IDENTITY-ID --secrets ... --env-vars ... --scale min=0,max=1 --startup-probe ... --readiness-probe ... --liveness-probe ...`),
    readOnly(`az containerapp ingress show --name "${app}" --resource-group "${rg}" --only-show-errors`),
  ]},
  { title: "3. Restore separate authConfigs state (provider/redirect/audience/secret-setting/allowed-principals; full-PUT may need managedEnvironments join/action, see microsoft/azure-container-apps#530; REST PATCH fallback)", steps: [
    write(`az containerapp auth update --name "${app}" --resource-group "${rg}" --redirect-urls "https://<fqdn>/auth/login/aad/callback" --allowed-audiences "<app-audience>" ...`),
  ]},
  { title: "4. Reacquire current real data (five-family acquisition; never snapshot-rolled back)", steps: [] },
  { title: "5. Rerun smoke set (health/startup, health/ready on 8080) and, if triggered by an external-check failure, the Phase E external checks in order", steps: [] },
  { title: "6. Deactivate the failing revision", steps: [
    write(`az containerapp revision deactivate --revision ${revision} --name "${app}" --resource-group "${rg}"`),
  ]},
  { title: "7. Record evidence (decision timestamp, restore start/end vs 5-minute objective, diff, verification)", steps: [] },
];

const selected = drill === "A" ? drillA : drillB;
console.log(`Azure abort/rollback drill ${drill} — app "${app}", rg "${rg}", failing revision "${revision}"`);
console.log(`Mode: ${live ? "LIVE read-only drill commands (requires drills-document authorization)" : "DRY-RUN (nothing executed)"}`);
console.log("Documentation: docs/operations/azure-abort-and-rollback-drills.md");
console.log(drill === "A"
  ? "Drill A: first-deployment abort - no rollback target; 8-minute abort threshold; never call this rollback."
  : "Drill B: later revision/config rollback - 5-minute objective; external data is never snapshot-rolled back.\n");

for (const section of selected) {
  console.log(section.title);
  for (const step of section.steps) {
    const marker = live && step.readOnly ? "run" : step.readOnly ? "read-only" : "WRITE";
    console.log(`    [${marker}] $ ${step.cmd}`);
    if (live && step.readOnly) {
      const output = await run(step.cmd);
      console.log(`    live output: ${output}`);
    }
  }
  if (live && section.steps.some((s) => !s.readOnly)) {
    console.log("    (write steps printed only - this script never executes writes)");
  }
  console.log("");
}

console.log("Stop conditions:");
console.log("  Drill A: never re-enable ingress once the abort path is entered; USD 45 -> request teardown/retention authority.");
console.log("  Drill B: 5-minute objective exceeded -> record deviation, stop automated attempts, operator decision within the window.");
if (live) {
  console.log("Live run completed: read-only only. No revision was deactivated, no update applied, no resource deleted.");
  console.log("Drill practice records are marked 'drill (dry-run)' and are not evidence.");
} else {
  console.log("Dry run completed: no command was executed. Re-run with --live during an authorized drill to capture read-only state.");
}
