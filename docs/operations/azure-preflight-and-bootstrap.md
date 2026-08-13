# Azure go/no-go preflight and least-privilege bootstrap design

Status: operator procedure, 2026-08-13. This document defines the go/no-go
preflight that must pass before any Azure write, and the least-privilege grant
design for the bootstrap DAG (design section 0.5, plan `PLAN-4.1`/`PLAN-4.2`).
It is procedure, not authorization.

The read-only checks below are examples of inspection; they become evidence
only when run during an authorized preflight and retained in the gate record.
Routine development must not run write-capable Azure commands. The paired
dry-run script `deploy/azure-preflight-dry-run.mjs` prints this checklist and
the exact commands without executing anything; `--live` executes only the
read-only commands listed here and requires the same authorization as the
preflight itself.

## 1. When this applies

After the release-path prerequisites hold (`docs/operations/azure-release-path.md`
P-1..P-7), and immediately before the first write of the authorized window.
Every check has a pass criterion and a fail action; any fail action is:
ABORT before the next write, record the failure and evidence, and reschedule.
The preflight must also confirm the time buffer: provisioning starts no
earlier than 48 hours before the demonstration, teardown targets 24 hours
after it, and 7 days is the operator-enforced maximum.

## 2. Go/no-go preflight checklist

Naming: `<prefix>` is the short, globally unique resource prefix
(`namePrefix` in Bicep); `<rg>` the resource group; `<env>` the protected
GitHub environment (`poc-deploy`). All commands are read-only. Evidence is
retained per the gate-manifest rules (`deploy/evidence-manifest.schema.json`):
check ID, procedure, timestamps, threshold, measured value, artifact path +
SHA-256, result, failure fallback.

| ID | Capability verified | Read-only command(s) | Pass criterion | Evidence to retain | Fail action |
|---|---|---|---|---|---|
| PF-01 | Subscription/tenant/region context | `az account show --only-show-errors`; `az account list-locations --query "[?name=='southeastasia']"` | The enabled subscription supports `southeastasia`; tenant context matches the out-of-Git tenant reference (compare hashes only) | Subscription/tenant hashes, location metadata, authorization record | ABORT: no writes without the expected tenant/subscription |
| PF-02 | Provider-registration authority | `az provider show --namespace Microsoft.App --query registrationState --only-show-errors` | `Microsoft.App` is `NotRegistered` or `Registered`, and the user (bootstrap authority) explicitly confirms authority to register it as the first bootstrap write | Provider state + written authority statement | ABORT: registration authority absent means no Container Apps writes |
| PF-03 | Resource name/quota availability | `az acr check-name-availability --name "${prefix}acr"` (read-only); confirm the Container App/identity/workspace names are unused (e.g., `az resource show` per expected name returning not-found) | All names unique; no quota blockers reported for the Consumption profile in `southeastasia` | Name-availability outputs | ABORT and rename/replan |
| PF-04 | Budget capability | `az budget show --name "${prefix}-budget"` (expect not-found; subscription currently has zero budgets) | Zero existing budgets; user confirms create/delete authority for budgets and the mandatory contact (email or action group) | Budget inventory, authority statement | ABORT: budget governance cannot be established |
| PF-05 | RBAC capability | `az role definition list --query "[?contains(roleName,'Container App')].{name:roleName,id:name}"` | The candidate exact-app role resolves (built-in Container Apps Contributor `358470bc-b998-42bd-ab17-a7e34c199c0f` or a verified custom role) with actions that include `Microsoft.App/containerApps/write` and no Key Vault data or role-assignment actions; user confirms create/delete role-assignment authority | Role definition IDs/actions, authority statement | ABORT: least-privilege grant design cannot be realized |
| PF-06 | Deployment-identity federation | Confirm the GitHub repository and protected environment `<env>` exist; `gh secret list -e poc-deploy` style inventory only to prove nothing secret is required for OIDC | Protected environment name and subject format `repo:<owner>/<repo>:environment:<env>` match `githubRepository`/`githubEnvironment` | Environment/subject references (no tokens) | ABORT until the protected environment matches |
| PF-07 | ACR push capability | `az acr check-name-availability --name "${prefix}acr"`; verify the push path (`${prefix}acr.azurecr.io/<repository>@<digest>`) is expressible | Registry name available; digest format `sha256:<64 hex>`; user confirms the protected job may push only the verified subject | Name/digest references | ABORT: no push before digest verification |
| PF-08 | Key Vault secret-write capability | Confirm vault name availability; define the secret paths `caas-api-key` and `entra-client-secret` (names only) | Bootstrap authority confirms write authority for both named secrets and the version-pinned reference policy; no secret value is ever materialized here | Secret-name policy, authority statement | ABORT: secret path policy not fixed |
| PF-09 | Container App + authConfig capability | Read-only metadata checks for `Microsoft.App` types in `southeastasia` (as in the 2026-08-12 authenticated discovery) | Required resource types and the Consumption workload profile expose metadata; user confirms app-creation and `authConfigs` authority | Metadata check summary | ABORT |
| PF-10 | User-auth Entra app credential + redirect | Confirm the single-tenant issuer `https://login.microsoftonline.com/<tenant>/v2.0` context and the planned redirect URI `https://<app-fqdn>/auth/login/aad/callback` | FQDN is derivable only after apply 2; user confirms Entra app/credential create-delete authority and expiry rotation plan | Authority statement, redirect URI plan | ABORT until Entra authority is confirmed |
| PF-11 | Cleanup capability | `az resource list --query "[?resourceGroup=='<rg>']"` (expect empty pre-write) | User confirms delete authority for the resource group, app registration, identities, federated credential, budgets, and alerts; teardown target within 24 hours of the demonstration | Cleanup authority statement + empty inventory | ABORT: no write without cleanup authority |
| PF-12 | Cost forecast and buffer | Cost query of current month (read-only) vs the seven-day forecast USD 34.66, ceiling USD 50, alert thresholds 25 / 37.50 / 45 | Forecast/actual below USD 45; measured deployment/smoke/abort/rollback buffers fit the authorized window | Cost numbers, measured deadlines | ABORT and reschedule; at or above USD 45 request teardown/retention authority |

