# Azure abort and rollback drills

Status: operator procedure, 2026-08-13. Two drills cover the only two
failure shapes in the POC topology: Drill A for a first deployment that has
no rollback target (design section 0.5, release path section 5), and Drill B
for a later failure once a known-good revision exists (5-minute rollback
objective, `AC-POC-REL-01`). Each drill states exact commands, stop
conditions, and what evidence to retain. Drills are practice: run them
dry (see the paired script) during an authorized window; never fabricate a
drill record as a real event.

Binding: `docs/operations/azure-release-path.md` section 5,
`docs/operations/azure-deployment-procedure.md` Phases C-E, design section
0.6. External CAAS data is NEVER snapshot-rolled back; a later rollback
reacquires current real data after the revision/config restore.

## Drill A - First-deployment abort (no rollback target)

Applies when the first-ever deploy fails: the failed candidate is the only
candidate; there is no prior revision to return to. Stop the deployment at
the 8-minute abort threshold, not after. Never call this rollback.

Trigger: any of
- revision not Healthy/Succeeded within 8 minutes of apply (cold-start hard
  deadline 180 s exceeded; readiness probes 5 + 17 x 10 = 175 s budget
  consumed);
- Phase D pre-ingress check fails (auth configuration, negative principal,
  five-family acquisition, telemetry);
- Phase E external check 1 or 2 fails (absent auth accepted, or deployment
  identity authenticated).

Steps (in order):

1. Stop the protected job / any automated descendant.
2. Keep ingress disabled - it is already disabled by construction; verify:
   ```bash
   az containerapp show --name "${prefix}-app" --resource-group "${rg}" \
     --query "properties.configuration.ingress.external"   # must be false
   az containerapp ingress disable --name "${prefix}-app" --resource-group "${rg}"
   ```
3. Deactivate/remove the failed candidate:
   ```bash
   az containerapp revision list --name "${prefix}-app" --resource-group "${rg}" \
     --query "[?properties.healthState!='Healthy'].name" -o tsv
   az containerapp revision deactivate --revision <failed-revision> \
     --name "${prefix}-app" --resource-group "${rg}"
   ```
   For an unrecoverable candidate, remove the app resource itself only
   under the authorized cleanup set (release path section 4 step 7 / post-demo
   doc), never while descendants still run.
4. Clear temporary credentials: delete the bootstrap session token/temp
   credentials used for the attempt; revoke any in-flight OIDC tokens.
5. Record evidence: failure signatures (revision state, probe failures,
   log excerpts under the 0.1 GiB/day cap), timestamps vs the 8-minute
   threshold, commands run, stop condition hit. Retain per the gate-manifest
   rules (PG-04, failure fallback).
6. Decide within the authorized window: repair and reschedule, or request
   teardown (post-demo doc). Abort drills do not leave partially written
   resources ungoverned: any resources created in Phases A-C are cleaned up
   in reverse DAG order unless teardown authority covers them.

Stop conditions: once the abort path is entered it never re-enables ingress;
the 8-minute threshold is the abort line; at USD 45 stop and request
teardown/retention authority.

## Drill B - Later revision/config rollback (5-minute objective)

Applies only when a known-good revision exists. Restore the prior revision
plus the complete app-scoped configuration, then reacquire current real
data. The 5-minute objective is measured from decision to restored serving.

Trigger: any of
- a later revision fails probes/health after promotion;
- a later configuration change (ingress/traffic, revision mode, identity,
  Key Vault references, env, scale, probes, authConfigs) degrades the app;
- Phase E external check 3 fails after a later change.

Steps (in order):

1. Record the failing state: revision list + config snapshot for evidence
   (no snapshot rollback of data; configuration state only).
2. List candidates and select the prior known-good revision:
   ```bash
   az containerapp revision list --name "${prefix}-app" --resource-group "${rg}" \
     --query "sort_by([].{name:name,active:properties.active,health:properties.healthState,created:properties.createdTime},&created)" -o table
   # prior-good = the active Healthy revision before the failing one
   az containerapp update --name "${prefix}-app" --resource-group "${rg}" \
     --revision-suffix <prior-good-suffix> \
     --image "<prior-good-image-reference>" \
     --min-replicas 0 --max-replicas 1 \
     --active-revisions-mode Single \
     --identity <runtime-identity-id> \
     --secrets "caas-api-key=keyvaultref:<kv-uri>secrets/caas-api-key,version=<v>" \
     --env-vars "apikey=secretref:caas-api-key" \
     --scale min=0,max=1 \
     --startup-probe ... --readiness-probe ... --liveness-probe ...   # exact probe set per Bicep
   az containerapp ingress show --name "${prefix}-app" --resource-group "${rg}"   # confirm external state
   ```
   The full-PUT update may require `Microsoft.App/managedEnvironments/join/action`
   (microsoft/azure-container-apps#530); if `LinkedAuthorizationFailed`
   occurs, use the REST PATCH API or the verified minimal grant decision
   from the preflight - recorded, never ad-hoc.
3. Restore the separate `authConfigs` state if it changed:
   `az containerapp auth update --name "${prefix}-app" --resource-group "${rg}" \
     --redirect-urls "https://<fqdn>/auth/login/aad/callback" \
     --allowed-audiences "<app-audience>" ...` (exact provider/redirect/
   audience/secret-setting/allowed-principal values per the Bicep authConfig
   contract; `allowedPrincipals.identities` keeps exactly the user object ID).
4. Reacquire current real data: trigger the five-family acquisition flow
   against live CAAS data; verify telemetry and the 0.1 GiB/day log cap.
5. Rerun the smoke set (readiness on 8080, `/health/startup`,
   `/health/ready`) and, when the rollback was driven by an external-check
   failure, rerun the Phase E external checks in order.
6. Deactivate the failing revision:
   ```bash
   az containerapp revision deactivate --revision <failing-revision> \
     --name "${prefix}-app" --resource-group "${rg}"
   ```
7. Record evidence: decision timestamp, restore start/end vs the 5-minute
   objective, revision/config diff, reacquired-data verification, smoke and
   external-check outcomes.

Stop conditions: if the 5-minute objective is exceeded, record the deviation
and stop further automated attempts; request operator decision within the
window. Never roll back external CAAS data; never reuse a deactivated
revision as if it were current.

## Scripted dry-run

`node deploy/azure-abort-rollback-dry-run.mjs [--drill A|B] [--live]`
prints the exact drill steps with the substituted resource names and
executes nothing by default; `--live` runs only the read-only commands in
this document (revision list/show, ingress show, config show). Practice
records are marked "drill (dry-run)" and are not evidence.

## Post-drill governance

- After any drill, the resource state must match the release path access
  model: ingress disabled unless a passing external-check record exists;
  bootstrap write access revoked after Phase E; deployment identity grants
  still exactly AcrPush + exact-app (re-run the identity-negative checks
  `deploy/azure-identity-negative-checks.mjs --live` if the drill touched
  role assignments).
- Cost: any drill time counts against the same budget; at USD 45 stop and
  request teardown/retention authority.
