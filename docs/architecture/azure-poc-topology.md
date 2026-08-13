# Azure POC topology: single-app conformance (design section 0.5)

Status: reconciled IaC contract, 2026-08-13. This document maps the binding
single-app POC topology to the checked-in Bicep and states what is deliberately
absent. It is a design and procedure reference, not evidence that any Azure
resource exists. Nothing here authorizes a cloud write.

Normative source: system design section 0.5 (POC Azure, identity, map, and
egress boundaries), implementation plan sections 5.2, 5.3, 5.5, and 6.3. Where
legacy sections 18/19 of the design conflict with section 0.5, section 0.5 is
binding and this document follows it.

## 1. The reconciled topology

One region (`southeastasia`), one resource group, one Container Apps managed
environment with the Consumption workload profile, one Container App, one ACR
Basic registry, one Key Vault Standard vault, one runtime user-assigned managed
identity, one distinct deployment user-assigned identity with a GitHub
protected-environment federated credential, one single-tenant user-auth Entra
app registration plus Container Apps `authConfigs`, and one bounded Log
Analytics / Azure Monitor path with the subscription budget/alerts. There is no
second environment, no staging, and no staging-to-production promotion.

| Surface (section 0.5) | Bicep artifact | Deployment-time input | Conformance note |
|---|---|---|---|
| Region `southeastasia` | `infra/bicep/main.bicep` `param location` (`@allowed(['southeastasia'])`) | none (fixed) | Selection confirmed by authenticated discovery on 2026-08-12 |
| Resource group (1) | `main.bicep` `deploymentResourceGroup` | `resourceGroupName`, `namePrefix` | Tagged with lifecycle/teardown tags |
| Scoped budget + alerts (USD 50; alerts 25 / 37.50 / 45) | `main.bicep` `budget` | `budgetStartDate`, `budgetEndDate`, `budgetContactEmails`, `budgetActionGroupId` | Azure notification thresholds are percent-of-amount: 50 / 75 / 90 percent of USD 50. At least one contact is mandatory or the alerts cannot deliver. Alerts are delayed governance signals, not billing cutoffs; expiry tags do not delete resources |
| ACR Basic (1), admin login disabled | `resource-group.bicep` `registry` | prefix-derived name | `adminUserEnabled: false`; public data plane enabled for the OIDC-authenticated push |
| Key Vault Standard (1), RBAC mode, soft delete | `resource-group.bicep` `keyVault` | `tenantId` | `enableRbacAuthorization: true`, `accessPolicies: []`; runtime identity gets the Key Vault Secrets User role only |
| Runtime user-assigned identity (1) | `resource-group.bicep` `runtimeIdentity` | prefix-derived name | Grants: AcrPull (registry scope), Key Vault Secrets User (vault scope). No push, no role assignment |
| Deployment user-assigned identity (1) + GitHub protected-environment federated credential | `resource-group.bicep` `deploymentIdentity`, `federatedCredential` | `githubRepository`, `githubEnvironment` (default `poc-deploy`) | Grant at bootstrap: AcrPush (registry scope) only. The exact-app deployment grant is deliberately NOT in Bicep: section 0.5 DAG step 5 assigns it only after the app resource exists |
| Container Apps managed environment (1), Consumption profile | `resource-group.bicep` `managedEnvironment` | prefix-derived name | Default Consumption workload profile; logs to the Log Analytics workspace |
| Container App (1), ingress disabled at bootstrap, `activeRevisionsMode: Single` | `resource-group.bicep` `containerApp` | `imageDigest`, `imageRepository`, `minReplicas` (0), `maxReplicas` (1), `bootstrap` (true), `enableExternalIngress` (false) | Created only by the second bootstrap apply (`createContainerApp: true`); references the unchanged PG-03 digest; `maxReplicas: 1` per section 6.2 |
| Container Apps `authConfigs` (single-tenant Entra, `allowedPrincipals.identities` = user object ID) | `resource-group.bicep` `authConfig` | `entraClientId`, `appAudience`, `allowedUserObjectId`, `tenantId`, `entraClientSecretName` | Created only when `bootstrap: false` (after FQDN + Entra app exist). `allowedPrincipals.identities` permits only the user's object ID supplied outside Git |
| Bounded monitoring | `resource-group.bicep` `logWorkspace` (PerGB2018, 30-day retention) | prefix-derived name | Retention is the lowest supported 30-day tier; the section 6.3 log cap (0.1 GiB/day) is operator-monitored. No Application Insights, no scheduled-query rules, no metric alerts beyond the subscription budget: budget alerts are the cost governance path |
| Probes (startup/liveness/readiness on port 8080) | `resource-group.bicep` `containerApp` template | none | Startup budget 5 + 17 x 10 = 175 s inside the section 6.2 180-second cold-start hard deadline |
| OCI image | `main.bicep` `var image` = `'${imageRepository}@${imageDigest}'` | `imageDigest` (`sha256:` + 64 lowercase hex, length 71) | Digest-qualified only; no tag deployment; no placeholder image |

