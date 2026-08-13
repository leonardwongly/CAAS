# Flight Route Explorer - System Design

Status: Local-first POC design independently reviewed with no unresolved P0/P1; confirmed live API and read-only Azure capability evidence retained; the local-first POC implementation now exists beneath this document, while Azure resources, deployment, CI execution, and UAT remain intentionally un-evidenced and unauthorized; `PG-00` remains blocked only by an explicitly authorized exact-hash commit and later implementation authorization
Version: 1.2-rc4
Date: 2026-08-12
Last reviewed: 2026-08-12
POC decision authority: The user; no separate named-owner or reviewer-audience register is required
Technical execution authority: Not granted
Source brief: `CAAS Tech Challenge_v2.21.pdf`

## 0. Normative POC reconciliation - 2026-08-12

This section is the binding challenge/POC design. Where Sections 3 through 29
conflict with it, this section supersedes their challenge-path wording. Legacy
staging, snapshot publisher, Blob pointer, Container Apps Job, Service Bus,
controller, attestor, reviewer-role, synthetic runtime, and multi-environment
material is retained only as historical production-hardening analysis; it must
not be implemented for the POC. Section 30 remains the separate production gate.

### 0.1 Delivery profile and authority

The challenge outcome is one private, single-user Azure proof of concept using
real CAAS data at runtime and during the demonstration. There is no synthetic
runtime/demo fallback, separate staging environment, reviewer audience, or
staging-to-production promotion. Automated tests may use minimized,
irreversibly sanitized captures of real responses and pure mathematical vectors.
This design does not authorize implementation, cloud writes, a Git commit, or
production use. Delivery is local-first: feature work, real-data integration,
container execution, debugging, and iteration occur on loopback/local
infrastructure. At completion, secretless Linux CI builds the final-feature
commit once into the authoritative digest-bound OCI subject; that exact subject,
not an independent local rebuild, must pass the complete loopback-only real-data
`PG-03` gate. Azure exists only for the late push of that unchanged subject and
final deployment/auth/rollback/UAT evidence.

### 0.2 Application and data topology

- React/Vite frontend and Fastify backend remain separate source/build
  responsibilities and deploy in one non-root Linux image.
- The authoritative CI-built image is proven loopback-only with real CAAS
  runtime data; the key is injected at runtime and never enters the image or
  browser. That exact digest is required before any Azure write.
- The Fastify server is the only CAAS client. It performs bounded, allow-listed
  HTTPS GETs to all five accepted families, validates and sanitizes every
  response, exercises Airways without exposing its unproven values, and builds
  an immutable complete in-memory generation.
- Startup requires one usable five-family real generation and fails explicitly
  if any family is unavailable/invalid. User refresh builds separately and swaps
  atomically only after complete validation; a failed refresh retains the prior
  complete generation only within freshness and memory limits.
- At most the active and immediately previous generation are retained for 30
  minutes. Nothing persists across a restart. Every cursor, point reference,
  candidate ID, and draft token binds to application revision and generation.
- There is no application database, Blob snapshot store, scheduled publisher or
  validator Job, mutable pointer, queue, Service Bus, orchestrator, controller,
  attestor, or data rollback. After a known-good deployment exists, application
  rollback restores code and app-scoped configuration and reacquires current
  real data; first deployment uses abort/cleanup instead.

### 0.3 Confirmed live contract

Bounded authenticated discovery at `2026-08-12T09:30:06Z` returned:

| Dataset | HTTP/media | Bytes | Records | POC use |
|---|---|---:|---:|---|
| Flight Plan | `200`, JSON | 222,298 | 115 | Search, selection, recorded routes |
| Airways | `200`, text-declared JSON array | 66,243 | 9,319 | Mandatory fetch/schema/count exercise; values/types hidden from every product output |
| Fixes | `200`, text-declared JSON array | 5,655,307 | 247,419 | Exact intermediate-point resolution |
| Airports | `200`, text-declared JSON array | 288,573 | 13,175 | Exact departure/destination resolution |
| NAVAIDs | `200`, text-declared JSON array | 206,841 | 10,195 | Exact intermediate-point resolution |

