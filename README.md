# Flight Route Explorer

> **Status: implemented local-first POC.** The repository contains the Fastify BFF, React/Vite UI, five-family real-data adapter, route engine, offline tests, Linux container, and inert Azure artifacts. Secretless CI runs on pull requests and `master` (green at commit `0dec8aed`; see [What is evidenced now](#what-is-evidenced-now)). Azure resources, deployment, and rollback drills remain intentionally unevidenced and unauthorized; machine-executed UAT evidence is retained (`docs/testing/artifacts/`).

Flight Route Explorer is intended to be a private, single-user, non-operational decision-support demonstration. It visualizes recorded flight routes, resolves reference points exactly where possible, computes modeled great-circle distance, and lets a user compare a recorded route with a local draft. It does not file, dispatch, approve, clear, navigate, or recommend a route.

The [master product document](docs/product/master-product-document.md) is the source of truth for product direction, target experience, personas, terminology, and product priorities. Binding implementation obligations remain in [Section 0 of the system design](docs/superpowers/specs/2026-08-11-flight-route-explorer-design.md#0-normative-poc-reconciliation---2026-08-12); the former Sections 3-29 are preserved as a non-binding [historical archive](docs/superpowers/historical/2026-08-11-flight-route-explorer-design-legacy-sections-3-29.md). [Documentation index](docs/index.md) remains the repository entry point.

## Read this in order

1. [Master product document](docs/product/master-product-document.md)
2. [POC architecture and legacy reconciliation](docs/architecture/poc-boundary.md)
3. [Real CAAS data contract](docs/data-use/caas-contract.md)
4. [Airport-name reference governance](docs/data-use/airport-name-reference.md)
5. [Local operations and deferred Azure path](docs/operations/local-and-azure.md)
6. [Safety, secrets, and privacy boundary](docs/security/safety-and-secrets.md)
7. [Validation and evidence rules](docs/testing/evidence-and-validation.md)
8. [ADR: authority and superseded mechanisms](docs/adr/0001-poc-authority-and-legacy-reconciliation.md)

## What is evidenced now

The retained [PG-00 discovery manifest](docs/evidence/pg-00-live-api-discovery.json) records bounded, authenticated, read-only discovery performed on 2026-08-12. It contains aggregate response metadata and no credential, raw record, or identifier list:

| Family | Endpoint path | Observed response | Records | POC use |
|---|---|---:|---:|---|
| Flight Plan | `/flight-manager/displayAll` | `200`, JSON | 115 | Search, selection, recorded routes |
| Airways | `/geopoints/list/airways` | `200`, `text/plain` carrying JSON | 9,319 | Mandatory fetch, parse, schema/count validation; values hidden |
| Fixes | `/geopoints/list/fixes` | `200`, `text/plain` carrying JSON | 247,419 | Exact intermediate-point resolution |
| Airports | `/geopoints/list/airports` | `200`, `text/plain` carrying JSON | 13,175 | Exact departure/destination resolution |
| NAVAIDs | `/geopoints/list/navaids` | `200`, `text/plain` carrying JSON | 10,195 | Exact intermediate-point resolution |

All 270,789 reference records passed the bounded identifier/coordinate parser during discovery. Of 891 designated route occurrences, 80 were unresolved, 9 matched more than one reference family, and ambiguity is preserved. This proves the recorded discovery observation only; it does not prove future code, retry behavior, quotas, or deployment behavior.

### Retained local lane and measurement records

The validation lanes below are real commands with retained records under `docs/evidence/`. Each record binds the commit that produced it and is re-settled by `pnpm run verify`; superseded records are archived under `docs/evidence/archived/`. The CI-built OCI subject is now retained alongside the local candidate:

| Lane | Record | Result |
|---|---|---|
| Authorized live five-family run (tree `116a84d`) | [live-lane-116a84d608f3.json](docs/evidence/live-lane-116a84d608f3.json) | 5/5 checks pass; real acquisition, exact-once browse, refresh auth, secret excluded |
| Current loopback five-family lane (fixture-backed mechanics) | [loopback-lane-local-e965c728fe45.json](docs/evidence/loopback-lane-local-e965c728fe45.json) | 23/23 checks pass, including selected-first neutral source order, descriptive distance, no public preference fields, exact-once browse, refresh, fail-closed startup, restart, and airway exclusion |
| Loopback container lane (no credential, fail-closed boot) | [loopback-container-local-116a84d608f3.json](docs/evidence/loopback-container-local-116a84d608f3.json) | 7/7 checks pass; digest-pinned base, non-root, no secret env |
| Security measurement (hermetic) | [security-local-116a84d608f3.json](docs/evidence/security-local-116a84d608f3.json) | 8/8 pass; `SEC-PACKAGE-AUDIT` passed on the retained authorized networked audit (0 advisories, [dependency-audit-local.json](docs/security/dependency-audit-local.json)) |
| Performance measurement (fixture-backed loopback) | [performance-local-116a84d608f3.json](docs/evidence/performance-local-116a84d608f3.json) | 8/8 pass against the documented policy objectives; live/CI values pending |
| Workspace lint (import boundaries, script hygiene) | [lint-local-116a84d608f3.json](docs/evidence/lint-local-116a84d608f3.json) | 3/3 checks pass |
| Local OCI subject candidate | [oci-subject-local.json](docs/evidence/oci-subject-local.json) | Local digest `sha256:ec1624d8…`; the local build candidate for `PG-03` |
| Authoritative CI-built OCI subject (PR #39 merge ref `0962c7fe`) | [oci-digest-bundle-0962c7fedb67.json](docs/evidence/oci-digest-bundle-0962c7fedb67.json) | CI digest `sha256:ae5dc6d1…`; all image assertions pass; CI Trivy scan 0 HIGH/CRITICAL ([report](docs/security/trivy-scan-ci-0962c7fe.json)) |
| Exact-subject real-data container run | [container-live-lane-afe29166ac21.json](docs/evidence/container-live-lane-afe29166ac21.json) | 5/5 checks pass on the exact CI digest (liveness, five-family acquisition, browse exact-once, secret exclusion); **the `PG-03` gate manifest now records `pass`** |

Current focused validation includes 17 accessibility tests, 28 synchronized overview/keyboard interaction tests, 4 exact-once client overview traversal tests, 29 API tests (including 4 airport-bundle governance tests), 30 route-safety/runtime/API-contract tests, and 8 responsive tests. The new fixture-backed loopback record passes 23/23. Broader retained records remain subject-bound as described in the [POC capability and gate-status matrix](docs/status/poc-capability-and-gate-matrix.md).

## Binding implementation contract

- The Fastify server is the only CAAS client. The browser calls same-origin application APIs, never CAAS directly.
- Runtime acquisition uses bounded, allow-listed HTTPS `GET`s for all five families: Flight Plan, Airways, Fixes, Airports, and NAVAIDs.
- Every response is validated and sanitized into an immutable complete in-memory generation. Startup fails explicitly if any mandatory family is unusable. Refresh builds separately and swaps atomically only after complete validation.
- Keep at most the active and immediately previous generation for the defined freshness window; nothing persists across restart. Generation-bound cursors, point references, candidate IDs, and draft tokens fail closed after invalidation.
- Use exact reference resolution. Preserve duplicate matches and unresolved positions as explicit ambiguity/gaps; never infer by proximity.
- Use full-precision Haversine totals with `R = 3440.065 NM`; display distance to `0.1 NM`. Modeled distance is descriptive only. Public DTOs never emit `rank`, `rankDistanceNm`, `rankLabel`, or `operationalProxy`; the default route order is selected-first, then immutable source order, with canonical signature only as a deterministic final fallback.
- Airways must be fetched, parsed, counted, and validated, but its unproven values/types must not appear in API/UI output, logs, signatures, diffs, geometry, completeness, or route comparison. The POC draws routes from exact resolved waypoint/reference coordinates, not inferred airway topology.
- The ready UI traverses every generation-bound overview cursor exactly once and shows every safe flight plus every available resolved route component, with no 10-route cap. Map, full list, callsign filter, HUD, and details share one selected `flightId`; overlapping identical paths use an explicit chooser and the list remains the keyboard-equivalent path.
- Airport endpoints use `Full Airport Name (ICAO)` with `Name unavailable (ICAO)` fallback. Names come only from the bundled OurAirports exact-ICAO reference pinned at commit `be07e33e6cc10087f57064f2bb3fccfcd39f5801` (10,444 records, Public Domain/Unlicense, community-maintained and not an official ICAO publication); there is no fuzzy, proximity, generated-code, or runtime third-party lookup.
- The implementation renders OpenStreetMap raster tiles under a dependency-free Web Mercator tile layer (owner-authorized 2026-08-15, design §0.5). Tile URLs carry `{z}/{x}/{y}` only with `no-referrer` requests, the OSM attribution is shown, the CSP allows only `https://tile.openstreetmap.org` for images, and zoom is bounded 1-19 with at most 64 tiles per frame. If tiles fail or are toggled off, the schematic base map renders and route data remains usable without tile availability.
- The persistent safety copy is: **“Demonstration only. Operational weather, NOTAM, ATC, fuel, aircraft suitability, and regulatory constraints are not evaluated.”** Do not call a candidate valid, recommended, safe, cleared, or unqualified “best.”

## Repository and implementation shape

The current tree contains the root `pnpm` workspace, the implemented `apps/api`, `apps/web`, `packages/contracts`, `packages/route-engine`, `packages/upstream-caas`, and `tests` packages, plus validation, container, and inert Azure artifacts.

The intended separation is:

```text
apps/api/                 Fastify BFF and live five-family adapter
apps/web/                 React/Vite map-first UI
packages/contracts/       Runtime/public DTOs and schemas
packages/route-engine/    Exact resolution, descriptive distance, local-variation validation, delta logic
packages/upstream-caas/  Allow-listed upstream clients and sanitizers
tests/                    Unit, contract, integration, E2E, a11y, security, live lanes
docs/                     Binding decisions, data-use, operations, security, evidence
```

Frontend and backend remain separate source/build responsibilities even though the target POC packages them into one non-root Linux image. There is no database, Blob snapshot store, publisher Job, Service Bus, mutable pointer, controller, attestor, or staging environment in the binding POC.

## Local Linux workflow

The currently checked-in root metadata pins Node `>=22.22.2` and `pnpm@11.5.2`. Commands below are local setup or currently declared scaffold commands; no command should be described as passed until its output, subject, measurements, and artifact hash are retained in a gate manifest.

```bash
# Confirm the workspace is the intended checkout.
pwd
git status --short

# Use the pinned package manager and install from the lockfile.
corepack prepare pnpm@11.5.2 --activate
pnpm install --frozen-lockfile

# Create an untracked local environment file; never paste the key in a command,
# URL, source file, image build context, shell history, or retained output.
cp .env.example .env
$EDITOR .env

# Current scaffold validation entry points.
pnpm run validate:config
pnpm run typecheck
pnpm run validate
```

`pnpm run validate:config` checks root JSON/YAML/TypeScript configuration and the placeholder environment contract. `pnpm run validate` runs configuration and policy validation, workspace typechecks, package tests, the offline suite, evidence validation, lint, and the Linux container smoke lane. `pnpm run build` builds the Vite UI and backend/package TypeScript outputs. The real-data lane is intentionally separate from offline validation and requires the ignored local `.env` credential.

The named lanes in the plan are now implemented commands on this tree: `test:offline` (214 tests), `test:adversarial` (17 tests), `test:a11y`, `test:e2e`, `test:responsive`, `test:integration` (loopback lane), `test:security`, `test:performance`, `test:container`, `test:evidence`, `test:live` (executed in authorized runs with retained records), `oci:build`/`oci:verify`, and `verify`. The plan's `test:unit` and `test:property` names do not exist as commands; unit- and property-style coverage lives in the offline suite and package tests. A command counts as passed only when its retained record includes the exact subject, result, measurements, and artifact hashes, per [validation and evidence](docs/testing/evidence-and-validation.md).

## Azure write boundary

Routine work is local and loopback-only. **No Azure provider registration, Entra application/secret, budget, RBAC assignment, registry, vault, monitoring resource, managed environment, or Container App may be created during implementation or documentation work.** The authoritative secretless Linux CI OCI subject must first pass the complete loopback-only real-data `PG-03` gate. Only after that gate, a demonstration planned within 48 hours, a go/no-go capability check, and explicit user authorization may the late Azure POC bootstrap begin.

There is no staging-to-production promotion. The unchanged verified digest is pushed directly to one private, single-user POC. First deployment has no rollback target: keep ingress disabled and abort/deactivate/clean up on failure. Only after a known-good deployment exists may a later revision restore the prior revision plus complete app-scoped configuration; external CAAS data is reacquired and is never rolled back as a snapshot.

No Azure deployment, authentication configuration, rollback drill, UAT, or teardown is evidenced today. The authorized release path is defined as operator procedures: [Azure release path](docs/operations/azure-release-path.md), [go/no-go preflight](docs/operations/azure-preflight-and-bootstrap.md), [deployment procedure](docs/operations/azure-deployment-procedure.md), [abort and rollback drills](docs/operations/azure-abort-and-rollback-drills.md), and [post-demo verification](docs/operations/azure-post-demo-verification.md); see [operations](docs/operations/local-and-azure.md) for the read-only preflight and stop conditions.

## AI use

AI-assisted tools were used for requirements analysis, design exploration, implementation support, test-case generation, and review. Human understanding and source review remain authoritative. Any future implementation must be covered by automated tests and authorized live validation, and a walkthrough must explain algorithms and limitations without treating AI output as authority.

## Known limitations and evidence boundary

The discovery record confirms successful responses only. It did not deliberately induce throttling or upstream failures, observed no pagination metadata or Flight response rate-limit/retry headers, and makes no quota, retry, or failure-behavior claim. An executed Challenge Data Use Record is present ([docs/data-use/data-use-record.md](docs/data-use/data-use-record.md), filled by the owner decision of 2026-08-15) with the [authorization gate](docs/data-use/data-use-authorization-gate.md) status `AUTHORIZED` ([status artifact](docs/data-use/data-use-authorization-gate-status.yaml)); beyond the record's decisions, HTTP `200` and possession of a key do not authorize reviewer redistribution of live CAAS-derived data.

Historical/generated evidence is immutable audit history. Records that contain the superseded Rank-era checks prove only their named older subject and contract; they do not prove the current neutral comparison, all-route overview, or airport-name bundle. Current claims require current tests or a new subject-bound record such as `loopback-lane-local-e965c728fe45.json`.

`PG-03` has passed on the exact CI-built subject: the container live lane
(`scripts/validation/container-live-lane.mjs`) ran the CI image
(`sha256:ae5dc6d1…`) loopback-only with real CAAS data — 5/5 checks — and the
gate manifest records `pass` (4/4 checks). Not evidenced: Azure resources,
deployment, or rollback drills. Machine-executed UAT evidence is retained
(`docs/testing/artifacts/`, 16/16 rows in Chrome/Chromium/WebKit); the live
20-minute walkthrough has not been run. Secretless CI runs on pull requests
and `master` and is green at commit `0dec8aed`: `ci-secretless-validation`
(offline evidence validation, Semgrep, gitleaks secret scan, dependency
audit), `oci-subject-build` (image assertions + Trivy), and `POC deployment
artifact validation`; the CI-built subject digest is retained at
[docs/evidence/oci-digest-bundle-0962c7fedb67.json](docs/evidence/oci-digest-bundle-0962c7fedb67.json).
Production intent is declined by the owner (2026-08-15, issues #32–#34 closed
out of scope): the project remains a private, non-operational local-first POC
and production remains prohibited.
