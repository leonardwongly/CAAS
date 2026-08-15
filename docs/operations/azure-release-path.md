# Azure release path: authorized, time-boxed POC delivery

Status: operator procedure, 2026-08-13. This document defines the authorized
release path for the late Azure POC: the prerequisites that must hold, the
section 0.5 bootstrap DAG as an operator runbook, and the time-boxed schedule.
It is procedure, not authorization. No provider registration, Entra
app/secret, budget, RBAC, registry, vault, monitoring resource, managed
environment, or Container App may be created merely because this document
exists. Every cloud-write step below requires the explicit authorization
recorded at gate `PG-04` (`PG04-AUTHORIZATION`) in addition to the gates this
document states.

Binding sources: system design section 0.5, section 0.6 (`AC-POC-REL-01`),
implementation plan section 5.5 and Phase 4 (`PLAN-4.1` through `PLAN-4.4`),
and `docs/operations/local-and-azure.md`. Legacy staging/promotion material in
design sections 18/19 is historical only and must not be reintroduced.

## 1. Purpose and boundary

The challenge outcome is one private, single-user Azure POC running real CAAS
data. Delivery is local-first: Azure exists only for the late push of the
unchanged verified digest and final deployment/auth/rollback/UAT evidence.
There is no staging environment, no snapshot store, and no data rollback.
First deployment has no rollback target: failure means ingress stays disabled
and the failed candidate is deactivated/removed before cleanup or repair.
After a known-good revision exists, later rollback restores the prior revision
plus complete app-scoped configuration and reacquires current real data.

## 2. Release prerequisites (all must hold before any cloud write)