Discovery confirms successful response contracts only. It deliberately did not
induce throttling or upstream faults and makes no quota/retry/failure-behavior
claim; bounded adapter retry/failure behavior is proved later with deterministic
tests and any naturally occurring authorized live evidence.

Every Fix, Airport, and NAVAID string passed the bounded
`IDENTIFIER (latitude,longitude)` parser and coordinate-range checks. Of 891
structured designated route occurrences, Fixes matched 577, NAVAIDs matched
243 (234 NAVAID-only), and 80 remained unresolved. Airports matched all 115
departures and 114 of 115 destinations. Ambiguity is preserved and unresolved
positions remain explicit gaps; no proximity inference is permitted.

Fifty-nine flights contained 927 ordered route elements, with a maximum of 39.
Airway fields existed, but route-text association was inconsistent and 236 of
889 values were absent from the separate airway-name list. No authoritative
occurrence/directed-leg relation was proved. Upstream `airway` and `airwayType`
therefore do not enter presentation DTOs, signatures, diffs, tables, map labels,
geometry, completeness, or ranking. The user, as challenge decision authority,
accepts this as a safety-driven POC variance from a literal requirement to draw
recorded airway topology: the app exercises and validates the Airways API but
draws selected routes only from exact resolved waypoint/reference coordinates.
It must not claim literal airway-topology conformance unless a later authoritative
contract proves the relation.

### 0.4 Candidate ranking and presentation

Leg and total Haversine distance use full precision with `R = 3440.065 NM`.
Only for competition-rank equality, derive `rankDistanceNm` by rounding the full
sum to `0.000001 NM`. Complete candidates with the same value share rank; every
Rank 1 candidate is presented together. Point count and canonical signature
stabilize display order only. Visible distance remains rounded to `0.1 NM`.
Incomplete candidates remain available but unranked. The only qualified label is
“Rank 1 by shortest modeled distance among complete candidates.” It never means
operationally valid, recommended, safe, cleared, or suitable for flight;
“valid” and unqualified “best” are not candidate labels.

### 0.5 POC Azure, identity, map, and egress boundaries

The target POC topology is one region, one Container Apps managed environment
and app, ACR Basic, Key Vault Standard, one runtime user-assigned managed
identity, one distinct deployment user-assigned identity with a GitHub protected-
environment federated credential, one single-tenant user-auth Entra app
registration plus Container Apps `authConfigs`, and bounded Azure Monitor/Log
Analytics. The deployment identity can push the verified subject and deploy only
the exact app but cannot read Key Vault secrets or assign roles.
`allowedPrincipals.identities` permits only
the user's object ID supplied outside Git. Authenticated discovery selected
`southeastasia`: Container Apps, managed environments, the Consumption workload
profile, ACR, Key Vault, Log Analytics, scheduled-query rules, metric alerts,
and global action groups expose supporting metadata in the selected subscription.
`Microsoft.App` is not registered and requires an explicitly authorized
bootstrap write before deployment; `Microsoft.ManagedIdentity` and the other
required providers checked are registered.

No Azure provider registration, Entra app/secret, budget, RBAC, registry, vault,
monitoring, managed environment, or app is created during routine development.
Those writes begin only after the authoritative CI OCI digest passes `PG-03`,
the demonstration is planned within 48 hours, and the user explicitly authorizes
the cloud bootstrap. Before the window, a go/no-go checkpoint confirms provider,
resource, budget/RBAC, deployment-identity/federation, ACR push, Key Vault
secret-write, Container App/authConfig, user-auth Entra app/credential/redirect,
and cleanup capabilities; failure
aborts before a write.

