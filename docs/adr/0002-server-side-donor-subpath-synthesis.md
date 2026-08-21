# ADR-0002: Server-side donor-subpath synthesis

- **Status:** Accepted (owner direction 2026-08-18)
- **Decision authority:** User
- **Scope:** Challenge POC only; additive documentation capability, not production authorization
- **Review trigger:** Any change to synthesis join rules, bounds, provenance semantics, public DTOs, distance partitioning, neutrality, or privacy wording

## Context

A recorded route with unresolved or ambiguous gaps is complete as a source fact but incomplete as geometry. The owner direction of 2026-08-18 permits answering the question "could other flights in this data generation have observed geometry between these exact anchors?" without removing, replacing, or repairing the incomplete route. Client-side interpolation, fuzzy matching, and reconstructed topology were rejected: they would turn uncertainty into a false route and contradict the exact-resolution boundary of ADR-0001.

The feature is governed by the same evidence partition as ADR-0001: it is implemented, focused-tested locally, and documented additively. It creates no new upstream dataset, no persistence, and no redistribution surface.

## Decision

1. The owner direction of 2026-08-18 is binding: complete routes are never removed or replaced, and candidate geometry may be assembled only from contiguous forward gap-free coordinate slices observed on other flights in the same immutable data generation.
2. Assembly is server-side (`donor-subpath-v1`, `packages/route-engine/src/synthesis.ts`). The client never interpolates, reconstructs, or invents geometry; it renders only what the synthesis endpoint returns.
3. Joining requires exact reference identity or exact coordinate. A conflicted reference id (same identifier, different coordinates) is unjoinable with no coordinate fallback. Borrowed slices are forward-only (no reversal), contiguous (no gap-crossing), and never interpolated or fuzzy-matched.
4. Synthesis is strictly additive. Source routes, gaps, distances, signatures, comparisons, and ordering are never mutated; golden regression fixtures prove DTO byte-stability for unaffected surfaces.
5. The two new endpoints are POST-only and identifiers/tokens travel in request bodies, never URLs: `POST /api/v1/routes/synthesis` (`{flightId, cursor?}` → status, corridorCount, corridorsCovered, a bounded candidate page of at most `SYNTHESIS_PAGE = 5`, nextCursor) and `POST /api/v1/routes/source-occurrences` (`{proofId}` → the donor flight's observed occurrences for auditing). Both fail closed: synthesis statuses are `not-needed`, `full`, `ambiguous`, `partial`, `unavailable`, `over-limit`, and `candidate-limit-exceeded`; source-occurrences rejects forged, tampered, or cross-generation proofs with `PROOF_INVALID`.
6. Bounds are hard: at most `MAX_ROUTE_POINTS = 256` endpoint-inclusive points per candidate, at most `MAX_SYNTHESIS_CANDIDATES = 20` candidates, a 2 MiB browser response limit, and the standard 5-second warm-request deadline. At most `MAX_DONOR_PROVENANCE = 8` provenance entries are retained per deduplicated geometry; beyond that the aggregate carries `donorTruncated`.
7. Provenance is audit-grade but generation-bound. Each borrowed segment carries scoped HMAC proof tokens (`proofIds`) that resolve via `source-occurrences`; the token secret rotates per snapshot, so cross-generation or forged proofs fail closed (`PROOF_INVALID`).
8. Neutrality is mandatory. Candidates are never ranked, best-labelled, or shortest-labelled; deduplicated geometries aggregate donor counts only. This extends the comparison-without-a-winner contract of ADR-0001.
9. Distances partition into source-resolved and borrowed components. Any estimated total is labelled separately and is never a route suggestion; the separate statistical gap-distance annotation remains distinct from and is not synthesis.
10. Privacy posture: synthesis responses expose opaque tokens, borrowed geometry, distances, and aggregate donor counts only — never donor upstream identifiers, callsigns, or raw flight indices. Web rendering draws borrowed geometry dotted and recorded geometry solid, with sr-only copy, and the chooser is on-demand for incomplete routes only.

## Consequences

Incomplete routes remain visibly incomplete everywhere: source DTOs, gaps, completeness, comparison eligibility, ordering, and export semantics are unchanged. Synthesis adds a separate auditable surface whose every geometry statement resolves back to observed occurrences in the current generation. Fail-closed statuses and bounds mean a missing, ambiguous, oversized, or cross-generation case degrades to an explicit bounded answer rather than an invented route.

Pre-feature evidence remains historical and subject-bound; it does not prove synthesis behavior, and synthesis documentation does not upgrade older records. Test coverage includes engine/api/e2e/a11y/responsive suites, adversarial privacy negatives (`tests/adversarial/sec-r5-synthesis.test.ts`), performance checks `PERF-SYNTHESIS-INDEX-HARD` (≤1000 ms) and `PERF-SYNTHESIS-WARM-HARD` (p95 ≤5000 ms), and the honest live-lane aggregation `LIVE-SYNTHESIS-AGGREGATE` plus its container counterpart, which pass on bounded honest responses including zero synthesizable targets.

Any production extension — cross-generation donors, ranking, persistence, or broader access — requires a new decision. No production inference may be drawn from this ADR.
