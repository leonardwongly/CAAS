# POC interaction exclusions

## Authority

This document records deliberate interaction exclusions for the POC flight
route explorer. Each exclusion names what is excluded, why (safety or scope),
the acceptance evidence that keeps it excluded, the gate that would permit
re-entry, and the binding rules it must respect if ever re-entered. It is a
design commitment, not evidence. It complements the [POC boundary
document](poc-boundary.md), ADR-001, and binding design Section 0 (normative
reconciliation, 2026-08-12); Section 0.4 governs ranking and presentation and
is referenced throughout.

## The interaction that is included, to bound the exclusions

The POC supports exactly these interactions with routes and drafts:

1. **Browse and select** a recorded flight; display its recorded route.
2. **Draft** a local route (origin, destination, via waypoints) in the editor.
3. **Resolve** every draft waypoint exactly. Ambiguous references (multiple
   exact matches for the same identifier) fail closed until the user makes a
   generation-bound explicit selection from the bounded choices the server
   issued; the selection binds to the active generation and is rejected if
   stale, forged, tampered, or mismatched. Missing references remain gaps.
4. **Compare** one recorded route (baseline) against one local draft (target)
   when both operands are complete, reporting the directed difference of
   modeled distance totals at full precision. A draft may be supplied inline
   or by a server-issued in-memory draft id scoped to the active generation
   (see Section 6).
5. **Rank** complete same-endpoint recorded candidates by
   `rankDistanceNm` at `0.000001 NM`; incomplete candidates stay visible but
   unranked; all tied Rank 1 candidates are presented together under the only
   qualified label.

Everything else that a route editor might offer — undo/redo, draft ranking,
inferred topology, recorded-vs-recorded diff, a full directed diff, or draft
persistence across sessions — is deliberately excluded below.

## 1. Undo and redo

**Exclusion.** No undo or redo history for any editing or selection action in
the POC web client, and no server-side edit-history endpoint.

**Reason — safety.** Undo implies retained mutable editor state across
interactions: a stack of prior draft snapshots, selection tokens that may
belong to earlier generations, and reapplication of stale references. The POC
binds every explicit selection to the generation that issued it
(`GENERATION_EXPIRED` on refresh, `SELECTION_MISMATCH` on reference change,
fail-closed `INVALID_DRAFT` on shape violation). A history mechanism would
either replay selections against newer generations (a stale-selection hazard)
or require persisting generation-bound state across time. Neither is
acceptable for a demonstration that must never weaken the binding rules; the
cost is a harmless refresh or re-entry of the draft.

**Acceptance evidence keeping it excluded.** The web client has no undo/redo
UI (no undo/redo identifiers or commands in `apps/web/src`), no history API
exists in `apps/api/src/server.ts`, and the offline suites pin the
generation-bound selection protocol: forged, tampered, stale, and mismatched
selection tokens fail closed (400 `TOKEN_INVALID`, 409 `SELECTION_MISMATCH`,
410 `GENERATION_EXPIRED`) in
`tests/route-safety/explicit-selection.test.ts`, and the client never supplies
coordinates (selection body carries references plus server-issued tokens only,
pinned in `tests/route-safety/web-copy.test.ts`). Any undo/redo feature would
contradict those pinned behaviors and is caught by the same suites.

