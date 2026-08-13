# Flight Route Explorer - Implementation Plan

Status: Local-first POC plan independently reviewed with no unresolved P0/P1; live API and read-only Azure capability discovery confirmed; the local-first POC implementation now exists, while Azure resources, deployment, CI execution, and UAT remain un-evidenced and unauthorized; `PG-00` remains blocked only by an explicitly authorized exact-hash commit and later implementation authorization

Version: 1.4-rc4

Date: 2026-08-12

POC owner: The user; no separate named-owner register is required

Source design: [Flight Route Explorer system design](../specs/2026-08-11-flight-route-explorer-design.md)

Source brief: `CAAS Tech Challenge_v2.21.pdf`

## 1. Objective and conformance position

Deliver one private, single-user Azure proof of concept that uses real CAAS API
data and satisfies every `SRC-*` requirement from the source brief and every
`USR-*` requirement in the accepted design.

The application will:

- retrieve real Flight Plan, Airways, Waypoints/Fixes, Airports, and NAVAIDs
  data through a server-side allow-listed adapter;
- sanitize weak and drifting upstream schemas into stable runtime contracts;
- list flight-plan records and find flights by callsign and opaque identity;
- resolve a selected recorded route to ordered coordinates without guessing;
- calculate per-leg and total modeled great-circle distance only for complete,
  exactly resolved routes;
- rank every computationally complete same-endpoint **recorded** candidate;
- prominently list every Rank 1 recorded candidate tied for the shortest modeled
  distance, while retaining access to lower-ranked and incomplete options;
- let the user inspect only server-returned provenance, freshness, route-point,
  leg, gap, and modeled-distance information;
- draw only resolved route components in the dependency-free SVG diagram without
  connecting gaps or requesting external map tiles;
- let the user copy a route into a local computational draft, add/remove/reorder
  exact unambiguous reference points, reset it, and view its server-computed
  distance delta when both routes are complete;
- preserve unresolved, ambiguous, or unavailable data as a visible gap or
  unavailable value rather than supplying a substitute;
- build on Linux in secretless CI, package one non-root authoritative OCI
  subject, and prove that exact digest loopback-only against real CAAS data
  before any Azure write;
- only near completion, push and deploy that unchanged, locally proven CI digest
  directly to one private Azure POC environment through OIDC-based CI/CD; and
- provide a README, AI-use declaration, and a 20-minute demonstration that
  leaves 10 minutes of the 30-minute session for questions.

The only qualified top-ranked label is **“Rank 1 by shortest modeled distance
among complete candidates.”** It does not mean recommended, operationally
valid, safe, cleared, or suitable for flight. The application is a
non-operational decision-support demonstration and never files, dispatches,
clears, or navigates a route.

### 1.1 Conformance summary

| Source obligation | Binding POC outcome |
|---|---|
| `SRC-01`, `SRC-02` | Search/list, select, resolve, rank, and display only resolved recorded-route components in the dependency-free SVG route diagram. |
| `SRC-03` | Exercise the three supplied API families against real data through tested server-side adapters. Under the user's explicit safety direction, the source phrase “using recorded Airways and waypoints” is an accepted POC variance: Airways is fetched/validated, but selected-route geometry uses only exact resolved waypoint/reference coordinates and never infers or displays unproven airway topology. |
| `SRC-04` | Keep frontend, backend, domain, and upstream-adapter responsibilities separate even though one image deploys them. |
| `SRC-05` | Build on Linux and produce a non-root container. |
| `SRC-06` | Automate build, focused tests, exact-digest Azure POC deployment, smoke, and code rollback. |
| `SRC-07` | Provide architecture, algorithms, tooling, build/deploy, limitations, and AI-use documentation. |
| `SRC-08` | Provide a working flow explainable within the 30-minute session. |
| `USR-01` to `USR-07` | Remain POC-exit requirements unless the originating user explicitly changes them. |

Alternate-airway generation remains optional and out of scope. Recorded-route
comparison and a user-controlled computational draft do not claim to compute an
authoritative airway route.

### 1.2 Live API capability rule — 2026-08-13

The POC presents only data that the normalized server API returns for the active
live generation. During authorized loopback-only validation on 2026-08-13, the
public browse response exposed `id`, `flightId`, `callsign`, `origin`,
`destination`, and `routePointCount`. Route responses exposed a bounded subset
of `id`, `flightId`, `callsign`, `label`, `origin`, `destination`, `pointCount`,
`status`, `complete`, `legs`, `segments`, `gaps`, `provenance`, `freshness`, and
`safety`; `distanceNm`, `rankDistanceNm`, `rank`, and geometry appear only when
the route is computationally complete. The observed sampled route was
incomplete and therefore correctly returned gaps without invented geometry or
distance.

This observation records a public-schema capability check, not a fixed record
count, uptime promise, or authorization to redistribute CAAS data. UI, draft,
and documentation work must obey these rules:

1. Render an available normalized field only when the server returns it. Do not
   fabricate flight date/time, aircraft type, flight rules, cruise data,
   alternates, route text, airway values/types, coordinates, a route line, a
   distance, a rank, or a comparison result.
2. Represent missing, invalid, ambiguous, and unresolved inputs as explicitly
   unavailable or as a visible gap. Never infer a coordinate by proximity,
   interpolate across a gap, or substitute synthetic data.
3. Retain raw CAAS records, identifiers beyond the active request, credentials,
   and airway values/types outside public DTOs, UI, logs, test output, and plan
   evidence. The browser receives only the BFF's normalized opaque-ID contract.
4. Do not describe the current draft editor as supporting undo, redo, a full
   directed diff, secure explicit selection of ambiguous coordinates, or ranking
   a draft among recorded candidates. Those capabilities require a separately
   designed server protocol and evidence before they may be promised.

## 2. Ratified user decisions

The following decisions supersede the unresolved alternatives in version
1.1-rc2 and must be reflected in the system design and ADRs before `PG-00`:

1. **Best flight-plan presentation.** List all flight-plan records that pass
   schema sanitization for search. For a selected endpoint pair, calculate
   competition rank across all computationally complete **recorded** candidates.
   Display every tied Rank 1 candidate together and let the user choose; show
   lower ranks and incomplete/unranked diagnostics in secondary groups. A local
   draft is server-validated separately and may show a distance delta from the
   selected recorded route only when both computations are complete; it is not
   ranked into the recorded-candidate population.
2. **Real data only.** The running application and demonstration use real CAAS
   API data. There is no synthetic runtime/demo mode and no synthetic fallback.
   Automated tests may use minimized, irreversibly sanitized captures from real
   upstream responses plus pure mathematical test vectors; they must not contain
   keys, raw personal fields, or invented runtime flight records.
3. **No staging environment.** CI/CD deploys the exact tested image directly to
   one private Azure POC environment. The POC is not production and is not a
   staging-to-production promotion source.
4. **Single user.** The POC is accessible only to the user through one approved
   Microsoft Entra account. No reviewer-audience register or separate product,
   release, security, cost, or teardown owner roster is required.
5. **Small single-region POC.** Use one Azure region, one application replica at
   most, consumption-oriented resources, a USD 50 governance ceiling with
   alerts (not an enforced billing cutoff), and a seven-day maximum planned
   lifetime requiring explicit teardown or retention action.
6. **Airway display.** The 2026-08-12 discovery found `airway` and
   `airwayType` fields but did not prove one stable occurrence/directed-leg
   meaning: route-text association was mixed and 236 reported values were absent
   from the separate airway-name list. Do not expose airway values in product
   DTOs, tables, map labels, signatures, diffs, geometry, completeness, or
   ranking unless a later authoritative contract proves the relation. The user,
   as challenge decision authority, accepts this as a safety-driven variance from
   any literal reading that route graphics must depict recorded airway topology;
   fetching and validating Airways still satisfies the API-use obligation.
7. **Supplemental reference data.** The authenticated Airports and NAVAIDs
   endpoints both succeeded and every returned reference string passed the
   bounded `IDENTIFIER (latitude,longitude)` parser. Enable Airports for endpoint
   resolution and NAVAIDs for exact intermediate-point resolution alongside
   Fixes. Preserve ambiguity and explicit gaps; never guess by proximity.
8. **Competition-rank ties.** Sum full-precision leg distances, then derive a
   tie-only `rankDistanceNm` rounded to `0.000001 NM`. Candidates with the same
   `rankDistanceNm` share competition rank. Point count and canonical signature
   stabilize display order only. Display remains rounded to `0.1 NM`.
9. **Route diagram.** Use the dependency-free SVG route diagram for the
   local-first POC. It renders only server-returned resolved segments and visible
   gaps, uses no external tiles or map-provider API key, and remains usable when
   no geometry is available. Introducing an external tile provider requires a
   separately accepted privacy, CSP, attribution, caching, and failure-behavior
   design; it is not assumed by this plan.
10. **Azure topology.** Use the least-complex live-data topology in Section 5:
    one Container Apps managed environment and app, ACR, Key Vault, managed
    identity, single-tenant Entra app registration/auth config, and bounded
    monitoring. Do not use Blob snapshots, a publisher Job, Service Bus,
    controllers, attestation services, or a separate staging environment.
