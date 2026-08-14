# Azure POC deployment procedure

Status: operator procedure, 2026-08-13. This document implements the section
0.5 bootstrap DAG mechanics (design sections 0.5/0.6, `AC-POC-REL-01`) as
exact deployment steps: unchanged PG-03 digest push through OIDC, an
ingress-disabled first deploy, fail-closed external checks in a fixed order,
and the exact-app-scoped deployment grant issued only after the app resource
exists. Every command below is executed by the actor named in the step
(bootstrap authority in their own session, or the protected GitHub
environment job over OIDC). Procedure is not authorization: each phase states
the gate that must precede it.

Prerequisites: `docs/operations/azure-release-path.md` P-1..P-7 hold; the
preflight (`docs/operations/azure-preflight-and-bootstrap.md`) passed with
retained evidence. Stop conditions and abort/rollback drills:
`docs/operations/azure-abort-and-rollback-drills.md`. Topology contract:
`docs/architecture/azure-poc-topology.md`.

Naming: `<prefix>` resource prefix, `<rg>` resource group, `<env>` protected
GitHub environment (default `poc-deploy`), `<digest>` the verified PG-03
digest (`sha256:` + 64 lowercase hex). Parameter files are operator-supplied
outside Git and must contain no secrets and no real identifiers beyond
tenant context supplied at runtime.

## Phase A - Apply 1: foundation without the Container App (DAG steps 1-3)

Gate: P-1..P-7 + step-1 provider-registration authorization. Evidence: apply
outputs + `what-if` record; secret-name/version policy.

```bash
az deployment sub create \
  --name "${prefix}-apply1" \
  --location southeastasia \
  --template-file infra/bicep/main.bicep \
  --parameters @params/apply1.json \
  --what-if   # first: review; second run: apply
```

`apply1.json` (operator-supplied; no secrets): `deployResources: true`,
`bootstrap: true`, `createContainerApp: false`, `enableExternalIngress: false`,
`resourceGroupName`, `namePrefix`, `githubRepository`, `githubEnvironment`,
`tenantId`, `imageRepository`, `imageDigest` (exactly the verified subject),
`budgetStartDate`/`budgetEndDate`, and at least one of
`budgetContactEmails`/`budgetActionGroupId` (mandatory contact). The budget,
ACR, Key Vault, Log Analytics, managed environment, runtime identity, and
deployment identity + federated credential are created; the deployment
identity receives ACR push only. No Container App exists yet, so no
exact-app grant exists.

What-if must show: one resource group, one budget, ACR, identities +
federated credential, Key Vault, workspace, managed environment, two runtime
role assignments (AcrPull, Key Vault Secrets User), one deployment role
assignment (AcrPush), and NO Container App, NO authConfig, NO roleDefinitions.

Stop: any resource beyond the listed set, any unexpected provider
registration, or a failed `what-if` review aborts before apply.

## Phase B - OIDC digest push by the protected job (DAG step 4)

Gate: Phases A complete; the job is bound to the protected environment
`<env>` (subject `repo:<owner>/<repo>:environment:<env>`).

The protected no-checkout job verifies the offline PG-03 bundle before any
Azure login, then authenticates and pushes:

```bash
# job script (no-checkout; contents of the offline bundle fetched via
# trusted artifact store, never from an unverified local build)
sha256sum offline-bundle/image.tar   # must equal the PG-03 subject digest
az login --identity                  # deployment UAMI; OIDC via federation
az acr import --name "${prefix}acr" \
  --source "${prefix}acr.azurecr.io/${imageRepository}@${digest}" \
  --image "${imageRepository}@${digest}" --force || true   # fallback below
# canonical push form when importing a locally-carried bundle is not used:
docker pull "${imageRepository}@${digest}"
docker tag "${imageRepository}@${digest}" "${prefix}acr.azurecr.io/${imageRepository}@${digest}"
docker push "${prefix}acr.azurecr.io/${imageRepository}@${digest}"
az acr repository show-manifests --name "${prefix}acr" --repository "${imageRepository}" \
  --query "[?digest=='${digest}']"   # registry digest equals the preverified subject
cosign verify --certificate-identity 'https://github.com/<owner>/<repo>/.github/workflows/*' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  "${prefix}acr.azurecr.io/${imageRepository}@${digest}"
```

