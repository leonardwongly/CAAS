# Flight Route Explorer

> **Status: implemented local-first POC.** The repository contains the Fastify BFF, React/Vite UI, five-family real-data adapter, route engine, offline tests, Linux container, and inert Azure artifacts. Azure resources, deployment, CI, and UAT remain intentionally unevidenced and unauthorized.

Flight Route Explorer is intended to be a private, single-user, non-operational decision-support demonstration. It visualizes recorded flight routes, resolves reference points exactly where possible, computes modeled great-circle distance, and lets a user compare a recorded route with a local draft. It does not file, dispatch, approve, clear, navigate, or recommend a route.

The binding POC rules are in [Section 0 of the system design](docs/superpowers/specs/2026-08-11-flight-route-explorer-design.md#0-normative-poc-reconciliation---2026-08-12). The existing design and plan are not modified by this documentation set. [Documentation index](docs/index.md) remains the repository entry point.

## Read this in order

1. [POC architecture and legacy reconciliation](docs/architecture/poc-boundary.md)
2. [Real CAAS data contract](docs/data-use/caas-contract.md)
3. [Local operations and deferred Azure path](docs/operations/local-and-azure.md)
4. [Safety, secrets, and privacy boundary](docs/security/safety-and-secrets.md)
5. [Validation and evidence rules](docs/testing/evidence-and-validation.md)
6. [ADR: authority and superseded mechanisms](docs/adr/0001-poc-authority-and-legacy-reconciliation.md)

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

## Binding implementation contract

- The Fastify server is the only CAAS client. The browser calls same-origin application APIs, never CAAS directly.
- Runtime acquisition uses bounded, allow-listed HTTPS `GET`s for all five families: Flight Plan, Airways, Fixes, Airports, and NAVAIDs.
- Every response is validated and sanitized into an immutable complete in-memory generation. Startup fails explicitly if any mandatory family is unusable. Refresh builds separately and swaps atomically only after complete validation.
- Keep at most the active and immediately previous generation for the defined freshness window; nothing persists across restart. Generation-bound cursors, point references, candidate IDs, and draft tokens fail closed after invalidation.
- Use exact reference resolution. Preserve duplicate matches and unresolved positions as explicit ambiguity/gaps; never infer by proximity.
- Use full-precision Haversine totals with `R = 3440.065 NM`. For competition equality only, round the total to `0.000001 NM` as `rankDistanceNm`; display distance to `0.1 NM`. Show every tied first-place candidate under exactly: **“Rank 1 by shortest modeled distance among complete candidates.”**
- Airways must be fetched, parsed, counted, and validated, but its unproven values/types must not appear in API/UI output, logs, signatures, diffs, geometry, completeness, or ranking. The POC draws selected routes from exact resolved waypoint/reference coordinates, not inferred airway topology.
- The implementation uses a dependency-free SVG route diagram with no external map tiles or map-provider API key. This is a deliberate local-first POC variance from the design's configurable Leaflet/OpenStreetMap option; route data remains usable without tile availability.
- The persistent safety copy is: **“Demonstration only. Operational weather, NOTAM, ATC, fuel, aircraft suitability, and regulatory constraints are not evaluated.”** Do not call a candidate valid, recommended, safe, cleared, or unqualified “best.”

## Repository and implementation shape

The current tree contains the root `pnpm` workspace, the implemented `apps/api`, `apps/web`, `packages/contracts`, `packages/route-engine`, `packages/upstream-caas`, and `tests` packages, plus validation, container, and inert Azure artifacts.

The intended separation is:

```text
apps/api/                 Fastify BFF and live five-family adapter
apps/web/                 React/Vite map-first UI
packages/contracts/       Runtime/public DTOs and schemas
packages/route-engine/    Exact resolution, distance, ranking, local-draft validation, delta logic
packages/upstream-caas/  Allow-listed upstream clients and sanitizers
tests/                    Unit, contract, integration, E2E, a11y, security, live lanes
docs/                     Binding decisions, data-use, operations, security, evidence
```

Frontend and backend remain separate source/build responsibilities even though the target POC packages them into one non-root Linux image. There is no database, Blob snapshot store, publisher Job, Service Bus, mutable pointer, controller, attestor, or staging environment in the binding POC.

## Local Linux workflow

The currently checked-in root metadata pins Node `>=22.14.0` and `pnpm@11.5.2`. Commands below are local setup or currently declared scaffold commands; no command should be described as passed until its output, subject, measurements, and artifact hash are retained in a gate manifest.

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

`pnpm run validate:config` checks root JSON/YAML/TypeScript configuration and the placeholder environment contract. `pnpm run validate` runs configuration and policy validation, workspace typechecks, package tests, offline checks, and the Linux container smoke lane. `pnpm run build` builds the Vite UI and backend/package TypeScript outputs. The real-data lane is intentionally separate from offline validation and requires the ignored local `.env` credential.

The future implementation plan names additional lanes (`pnpm test:unit`, `test:property`, `test:contract`, `test:integration`, `test:a11y`, `test:e2e`, `test:live`, `test:performance`, `test:security`, `test:container`, `test:evidence`, `pnpm verify`, and Linux image commands). They are documented in [validation and evidence](docs/testing/evidence-and-validation.md) as planned contracts, not as commands that currently pass.

## Azure write boundary

Routine work is local and loopback-only. **No Azure provider registration, Entra application/secret, budget, RBAC assignment, registry, vault, monitoring resource, managed environment, or Container App may be created during implementation or documentation work.** The authoritative secretless Linux CI OCI subject must first pass the complete loopback-only real-data `PG-03` gate. Only after that gate, a demonstration planned within 48 hours, a go/no-go capability check, and explicit user authorization may the late Azure POC bootstrap begin.

There is no staging-to-production promotion. The unchanged verified digest is pushed directly to one private, single-user POC. First deployment has no rollback target: keep ingress disabled and abort/deactivate/clean up on failure. Only after a known-good deployment exists may a later revision restore the prior revision plus complete app-scoped configuration; external CAAS data is reacquired and is never rolled back as a snapshot.

No Azure deployment, authentication configuration, rollback drill, UAT, or teardown is evidenced today. See [operations](docs/operations/local-and-azure.md) for the read-only preflight and stop conditions.

## AI use

AI-assisted tools were used for requirements analysis, design exploration, implementation support, test-case generation, and review. Human understanding and source review remain authoritative. Any future implementation must be covered by automated tests and authorized live validation, and a walkthrough must explain algorithms and limitations without treating AI output as authority.

## Known limitations and evidence boundary

The discovery record confirms successful responses only. It did not deliberately induce throttling or upstream failures, observed no pagination metadata or Flight response rate-limit/retry headers, and makes no quota, retry, or failure-behavior claim. No Challenge Data Use Record is present, so HTTP `200` and possession of a key do not authorize reviewer redistribution of live CAAS-derived data.

Not evidenced: authoritative CI OCI digest, CI execution, automated accessibility/security/performance gates, Azure, deployment, rollback, UAT, or production approval. The local implementation is a non-operational demonstration only; public or broad organizational use remains prohibited until the separate production gate is approved.