11. **Local-first delivery and cost control.** Build and integrate locally, then
    have secretless Linux CI build the final-feature commit once and export its
    digest-bound OCI subject. `PG-03` requires that exact CI subject—not an
    independently rebuilt local image—to pass the complete loopback-only
    real-data container gate. Do not register providers, create Entra
    applications/secrets, budgets, RBAC, or Azure resources before `PG-03` and a
    separate explicit cloud-write authorization. Provision Azure no earlier than
    48 hours before the planned demonstration, use it only for final auth,
    deployment, smoke, rollback, and UAT evidence, and target teardown within 24
    hours after the demonstration. Seven days is the governance maximum requiring
    explicit teardown approval or separately authorized retention; tags and
    alerts do not enforce deletion or a billing cutoff.

## 3. Authority and hard boundary

This plan is not implementation authorization. Durable implementation may begin
only after:

1. the `PG-00` packet in Section 8.2 is complete;
2. the system design and ADRs are reconciled with Section 2 at exact hashes;
3. an independent review reports no unresolved P0/P1 issue affecting the POC
   public contract, trust boundary, or feasible delivery path; and
4. a later user request explicitly authorizes implementation.

The user may authorize one narrow pre-`PG-00` enabling exception for:

- secret-safe `.gitignore`/`.dockerignore` and repository hygiene;
- read-only real API discovery whose retained outputs are irreversibly
  sanitized before entering source control;
- disposable, timeboxed Azure/authentication/toolchain capability checks; and
- cost measurements needed to confirm the fixed POC resource profile.

An exception records paths/resources, credential/data handling, budget, expiry,
teardown, retained sanitized output, and prohibition on durable product code or
production writes. This plan edit does not itself authorize implementation.

Commands shown later are future validation contracts, not evidence that the
system exists.

## 4. Sources and design reconciliation

Implementation follows, in order:

1. `CAAS Tech Challenge_v2.21.pdf` and explicit user requirements;
2. the latest accepted system design and accepted ADRs;
3. this implementation plan;
4. generated OpenAPI and runtime schemas; and
5. code and infrastructure defaults.

Phase 0 must update the current design rather than letting implementation choose
between conflicting documents. Required changes include:

- replace reviewer-staging/synthetic-fallback language with the private,
  single-user, real-data POC decision;
- replace the scheduled publisher, shadow validator, Blob pointer, retained
  snapshot, and pointer-specific rollback model with one server-side live
  adapter and one immutable in-memory generation per process;
- permit the Fastify server process to possess the Key Vault-injected CAAS key
  while proving that the browser, assets, responses, logs, image layers, and
  test artifacts never contain it;
- preserve one-image packaging and direct narrowly scoped GitHub OIDC;
- replace snapshot rollback claims with first-deployment abort/cleanup and, only
  after a known-good deployment exists, full application revision plus app-scoped
  configuration rollback; external CAAS data remains current and is not rolled
  back;
- update `AC-SD-09`, `AC-SD-11`, `AC-DEL-04` through `AC-DEL-07`, related risks,
  traceability, walkthrough, and readiness language;
- update airway behavior to hide unproven values;
- add the tie-only `rankDistanceNm` policy and all-Rank-1 presentation;
- accept, supersede, or reject `ADR-001` through `ADR-008`; and
- remove former intent/orchestrator/controller/attestor proposals from the
  challenge path.

A contradiction stops affected work until the higher-precedence artifact is
corrected and approved.

## 5. Selected POC architecture

### 5.1 Application and live-data topology

- React/Vite frontend and Fastify BFF remain separate source/build
  responsibilities and deploy in one non-root Linux image.
- Shared runtime contracts and pure route-domain packages have no React, HTTP,
  Azure, filesystem, secret, or uncontrolled-clock dependency.
- The Fastify server is the only CAAS client. It receives the API key through an
  Azure Key Vault-backed secret reference and never returns or logs it.
- At startup, the server performs bounded, allow-listed HTTPS GET requests to
  all five accepted endpoint families: Flight Plan, Airways, Fixes, Airports,
  and NAVAIDs. It validates/sanitizes every response, exercises the Airways
  contract without exposing its unproven values, builds one immutable in-memory
  generation, and becomes ready only after the complete generation is usable.
  Cold startup fails explicitly with `UPSTREAM_UNAVAILABLE` if any mandatory
  family cannot be acquired and validated.
- A user-triggered refresh builds a complete five-family generation separately
  and atomically swaps it only after validation. Failed refresh keeps the prior
  real generation only within Section 6 freshness/resource limits and reports
  its retrieval time and stale state.
- Refresh invalidates prior cursors/draft revision tokens. The UI warns before
  refresh and safely clears selections whose generation no longer exists.
- The process retains at most the active and immediately previous in-memory
  generation for 30 minutes to complete in-flight interactions, subject to the
  hard memory limit. Nothing persists across a restart.
- There is no synthetic mode, Blob snapshot store, publisher Job, mutable data
  pointer, Service Bus, orchestrator, controller fleet, or attestation service.
- Steady state has one active serving revision with `maxReplicas: 1` for that
  revision. Platform prewarming or rollout may create transient overlap; every
  generation-bound cursor, point reference, candidate ID, and draft token also
  binds to the application revision/generation, and cross-revision mismatches
  fail closed instead of mixing data.

If startup cannot acquire a valid real generation, the application reports
`UPSTREAM_UNAVAILABLE` and does not present test or synthetic records as real.

### 5.2 Azure topology

The POC contains only:

- one Azure Container Apps managed environment in one region;
- one Azure Container Apps application in that managed environment;
- one Azure Container Registry Basic registry;
- one Azure Key Vault Standard vault containing the CAAS key and the Entra
  authentication client-secret reference;
- one runtime user-assigned managed identity for Key Vault access and ACR pull;
- one distinct deployment user-assigned managed identity with a GitHub protected-
  environment federated credential and only registry-push/exact-app deployment
  permissions; it has no Key Vault data access or role-assignment permission;
- one single-tenant Microsoft Entra app registration plus Container Apps
  `authConfigs`, restricted through `allowedPrincipals.identities` to the user's
  object ID supplied outside Git;
- one Log Analytics/Azure Monitor path with the lowest supported retention and
  the cap in Section 6; and
- Bicep for the managed environment, app, runtime/deployment identities and
  federation, auth metadata, monitoring, budget alerts, access expiry, and
  teardown tags.

Entra authentication requires the tenant/issuer, application client ID,
application URL/redirect URI, client-secret setting, allowed audience, and
allowed user identity. A one-time bootstrap authority creates the app
registration and expiring secret. The secret is referenced through Key Vault,
never committed, rotated before expiry if the POC is retained, and deleted with
the app registration during teardown.

Bootstrap is an explicit dependency DAG rather than an app/FQDN cycle:

1. create the resource group and scoped budget/alerts, then complete required
   provider registration;
2. create ACR, the runtime identity, Key Vault with the CAAS secret reference,
   monitoring, and the managed environment; grant only required runtime
   pull/secret access;
3. create the distinct deployment user-assigned identity and repository/protected-
   environment federated credential, grant registry-push only, and verify an OIDC
   token can authenticate without reading secrets or assigning roles;
4. push the already verified OCI digest unchanged to ACR and verify the registry
   subject/referrers;
5. have the one-time bootstrap authority create the real Container App from that
   digest with external ingress disabled and without `authConfigs`; only after
   the app exists, grant the deployment identity update rights scoped to that
   exact app, then have the protected job idempotently apply/verify the same
   digest-bound configuration and obtain its stable FQDN;
6. create the user-auth Entra registration/secret for that FQDN, write the secret
   to Key Vault, and configure redirect URI/audience/provider/allowed principal
   and `authConfigs`; verify control-plane auth settings and internal readiness
   while ingress remains disabled, and obtain a valid app-audience token for the
   deployment identity as the authenticated-but-not-allowed negative principal;
   and
7. enable external ingress; first prove absent auth is rejected, then prove the
   deployment-identity token is denied, then run allowed-user browser/business/
   map checks. Disable ingress immediately on any failure before the app can be
   called known-good.

No placeholder image, temporary public app, or app-first circular dependency is
allowed. Unauthenticated requests are rejected/redirected by platform
authentication once ingress is enabled.

No Storage account, Container Apps Job, queue, private endpoint, VPN/Bastion,
Azure Firewall, WAF, public production environment, or second application
environment is planned.

Platform references:

- Container App and managed-environment Bicep: <https://learn.microsoft.com/en-us/azure/templates/microsoft.app/containerapps>
- Container Apps Entra authentication: <https://learn.microsoft.com/en-us/azure/container-apps/authentication-azure-active-directory>
- Container Apps `authConfigs`: <https://learn.microsoft.com/en-us/azure/templates/microsoft.app/containerapps/authconfigs>

### 5.3 Identity, network, and telemetry boundaries

- PR CI has no Azure login, OIDC token, CAAS key, or application secret.
- Artifact publication and direct POC deployment use separate protected OIDC
  jobs.
- The deployment identity can deploy only the exact POC app/configuration. It
  cannot assign RBAC, read secrets, write arbitrary registry content, or mutate
  unrelated resources.
- Deployment-identity creation, its repository/protected-environment federated
  credential, and initial role assignments are one-time bootstrap actions,
  separate from routine deployment and from the runtime secret-reading identity.
- The browser calls only the same-origin BFF; it never calls CAAS or an external
  map provider.