Stop: digest mismatch, unverified referrer, or any push of a different
digest stops descendants and keeps ingress disabled. The deployment identity
has no Key Vault data role and no role-assignment grant by construction
(verified in Phase D's negative checks).

## Phase C - Apply 2: the real ingress-disabled app, then the exact-app grant (DAG step 5)

Gate: Phase B push verified. Bootstrap authority applies, then grants.

```bash
az deployment sub create \
  --name "${prefix}-apply2" \
  --location southeastasia \
  --template-file infra/bicep/main.bicep \
  --parameters @params/apply2.json \
  --what-if   # review: exactly the Container App added to apply1 state

# bootstrap authority: exact-app grant ONLY after the app resource exists.
# appId = az resource show --resource-group "${rg}" \
#   --name "${prefix}-app" --resource-type Microsoft.App/containerApps \
#   --query id -o tsv   (the resource must already exist; see PF-05 role shape)
deploymentRoleId=<role-definition-id-from-PF-05>
deploymentPrincipal=<deployment-identity-object-id>
appId=<container-app-resource-id>
az role assignment create --assignee "$deploymentPrincipal" \
  --role "$deploymentRoleId" --scope "$appId" \
  --description "exact-app update for the POC deployment identity (post-create only)"

# protected job: idempotent apply/verify of the digest-bound configuration
az containerapp update --name "${prefix}-app" --resource-group "${rg}" \
  --image "${prefix}acr.azurecr.io/${imageRepository}@${digest}" \
  --min-replicas 0 --max-replicas 1
az containerapp revision list --name "${prefix}-app" --resource-group "${rg}" \
  --query "[?properties.healthState=='Healthy' && properties.provisioningState=='Succeeded']"
az containerapp show --name "${prefix}-app" --resource-group "${rg}" \
  --query "properties.configuration.ingress.external"  # must be false
fqdn=$(az containerapp show --name "${prefix}-app" --resource-group "${rg}" \
  --query "properties.configuration.ingress.fqdn" -o tsv)
```

`apply2.json` = `apply1.json` plus `createContainerApp: true` (bootstrap
still true, external ingress still false). The app references the pushed
digest, `minReplicas 0` / `maxReplicas 1`, startup probe budget
5 + 17 x 10 = 175 s inside the 180 s cold-start hard deadline.

Gate for readiness: revision Healthy + Succeeded with the FQDN obtained
within the 8-minute abort threshold. Stop: any candidate not healthy within
the threshold - deactivate/remove the candidate, keep ingress disabled, and
run Drill A (`docs/operations/azure-abort-and-rollback-drills.md`).

## Phase D - Pre-ingress verification (DAG step 6)

Gate: Phase C complete and FQDN known.

1. Bootstrap authority creates the single-tenant user-auth Entra app and an
   expiring credential for the FQDN; the credential is written directly to
   Key Vault as `entra-client-secret` (secret value never enters source,
   commands, CI, or gate artifacts; CAAS API key already in Key Vault as
   `caas-api-key`).
2. Apply 3 (`bootstrap: false`, `createContainerApp: true`,
   `enableExternalIngress: false`): creates the complete `authConfigs`
   (single-tenant issuer, redirect, audience `https://<fqdn>/`,
   `allowedPrincipals.identities` = user object ID only).
3. Control-plane verification with ingress still disabled:
   - `az containerapp auth show --name "${prefix}-app" --resource-group "${rg}"`
     - `globalValidation.unauthenticatedClientAction` is `RedirectToLoginPage`;
     - `identityProviders.azureActiveDirectory.allowedAudiences` contains the
       app audience;
     - `allowedPrincipals.identities` contains exactly one entry (user object
       ID) - never the deployment identity.
   - internal readiness: `/health/startup`, `/health/ready` on port 8080 via
     the FQDN while `external` remains false (the FQDN is served by the
     environment; external traffic is blocked at ingress);
   - five-family acquisition and telemetry: one successful acquisition of
     the five families of real CAAS data; log volume stays under the
     0.1 GiB/day cap (section 6.3).
4. Identity-negative checks (runnable-but-inert; live mode executes only
   read-only commands): `node deploy/azure-identity-negative-checks.mjs --live`
   - NEG-01: deployment identity absent from `allowedPrincipals.identities`
     (`az containerapp auth show ... --query` shows the single user entry);
   - NEG-02: deployment identity `az keyvault secret list`/`show` expects
     `403`/`AuthorizationFailed` (no Key Vault data role);
   - NEG-03: `az role assignment list --assignee <deployment-identity>` shows
     only AcrPush (registry scope) + the exact-app role (app scope) +
     optional verified minimal grants; no Owner/Contributor/
     role-assignment-admin.
5. Bootstrap authority obtains a valid app-audience token for the deployment
   identity while it remains excluded from `allowedPrincipals.identities`
   (the negative principal used in the Phase E denial check).

Stop: any pre-ingress check fails - keep ingress disabled, do not enable
ingress, record evidence, run the relevant drill.

## Phase E - Apply 4 and fail-closed external checks (DAG step 7)

Gate: Phase D complete; P-5 data-use authority in effect (externally
accessible live-data flow).

```bash
az deployment sub create \
  --name "${prefix}-apply4" \
  --location southeastasia \
  --template-file infra/bicep/main.bicep \
  --parameters @params/apply4.json   # bootstrap: false, createContainerApp: true,
                                     # enableExternalIngress: true
az containerapp show --name "${prefix}-app" --resource-group "${rg}" \
  --query "properties.configuration.ingress.external"   # must be true
```

Fail-closed external checks run immediately after, in this fixed order; the
first failure disables ingress immediately (`az containerapp ingress disable`
or apply 4 revert) and enters the first-deploy abort path:

1. Absent auth rejected: unauthenticated request to `https://<fqdn>/` is
   redirected to the login page (302 to the AAD login endpoint) and never
   serves application content. Evidence: HTTP status/redirect capture.
2. Authenticated deployment identity denied: the app-audience token for the
   deployment identity (Phase D step 5) is rejected by the auth stack -
   request is redirected/denied and never serves application content.
   Evidence: HTTP status capture. This proves the negative principal.
3. Allowed user full flow: the user authenticates with their own Entra
   identity, the auth stack permits exactly that principal, and the
   browser/business flow (five-family flight exploration against real CAAS
   data) completes end to end. Evidence: authenticated-flow capture.

Only after all three pass is the first known-good revision recorded in the
PG-04 manifest and the bootstrap write access revoked
(`docs/operations/azure-preflight-and-bootstrap.md` section 3.5).

## AC-POC-REL-01 mapping

| Requirement | Where satisfied |
|---|---|
| Unchanged verified digest deployed directly | Phase B push of the exact PG-03 subject; no rebuild, no staging |
| Ingress disabled through all control-plane/auth gates | Phases A-E: `bootstrap`/`enableExternalIngress` false until Phase E |
| Fail-closed external checks in order | Phase E checks 1 -> 2 -> 3; first failure disables ingress |
| Exact-app grant after resource exists | Phase C: role assignment after `az resource show` returns the app |
| No snapshot/rollback of external data | First-deploy failures deactivate/remove; later failures restore revision + config and reacquire data (drills doc) |
| Demo within 48 h, teardown 24 h after, 7-day max | Release path section 3 schedule; post-demo verification doc |
| Deployment hard deadline 10 minutes (plan §6.3) | Phases A-E run within a single 10-minute window; abort threshold 8 minutes without a healthy candidate revision; exceeding the window triggers the abort drill, never an unbounded retry loop |

## Stop conditions

- Any phase gate fails: stop descendants, keep ingress disabled until the
  applicable drill completes, record evidence.
- USD 45 forecast/actual alert: stop new deployment work; request teardown
  or retention authority.
- Secret or real identifier exposure in source/commands/CI/gate artifacts:
  revoke exposed material, invalidate affected identities/versions, repair
  only through the authorized process.
- Authorized window no longer meetable: abort and reschedule.