Bootstrap follows one dependency DAG: tagged resource group and scoped
budget/alerts, then provider registration; ACR/runtime identity/Key Vault/
monitoring/managed environment and least-privilege runtime grants; distinct
deployment user-assigned identity, protected-environment federation and ACR-push-
only grant; unchanged verified digest push through OIDC; one-time bootstrap-
authority creation of the real ingress-disabled app from that digest; exact-app-
scoped deployment grant only after the resource exists, followed by protected-job
idempotent apply/verification; FQDN acquisition; user-auth Entra app/secret
written directly to Key Vault and complete `authConfigs`; reachable control-
plane/revision/acquisition/telemetry checks and acquisition of an app-audience
token for the deployment identity while it remains excluded from
`allowedPrincipals.identities`; then ingress enablement. External checks run
fail-closed in order: absent auth rejected, authenticated deployment identity
denied, then allowed-user full browser/business flow. Any failure disables or
keeps ingress disabled. No placeholder image, temporary unauthenticated public
ingress, or circular app/FQDN dependency is permitted.

The app deploys the unchanged `PG-03` digest directly to the POC through narrowly
scoped GitHub OIDC; there is no staging environment. A failed first deployment
has no rollback target: ingress stays disabled and the failed candidate is
deactivated/removed before cleanup or repair. After a known-good revision exists,
rollback restores both the prior revision and app-scoped ingress, identity,
secret-reference, scale/environment and separate `authConfigs` settings, then
fetches current data. Steady state configures at most one active serving replica,
with transient platform rollout/prewarming overlap treated honestly.

OpenStreetMap Standard raster tiles are the configurable Leaflet default. The UI
shows attribution, permits an origin-only cross-origin Referer, keeps all flight
and user state out of URLs, honors caching, and prohibits bulk, prefetch,
offline, proxy, and headless scan behavior. Direct requests disclose the user's
client IP and requested `z/x/y` viewport tiles to the provider; this is accepted
for the one-user POC. Route Data remains usable if tiles fail.

Network-enforced outbound filtering is omitted to preserve the least-complex
POC. Strict application origin/path/method/redirect/proxy controls are mandatory.
This residual is accepted only for the POC and blocks broader production access
until enforced egress is designed and tested.

The total Azure governance ceiling is USD 50, with alerts at USD 25, USD 37.50,
and USD 45. Budgets/alerts are delayed notifications, not enforced billing
cutoffs, and expiry tags do not delete resources. Provisioning starts no earlier
than 48 hours before the planned demonstration. Teardown targets 24 hours after
the demonstration; seven days is an operator-enforced maximum requiring explicit
teardown approval or separately authorized retention. Stop new deployment work
at a USD 45 forecast/actual alert and request teardown or retention authority.
Authenticated read-only checks confirmed the enabled subscription, tenant,
allowed-user object, selected region, and required regional metadata without
retaining raw identifiers in Git. A conservative seven-day, continuously active
1-vCPU/2-GiB retail forecast with no free grants and 20% contingency is USD
34.66. The subscription has zero existing budgets;
provider registration, budgets/alerts, app registration, auth secret, and all
resources remain unauthorized writes.

### 0.6 POC acceptance overrides

The checked-in evidence schema is a structural envelope, not a threshold engine.
`PG-00` is human-reviewed against exact hashes using normative plan Section 8.2
as policy (`policyVersion` `PG-00/<plan-version>`, `policySha256` equal to the
reviewed plan hash, and `evaluationMode` `human-reviewed-pg00`). Before `PG-01`
can pass, the
implementation adds a versioned gate/check policy and semantic validator that
rejects missing/unknown/duplicate checks, wrong subjects, incompatible values or
units, insufficient samples, unresolved artifact hashes, expired exceptions,
and caller results inconsistent with policy-derived outcomes. Every later gate
binds the policy/validator hashes, check IDs, exact commit/OCI subject,
environment, procedure, typed threshold, measured value/sample count, artifact
hash, derived result, exception/expiry, and fallback. Command exit or structural
schema validation alone cannot pass a gate. Cold-start, latency, and memory
measurements follow implementation-plan Section 6.

For the challenge profile, the following replace conflicting `AC-SD-*` and
`AC-DEL-*` snapshot/staging criteria in the archived historical sections
(formerly Sections 3-29):