- The BFF HTTP client permits only the approved HTTPS hostname and exact GET
  path families, disables redirects, ignores proxy environment variables,
  bounds DNS/connection/read/total time, and rejects direct IP or alternate
  origin targets.
- To keep the POC topology minimal, network-level outbound filtering is not
  added. This is an explicit POC residual risk; production requires enforced
  egress before broader access.
- Logs and enabled platform categories are tested for the API key, restricted
  raw fields, callsigns, query strings, unbounded exceptions, and raw dependency
  URLs. Only bounded reason codes, counts, durations, generation IDs, and health
  states are emitted.

### 5.4 Route diagram decision

The POC uses a dependency-free SVG route diagram rather than Leaflet or external
raster/vector tiles. It consumes only the BFF's normalized route `segments`,
leg, and gap outputs; it draws no line for missing or unresolved portions and
shows a non-map state when no resolved geometry is returned. This preserves a
usable route-data path without sending user IP, viewport coordinates, flight
state, or URLs to a map provider.

No map-provider URL, attribution, tile cache, tile prefetch, tile fallback, or
cross-origin tile CSP allowance is part of the POC. Adding one later is an
explicit design change requiring provider contract evidence and privacy,
attribution, CSP, caching, no-prefetch, failure-behavior, and accessibility
validation before it can appear in this plan.

### 5.5 CI/CD and rollback

- PR jobs run format, lint, type, focused tests, build, dependency review, and
  secret scanning without cloud credentials.
- For the final-feature commit, secretless Linux CI builds once, scans the image,
  produces SBOM/provenance, signs it, and exports the exact digest as a retained
  OCI layout. It does not rebuild after this point and does not need Azure or ACR
  for `PG-03`.
- CI publishes a digest-bound offline verification bundle as a retained GitHub
  artifact: OCI layout/digest manifest, signature/certificate/bundle, SBOM,
  provenance, scan result, and policy metadata.
- `PG-03` downloads and verifies that bundle, loads/runs that exact OCI digest
  loopback-only, and records all local real-data, browser, accessibility,
  container, security, and performance checks against it. A separately built
  local image is not an equivalent gate subject.
- A protected no-checkout Phase 4 job first verifies the same offline bundle and
  OCI subject before Azure login. It obtains narrowly scoped OIDC, pushes the
  unchanged subject to private ACR, verifies that the registry digest and Cosign
  OCI referrer match the preverified bundle, and deploys only that digest.
- Health, single-user auth and identity-negative cases, five-family live upstream
  acquisition, browse-all/business flow, telemetry, and prohibited-field smoke
  run against the deployed revision.
- Before the first healthy deployment exists, failure keeps ingress disabled,
  deactivates/removes the failed candidate, and follows the teardown/abort path;
  it is not called rollback. For later deployments, rollback restores both the
  previous healthy revision and the versioned app-scoped configuration
  (`authConfigs`, ingress, identity, secret references, scale, environment, and
  allowed-principal/audience settings), then reruns smoke. External data is not
  rolled back; the restored process fetches current real data.
- Retained GitHub/Azure records plus the checked-in machine-decidable gate
  manifest are sufficient POC evidence. Independent attestation infrastructure
  is out of scope.

Cosign defaults to storing signatures in the image repository, so private-ACR
verification necessarily occurs after narrowly scoped registry authentication;
the offline bundle supplies the independent pre-login check:
<https://docs.sigstore.dev/cosign/system_config/registry_support/>.

## 6. Quantitative POC policy

These limits are intentionally conservative for the observed data volume and a
small one-user POC. Crossing a hard limit fails closed with a bounded error and
never silently truncates required results.

### 6.1 Upstream and data limits

| Surface | Limit |
|---|---:|
| HTTPS connect timeout | 5 seconds |
| Per-request total timeout | 30 seconds |
| Retry | One retry for `429` or retryable `5xx`, honoring bounded `Retry-After`; no retry for other `4xx` |
| Flight response | 10 MiB and 10,000 records |
| Airways response | 5 MiB and 100,000 names |
| Fixes response | 96 MiB and 500,000 records |
| Airports response | 32 MiB and 100,000 records |
| NAVAIDs response | 32 MiB and 100,000 records |
| Aggregate decoded reference records | 700,000 |
| Route elements per flight | 254 intermediate; 256 endpoint-inclusive occurrences |
| Same-endpoint candidates | 500; above this return `TOO_MANY_CANDIDATES` rather than truncate |
| Ambiguity page | 50 results |
| Ambiguity hard total | 500; above this require a narrower term |
| Browser request body | 64 KiB |
| Browser response | 2 MiB; use summary/detail pagination rather than truncate |

Raw response buffers are released after validation/index construction. Unknown
fields do not enter normalized DTOs.

### 6.2 Runtime and freshness limits

| Surface | Objective / hard limit |
|---|---|
| Container shape | 1 vCPU, 2 GiB memory |
| Configured serving replicas | `activeRevisionsMode: Single`; min 0 outside planned use, min 1 during demo, `maxReplicas: 1` per active revision |
| Transient rollout/platform replicas | Temporary old/new revision overlap or platform prewarming is permitted and monitored; it is not represented as a hard one-replica guarantee |
| Process resident memory | 1.5 GiB target ceiling; hard container limit 2 GiB |
| Cold startup to readiness | 120-second objective, 180-second hard deadline |
| Warm API requests | p95 <= 2 seconds, 5-second hard server deadline |
| Live flight generation freshness | fresh <= 5 minutes; stale warning after 5 minutes; unusable after 30 minutes |
| Reference generation freshness | fresh <= 24 hours; stale warning after 24 hours; unusable after 7 days |
| Retained in-memory generations | active plus one previous for at most 30 minutes and within memory limit |
| Visible routes simultaneously drawn | 10; all Rank 1 options remain listed and the user selects which to draw |
| Points rendered for one candidate | 256 occurrences plus gap boundaries |

Gate measurements use one declared clock and retained machine-readable output:
three clean cold starts must each reach readiness within 180 seconds; the
120-second value remains a reported objective. Warm latency uses at least 100
requests after 10 warmups, reports the nearest-rank p95 at index
`ceil(0.95 * n)`, requires p95 at most 2 seconds and every request at most 5
seconds. Container/cgroup resident memory is sampled at least once per second
through acquisition and the complete flow; observed peak is reported against the
1.5-GiB target and must remain below the 2-GiB hard limit without OOM/restart.
Every threshold records sample count, measured value, units, start/end time, and
artifact hash in the Section 8 manifest; an objective miss cannot be silently
reported as a pass.

Configured `maxReplicas: 1` is a steady-state/per-active-revision target,
not an absolute platform cap. Container Apps can temporarily prewarm replicas
during maintenance or revision rollout. Budget monitoring includes that brief
overlap, and only one revision serves traffic after cutover. Platform behavior:
<https://learn.microsoft.com/en-us/azure/container-apps/scale-app>.

A failed refresh retains the last usable real generation only within these
freshness limits. There is no synthetic fallback.

### 6.3 Deployment, cost, and lifetime limits

| Surface | Limit |
|---|---:|
| Deployment hard deadline | 10 minutes |
| Healthy revision + business smoke | 2 minutes after revision readiness |
| Abort threshold | 8 minutes without a healthy candidate revision |
| Code/config rollback objective | 5 minutes |
| Log ingestion cap | 0.1 GiB/day or the nearest lower supported cap |
| Azure POC governance ceiling | USD 50 forecast/actual-cost decision point; alerts do not enforce shutdown |
| Cost alert thresholds | USD 25, USD 37.50, and USD 45 |
| Region | `southeastasia`; authenticated discovery confirms region visibility and required resource-type/Consumption-profile metadata, subject to `Microsoft.App` registration during authorized Phase 4 bootstrap |
| Azure provisioning window | No earlier than 48 hours before the planned demonstration and only after `PG-03` plus explicit cloud-write authorization |
| Planned POC lifetime | Target teardown within 24 hours after demonstration; seven-day governance maximum requires explicit teardown or separately authorized retention |

Authenticated discovery selected `southeastasia` and confirmed the Consumption
workload profile plus required resource-type metadata. The subscription has no
existing budget. `Microsoft.App` is not registered; registration is deliberately
deferred to the authorized Phase 4 bootstrap after the local release candidate
passes `PG-03`.

A conservative seven-day retail-rate forecast assumes 1 vCPU/2 GiB is billed as
continuously active, uses no free grant, consumes the full 0.1 GiB/day log cap,
allows 10,000 Key Vault operations and 1 GiB of extra ACR storage, then adds 20%
contingency. The observed rates yield USD 34.66, below the USD 50 ceiling:

- Container Apps CPU: USD 20.5632;
- Container Apps memory: USD 4.8384;
- ACR Basic: USD 1.1662;
- log ingestion/retention: USD 2.1840;
- Key Vault and extra ACR storage allowance: USD 0.1300; and
- subtotal USD 28.8818; contingency total USD 34.6582.

Rates came from the Azure Retail Prices API on 2026-08-12:
<https://learn.microsoft.com/en-us/rest/api/cost-management/retail-prices/azure-retail-prices>.
Actual billing depends on account agreements, shared free grants, runtime, data
transfer, and meter changes. Azure budgets and cost alerts are delayed governance
signals, not transaction cutoffs; expiry tags likewise do not delete resources.
Before provisioning, at USD 45 forecast, or on any alert/estimate suggesting the
USD 50 ceiling may be crossed, stop new deployment work and request explicit
teardown or retention authority. Scheduled automatic deletion is out of scope
unless separately authorized, so the 24-hour target and seven-day maximum are
operator-enforced lifecycle decisions and must not be described as hard platform
controls.

