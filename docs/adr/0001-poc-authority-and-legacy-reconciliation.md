# ADR-0001: Binding POC authority and legacy reconciliation

- **Status:** Accepted for the 2026-08-12 POC documentation boundary
- **Decision authority:** User
- **Scope:** Challenge POC only; not production authorization
- **Review trigger:** Any change to source-data semantics, public DTOs, trust boundaries, persistence, deployment topology, access audience, or safety wording

## Context

The existing system design contains a normative Section 0 followed by older architecture analysis. The older material discusses staging, immutable Blob snapshots, publisher and validator Jobs, pointers, reviewer roles, synthetic fixtures/fallbacks, multiple environments, controllers, attestors, and production promotion. Those mechanisms are useful historical hardening analysis but conflict with the accepted single-user local-first POC.

The retained PG-00 discovery proves only bounded read-only API observations. The repository does not evidence the application, tests, OCI subject, CI, Azure resources, or deployment. Documentation must therefore state implementation commitments without turning them into claims of completion.

## Decision

1. Section 0 of the existing system design is the binding POC authority. The implementation plan operationalizes it. The former later sections (3-29) were extracted verbatim on 2026-08-13 into the [historical archive](../superpowers/historical/2026-08-11-flight-route-explorer-design-legacy-sections-3-29.md); they remain historical production-hardening analysis, are non-normative for the POC, and are explicitly reconciled by this ADR, the POC boundary document, and the capability/gate matrix.
2. The POC is a private, single-user, real-data demonstration with no synthetic runtime/demo fallback, no staging environment, and no staging-to-production promotion.
3. The Fastify server is the only CAAS client and must acquire all five families: Flight Plan, Airways, Fixes, Airports, and NAVAIDs. It validates and sanitizes a complete in-memory generation and swaps refreshes atomically.
4. Airways is mandatory for fetch/schema/count conformance, but airway values/types remain hidden because occurrence/directed-leg semantics are unproven. No airway topology is inferred or claimed.
5. Exact point resolution preserves ambiguity and unresolved gaps. Haversine distance is descriptive only. Same-endpoint routes use selected-first immutable source order with canonical signature only as a deterministic final fallback; public preference fields and winner language are prohibited.
6. The POC has no database, Blob snapshot/pointer, publisher Job, queue, controller, attestor, or application data rollback. First Azure deployment failure is abort/cleanup; only later known-good code/config can roll back, followed by current-data reacquisition.
7. All feature work, live-data integration, image execution, debugging, and authoritative build proof are local/loopback-first. No Azure write occurs before exact-digest PG-03, the 48-hour demonstration window, go/no-go preflight, and explicit user authorization.
8. AI-assisted work is disclosed, but human understanding, source review, tests, and live validation remain authoritative.
9. After readiness, the client traverses every generation-bound overview cursor exactly once and shows every safe flight plus every available resolved component without a 10-route cap. Map, full list, callsign filter, HUD, and details share one `flightId`; exact overlaps use an explicit chooser.
10. Airport display names come only from the pinned 10,444-record OurAirports exact-ICAO bundle. The source is Public Domain/Unlicense, community-maintained, and not an official ICAO publication; manifest/checksum/deterministic generation/update/rollback controls are mandatory.

## Reconciliation table

| Older proposal | POC disposition | Replacement |
|---|---|---|
| Publisher/shadow validation/Blob/pointer | Rejected for POC | Server adapter plus complete in-memory generation |
| Container Apps Job/Service Bus/controller/attestor | Rejected for POC | One Container App target only, if Azure is later authorized |
| Staging and promotion | Superseded | Direct unchanged-digest private POC deployment |
| Reviewer-audience registry | Superseded | One explicitly allowed Entra user; no live redistribution without a Data Use Record |
| Synthetic runtime/demo fallback | Rejected | Real runtime data only; sanitized captures only in deterministic tests |
| Snapshot rollback | Superseded | First-deploy abort/cleanup; later revision and app-config rollback, then live reacquisition |
| Network-enforced egress | Deferred/accepted residual | Application-level allow-list now; enforced egress required for production |

## Consequences

The design remains historically complete without silently making legacy mechanisms implementation requirements. Operational state is intentionally process-local and lost on restart. Live data is current rather than snapshot-versioned, so code rollback does not restore old CAAS data. The minimal topology reduces POC complexity but does not meet the separate production gate.

A future production architecture requires a new decision for persistence, scale, egress, access, data redistribution, SLO/DR, and rollback semantics. No production decision may be inferred from this ADR.

## Amendment — master product authority (2026-08-16)

The [master product document](../product/master-product-document.md) is the source of truth for intended experience, product direction, personas, terminology, requirements, and priorities. This ADR's technical reconciliation, topology constraints, safety boundary, and evidence rules remain independently binding.

The 2026-08-16 comparison-without-a-winner, all-route overview, shared-selection, and governed airport-name decisions are now reconciled across the design, plan, public contracts, implementation, focused tests, current UAT procedure, and evidence rules. The former `AC-POC-RANK-01` contract is superseded by `AC-POC-COMPARE-01`. Historical/generated Rank-era evidence remains immutable and proves only its named older subject; documentation does not upgrade it.

Existing source documents remain retained for traceability; this amendment deletes or rewrites none of the original decision history.

## Evidence status

Observed: PG-00 aggregate discovery and documented read-only Azure capability checks. Implemented and focused-tested locally: neutral comparison, uncapped exact-once overview traversal, shared selection, tolerant gap projection, and governed airport-name enrichment. Retained older evidence remains subject-bound. Not evidenced by this amendment: revised live UAT, Azure writes, deployment, Azure rollback, or production approval.