**Re-entry gate.** A future scope decision may add a *generation-fresh* edit
history (e.g., re-typing the draft with the current generation's tokens) under
a separate acceptance criterion. Re-entry must preserve every binding rule:
history entries never carry coordinates, never resolve by proximity, and
expire with their generation.

## 2. Draft ranking

**Exclusion.** Locally edited drafts are never ranked into the recorded-
candidate population, never receive a rank or the qualified Rank 1 label, and
never compete with recorded candidates.

**Reason — safety.** Binding Section 0.4 ranks complete same-endpoint
recorded routes alone, and incomplete candidates remain available but
unranked. Drafts are unverified user input: a recorded route's provenance and
generation binding do not apply to it. Ranking a draft next to recorded
candidates would present the draft as equivalent evidence ("competing" for a
qualified label) and would require assigning rank semantics to incomplete
drafts — both forbidden. The draft is separately server-validated and may
expose a delta only when both comparison operands are complete.

**Acceptance evidence keeping it excluded.** The draft DTOs carry no
`rank`, `complete`, or `status` fields, while complete drafts do carry
`rankDistanceNm` (full-precision distance rounded at `0.000001 NM` for
comparison only), pinned in
`tests/route-safety/safety-ranking.test.ts` ("draft route payloads never carry
rank or complete fields"). The two-operand comparison reports
`comparison.status = "incomplete"` with `INCOMPLETE_OPERAND` when either
operand is incomplete, and the legacy `drafts/compare` endpoint reports
`"gap"` for the same unresolved state
(`tests/route-safety/comparison-contract.test.ts`). Incomplete candidates
appear after ranked ones with no rank, no `rankDistanceNm`, and no distance
(`tests/route-safety/safety-ranking.test.ts`), and `rankLabel` is emitted only
when at least one complete candidate has rank 1.

**Re-entry gate.** A production-adjacent "rank my draft against recorded
routes" feature would be a new acceptance criterion with explicit language for
draft provenance and candidate eligibility; it may not reuse the recorded-
candidate ranking vocabulary without a binding rule change, and it must keep
incomplete drafts unranked.

## 3. Inferred topology

**Exclusion.** No topology is ever inferred: no adjacency inference, list-
membership inference, name-similarity inference, or route-text inference. No
airway or airway-type value appears in any product-facing DTO, log,
signature, diff, route table, map label, geometry, completeness, or ranking.
Route graphics use only exact resolved waypoint/reference coordinates.

**Reason — safety.** The POC boundary document records that Airways is a
mandatory runtime input (fetched, parsed, schema/count validated, represented
in acquisition evidence) whose relationship between a route occurrence and a
directed leg was not proved. Drawing recorded airway topology — or deducing
any connection between two points — from adjacency or membership would assert
operational conformance the data cannot support. A continuous line must never
cross a gap, and an unresolved point is a diagnostic, never a nearest-neighbor
choice.

**Acceptance evidence keeping it excluded.** The offline suites pin
ambiguity-preserving exact resolution: ambiguous draft waypoints fail closed
with gap reason `"ambiguous"` until a generation-bound explicit selection
binds the exact coordinate, and geometry passes through the chosen coordinate
with no proximity guess (`tests/route-safety/explicit-selection.test.ts`).
The API payload regression scan rejects any candidate-qualifying copy
(`tests/route-safety/safety-ranking.test.ts`), and the web copy scan pins the
same (`tests/route-safety/web-copy.test.ts`). The discovery manifest
(`docs/evidence/pg-00-live-api-discovery.json`) and the POC boundary
document's Airways variance record the unproved occurrence-to-leg relation
that motivates the exclusion.

**Re-entry gate.** Only a later authoritative contract proving the
route-occurrence-to-directed-leg relation may permit airway-topology
presentation, under a new acceptance criterion and a data-use review; the
prohibition on proximity resolution is not lifted by such a contract.

## 4. Recorded-vs-recorded comparison (adjacent exclusion)

**Exclusion.** No comparison of two recorded routes against each other; the
comparison operands are exactly one recorded baseline and one local draft
target.

**Reason — scope.** The POC's comparison contract is the flight-plan-vs-draft
question that appears in the product-facing requirement: how does a proposed
change to a route compare with what is recorded? Comparing two recorded
routes adds a symmetric pairing UI and a second provenance dimension with no
POC acceptance criterion behind it.

**Acceptance evidence keeping it excluded.** The two-operand endpoint
(`POST /api/v1/routes/compare`) accepts exactly `baselineId` (a recorded
generation-bound token) plus one `targetDraft`; a second draft identifier is
rejected with `INVALID_COMPARE` (400), and missing operands are rejected with
`INVALID_BASELINE` / `INVALID_COMPARE`
(`tests/route-safety/comparison-contract.test.ts`). No
recorded-vs-recorded request shape exists in `apps/api/src/server.ts`.

**Re-entry gate.** A new acceptance criterion would add recorded-vs-recorded
pairing with its own request contract; both operands would still be
generation-bound, and the comparison vocabulary must remain directional
(`distanceDeltaNm = target - baseline` at full precision).

## 5. Full directed diff (adjacent exclusion)

**Exclusion.** The comparison reports the directed difference of modeled
distance totals at full precision plus added/removed waypoint counts and
per-waypoint difference kinds. It does not produce a full directed diff of
waypoint sequences (ordering, substitution, or re-sequencing operations).

**Reason — scope and safety.** A full diff would claim to explain *why* the
distances differ by attributing deltas to individual waypoint edits. Route
waypoint ordering in the upstream data was not proven to be directed-leg
order (see the Airways variance), so per-waypoint delta attribution would be
inferred topology in another form. The counts and kinds report observable
set-level differences without claiming an operational cause.

**Acceptance evidence keeping it excluded.** The comparison contract returns
`addedWaypointCount`, `removedWaypointCount`, and `waypointDifferences`
(kinds only), never sequence-edit operations, and the difference of totals is
computed directly from full-precision distances (`distanceDeltaNm ===
target.distanceNm - baseline.distanceNm`)
(`tests/route-safety/comparison-contract.test.ts`).

**Re-entry gate.** Only an authoritative directed-leg contract (the same one
Section 3 requires) may permit sequence-level diff attribution, under a new
acceptance criterion.

## 6. Draft persistence (adjacent exclusion)

**Exclusion.** Drafts are remembered only in-memory, scoped to the active
generation, bounded by capacity, and tied to server-issued draft tokens; they
are never durably persisted. There is no draft store that outlives the
process or the generation: no application database, no saved-draft
endpoints that accept foreign-generation ids, no draft ids that survive a
refresh or restart. A draft id expires with the generation that issued it.

**Reason — safety.** Durable draft persistence would retain generation-bound
selection tokens past their generation, forcing either stale-selection
acceptance or a reconciliation step that re-resolves references against a
newer generation — which is proximity-style inference the POC forbids. The
POC has no application database by design (POC boundary document), and the
in-memory facility is a convenience that never weakens that boundary.

**Acceptance evidence keeping it excluded.** The in-memory draft store is
capacity-bounded (excess entries are rejected with 429 `DRAFT_CAPACITY_REACHED`),
each draft id is a generation-scoped signed token, and `getDraft` rejects any
id from another generation with 410 `DRAFT_EXPIRED`. The refresh flow clears
the current selection and route (client copy "Refresh the live data
generation? The current flight selection and route will be cleared..." in
`apps/web/src/labels.ts`), selections from an older generation are rejected
with 410 `GENERATION_EXPIRED` after refresh
(`tests/route-safety/explicit-selection.test.ts`), and the request body for
comparison carries no coordinates, so nothing persisted could rebind silently
(`tests/route-safety/web-copy.test.ts`).

**Re-entry gate.** A saved-drafts feature would need a storage decision
(expressly out of POC scope, which has no application database), plus a
binding rule for re-validating saved selections against the current
generation without weakening the fail-closed contract.

## Relationship to acceptance evidence

Every exclusion above is kept in place by executable offline suites under
`tests/route-safety/` (`explicit-selection.test.ts`,
`safety-ranking.test.ts`, `comparison-contract.test.ts`, `web-copy.test.ts`)
and the contract suite in `packages/contracts/test/contracts.test.ts`, run by
`pnpm run test:offline`. The web-client and API surface they pin are the
included interactions listed at the top of this document; any feature that
re-enters an excluded interaction contradicts those pinned behaviors and is
caught before review. This document is a design commitment; it becomes
evidence only with a retained gate manifest at the appropriate gate (see the
[capability and gate-status matrix](../status/poc-capability-and-gate-matrix.md)
and the [testing and evidence contract](../testing/evidence-and-validation.md)).