If the selected service cannot enforce a technical cap, use the nearest safer
supported setting and document it. Governance limits that lack enforcement must
remain labeled as governance controls.

## 7. Review-remediation register

| ID | POC disposition | Required closure evidence | Gate |
|---|---|---|---|
| `PLAN-R-01` | Private admin topology removed. | Late Phase 4 Key Vault bootstrap/rotation steps and least-privilege app identity. | `PG-04` |
| `PLAN-R-02` | Continuous publisher/state machine removed. | Atomic in-process generation build/swap and failed-refresh retention tests. | `PG-03` |
| `PLAN-R-03` | Snapshot bootstrap pair removed. | First-deploy ingress-disabled abort/cleanup plus later known-good revision and full app-config rollback smoke. | `PG-04` |
| `PLAN-R-04` | Composite publication budget removed. | Section 6 timeouts, startup, deployment, smoke, and rollback tests. | `PG-03`, `PG-04` |
| `PLAN-R-05` | Lease/pointer serviceability removed. | Initial deployment abort threshold and, only after known-good state exists, revision plus app-config rollback. | `PG-04` |
| `PLAN-R-06` | Snapshot rollback ring removed. | Document that data is live/current and not rolled back with code. | `PG-00`, `PG-04` |
| `PLAN-R-07` | Intent/controller topology removed. | Exact-app OIDC, separate bootstrap, and negative permission tests. | `PG-04` |
| `PLAN-R-08` | Network firewall removed for POC. | Explicit residual risk plus strict application origin/path/redirect/proxy tests. | `PG-00`, `PG-04` |
| `PLAN-R-09` | Statistical promotion deferred. | Health/business smoke; telemetry unavailable is never called low traffic. | `PG-04`; `PG-PROD` |
| `PLAN-R-10` | Independent signer/sink removed. | Commit/digest/config-bound CI and Azure deployment records. | `PG-04` |
| `PLAN-R-11` | Token complexity minimized. | If lineage tokens remain, generation-stable retry/rotation tests. | `PG-03` |
| `PLAN-R-12` | Remains mandatory. | Deterministic ambiguity pagination/error; never silent truncation. | `PG-03` |
| `PLAN-R-13` | Blob retained-loader removed. | Active/previous in-memory generation count, bytes, memory, and admission tests. | `PG-03` |
| `PLAN-R-14` | Multi-epoch secret design removed. | Key Vault least privilege, rotation, revocation, and restart test. | `PG-04` |
| `PLAN-R-15` | Full platform inventory deferred. | Test every enabled POC log/category for prohibited fields and cap/retention. | `PG-04`; `PG-PROD` |
| `PLAN-R-16` | Remains mandatory in minimal form. | Stable `SRC`, `USR`, `AC`, decision, gate, and evidence references. | `PG-00`, `PG-05` |
| `PLAN-R-17` | POC profile fixed. | Local-first completion, late 48-hour Azure provisioning window, USD 50 governance ceiling/alerts, access expiry, 24-hour teardown target, and seven-day operator-enforced maximum with no false automatic-cutoff claim. DR/on-call is production-only. | `PG-00`, `PG-04`, `PG-05`; `PG-PROD` |
| `PLAN-R-18` | Remains mandatory. | Use `hasResolvableFiledRoute` and non-operational candidate wording. | `PG-00`, `PG-03` |

Removing a mechanism does not remove its underlying least-privilege, rollback,
redaction, or truthfulness obligation.

## 8. Delivery gates

### 8.1 Gate governance

The user is the sole POC decision authority. Gate records need no named-owner or
reviewer-audience matrix. `deploy/evidence-manifest.schema.json` is the checked-in
structural envelope; JSON Schema alone does not compare thresholds, discover
artifacts, enforce sample rules, or make a gate decision. `PG-00` is therefore a
human-reviewed exact-hash record whose policy subject is normative Section 8.2
of the reviewed plan: use `policyVersion` `PG-00/<plan-version>`, set
`policySha256` to that plan's full SHA-256, and set `evaluationMode` to
`human-reviewed-pg00`; validator fields are omitted. Before `PG-01` can pass,
`PLAN-1.3` must add a
versioned `deploy/poc-policy.yaml` check registry and semantic validator, retain
their hashes in every later manifest, and test the validator against contradictory
and incomplete records.

The policy maps each gate to its exact mandatory check IDs and one typed operator
(`equals`, `less-than-or-equal`, `greater-than-or-equal`,
`all-less-than-or-equal`, `set-equals`, `hash-equals`, or `manual-approval`). The
validator rejects missing, unknown, or duplicate checks; incompatible
expected/measured types or units; insufficient Section 6 samples; start/end time
inversion; unresolved or hash-mismatched artifacts; subject/environment drift;
expired exceptions; and open P0/P1 issues. It derives each check and gate result
from policy plus measurements and rejects a caller-supplied result that differs.
No gate from `PG-01` onward may pass from schema validation or command exit status
alone.

Each record binds gate ID, exact commit/OCI digest or document hash, environment,
procedure version, typed threshold, measured value/units/sample count, retained
artifact path plus SHA-256, derived result, exception/expiry, and failure
fallback. A gate passes only when the semantic validator resolves every mandatory
check against the one declared subject/environment and derives `pass`; human
UAT/authorization remains an explicit policy check rather than an inference.

| Gate | Outcome | Minimum evidence | Blocks |
|---|---|---|---|
| `PG-00` | Authorized POC plan | Section 8.2 packet at exact hashes and later explicit implementation authorization | All durable implementation |
| `PG-01` | Runnable baseline | Locked workspace, real-capture fixture policy, ignore contexts, secretless CI, README skeleton, and versioned evidence schema/policy/semantic-validator negative tests plus one-command verification | Product integration |
| `PG-02` | Local real-data vertical slice | Real API acquisition, search, duplicate selection, route resolution, map/table, visible gaps, non-root image, sanitized evidence | Remaining capabilities |
| `PG-03` | Local release candidate complete | The authoritative secretless-CI OCI digest passes complete loopback-only five-family live acquisition, browse-all, distance/ranking/edit/diff, automated a11y, container, security, and measured performance/restart/failure checks; no Azure resource required | Authorized late Azure POC bootstrap/deployment |
| `PG-04` | Deployable Azure POC | Unchanged `PG-03` digest, executable bootstrap DAG, OIDC deployment, single-user auth/identity negatives, live acquisition, monitoring/business smoke, explicit first-deploy abort evidence, and later revision plus app-config rollback drill | POC acceptance |
| `PG-05` | Demonstration ready | All `SRC`/`USR` acceptance, manual UAT/a11y, README/AI declaration, cost/teardown, timed walkthrough | Challenge completion |
| `PG-PROD` | Production authorized | Separate approved data/access, edge/egress, SLO/DR/on-call/cost/privacy and release evidence | Production traffic |
| `PG-LIFE` | Lifecycle controlled | Maintenance, expiry/access review, deprecation, and decommission | Long-term operation |

### 8.2 Minimum `PG-00` packet

`PG-00` passes only when:

1. the system design and ADRs incorporate every Section 2 decision;
2. real endpoint discovery confirms all five mandatory APIs, records whether
   airway semantics are proven, and retains a secret-free aggregate discovery
   manifest with a replay procedure, parser/validation rules, counts, sizes,
   timings, and response-hash locators but no raw records or credential;
3. the local-first one-app architecture, deferred Azure/Entra bootstrap plan,
   application-layer egress residual, single-user access design, OSM policy and
   client-IP/viewport disclosure, limits, budget, late provisioning window, and
   teardown policy are accepted; no materialized Azure or Entra resource is
   required for this gate;
4. stable acceptance IDs and traceability cover complete browse-all traversal,
   all five endpoint families, best-route ties, real-only operation, no staging,
   airway output exclusion, exact Airports/NAVAIDs resolution, POC deployment,
   and documentation;
5. the design, plan, ADRs, and documentation index are committed at exact hashes
   with no unresolved P0/P1; and
6. the user later explicitly authorizes implementation.

#### 8.2.1 `PG-00` execution record - 2026-08-12

The user authorized bounded, read-only discovery. The local `.env` variable
name was confirmed as `apikey`; its value was neither printed nor retained in
these documents. No raw upstream record, cloud resource, role assignment, app
registration, secret, or Git commit was created.

The discovery started at `2026-08-12T09:30:06Z`. Hashes below are the first 16
hexadecimal characters of the response-body SHA-256 and are evidence locators,
not stable upstream version identifiers. The same secret-free aggregates and
replay rules are retained in
[`docs/evidence/pg-00-live-api-discovery.json`](../../evidence/pg-00-live-api-discovery.json);
that manifest contains no host credential, raw record, or identifier list.