## 2. Deliberately absent (and why)

- No Storage account / Blob snapshot store, snapshot publisher or validator
  Container Apps Job, Service Bus, mutable pointer, or queue. The application
  holds at most the active and previous in-memory generation (section 0.2);
  data is never snapshot-rolled back.
- No second application environment and no staging-to-production promotion
  (section 0.1, plan section 5.5). The unchanged verified digest is pushed
  directly to the one private POC.
- No private endpoints, VPN/Bastion, Azure Firewall, WAF, or network-enforced
  egress. The no-firewall residual is an accepted POC tradeoff (section 0.5);
  production access remains blocked until enforced egress is designed and
  tested.
- No placeholder image and no temporary unauthenticated public ingress. The
  app is created from the verified digest with external ingress disabled and
  no `authConfigs`; auth configuration and ingress are applied only through
  the documented later applies.
- No `Microsoft.Authorization/roleDefinitions` resource in Bicep: the
  exact-app deployment role is a bootstrap-authority action outside the
  template (see `docs/operations/azure-preflight-and-bootstrap.md`), and
  `deploy/poc-policy.yaml` restricts Bicep-declared resource types to the
  allow-list.
- No budget notification without a contact: `budgetContactEmails` /
  `budgetActionGroupId` must be supplied by the authorized bootstrap, or the
  budget apply is refused by the operator before deployment.

## 3. Two-phase bootstrap split (DAG steps 3-5)

Section 0.5 orders the dependency DAG so the unchanged digest is pushed
through OIDC before the one-time bootstrap authority creates the real
ingress-disabled app. The Bicep expresses that split with
`createContainerApp`:

| Apply | Parameters | What it creates | DAG step |
|---|---|---|---|
| Apply 1 | `deployResources: true`, `bootstrap: true`, `createContainerApp: false`, digest/tenant/contacts supplied | resource group, budget/alerts, ACR, runtime + deployment identities, federated credential, ACR push grant, Key Vault, Log Analytics, managed environment | steps 1-3 |
| (OIDC push by the protected job) | - | unchanged PG-03 digest in ACR, verified registry digest + Cosign referrer | step 4 |
| Apply 2 | apply 1 + `createContainerApp: true` | the real Container App from the pushed digest, ingress disabled, no `authConfigs`, `minReplicas: 0` | step 5 |
| (bootstrap authority) | - | exact-app-scoped deployment grant to the deployment identity, only after the app resource exists | step 5 |
| Apply 3 | `bootstrap: false`, `createContainerApp: true`, `entraClientId`, `appAudience`, `allowedUserObjectId` | the `authConfigs` binding the Entra app/secret for the FQDN | step 6 |
| Apply 4 | apply 3 + `enableExternalIngress: true` | external ingress; the fail-closed external checks run immediately after | step 7 |

Every bootstrap=false apply MUST use `createContainerApp: true`; the
`authConfigs` resource is a child of the Container App, and a bootstrap=false
apply without the app fails safely at deployment time.

## 4. Identity and least-privilege summary

| Identity | Allowed | Explicitly denied |
|---|---|---|
| Runtime UAMI | ACR pull; Key Vault Secrets User on the vault | registry push, role assignment, anything else |
| Deployment UAMI (OIDC) | ACR push of the verified subject; exact-app update only after the app exists (bootstrap authority grants it) | Key Vault secret read, role assignment, other resources, ACR content beyond the verified subject |
| Bootstrap authority (the user) | one-time foundation creation, app creation, exact-app grant, Entra app/secret, cleanup | nothing beyond the authorized bootstrap session; bootstrap write access is revoked after apply 4 |

The deployment identity is intentionally absent from
`allowedPrincipals.identities`, which contains only the user's object ID
supplied outside Git and never committed.

## 5. Relationship to the release procedures

- Preflight and least-privilege design: `docs/operations/azure-preflight-and-bootstrap.md`
- Authorized, time-boxed release path and schedule: `docs/operations/azure-release-path.md`
- Deployment procedure and identity-negative checks: `docs/operations/azure-deployment-procedure.md`
- Abort and rollback drills: `docs/operations/azure-abort-and-rollback-drills.md`
- Post-demo cost, access, teardown verification: `docs/operations/azure-post-demo-verification.md`

This document is procedure/design material. It does not authorize provider
registration, Entra app/secret, budget, RBAC, registry, vault, monitoring,
managed environment, or Container App creation.