All twelve checks must pass with retained evidence before the first write.
A failed check aborts the whole bootstrap; partial resources from a prior
attempt are cleaned up before rescheduling.

## 3. Least-privilege grant design

### 3.1 Identity grants

| Identity | Grants (exact scope) | Explicitly denied |
|---|---|---|
| Runtime user-assigned identity | `AcrPull` on the ACR; `Key Vault Secrets User` on the vault | registry push, role assignment, any other data path |
| Deployment user-assigned identity | `AcrPush` on the ACR (bootstrap); exact-app update role on the Container App only (bootstrap authority assigns it after the app exists) | Key Vault secret read (no Key Vault data-role at all), role assignment, ACR content beyond the verified subject, any other app/resource |
| Bootstrap authority (the user) | One-time bootstrap writes (RG/budget, registration, ACR/identity/vault/monitoring/env, deployment identity + federation, app creation, exact-app grant, Entra app/secret to Key Vault, cleanup) | nothing beyond the authorized window; all bootstrap write access revoked at cleanup |

The deployment identity cannot read Key Vault secrets or assign roles by
construction: no role assignment ever grants it a Key Vault data role, and no
role assignment grants it `Microsoft.Authorization/roleAssignments/*` or an
Owner/Contributor-equivalent. These are verified by the identity-negative
checks (`deploy/azure-identity-negative-checks.mjs`,
`docs/operations/azure-deployment-procedure.md` section 5).

### 3.2 Exact-app deployment role

The exact-app role is assigned by the bootstrap authority scoped to the
Container App resource ID, only after that resource exists (DAG step 5). The
role actions must include exactly the app-update surface:

- `Microsoft.App/containerApps/read` and `Microsoft.App/containerApps/write`
  (scoped to the one app);
- `Microsoft.App/managedEnvironments/read` and
  `Microsoft.App/managedEnvironments/join/action` (scoped to the managed
  environment) - the `join/action` is required by `az containerapp update`
  full-PUT behavior (see microsoft/azure-container-apps issue #530); it is a
  binding-validation action, not a mutation grant;
- `Microsoft.Resources/subscriptions/resourceGroups/read` for ARM scoped
  resolution.

The role must NOT contain: Key Vault data actions, `Microsoft.Authorization/*`
actions, ACR write actions, or any other `Microsoft.App/*` write action.
Prefer the built-in Container Apps Contributor role only after verifying its
action set against this list during preflight; otherwise use a bootstrap-
created custom role (created out-of-Bicep; `roleDefinitions` is not in the
policy allow-list). A full-PUT `az containerapp update` by the deployment
identity is expected to succeed with the app-scoped write plus the
environment-scoped `join/action`; if it still fails with
`LinkedAuthorizationFailed`, the repair path is the REST PATCH API or an
additional verified minimal grant - both require a documented authorization
decision within the window.

### 3.3 Allowed principal

`allowedPrincipals.identities` in the `authConfigs` contains exactly one
entry: the user's object ID, supplied at deployment time outside Git. It is
never committed, hashed into evidence as an identifier, or logged. The
deployment identity's object ID must be absent from that list; the
identity-negative checks assert that.

### 3.4 Secret paths (never in source, commands, CI, or gate artifacts)

- CAAS API key: created by the bootstrap authority as a versioned Key Vault
  secret named `caas-api-key`; the Container App references it by name with
  the runtime identity. Value never enters Git, shell history, CI output, or
  parameters.
- Entra client secret: generated by the bootstrap authority for the
  single-tenant app, written directly to Key Vault as `entra-client-secret`;
  the Container App references it by name. Expiry is set at creation and
  rotation/revocation handled at teardown or on retention approval.
- No `.env` is created or modified; no real identifier or secret appears in
  any committed artifact.

### 3.5 Bootstrap write-access revocation

Immediately after apply 4 and the external checks:
- delete the bootstrap authority's temporary credentials/session sign-out;
- remove any bootstrap-only role assignments;
- the deployment identity remains the only app writer (federated OIDC);
- record the revocation in the PG-04 manifest.

## 4. Stop conditions (any of these aborts or halts the bootstrap)

- Any preflight check fails (section 2 fail actions).
- Forecast/actual spend reaches USD 45: stop new deployment work; request
  teardown or retention authority.
- Any secret or committed tenant/user identifier appears in source, command
  arguments, CI output, or gate artifacts: revoke exposed material, invalidate
  the affected identities/versions, and repair only through the authorized
  process.
- The authorized window (provisioning <= 48 hours before the demonstration)
  can no longer be met: abort and reschedule.
