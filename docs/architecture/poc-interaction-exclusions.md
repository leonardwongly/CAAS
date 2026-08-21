# POC interaction exclusions

## Authority

This document records deliberate interaction exclusions for the POC flight
route explorer. Each exclusion names what is excluded, why (safety or scope),
the acceptance evidence that keeps it excluded, the gate that would permit
re-entry, and the binding rules it must respect if ever re-entered. It is a
design commitment, not evidence. It complements the [POC boundary
document](poc-boundary.md), ADR-001, and binding design Section 0 (normative
reconciliation, 2026-08-12); Section 0.4 governs neutral comparison and presentation and
is referenced throughout.

## The interaction that is included, to bound the exclusions

The POC supports exactly these interactions with routes and local variations:

1. **Browse and select** every safe active-generation flight from the map, full
   list, or callsign filter; all surfaces share one selected `flightId`.
2. **Compare recorded routes neutrally** for one endpoint pair. The selected
   route appears first, remaining routes retain immutable source order, complete
   and incomplete routes stay visible, and modeled distance is descriptive only.
3. **Explore a local unsaved variation** (origin, destination, via waypoints) in
   the optional variation editor.
4. **Resolve** every variation waypoint exactly. Ambiguous references fail closed
   until the user makes a generation-bound explicit selection; missing references
   remain gaps.
5. **Compare** one recorded route with one local variation when both operands are
   complete, reporting the directed difference of modeled distance totals.

Preference ranking, undo/redo, inferred topology, arbitrary cross-endpoint
comparison, a full directed sequence diff, and persistence across sessions are
excluded below. Public DTOs omit `rank`, `rankDistanceNm`, `rankLabel`, and
`operationalProxy`.

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

## 2. Preference ranking

**Exclusion.** Neither recorded routes nor local variations receive a public
rank, winner badge, preference label, or operational-proxy field. Modeled
distance never controls default order.

**Reason — safety.** The available data omits weather, NOTAM, ATC, fuel,
aircraft suitability, clearance, legality, and regulatory constraints. Turning
one geometric measure into a declared preference would imply evidence the POC
does not possess. A local variation is additionally user-authored and ephemeral.

**Acceptance evidence keeping it excluded.** Route-safety, runtime-policy, and
API-contract tests reject `rank`, `rankDistanceNm`, `rankLabel`, and
`operationalProxy` anywhere in public payloads. Neutral ordering tests require
the selected recorded route first, remaining immutable source order, and
canonical signature only as a deterministic final fallback. Incomplete routes
retain explicit gaps and omit unavailable totals.

**Re-entry gate.** Any preference feature requires a new product and safety
decision, an authoritative operational-input contract, separately named public
fields and copy, and new acceptance evidence. It may not silently reuse modeled
distance as operational advice.

## 3. Inferred topology

**Exclusion.** No topology is ever inferred: no adjacency inference, list-
membership inference, name-similarity inference, or route-text inference. No
airway or airway-type value appears in any product-facing DTO, log,
signature, diff, route table, map label, geometry, completeness, or route comparison.
Route graphics use only exact resolved waypoint/reference coordinates.

**Reason — safety.** The POC boundary document records that Airways is a
mandatory runtime input (fetched, parsed, schema/count validated, represented
in acquisition evidence) whose relationship between a route occurrence and a
directed leg was not proved. Drawing recorded airway topology — or deducing
any connection between two points — from adjacency or membership would assert
operational conformance the data cannot support. A continuous line must never
cross a gap, and an unresolved point is a diagnostic, never a nearest-neighbor
choice.

The owner-approved conservative potential layer is not topology: it was a client-only, dotted visual estimate between exact anchors with no span-distance upper limit; its synthetic unnamed midpoint rendering was retired on 2026-08-20 (ADR-0002), and the estimate survives only as a separate descriptive statistical annotation. It does not alter recorded geometry, source DTOs, completeness, source `distanceNm`, comparison, ranking, export, or the original gap; ambiguous and endpoint-only gaps remain unresolved.

A client-only distance annotation may describe an exact-anchor geometric minimum and, after separate historical release gates pass, a conformal statistical interval. It is not a reconstructed route or a complete-route modeled-distance operand. Consecutive missing records sharing one anchor pair are one corridor; no missing fix, airway, or intermediate topology is inferred. Annotation values are prohibited inputs to route ordering, comparison, preference language, public DTOs, server state, logging, and export. An absent or out-of-support model fails closed to the geometric minimum or unavailable state.

**Acceptance evidence keeping it excluded.** The offline suites pin
ambiguity-preserving exact resolution: ambiguous draft waypoints fail closed
with gap reason `"ambiguous"` until a generation-bound explicit selection
binds the exact coordinate, and geometry passes through the chosen coordinate
with no proximity guess (`tests/route-safety/explicit-selection.test.ts`).
The API payload regression scan rejects any candidate-qualifying copy
(`tests/route-safety/safety-ranking.test.ts`), and the web copy scan pins the
same (`tests/route-safety/web-copy.test.ts`). The gap-distance suites additionally pin corridor grouping, hidden-point feature isolation, route-group-held-out calibration, source immutability, API absence, lower-bound copy, and fail-closed model behavior (`packages/route-engine/test/gap-distance.test.ts`, `tests/route-safety/estimated-distance.test.ts`, `tests/e2e/gap-distance.test.tsx`, and `tests/a11y/gap-distance.test.tsx`). The discovery manifest
(`docs/evidence/pg-00-live-api-discovery.json`) and the POC boundary
document's Airways variance record the unproved occurrence-to-leg relation
that motivates the exclusion.

**Re-entry gate.** Only a later authoritative contract proving the
route-occurrence-to-directed-leg relation may permit airway-topology
presentation, under a new acceptance criterion and a data-use review; the
prohibition on proximity resolution is not lifted by such a contract.

## 4. Cross-endpoint comparison (adjacent exclusion)

**Exclusion.** Recorded-route comparison is limited to routes with the same
origin and destination. The POC does not compare arbitrary endpoint pairs as if
their modeled distances answered the same question.

**Reason — safety and scope.** Different endpoints represent different trips;
a side-by-side distance delta would have no like-for-like interpretation and
could be mistaken for a recommendation.

**Acceptance evidence keeping it excluded.** Same-endpoint candidate assembly is
server-owned and generation-bound. The route chooser and comparison surfaces
consume only that set, while exact endpoint identity remains part of every
recorded route DTO.

**Re-entry gate.** A cross-endpoint analytical feature requires a separately
specified user question, metrics, copy, and acceptance criterion. It must remain
non-operational and may not introduce preference ranking.

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