| Dataset / endpoint | Result | Bytes / records | Body hash | Later 30-second probe |
|---|---|---:|---|---:|
| Flight Plan `/flight-manager/displayAll` | `200`, `application/json; charset=utf-8` | 222,298 / 115 | `f4085e3c5227de9f` | 255 ms |
| Airways `/geopoints/list/airways` | `200`, `text/plain; charset=utf-8` JSON array | 66,243 / 9,319 | `df7bd82032bad47b` | 263 ms |
| Fixes `/geopoints/list/fixes` | `200`, `text/plain; charset=utf-8` JSON array | 5,655,307 / 247,419 | `704056054cc0d476` | 1,143 ms |
| Airports `/geopoints/list/airports` | `200`, `text/plain; charset=utf-8` JSON array | 288,573 / 13,175 | `28610a6ba7dcd4dc` | 149 ms |
| NAVAIDs `/geopoints/list/navaids` | `200`, `text/plain; charset=utf-8` JSON array | 206,841 / 10,195 | `e67f9537016aae0f` | 302 ms |

Bounded aggregate findings:

- all 270,789 Fix, Airport, and NAVAID records matched
  `IDENTIFIER (latitude,longitude)` and had valid coordinate ranges;
- Fixes had 210,905 unique identifiers, 12,230 duplicate-identifier groups,
  and maximum multiplicity 160; Airports had 13,175 unique identifiers and no
  duplicate group; NAVAIDs had 5,726 unique identifiers, 1,791 duplicate groups,
  and maximum multiplicity 32;
- 89 callsign groups existed; 24 were duplicated, with maximum multiplicity 4;
  67 endpoint pairs existed; 32 repeated, with at most 7 candidates for one pair;
- 59 flights contained 927 structured route elements, with at most 39 elements;
  all 59 sequences were unique and monotonic;
- of 891 designated route occurrences, Fixes matched 577, NAVAIDs matched 243,
  234 were NAVAID-only, 9 matched more than one dataset, and 80 remained
  unresolved; 13 additional elements carried direct coordinates and 23 lacked a
  position object;
- Airports matched all 115 departure identifiers and 114 of 115 destination
  identifiers; the one remaining destination stays unresolved;
- structured airway types were `DIRECT` (128), `NAMED` (776), `SID` (10), and
  `STAR` (13). An airway value appeared on 889 elements, but only 653 values
  occurred in the separate airway list, 236 did not, and route-text adjacency
  was inconsistent. This is insufficient proof of occurrence/leg semantics, so
  airway values remain hidden; and
- responses exposed no pagination metadata and the observed Flight response
  exposed no rate-limit/retry headers. Discovery did not deliberately induce
  throttling or failure and therefore makes no upstream quota claim.

The observations fit Section 6 without changing its hard limits: largest payload
5.66 MB versus a 96 MiB applicable cap; 270,789 aggregate reference records
versus 700,000; maximum route length 39 versus the 254 intermediate-element
cap; maximum same-endpoint population 7 versus 500; and maximum observed identifier
multiplicity 160 versus the 500 ambiguity hard total.

| `PG-00` packet item | Status on 2026-08-12 |
|---|---|
| Design and ADR reconciliation | Updated in system-design version `1.2-rc4`; independent exact-hash reviews of the corrected plan/design report no unresolved P0/P1. |
| Real endpoint discovery | Successful contracts are confirmed for Flight Plan, Airways, Fixes, Airports, and NAVAIDs. All five are mandatory generation inputs; Airways fetch/schema/count is exercised while values/types stay hidden. Secret-free aggregates/replay rules are retained in the linked JSON manifest. Deliberate throttle/fault probing was not authorized or performed; unobserved failure behavior is explicitly deferred to `PLAN-3.4` and is not claimed as discovered. |
| Topology, local-first path, OSM, egress, limits, budget, teardown | User-directed POC decisions are accepted. The authoritative CI OCI digest must pass complete loopback-only real-data container evidence before all Azure writes. Direct OSM requests disclose client IP and viewport tile coordinates; application-only egress remains an accepted POC residual and a production blocker. |
| Azure account, region, and provider/SKU availability | Authenticated read-only checks confirmed an enabled selected subscription (`sha256:3e361ecb94f7`), tenant (`sha256:d989279aec5b`), signed-in user (`sha256:3f223ecb4e07`), and two enabled visible subscriptions. `southeastasia` supports the required metadata. `Microsoft.App` is `NotRegistered`; `Microsoft.ManagedIdentity` and the other required providers are registered. Provider registration writes are deferred to authorized Phase 4 after `PG-03` and are not a `PG-00` prerequisite. |
| Cost and budget context | The conservative seven-day estimate is USD 34.66 with contingency and no free grants, below the USD 50 governance ceiling. The subscription has zero budgets. Azure is provisioned no earlier than 48 hours before the demo; alerts and all resources are created only in authorized Phase 4; teardown targets 24 hours after the demo. Alerts/tags do not enforce spend cutoff or deletion, so seven days is an operator-enforced maximum requiring explicit action. |
| Entra bootstrap inputs | Tenant and allowed-user identity are confirmed outside Git by the hashes above. App/client ID, redirect URI, Key Vault secret reference/expiry, and secret are intentionally deferred until the late Phase 4 bootstrap DAG obtains the real ingress-disabled app FQDN. They are `PG-04`, not `PG-00`, evidence. |
| Stable acceptance and traceability | POC acceptance IDs are recorded in Section 8.3 and the design reconciliation. Independent exact-hash review reports no unresolved P0/P1. |
| Exact-hash Git record | The documents are committed: the design/plan content at `341acd9`/`1d109f6`, the POC completion at `96bd1a9`, and the 2026-08-13 documentation-reconciliation edits on the `docs/reconcile-poc-documentation` branch. Whether the existing commits constitute the explicitly authorized exact-hash record required by design Section 0.7 remains the user's determination; documentation work does not grant that authority. |
| Implementation authorization | Open. This documentation-reconciliation request is not durable implementation authorization; a later explicit implementation request remains required per design Section 0.7. |

### 8.3 POC acceptance additions

- `AC-POC-LOCAL-01`: the authoritative secretless-CI OCI digest passes the
  complete loopback-only five-family real-data container gate, including focused
  capability, browse-all, resource, secret/telemetry, automated accessibility,
  restart, and failure checks before any Azure write.
- `AC-POC-BROWSE-01`: traverse the bounded flight-list cursor from first page to
  terminal cursor and prove every record in the active generation appears
  exactly once, with no duplicate, omission, silent truncation, or cursor reuse
  across a generation change; callsign search and duplicate selection remain
  directly exercised.
- `AC-POC-RANK-01`: list all Rank 1 candidates sharing the minimum
  `rankDistanceNm` under the exact label “Rank 1 by shortest modeled distance
  among complete candidates,” show provenance and modeled distance, and let the
  user choose; never label a candidate valid, recommended, safe, or cleared.
- `AC-POC-LIVE-01`: local and Azure POC flows acquire and validate real Flight
  Plan, Airways, Fixes, Airports, and NAVAIDs data through the real server
  adapter; cold startup fails if any family is unusable, failed refresh retains
  only a still-usable prior five-family generation, and no synthetic
  runtime/demo fallback exists.
- `AC-POC-DATA-01`: Airways fetch/schema/count validation is directly evidenced
  while its unproven values and types are absent from every UI/API DTO, log,
  signature, diff, geometry, completeness, and ranking output; Airports and
  NAVAIDs participate through exact ambiguity-preserving resolution. Evidence
  records the challenge-owner Airways graphical-topology variance rather than
  claiming literal airway display or inferring a relation.
- `AC-POC-MAP-01`: the dependency-free SVG route diagram renders only exact
  resolved segments, preserves visible gaps without connecting them, keeps
  Route Data usable when geometry is absent, and makes no cross-origin map or
  tile request.
- `AC-POC-SEC-01`: the browser never receives the CAAS key or raw upstream
  object; the accepted no-firewall residual and application allow-list tests are
  recorded.
- `AC-POC-REL-01`: unchanged-digest direct POC deployment, first-deploy
  ingress-disabled abort/cleanup, smoke, later prior-revision plus app-scoped
  configuration rollback, and current-live-data reacquisition meet Section 6.
- `AC-POC-DOC-01`: code structure, key concepts, build/test/deploy code, lessons
  learned, requested feedback, and separate two-week/production roadmaps appear
  in the README/walkthrough.

## 9. Planned repository map

```text
.
├── apps/
│   ├── api/src/{app,server,config,plugins,routes,upstream}/
│   └── web/src/{app,components,features,map,state,styles}/
├── packages/
│   ├── contracts/src/
│   ├── route-engine/src/
│   ├── upstream-caas/src/
│   ├── token-service/src/           # only if authenticated client state is retained
│   └── test-fixtures/src/captured-real/
├── tests/{contract,integration,e2e,performance,security,azure}/
├── infra/bicep/{modules,environments/poc}/
├── deploy/{poc-policy.yaml,evidence-manifest.schema.json}/
├── .github/workflows/
├── docs/{adr,architecture,data-use,evidence,operations,security,testing}/
├── docs/superpowers/{specs,plans}/
├── containers/application.Dockerfile
├── .env.example
├── .dockerignore
├── .gitignore
├── README.md
├── package.json
├── pnpm-lock.yaml
├── pnpm-workspace.yaml
└── tsconfig.base.json
```

Raw responses, keys, user `.env` files, downloaded logs, restricted evidence,
and browser traces containing live values are never tracked or copied into the
container context. Captured-real fixtures retain only fields needed to prove
contracts and use irreversible identifier substitutions while preserving the
observed schema and edge condition.

## 10. Phase matrix