- `AC-POC-LOCAL-01`: the authoritative secretless-CI OCI digest passes the
  complete loopback-only five-family real-data container gate, including focused
  capabilities, exact-once browse-all, resource measurements, secret/telemetry
  boundaries, automated accessibility, restart, and failure checks before any
  Azure write.
- `AC-POC-BROWSE-01`: cursor traversal from first page through terminal cursor
  returns every active-generation flight exactly once without omission,
  duplication, silent truncation, or cross-generation reuse; callsign search and
  duplicate selection are directly exercised.
- `AC-POC-RANK-01`: present every tied Rank 1 candidate with provenance and
  modeled distance under the exact qualified label; never call a candidate
  valid, recommended, safe, cleared, or unqualified best.
- `AC-POC-LIVE-01`: local and Azure POC flows acquire and validate real Flight
  Plan, Airways, Fixes, Airports, and NAVAIDs data through the server adapter;
  cold startup fails on any unusable family, refresh retains only a still-usable
  complete generation, and no synthetic runtime/demo fallback exists.
- `AC-POC-DATA-01`: Airways fetch/schema/count validation is directly evidenced
  while its values/types are absent from every API/UI/log/route output; Airports
  and NAVAIDs participate only through exact, ambiguity-preserving resolution.
  Evidence records the user-approved graphical-airway variance and never claims
  inferred airway-topology display.
- `AC-POC-MAP-01`: attribution, accepted IP/tile disclosure, origin-only
  Referer, caching, no-prefetch, configurable provider, and non-map tile-failure
  behavior pass.
- `AC-POC-SEC-01`: the browser never receives the CAAS key/raw object; strict
  application allow-list tests and the accepted no-firewall residual are
  recorded.
- `AC-POC-REL-01`: unchanged-digest direct deployment, first-deploy
  ingress-disabled abort/cleanup, later prior-revision plus complete app-scoped
  configuration rollback, smoke, and current-data reacquisition meet the
  quantitative policy.
- `AC-POC-DOC-01`: architecture, algorithms, tooling, build/deploy, limitations,
  AI use, lessons, requested feedback, and future roadmaps are documented.

### 0.7 Remaining `PG-00` blockers and deferred `PG-04` inputs

The endpoint/schema and account-specific read-only capability decisions are
confirmed. The selected enabled subscription, tenant, and signed-in user are
recorded only as hashes in the implementation plan. `southeastasia` supports the
required resource types and Consumption profile.

`Microsoft.App` registration, app/client ID, redirect URI, secret
reference/expiry, budgets/alerts, RBAC, and all Azure resources are deliberately
deferred `PG-04` inputs. They are neither required nor authorized for `PG-00`;
materializing them early would violate the accepted local-first cost policy.
The corrected version `1.2-rc4` and its implementation plan passed independent
exact-hash review with no unresolved P0/P1. An authorized exact-hash Git commit
and a later explicit implementation request remain required; no review or plan
edit grants either authority.

> **Non-normative legacy warning:** Sections 3 through 29 were extracted
> verbatim on 2026-08-13 into the
> [archived historical document](../historical/2026-08-11-flight-route-explorer-design-legacy-sections-3-29.md).
> That material contains terms such as staging, snapshots, synthetic fixtures,
> publisher jobs, reviewer access, and production promotion. None of those
> challenge-path mechanisms or acceptance statements may be implemented or
> used to interpret the POC. For the challenge, Section 0 and the current
> implementation plan are exclusively binding; Section 30 remains a separate
> future production gate.

This document is the architecture and lifecycle source of truth for the challenge implementation. Statements in future tense are design commitments, not evidence that code, infrastructure, tests, deployments, or operational controls already exist. The local-first POC implementation is committed and described in the README; Azure resources, deployment, CI execution, and UAT remain un-evidenced and unauthorized. Public production use remains prohibited until every production gate in Section 30 is approved with retained evidence; the archived historical sections (including the former Section 5.1) are non-normative and cannot gate production.

## 1. Summary

Build a TypeScript flight-route exploration application that:

- retrieves recorded flight plans and aeronautical reference data from the supplied CAAS APIs;
- lets a user find and select a flight by callsign;
- resolves its ordered route points to latitude and longitude;
- draws the filed route and comparable candidates on a global map;
- calculates per-leg and total modeled distance in nautical miles;
- ranks every complete same-endpoint recorded route and computationally complete local draft by shortest modeled distance;
- lets the user copy a route into a local draft, edit its waypoint sequence, and compare the result;
- deploys a tested, containerized application to Azure Container Apps through a gated CI/CD pipeline.

This is a decision-support demonstration. It is not an operational flight-planning, navigation, filing, dispatch, clearance, or safety system.

## 2. Source requirements

### 2.1 PDF requirements

| ID | Requirement |
|---|---|
| `SRC-01` | Select a flight and display its route on a global map. |
| `SRC-02` | List routes and search flight plans by callsign. |
| `SRC-03` | Use the Flight Plan, Airways, and Waypoints APIs. |
| `SRC-04` | Keep frontend and backend responsibilities separate. |
| `SRC-05` | Build on Linux and produce a containerized artifact. |
| `SRC-06` | Automate build, test, and deployment. |
| `SRC-07` | Provide a README covering architecture, algorithms, tooling decisions, build/deploy steps, and AI use. |
| `SRC-08` | Provide a working flow that can be explained in a 30-minute walkthrough. |

### 2.2 User requirements

| ID | Requirement |
|---|---|
| `USR-01` | Show distance between consecutive waypoints and total route distance. |
| `USR-02` | List complete recorded routes and computationally complete local drafts ranked by shortest modeled distance. |
| `USR-03` | Let the pilot select, copy, and change a route locally. |
| `USR-04` | Explain differences between routes. |
| `USR-05` | Keep cards and controls from obscuring excessive map content. |
| `USR-06` | Provide a robust CI/CD design. |
| `USR-07` | Use Azure as the deployment platform. |

The PDF describes alternate-route generation as optional. In this design, comparison and local drafting are first-class, but the application does not invent airway connectivity that the source API does not provide.

## 3. Archived historical analysis (formerly Sections 3-29)

The former Sections 3 through 29 of this document (goals, source requirements,
challenge-path architecture, snapshot publisher, Blob pointer state, Container
Apps Jobs, Service Bus, staging and promotion, reviewer access, tile-provider
decisions, synthetic-runtime analysis, and pre-implementation lifecycle-gate
and ADR material) were extracted verbatim on 2026-08-13 into the historical
archive:

- [Archived historical Sections 3-29](../historical/2026-08-11-flight-route-explorer-design-legacy-sections-3-29.md)

Per Section 0, none of that material is binding or implementable for the POC;
it is preserved only as historical production-hardening analysis. The archive
retains the original section numbering, so the former Section 5.1, 7, 8, 16,
17, 18, 19, 23, 28, and 29 discussions are found under those same numbers
there. Section 30 remains the separate future production gate below, followed
by Sections 31 and 32.

## 30. Public-production gate

Public or broad organizational production access is prohibited until retained evidence proves all of the following:

1. Written CAAS redistribution/licensing authorization plus data classification, privacy, residency, retention, acceptable-use, and end-user access decisions.
2. Named service, product, technical, security/data, release, cost, and on-call owners with escalation and independent production approval.
3. Approved availability/latency/error SLIs, SLOs, error budget, support hours, paging thresholds, incident severities, incident command/communications, and postmortem process.
4. Approved RTO/RPO and successful restore/DR tests for Key Vault configuration, ACR/evidence, snapshots/pointers, IaC, monitoring evidence, and the chosen regional/platform-loss scenario.
5. Aggregate edge/WAF/quota protection, origin lockdown, forwarded-header policy, bot/rate-limit/origin-bypass tests, and CAAS quota-exhaustion behavior.
6. Production-sized capacity/load evidence, Azure quota/headroom validation, autoscaling policy, resource budgets, monthly forecast/ceiling, tags, cost alerts, telemetry caps, and spend owner.
7. Telemetry redaction proof, data/log/evidence retention schedules, access-review cadence, audit export/legal-hold decision, and provider/tile privacy approval.
8. Manual accessibility matrix, product UAT, vulnerability remediation SLAs, emergency patch/change path, and current runbooks for alerts, outages, drift, secrets, rollback, restore, and decommission.
9. Auditable change record naming release authority, required sign-offs, risk acceptance, change window/communications, known-good targets, and emergency rollback authority.