| # | Prerequisite | Evidence to retain | Gate |
|---|---|---|---|
| P-1 | The authoritative secretless-CI OCI digest passes the complete loopback-only real-data `PG-03` gate (`AC-POC-LOCAL-01`). A locally rebuilt image is not an acceptable subject | PG-03 gate manifest with exact digest, policy hashes, artifacts | `PG-03` pass record |
| P-2 | A demonstration is planned within 48 hours of the provisioning start | Dated demonstration plan; provisioned window recorded in the PG-04 manifest | `PG04-AUTHORIZATION` |
| P-3 | Explicit user cloud-write authorization. Documentation review or a design decision is not authorization; the user's object ID is supplied outside Git | `PG04-AUTHORIZATION` manual-approval check with authorization record | `PG04-AUTHORIZATION` |
| P-4 | The go/no-go preflight (provider/region/quota, budget/RBAC, deployment-identity federation, ACR push, Key Vault secret-write, Container App + authConfig, user-auth Entra app credential + redirect, cleanup capabilities) passes; any failed check aborts before a write | Preflight record per `docs/operations/azure-preflight-and-bootstrap.md` | `PG-04` |
| P-5 | The CAAS Data Use Record (`docs/data-use/data-use-record.md`) is filled and the data-use gate status is `AUTHORIZED` (2026-08-15, owner decision); the audience/retention decisions are re-confirmed per demonstration window. Absent a valid record, the externally accessible live-data demonstration fails closed (issues #26/#27/#28 resolved 2026-08-15) | Data-use record location, SHA-256, and gate status artifact, referenced in the PG-04 manifest | `PG-04`, `PG-05` |
| P-6 | Forecast/actual spend is below USD 45. At or above USD 45, stop new deployment work and request teardown or retention authority | Cost query evidence | `PG-04` |
| P-7 | Enough measured time buffer remains for the deployment (10-minute hard deadline), smoke (2 minutes after revision readiness), abort (8-minute threshold), and rollback (5-minute objective) within the authorized window | Measured deadlines from `PLAN-3.4`/`PG-03` | `PG-04` |

No cloud write starts before P-1 through P-7 hold. Missing capability,
unresolved quota/name, absent cleanup authority, or insufficient buffer aborts
and reschedules.

## 3. Time-boxed schedule

| Milestone | Constraint |
|---|---|
| Provisioning start | No earlier than 48 hours before the planned demonstration, and only after P-1 through P-7 |
| Demonstration | Planned date within the provisioning window |
| Teardown target | 24 hours after the demonstration |
| Governance maximum | 7 days after provisioning start, operator-enforced; requires explicit teardown approval or separately authorized retention. Tags and budgets do not delete resources |
| Cost stop | At a USD 45 forecast/actual alert, stop new deployment work and request teardown or retention authority; USD 50 is the governance ceiling decision point |

The 24-hour target and 7-day maximum are operator-enforced lifecycle
decisions, never hard platform controls. Alerts at USD 25, USD 37.50, and
USD 45 are delayed notifications, not billing cutoffs.

## 4. Bootstrap DAG runbook (design section 0.5)

Each step states who acts, what authorization must precede it, what evidence
is retained, and the stop condition. Detailed commands live in
`docs/operations/azure-deployment-procedure.md`; the topology is reconciled in
`docs/architecture/azure-poc-topology.md`.

| Step | Actor | Action | Authorization required before | Evidence retained | Stop condition |
|---|---|---|---|---|---|
| 1 | Bootstrap authority (user) | Create the tagged resource group and scoped budget/alerts (contacts mandatory); register `Microsoft.App` and wait for registration | P-1..P-7; explicit authorization for provider registration | RG id (hash), budget id, registration state, authorization record | Any failure: abort, clean up any partial budget/RG, reschedule |
| 2 | Bootstrap authority | Apply 1 (`createContainerApp: false`): ACR Basic, runtime identity, Key Vault + CAAS secret reference, Log Analytics, managed environment; grant runtime AcrPull + Key Vault Secrets User only | Step 1 complete; write authorization | Apply 1 outputs + `what-if` record; secret-name/version policy | Failure: remove partial resources in reverse DAG order; no descendants |
| 3 | Bootstrap authority | Create the deployment user-assigned identity and GitHub protected-environment federated credential; grant ACR push only; prove OIDC authentication while secret read and role assignment remain denied | Step 2 complete | Identity id (hash), federated credential subject, OIDC proof, negative-proof | OIDC cannot authenticate, or secret read / role assignment not denied: abort |
| 4 | Protected no-checkout job (GitHub OIDC) | Verify the offline PG-03 bundle before Azure login; push the unchanged subject; verify registry digest + Cosign referrer | Steps 1-3 complete; job bound to the protected environment | Registry digest equals preverified subject; referrer verification | Digest mismatch or unverified referrer: stop descendants, keep ingress disabled |
| 5 | Bootstrap authority, then protected job | Apply 2 (`createContainerApp: true`) creates the real ingress-disabled app from the pushed digest; bootstrap authority grants the exact-app-scoped deployment role only after the app resource exists; protected job idempotently applies/verifies the digest-bound configuration, passes revision/probe readiness, obtains the FQDN | Step 4 complete; exact-app grant is after the resource exists, never before | Apply 2 outputs, role-assignment scope (app id), FQDN, revision/probe evidence | Candidate not healthy within the 8-minute abort threshold: deactivate/remove, keep ingress disabled, abort path per `azure-abort-and-rollback-drills.md` |
| 6 | Bootstrap authority | Create the single-tenant user-auth Entra app and expiring credential for the FQDN; write the credential directly to Key Vault; apply 3 (`bootstrap: false`) creates complete `authConfigs`; verify control-plane auth settings, internal readiness, five-family acquisition and telemetry while ingress stays disabled; obtain a valid app-audience token for the deployment identity while it remains excluded from `allowedPrincipals.identities` | Step 5 complete; secret values never enter source, commands, CI, or gate artifacts | Entra app/client-id hash, secret-version reference, authConfig verification, token-proof of the negative principal | Any pre-ingress check fails: keep ingress disabled; do not enable ingress |
| 7 | Bootstrap authority | Apply 4 (`enableExternalIngress: true`); then fail-closed external checks in order: absent auth rejected, authenticated deployment identity denied, allowed-user full browser/business flow | Step 6 complete | Three-stage check evidence | First failure: disable ingress immediately; first-deploy abort path |

Stop new deployment work at any USD 45 forecast/actual alert and request
teardown or retention authority. Failure at any checkpoint stops descendants
and uses the recorded cleanup set for resources already created
(`docs/operations/azure-post-demo-verification.md`).

## 5. Deployment, abort, and rollback semantics (AC-POC-REL-01)

- Unchanged-digest direct deployment through narrowly scoped OIDC: the exact
  `PG-03` digest is pushed and deployed; there is no rebuild and no staging.
- First deployment: ingress disabled until control-plane, revision, probe,
  five-family acquisition, telemetry, and auth configuration checks pass; then
  the three fail-closed external checks; only after all pass is the first
  known-good revision recorded.
- First-deploy failure: no rollback target. Keep ingress disabled,
  deactivate/remove the failed candidate under the authorized cleanup
  procedure, clear temporary credentials, repair within the window or request
  teardown. Never call this rollback.
- Later failure (known-good revision exists): restore the prior revision plus
  the complete app-scoped configuration (ingress/traffic, revision mode,
  identity, Key Vault references, environment variables, scale, probes, and
  the separate `authConfigs` provider/redirect/audience/secret-setting/
  allowed-principal settings) within the 5-minute rollback objective, then
  reacquire current five-family real data and rerun the smoke set. External
  CAAS data is never snapshot-rolled back.

Drill procedures with exact commands and stop conditions:
`docs/operations/azure-abort-and-rollback-drills.md`.

## 6. Access model during the release window

- Bootstrap authority: the user's own session, revoked at cleanup (sign-out,
  delete temporary credentials, remove bootstrap-only role assignments).
- Deployment identity: federated OIDC from the GitHub protected environment;
  ACR push only until the app exists, then ACR push + exact-app update; no Key
  Vault data access; no role assignment. Verified by the identity-negative
  checks in `docs/operations/azure-deployment-procedure.md`.
- Runtime identity: ACR pull + Key Vault secret read only.
- Allowed user: the single user object ID in `allowedPrincipals.identities`,
  supplied outside Git.

## 7. What this document is not

This document is a runbook. It does not: create or authorize any cloud
resource, Entra app, secret, budget, RBAC assignment, or deployment; constitute
the user's explicit authorization (that is the `PG04-AUTHORIZATION` check
record); or permit live-data exposure without the P-5 data-use authority.
Production use remains prohibited until the separate production gate
(`PG-PROD`) is approved.