| Phase | Workstream | Dependency | Exit |
|---|---|---|---|
| 0 | Real discovery, design/ADR reconciliation, POC authority | None | `PG-00` |
| 1 | Repository and quality baseline | `PG-00` | `PG-01` |
| 2 | Local real-data vertical slice | `PG-01` | `PG-02` |
| 3 | Authoritative CI OCI release candidate, ranking, editing, comparison, and hardening | `PG-02` | `PG-03` |
| 4 | Late authorized Azure bootstrap, exact-digest deployment, auth, and rollback | `PG-03` plus explicit cloud-write authorization | `PG-04` |
| 5 | Demonstration acceptance | `PG-04` | `PG-05` |
| 6 | Production hardening | Challenge accepted plus separate authority | `PG-PROD` |
| 7 | Maintenance and decommission | First Azure resource | `PG-LIFE` |

## 11. Phase 0 - Real discovery and design closure

### `PLAN-0.1` Verify real API contracts

Under an explicitly authorized read-only discovery exception:

- query Flight Plan, Airways, and Waypoints/fixes endpoints;
- probe Airports and NAVAIDs endpoints with the supplied key;
- record observed status/media type, aliases, pagination, size/count, IDs,
  duplicate callsigns, route grammar, coordinate validity, and ambiguity;
- record observed rate/retry headers and failures, but do not deliberately induce
  throttling or upstream faults during discovery; mark unobserved behavior unknown
  and defer bounded retry/failure implementation evidence to deterministic
  adapter tests in `PLAN-3.4` plus naturally occurring authorized live evidence;
- prove the airway-value relationship or mark it unproven and hidden;
- retain a secret-free aggregate JSON discovery manifest and human-readable
  replay procedure containing request method/path family, media/status, start
  time, bytes/counts/timings, response-hash locators, parser/validation rules,
  bounded aggregate findings, and the credential environment-variable name—but
  no credential, raw record, identifier list, or response body; and
- defer minimized irreversibly sanitized captured-real fixture production to
  `PLAN-1.1`; never commit raw responses or credentials.

### `PLAN-0.2` Update the system design and ADRs

Apply Sections 2, 4, 5, 6, and 8.3 to architecture, contracts, acceptance,
risks, traceability, walkthrough, readiness, and production separation. Accept,
supersede, or reject all proposed ADRs. Record exact document hashes.

### `PLAN-0.3` Confirm the fixed POC inputs

Record the selected Azure region and read-only availability evidence; retain the
out-of-Git tenant and allowed-user identity references; accept the future
single-user auth design, OSM policy/client-IP/viewport disclosure, strict
application-layer egress residual, USD 50 governance ceiling and non-enforcing
alert semantics, late provisioning window, operator-enforced seven-day maximum,
and teardown policy. Define but do not execute the Phase 4 provider, Key Vault,
Entra app/secret/redirect, budget, RBAC, and resource bootstrap DAG. No
materialized app/client ID, secret, budget, provider registration, or Azure
resource is required for `PG-00`. No separate named-owner or reviewer-audience
register is required.

### `PLAN-0.4` Independent re-review and authorization

Resolve every P0/P1. Accepted P2 items have a target gate and expiry. Obtain the
user's approval of exact design/ADR/plan hashes, then await a separate explicit
implementation request.

## 12. Phase 1 - Repository and quality baseline

### `PLAN-1.1` Bootstrap the locked workspace

Pin Node/pnpm, TypeScript, formatting/linting, Vitest, Playwright, package import
boundaries, `.gitignore`, `.dockerignore`, and secret-free `.env.example`.
Under the approved fixture policy, create minimized, irreversibly sanitized
captured-real fixtures from an authorized acquisition; preserve only required
schema/edge conditions and prove no key, raw identifier list, unnecessary field,
or source response remains. Application runtime requires real API credentials.
Tests default to those fixtures and pure numerical vectors, not a synthetic
application mode.

### `PLAN-1.2` Establish secretless CI

Run format, lint, typecheck, unit/contract tests, dependency review, secret scan,
and build on Linux. Add integration/E2E/container/IaC jobs as their surfaces
exist. Define the credential-free release-candidate job that builds once into a
retained digest-bound OCI layout and emits the Section 5.5 verification bundle;
that job becomes the sole image producer for `PG-03` and later deployment. Pin
actions by full commit. PR CI never logs in to Azure and never calls live CAAS
APIs.

### `PLAN-1.3` Create living documentation

Create the README skeleton, architecture diagram, documentation/evidence index,
adopt the pre-implementation `deploy/evidence-manifest.schema.json`, define the
versioned gate/check registry in `deploy/poc-policy.yaml`, and implement the
semantic validator specified in Section 8.1. Its negative fixtures must include
missing/duplicate/unknown checks, contradictory result/value, wrong subject,
insufficient samples, expired exceptions, reversed time, and artifact hash/path
failure. AI-use declaration, live-data setup, safety boundary, SVG route-diagram
capability boundary, and one-command validation contract follow. `PG-01` cannot pass until validator
and policy hashes are retained; claim only evidenced capabilities.

## 13. Phase 2 - Local real-data vertical slice

### `PLAN-2.1` Implement runtime contracts and real adapters

Write contract tests from captured-real fixtures, then implement bounded
allow-listed adapters for all five mandatory families: Flight Plan, Airways,
Fixes, Airports, and NAVAIDs. Validate and count Airways while excluding its
unproven values/types from product outputs. Airports resolve exact endpoint
identifiers and NAVAIDs participate in exact intermediate-point resolution.
Quarantine malformed records, discard unknown fields, release raw buffers, and
atomically publish only one complete five-family in-memory generation.

### `PLAN-2.2` Implement core route behavior

Test coordinate validation, SVG/GeoJSON coordinate order, endpoint handling,
strict point resolution, explicit gaps, Haversine oracles, antimeridian
rendering, canonical signatures, and generation-bound IDs. Never infer from
proximity or an airway name. Do not expose upstream airway values because Phase
0 did not prove a stable occurrence/directed-leg meaning.

### `PLAN-2.3` Implement the thin BFF

Add bounded cursor-based browse-all and callsign search/list, selection,
selected-route, point search, health, refresh, and exact-error endpoints. Browse
cursors bind to revision/generation and expose a terminal cursor; exact-once
validation reconciles the client-observed page count without inventing a server
total field. The browser never submits trusted coordinates, geometry, distance,
endpoints, provenance, or rank. Implement the Section 5.3 upstream allow-list
and Section 6 limits.

### `PLAN-2.4` Implement the thin accessible UI

Deliver complete browse-all, callsign search, duplicate disambiguation,
selection, SVG route diagram, route table, gap boundaries, loading/empty/error/
stale/no-geometry states, keyboard/focus behavior, and reduced-obstruction
basics. Render only normalized fields returned by the BFF and present absent
fields as unavailable; do not render a tile-failure state because this POC makes
no external tile requests. URLs contain no live flight identifiers, callsigns,
coordinates, tokens, or query state.

### `PLAN-2.5` Prove the local real-data slice

Run the application with the real API key in the local server environment and
prove all five family acquisitions, including Airways validation/count plus
output exclusion, through browse/search, selection, SVG route-diagram/table
display. Traverse browse-all from first to terminal cursor and prove that every
client-observed opaque flight ID appears exactly once with no duplicate or
cursor-loop. Retain only sanitized evidence. Build and smoke one
non-root, read-only-root-filesystem image. No synthetic records may appear if
cold acquisition fails; failed refresh may retain only a still-usable prior
complete generation.

## 14. Phase 3 - Ranking, editing, comparison, and hardening

### `PLAN-3.1` Implement candidate ranking and best-group presentation

Discover same-endpoint recorded candidates, deduplicate exact semantics, compute
full-precision distance and `rankDistanceNm`, assign competition rank, and list
all tied Rank 1 candidates together under the exact label “Rank 1 by shortest
modeled distance among complete candidates.” Show all remaining complete ranks
and incomplete diagnostics. Provenance, source time, retrieval time, and
persistent safety copy remain visible. Candidate labels/copy never use “valid”,
“recommended”, “safe”, “cleared”, or unqualified “best.”

### `PLAN-3.2` Implement local draft editing and comparison

Implement locked endpoints plus add/remove/reorder/reset for exact,
unambiguous reference points. The server computes draft legs, gaps, geometry,
and distance only when all points resolve exactly; the UI may show the modeled
distance delta from the selected recorded route when both values are available.
Ambiguous references fail closed until a generation-bound explicit-coordinate
selection protocol exists. Do not claim undo/redo, a full directed route diff,
or participation of a draft in recorded-candidate ranking without separately
implementing and testing those server contracts. The visible draft safety label
remains “Computationally complete; operational constraints not assessed.”

### `PLAN-3.3` Enforce generation, token, and quantitative policies

Bind cursors, point references, candidate IDs, and authenticated draft state to
the current in-memory generation. Implement active/previous admission, expiry,
refresh invalidation, Section 6 bytes/counts/timeouts/memory, deterministic
ambiguity pagination, and explicit too-many errors. If stateless lineage tokens
remain, test retry identity across key rotation.

### `PLAN-3.4` Complete focused POC tests

Required suites:

- unit/golden/property tests for parsers, resolution, Haversine, antimeridian,
  rank ties, local-draft validation and conditional server-computed delta,
  malformed inputs, and bounds;