## 31. Maintenance, deprecation, and decommission

### 31.1 Maintenance

- Dependency, base-image, scanner, GitHub Action, Node/pnpm, framework, Bicep API-version, Azure service, and tile-provider updates use the normal PR and release gates.
- The technical owner reviews automated updates and supported-version/EOL status on a documented cadence. Production adds severity/exploitability remediation SLAs and exposure tracking; challenge submission closes every release-blocking finding.
- Assumptions, ADRs, contracts, runbooks, performance baselines, and acceptance evidence are reviewed after a material upstream/platform change or incident.
- A technical-debt and lifecycle backlog records owner, priority, dependency, validation gate, and target milestone.

### 31.2 Deprecation

- A breaking API, token, DTO, snapshot/signature policy, feature, or operational-policy removal requires an ADR, versioned compatibility/migration plan, owner, notice/support period, and removal acceptance test.
- Challenge-only behavior with no external consumer may be removed without a public notice period, but release notes and retained evidence must state the change.

### 31.3 Decommission

1. Obtain product and operations approval and record the shutdown/teardown date.
2. Notify affected consumers and preserve required source, release, security, assessment, and audit evidence for the approved retention period.
3. Disable traffic/DNS and verify the application, candidate labels, health exceptions, and publisher triggers are no longer externally usable.
4. Revoke GitHub federated credentials, managed-identity grants, CAAS/token keys, and immutable secret references.
5. Dispose of snapshots, pointer history, logs, and evidence under the approved retention/deletion policy; do not delete material still subject to rollback, audit, or legal hold.
6. Delete Container Apps/Jobs, registry, storage, Key Vault, networking, monitoring, alerts, and scheduled workflows; verify no residual cost-bearing resource remains.
7. Record final evidence, residual obligations, and ownership transfer or closure. The challenge records a teardown owner/date even when no long-term operation is planned.

## 32. References

- Flight Object Manager OpenAPI: <https://api.swaggerhub.com/apis/CAASFSDATMSE/flight-object-manager/1.0.0>
- Aeronautical Data Service OpenAPI: <https://api.swaggerhub.com/apis/CAASFSDATMSE/aeronautical-data-service/1.0.0>
- Azure Container Apps overview: <https://learn.microsoft.com/en-us/azure/container-apps/overview>
- Azure Container Apps jobs: <https://learn.microsoft.com/en-us/azure/container-apps/jobs>
- Azure Container Apps authentication: <https://learn.microsoft.com/en-us/azure/container-apps/authentication>
- Azure Container Apps revisions: <https://learn.microsoft.com/en-us/azure/container-apps/revisions>
- Azure Container Apps traffic splitting: <https://learn.microsoft.com/en-us/azure/container-apps/traffic-splitting>
- Azure Container Apps health probes: <https://learn.microsoft.com/en-us/azure/container-apps/health-probes>
- Azure Container Apps secrets and Key Vault references: <https://learn.microsoft.com/en-us/azure/container-apps/manage-secrets>
- Azure Container Apps managed-identity image pull: <https://learn.microsoft.com/en-us/azure/container-apps/managed-identity-image-pull>
- Azure Container Apps monitoring: <https://learn.microsoft.com/en-us/azure/container-apps/log-monitoring>
- Azure Monitor OpenTelemetry: <https://learn.microsoft.com/en-us/azure/azure-monitor/app/opentelemetry-enable>
- Azure Login with GitHub OIDC: <https://learn.microsoft.com/en-us/azure/developer/github/connect-from-azure-openid-connect>
- GitHub artifact attestations: <https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations>
- Sigstore keyless signing: <https://docs.sigstore.dev/cosign/signing/signing_with_containers/>
- Azure Container Apps pricing: <https://azure.microsoft.com/en-us/pricing/details/container-apps/>
