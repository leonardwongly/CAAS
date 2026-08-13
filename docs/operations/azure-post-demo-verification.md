# Azure post-demo cost, access, and teardown verification

Status: operator procedure, 2026-08-13. This document defines the
post-demonstration verification checklist: cost reconciliation against the
governance numbers, access review and revocation, teardown verification, and
the evidence to retain. It is procedure, not authorization; teardown and
retention both require explicit authority before any write. This document
and its template make no claim that any teardown happened.

Binding: `docs/operations/azure-release-path.md` section 3 schedule
(teardown target 24 hours after the demonstration; 7-day operator-enforced
maximum), design section 0.5 / plan section 6.3 cost governance, and the
gate-manifest rules (`deploy/evidence-manifest.schema.json`).

## 1. Cost reconciliation

Governance numbers: USD 50 ceiling, alert thresholds USD 25 / USD 37.50 /
USD 45 (50 / 75 / 90 percent of the USD 50 budget), seven-day forecast
USD 34.66. Alerts are delayed notifications, not billing cutoffs; nothing
here is a platform enforcement.

| # | Check | Read-only evidence | Pass criterion | Fail action |
|---|---|---|---|---|
| C-1 | Current month actual | Cost query (`az costmanagement query` ActualCost, MonthToDate) | Actual below USD 45; if above, teardown authority requested at the USD 45 alert | Record the deviation; request teardown/retention authority before further cost |
| C-2 | Forecast vs seven-day forecast | Forecast cost query + the release-path forecast USD 34.66 | Forecast consistent with the USD 34.66 reference (drift explained, not hidden) | Record explanation; if forecast >= USD 45, request authority |
| C-3 | Alert delivery | Budget/alerts state (`az budget show --name "<prefix>-budget"`) + any alert emails/action-group notifications received | USD 25 / 37.50 / 45 thresholds configured (50 / 75 / 90) with the mandatory contact; notifications received at the crossed thresholds | Record missing notifications; escalate to operator decision |
| C-4 | Spend attribution | Resource-level cost by resource group/tag | Spend attributed to the POC resource group/tags; no unexpected resource types (policy `resources.prohibited` empty) | Investigate unexpected spend before teardown |

## 2. Access review and revocation

| # | Check | Evidence | Pass criterion |
|---|---|---|---|
| A-1 | Allowed principal still single | `az containerapp auth show ... allowedPrincipals.identities` | Exactly one entry (user object ID); no deployment identity, no drift |
| A-2 | Deployment identity grants still minimal | `node deploy/azure-identity-negative-checks.mjs --live` (NEG-01..NEG-03) | Absent from allowed principals; no Key Vault read; only AcrPush + exact-app role |
| A-3 | Runtime identity grants | Role assignment review for the runtime identity | AcrPull + Key Vault Secrets User only |
| A-4 | Bootstrap authority session revoked | Sign-out record, deleted temporary credentials, removed bootstrap-only role assignments | No bootstrap-only role assignment remains |
| A-5 | Federated credential / Entra app state | Federated credential subject, Entra app credential expiry | Expiry recorded; credential cannot outlive the governance window |

## 3. Teardown verification (only after explicit teardown authority)

Run in reverse DAG order (release path section 4): disable/remove external
access first, then app/authConfig, then environment/identities/registry/
vault/workspace, then RG/budget/alerts, then provider-registration state if
the authority covers it. Each removal is verified, never assumed.

| # | Verified gone or retention-authorized | Check |
|---|---|---|
| T-1 | External ingress disabled or app removed | `az containerapp show ... ingress.external` false, or app resource not found |
| T-2 | Container App + authConfig removed | `az resource show ... Microsoft.App/containerApps` not found |
| T-3 | Managed environment removed | `az resource show ... Microsoft.App/managedEnvironments` not found |
| T-4 | Key Vault (soft-delete state noted) / ACR / Log Analytics / identities / federated credential removed | Per-resource `az resource show` / `az identity list` not found; vault soft-delete/purge state recorded per the authority |
| T-5 | Resource group removed | `az resource list --resource-group "<rg>"` empty; RG absent |
| T-6 | Budget/alerts removed | `az budget show --name "<prefix>-budget"` not found |
| T-7 | Entra app + credentials removed (or expiry authorized) | App registration absent or expiry recorded with authority |
| T-8 | No prohibited resource types remain | Policy `resources.prohibited` inventory empty in the POC scope |

Retention: any resource kept beyond the 7-day maximum requires separately
authorized retention; its evidence must state the retention authority, the
retained resource, and the new expiry.

## 4. Evidence to retain

A completed evidence manifest for the lifecycle checks, modeled on
`docs/evidence/azure-poc-teardown-evidence.template.json` (template; no
teardown claims are made by it): gateId `PG-04` (or `PG-LIFE` per the
Release Evidence workstream's gate plan), policy reference with
`evaluationMode: semantic-validator`, one check per row above with
`checkId`, `procedure`, `startedAt`/`endedAt`, `threshold`,
`measurement`, `artifacts` (path + SHA-256), `result`, and
`failureFallback`, plus `blockingIssues` and `gateResult`. Cost numbers
(USD 25 / 37.50 / 45 / 50 / 34.66) appear only as thresholds and
measurements, never as claims about teardown.

## 5. Stop conditions

- USD 45 exceeded: stop teardown planning as usual work; execute teardown
  only under explicit authority and record it.
- Any access drift found in section 2: revoke before any teardown write.
- Missing authority for a removal step: that step is blocked; record
  `result: blocked` and the `failureFallback`, never perform the removal.