- contract tests from sanitized captured-real responses for all five endpoint
  families, including Airways acceptance and downstream output exclusion;
- integration tests for BFF browse-all exact-once traversal, upstream failures,
  mandatory-family cold-start failure, refresh atomicity/retention, generation
  invalidation, and secret/output boundaries;
- deterministic E2E using captured-real fixtures for complete browsing, search,
  selection, SVG route diagram/table parity, ties, editing, gaps, keyboard, and
  no-geometry behavior;
- a separately authorized local live E2E proving the same flow and five-family
  acquisition against CAAS;
- accessibility checks for keyboard, focus/announcements, contrast/reflow,
  route table, and keyboard editing; and
- security checks for key/raw-field absence, limits, output encoding, headers,
  same-origin URL privacy, BFF-only browser egress, telemetry redaction, and
  dependency failures.

Captured-real fixtures support deterministic tests; they are not a runtime or
demo fallback.

### `PLAN-3.5` Prove the authoritative local release candidate

Freeze the final-feature commit and run the credential-free Linux CI image job
once. Verify and download its digest-bound OCI layout plus signature, SBOM,
provenance, scan, and policy bundle. Load and run that exact digest—not a local
rebuild—loopback-only with the real CAAS key injected at runtime, never copied
into the image or browser.

Against that subject, run `test:container`, `test:live`, `test:e2e`,
`test:a11y`, `test:performance`, and `test:security` as mapped in Section 18.
Directly evidence all five endpoint families, exact-once browse-all, complete
search/selection, exact resolution and gaps, all tied Rank 1 options, editing and
diff, OSM/non-map behavior, refresh/staleness, three clean restarts, Section 6
measurements, telemetry redaction, secret boundaries, and cold/refresh failure.
The image is non-root with a read-only root filesystem and the intended
1-vCPU/2-GiB limits. Every check writes the Section 8 manifest against the same
commit/digest and retained artifact hashes.

`PG-03` fails if any lane rebuilds or cannot identify that digest. It passes
before any Azure provider registration, Entra app/secret, budget, RBAC,
registry, vault, monitoring, managed environment, or Container App is created.

## 15. Phase 4 - Late authorized Azure POC deployment

### `PLAN-4.1` Verify the authoritative subject and late-bootstrap authority

Do not rebuild after `PG-03`. Reverify the retained OCI layout, signature,
SBOM/provenance, scan, policy metadata, manifest hashes, and absence of `.env`,
key, raw responses, and restricted fields. No Phase 4 cloud write starts before
`PG-03`, a planned demonstration within 48 hours, and explicit cloud-write
authorization.

Before opening that window, record a go/no-go preflight for the selected
subscription/tenant/region and the user's bootstrap/cleanup authority. Confirm,
without speculative writes, resource-name/quota availability and the ability to:
register `Microsoft.App`; create/delete the resource group and budgets; create
role assignments, ACR, Key Vault, monitoring, managed environment/app and
`authConfigs`; use the deployment identity as an authenticated token-bearing
principal intentionally excluded from `allowedPrincipals.identities`; push only the verified ACR subject; create/delete the Entra app,
credential, redirect/audience and the distinct federated deployment user-assigned
identity; write application secrets through the controlled bootstrap path and
revoke bootstrap write access afterward; and revoke all access during cleanup.
Define the CAAS-key-to-Key-Vault and generated-Entra-secret-to-Key-Vault paths so neither secret enters source, command arguments,
shell history, CI output, deployment parameters, or gate artifacts. Missing
capability, unresolved quota/name, forecast at or above USD 45, absent cleanup
authority, or less than the measured deployment/rollback buffer aborts and
reschedules before any write. The user/bootstrap authority owns foundation
creation, initial ingress-disabled app creation, exact-app role assignment, and
cleanup; the deployment identity has only ACR push until that app exists and
never owns RBAC.

### `PLAN-4.2` Execute the minimal Azure bootstrap DAG

After the `PLAN-4.1` checkpoint and explicit authorization, execute and record
this dependency order in `southeastasia`:

1. create the tagged resource group and its scoped budget/alerts, then register
   `Microsoft.App` and wait for registration;
2. create ACR Basic, the runtime managed identity, Key Vault and CAAS secret
   reference, bounded monitoring, and the Container Apps managed environment;
   grant only required runtime ACR pull and Key Vault secret-read rights;
3. create the distinct deployment user-assigned identity and its GitHub
   repository/protected-environment federated credential, grant it ACR push only,
   and prove OIDC authentication while secret read and role assignment remain
   denied;
4. have the protected no-checkout job verify the offline bundle before Azure
   login, obtain short-lived OIDC through that identity, push the unchanged
   `PG-03` OCI subject, and verify its registry digest and Cosign referrer;
5. have the one-time bootstrap authority create the real Container App from that
   digest with external ingress disabled and no `authConfigs`; after the exact
   app resource exists, grant the deployment identity only app-scoped update
   rights, have the protected job idempotently apply/verify that digest-bound
   configuration, pass revision/probe readiness, and obtain the FQDN;
6. create the single-tenant user-auth Entra app and expiring credential for that
   FQDN, write the credential directly to Key Vault, set redirect URI/audience/
   provider and `allowedPrincipals.identities`, create `authConfigs`, verify
   control-plane settings plus acquisition/telemetry readiness while ingress
   remains disabled, and obtain a valid app-audience token for the deployment
   identity while keeping it outside the allowed-principal list; and
7. enable external ingress; first prove absent auth is rejected, then prove the
   authenticated deployment identity is denied, then run the allowed-user full
   browse/map/table/edit/diff/OSM/non-map business smoke. Disable ingress
   immediately on any failure.

Review Bicep build/lint/policy and `what-if` before each write checkpoint.
Environment parameters contain no secret or committed tenant/user identifier.
No second environment, placeholder image, temporary public ingress, or circular
app-first dependency is allowed. Failure at any checkpoint stops descendants and
uses the recorded cleanup set for resources already created.

### `PLAN-4.3` Verify first deployment and its distinct abort path

The first deployment has no previous healthy revision and therefore cannot claim
rollback. While ingress is disabled, use reachable control-plane/revision/probe
signals to require readiness, successful bounded acquisition of all five
families, expected generation counts/health, telemetry/prohibited-field checks,
and `authConfigs` inspection within Section 6 deadlines. No pre-ingress claim is
made for browser, browse-all, map, edit, or OSM behavior.

Then enable ingress and immediately sequence fail-closed checks: (1) an
unauthenticated request must be rejected/redirected; (2) a valid app-audience
token for the deployment identity, which is absent from
`allowedPrincipals.identities`, must be denied; and (3) the allowed user runs the
full exact-once browse-all, Rank 1, map/table, edit/diff, OSM/non-map, live, and
external business smoke. Disable ingress at the first failure. Record the first
known-good revision and complete app-scoped configuration only after all three
stages pass.

If initial readiness, auth, live acquisition, or smoke fails, keep or return
ingress disabled, capture only sanitized diagnostics, deactivate or remove the
failed candidate, clear credentials, and either repair within the authorized
window or request teardown. This is initial-deployment abort/cleanup, not rollback, and it
blocks `PG-04`.

### `PLAN-4.4` Prove later revision and app-configuration rollback

After a known-good deployment exists, snapshot/version the exact digest and all
restorable app-scoped settings: ingress/traffic, revision mode, identity, Key
Vault references, environment variables, scale, probes, and the separate
`authConfigs` provider, redirect/audience, secret setting, and allowed-principal
configuration. Introduce a controlled non-serving candidate/configuration change
that contains no vulnerability or secret, trigger the abort path, and within five
minutes restore both the prior healthy revision and that full configuration.
Reacquire current five-family real data and rerun allowed-user, absent-auth,
deployment-identity-denied, browse/business, health, and telemetry smoke. State explicitly that external
CAAS data is not version-rolled back.

## 16. Phase 5 - Demonstration acceptance

### `PLAN-5.1` Complete manual accessibility and UAT

Run keyboard-only review, one named screen-reader/browser pairing, responsive
reflow, contrast/forced-colors, OSM/tile-failure non-map flow, and user UAT
against the exact deployed digest.

### `PLAN-5.2` Audit requirements

Enumerate every `SRC-*`, `USR-*`, applicable `AC-*`, `PLAN-R-*`, and gate.
Classify evidence as proved, contradicted, incomplete, indirect, or missing.
Continue work for every POC item not proved. Local tests cannot substitute for
real Azure deployment, live API behavior, manual accessibility, or UAT.

### `PLAN-5.3` Finalize documentation and walkthrough

README covers architecture/code structure, live APIs, route/distance/ranking
algorithms, limits, OSM policy, security residuals, tooling rationale, exact
local/build/test/deploy steps, rollback, limitations, production roadmap, and AI
use. Rehearse this fixed 20-minute walkthrough:

1. problem, safety boundary, architecture, and code structure - 2 minutes;
2. real API evidence, sanitization, live refresh, and limits - 2 minutes;
3. callsign search, duplicate selection, and real route map/table - 3 minutes;
4. gaps, hidden/unproven airway data, distance, Rank 1 ties, and user choice - 3 minutes;
5. edit copy and directed comparison - 3 minutes;
6. tests, accessibility/failure states, and build/test/deploy code - 3 minutes;
7. exact digest, direct Azure POC deployment, auth, and rollback - 2 minutes;
8. limitations, AI use, lessons learned, requested feedback, and separate
   two-week/production roadmaps - 2 minutes.

Reserve exactly 10 minutes for transitions and questions.

### `PLAN-5.4` Close or retain the POC

Record exact digest/config, actual cost, residual risks, previous healthy
revision, evidence manifest, access expiry, and teardown result/date. Target
teardown within 24 hours after the demonstration. At seven days, the
operator-enforced governance maximum requires explicit teardown approval or
separately authorized retention; neither tags nor budgets perform automatic
deletion. POC completion does not authorize production.

## 17. Production and lifecycle

`PG-PROD` remains separate and requires written data redistribution/privacy
authority, broader access decisions, network-enforced egress, edge/origin
protection, SLO/error budget, capacity/cost, on-call, retention/legal hold,
vulnerability SLAs, expanded accessibility/UAT, RTO/RPO, restore/DR, incident
response, and release authority. Production mechanisms are selected by a new
ADR; the POC architecture is not automatically production architecture.

Lifecycle tracking starts with the first Azure resource. Decommission disables
traffic, revokes OIDC/RBAC/secret access, preserves required evidence, deletes
resources, verifies no unintended cost/access remains, and records final
obligations. Destructive teardown always requires explicit approval.

## 18. Validation command matrix

Commands become valid only when their phase creates the corresponding script.

| Command | Scope | Required from |
|---|---|---|
| `pnpm format:check` | Markdown/code formatting | `PG-01` |
| `pnpm lint` | Lint and import boundaries | `PG-01` |
| `pnpm typecheck` | All TypeScript projects | `PG-01` |
| `pnpm test:unit` | Pure packages/components | `PG-02` |
| `pnpm test:property` | Route/parser invariants | `PG-02` |
| `pnpm test:contract` | Captured-real schemas/OpenAPI/providers | `PG-02` |
| `pnpm test:integration` | BFF/live-adapter stubs/generation/token boundaries | `PG-02`, expanded `PG-03` |
| `pnpm test:a11y` | Automated browser accessibility against declared subject | `PG-02`; authoritative OCI digest at `PG-03`; deployed smoke/manual review at `PG-05` |
| `pnpm test:e2e` | Deterministic captured-real browse/search/map/edit flow | `PG-02`; authoritative OCI digest at `PG-03` |
| `pnpm test:live` | Authorized five-family CAAS acquisition, Airways exclusion, browse-all and business flow | `PG-02`; authoritative OCI digest at `PG-03`; unchanged deployed digest at `PG-04` |
| `pnpm test:performance` | Section 6 startup/API/memory rules with retained measurements | authoritative OCI digest at `PG-03` |
| `pnpm test:security` | Sanitization, secrets, limits, OSM/privacy, telemetry and artifact boundaries | authoritative OCI digest at `PG-03`; deployed negatives at `PG-04` |
| `pnpm test:container` | Digest identity, non-root/read-only image, health/API/UI and limits | `PG-02`; authoritative OCI digest at `PG-03`; registry/deployed identity at `PG-04` |
| `pnpm bicep:check` | POC Bicep build/lint/policy | `PG-04` |
| `pnpm test:azure` | Bootstrap checkpoints, single-user/identity negatives, five-family live smoke, first-deploy abort, later revision+app-config rollback | `PG-04` |
| `pnpm test:evidence` | Schema plus policy/validator positive and adversarial records | `PG-01`, every later gate |
| `pnpm verify` | Every applicable secretless local/CI gate | Evolves by phase |

No command is reported as passed unless it ran against the exact subject, its
exit status and measured assertions passed, and its output/artifact hash was
inspected and entered in the gate manifest. From `PG-01`, the semantic validator
must derive the same result from the versioned policy; a supplied result is not
authoritative. Command success alone cannot satisfy manual authorization/UAT or
replace a missing threshold measurement. `pnpm verify` does not call live CAAS or Azure; live/cloud lanes are explicit and
separately authorized.

## 19. Requirement-to-phase traceability

| Requirement | Phases | Primary acceptance evidence |
|---|---|---|
| `SRC-01`, `SRC-02` | 2-5 | Exact-once browse-all, search/select/map/table; all tied Rank 1 options; complete/incomplete groups |
| `SRC-03` | 0, 2-5 | Real five-family discovery/acquisition, direct Airways validation/output-exclusion, exact waypoint-derived route graphics, and recorded user-approved airway-topology variance in local/Azure flows |
| `SRC-04` | 0-4 | Architecture/import boundaries and provider/consumer tests |
| `SRC-05` | 1-4 | Linux build, non-root image, container smoke |
| `SRC-06`, `USR-06`, `USR-07` | 1, 4-5 | Secretless CI, exact-digest direct Azure POC deploy, live smoke, rollback |
| `SRC-07` | 1, 5 | README and AI-use review |
| `SRC-08` | 0, 5 | Timed 20-minute walkthrough and 10-minute question budget |
| `USR-01` | 2-5 | Distance oracles, API/UI evidence |
| `USR-02` | 3-5 | Tie-key/ranking properties and all-Rank-1 chooser E2E |
| `USR-03` | 3-5 | Draft integrity, editing, and keyboard E2E |
| `USR-04` | 3-5 | Ordered/directed diff and comparison E2E |
| `USR-05` | 2-5 | Reduced-obstruction outcomes, fit/reflow tests, non-map parity |

## 20. Risks and accepted POC tradeoffs

| Risk | Likelihood / impact | Mitigation and fallback |
|---|---|---|
| Live CAAS is unavailable during demo | Medium / High | Show explicit upstream-unavailable or allowed-stale real state; no synthetic substitution; document restart/refresh. |
| API key is present in the BFF process | Medium / High | Key Vault reference, managed identity, browser isolation, logs/scans, exact host/path allow-list. |
| No network-enforced egress | Low-Medium / High | Explicit POC residual, disabled redirects/proxies, strict destination allow-list; production blocks without enforced egress. |
| Any mandatory endpoint family is unavailable | Medium / High | Cold startup fails explicitly; failed refresh retains only a still-usable prior complete five-family generation; no guessing, partial generation, or synthetic substitution. |
| Airway semantics unproven | High / Low | Fetch and validate the family for challenge conformance but hide airway values/types from every product output. |
| Exact geometry is unavailable or interrupted | Medium / Medium | Keep the affected route portion visibly unavailable or gapped in the SVG route diagram; do not interpolate or connect it. |
| Browser output exceeds normalized BFF fields | Low / High | Enforce DTO allow-lists and same-origin requests; verify no raw upstream, credentials, airway values/types, or invented fields reach the browser. |
| Large reference data exceeds 2 GiB | Medium / High | Section 6 hard limits, streaming/bounded parsing, release raw buffers, fail closed; resize only with explicit user approval. |
| One replica restarts and loses generation | Medium / Medium | Readiness waits for real reload; min 1 during demo; explicit unavailable state; no false cached data claim. |
| Rank 1 is interpreted as operational advice | Medium / High | Adjacent modeled-distance criterion, provenance, persistent safety warning, never use recommended/valid/cleared copy. |
| Direct-to-POC first deployment fails | Medium / Medium | Ingress remains disabled; deactivate/remove failed candidate and follow cleanup. Only later deployments may claim revision plus app-config rollback. |
| USD 50 ceiling or seven-day lifetime is approached | Low / Medium | Forecast checkpoints, alerts, tagged expiry, explicit stop-work at USD 45, and operator-approved teardown; do not claim automatic cutoff/deletion. |

## 21. Commit and review strategy

After implementation authorization, use focused commits:

1. accepted design/ADR/plan closure;
2. repository/toolchain/secretless CI baseline;
3. sanitized captured-real contracts and adapters;
4. route resolution/distance and thin BFF;
5. SVG route-diagram/table real-data vertical slice and local image;
6. Rank 1 ties, all candidates, draft, and comparison;
7. generation/limits/security hardening;
8. final image and supply-chain evidence;
9. minimal Azure POC Bicep and exact-digest CI/CD;
10. live POC acceptance, documentation, and evidence.

Never stage `.env`, keys, raw responses, live logs, browser traces with real
values, or unrelated generated artifacts.

## 22. Completion audit

Before any completion claim:

1. enumerate every `SRC-*`, `USR-*`, applicable `AC-*`, `AC-POC-*`,
   `PLAN-R-*`, and gate;
2. link each to exact code/IaC/docs and executed evidence;
3. verify evidence proves the requirement rather than a proxy;
4. classify each item as proved, contradicted, incomplete, indirect, or missing;
5. continue work for every item not proved;
6. confirm no key, raw response, restricted field, or unrelated artifact entered
   Git or image history;
7. distinguish deterministic captured-real tests, local live CAAS, Azure POC,
   manual accessibility/UAT, and external authorization evidence; and
8. obtain the user's acceptance of the deployed POC and residual risks.

For the current planning objective, completion means the system design and ADRs
are reconciled with this plan at exact hashes, real discovery closes the API and
airway decisions, an independent review passes, and the user explicitly
approves implementation. The reconciliation, discovery, and independent-review
conditions are met, and the local-first POC implementation now exists beneath
this plan. The user's explicit implementation authorization remains the
outstanding design Section 0.7 blocker, and no gate beyond the local
implementation is claimed as evidenced; the evidence requirements in this
section and Section 18 still define what each later gate requires.
