// Adversarial sweep A1 — route-engine synthesis fail-closed limits & boundary values.
// Targets packages/route-engine/src/synthesis.ts only. Does not duplicate
// tests/synthesis/engine.test.ts (canonical fixtures, 21-distinct-donor limit,
// max-slice over-limit) or tests/adversarial/sec-r5-synthesis.test.ts (API/proofs).
import assert from "node:assert/strict";
import test from "node:test";
import { MAX_DONOR_PROVENANCE, MAX_ROUTE_POINTS, MAX_SYNTHESIS_CANDIDATES } from "../../packages/contracts/src/index.ts";
import {
  assembleSynthesisCandidates,
  buildSynthesisIndex,
  findDonorSlices,
  haversineDistanceNm,
  type ObservedRoute,
} from "../../packages/route-engine/src/index.ts";

const pt = (ordinal: number, referenceId: string, lat: number, lon: number) =>
  ({ ordinal, referenceId, coordinate: { lat, lon }, label: referenceId });
const coordPt = (ordinal: number, lat: number, lon: number, label = `P${ordinal}`) =>
  ({ ordinal, referenceId: undefined, coordinate: { lat, lon }, label });
const gap = (ordinal: number) => ({ ordinal, gapReason: "not-found" });
const route = (flightKey: string, occurrences: ObservedRoute["occurrences"]): ObservedRoute => ({ flightKey, occurrences });

// Shared anchors (same reference ids AND coordinates everywhere so seams join).
const D = { lat: 10, lon: 20 };
const E = { lat: 10, lon: 40 };
const F = { lat: 10, lon: 60 };
const ptAt = (ordinal: number, referenceId: string, c: { lat: number; lon: number }) => pt(ordinal, referenceId, c.lat, c.lon);

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const entry of Object.values(value as Record<string, unknown>)) deepFreeze(entry);
  }
  return value;
}

// ---------------------------------------------------------------------------
// MAX_ROUTE_POINTS (256): assembled-candidate boundary, acceptance side.
// ---------------------------------------------------------------------------
test("an assembled candidate at exactly MAX_ROUTE_POINTS is accepted; never truncated", () => {
  // Target records 2 anchors (D, E) with one gap between them. The borrowed
  // slice of exactly MAX_ROUTE_POINTS points contributes length-2 interior
  // points: 2 recorded + 254 interior = 256 == cap exactly.
  const interior = MAX_ROUTE_POINTS - 2; // 254 interior donor points
  const donor = route("a1-huge-fit", [
    ptAt(0, "D", D),
    ...Array.from({ length: interior }, (_, i) => coordPt(i + 1, 20 + i * 0.001, 30)),
    ptAt(interior + 1, "E", E),
  ]);
  const target = route("a1-target-fit", [ptAt(0, "D", D), gap(1), ptAt(2, "E", E)]);
  const outcome = assembleSynthesisCandidates(buildSynthesisIndex([donor, target]), target);
  assert.equal(outcome.status, "full", "a candidate exactly at the point cap is legal and covered");
  assert.equal(outcome.candidates.length, 1);
  const segment = outcome.candidates[0]!.borrowedSegments[0]!;
  assert.equal(segment.coordinates.length, MAX_ROUTE_POINTS, "the slice is emitted in full, never truncated");
  assert.deepEqual(segment.coordinates[0], D);
  assert.deepEqual(segment.coordinates.at(-1), E);

  // The lookup window admits at most a MAX_ROUTE_POINTS slice, so the
  // over-limit assembly rejection can only come from recorded points: the
  // same 256-point slice on a 3-recorded-point target totals 257 > cap.
  const target3 = route("a1-target-over", [ptAt(0, "C", { lat: 10, lon: 10 }), ptAt(1, "D", D), gap(2), ptAt(3, "E", E)]);
  const indexOver = buildSynthesisIndex([donor, target3]);
  const slicesOver = findDonorSlices(indexOver, target3.occurrences[1]!, target3.occurrences[3]!, target3.flightKey);
  assert.equal(slicesOver.length, 1);
  assert.equal(slicesOver[0]!.pointCount, MAX_ROUTE_POINTS, "the lookup window never returns more than the cap");
  const overOutcome = assembleSynthesisCandidates(indexOver, target3);
  assert.equal(overOutcome.status, "over-limit", "a 257-point assembled candidate is rejected, never truncated");
  assert.equal(overOutcome.candidates.length, 0);
});

test("MAX_ROUTE_POINTS-1 interior donor points hide the far anchor: lookup window caps the slice", () => {
  // 255 interior points place E at position 257 > MAX_ROUTE_POINTS-1 window,
  // so no slice may be returned (fail-closed silence, never a truncated slice).
  const interior = MAX_ROUTE_POINTS - 1;
  const donor = route("a1-huge-long", [
    ptAt(0, "D", D),
    ...Array.from({ length: interior }, (_, i) => coordPt(i + 1, 20 + i * 0.001, 30)),
    ptAt(interior + 1, "E", E),
  ]);
  const target = route("a1-target-long", [ptAt(0, "D", D), gap(1), ptAt(2, "E", E)]);
  const index = buildSynthesisIndex([donor, target]);
  const slices = findDonorSlices(index, target.occurrences[0]!, target.occurrences[2]!, target.flightKey);
  assert.equal(slices.length, 0, "a slice longer than MAX_ROUTE_POINTS must never be returned");
  const outcome = assembleSynthesisCandidates(index, target);
  assert.equal(outcome.status, "unavailable");
  assert.equal(outcome.candidates.length, 0);
});

// ---------------------------------------------------------------------------
// MAX_SYNTHESIS_CANDIDATES (20): exact-boundary inclusion vs sentinel return.
// ---------------------------------------------------------------------------
test("findDonorSlices returns exactly 20 slices at the cap and trips the over-limit sentinel at 21", () => {
  // One donor carrying two gap-split D..E components yields exactly two
  // slices for the same (from, to) pair; N such donors produce 2N slices.
  const twoAnchorDonor = (i: number) => route(`a1-rep-${i}`, [
    ptAt(0, "D", D), coordPt(1, 30 + i, 25), ptAt(2, "E", E),
    gap(3),
    ptAt(4, "D", D), coordPt(5, 50 + i, 25), ptAt(6, "E", E),
  ]);
  const target = route("a1-target-rep", [ptAt(0, "D", D), gap(1), ptAt(2, "E", E)]);

  const atCap = buildSynthesisIndex([...Array.from({ length: 10 }, (_, i) => twoAnchorDonor(i)), target]);
  const slicesAtCap = findDonorSlices(atCap, target.occurrences[0]!, target.occurrences[2]!, target.flightKey);
  assert.equal(slicesAtCap.length, MAX_SYNTHESIS_CANDIDATES, "exactly 20 slices is the inclusive boundary");

  const overCap = buildSynthesisIndex([...Array.from({ length: 11 }, (_, i) => twoAnchorDonor(i)), target]);
  const slicesOver = findDonorSlices(overCap, target.occurrences[0]!, target.occurrences[2]!, target.flightKey);
  assert.equal(slicesOver.length, MAX_SYNTHESIS_CANDIDATES + 1, "the sentinel returns one over the cap");

  // Assembly: exactly 20 corridor choices assembles; 21 choices fails closed.
  const ok = assembleSynthesisCandidates(atCap, target);
  assert.equal(ok.status, "ambiguous");
  assert.equal(ok.candidates.length, MAX_SYNTHESIS_CANDIDATES);
  assert.equal(new Set(ok.candidates.map((c) => c.geometrySignature)).size, MAX_SYNTHESIS_CANDIDATES);

  const exceeded = assembleSynthesisCandidates(overCap, target);
  assert.equal(exceeded.status, "candidate-limit-exceeded");
  assert.equal(exceeded.candidates.length, 0, "over-limit lookup fails closed with no candidates");
});

test("multi-corridor Cartesian product: exactly 20 candidates assembles, 21 fails closed", () => {
  // Corridor 1 (D->E) and corridor 2 (E->F) each see one slice per donor;
  // choice counts multiply across corridors.
  const target = route("a1-product-target", [ptAt(0, "D", D), gap(1), ptAt(2, "E", E), gap(3), ptAt(4, "F", F)]);

  const deDonors = Array.from({ length: 4 }, (_, i) => route(`a1-de-${i}`, [ptAt(0, "D", D), coordPt(1, 20 + i, 30), ptAt(2, "E", E)]));
  const efDonors = Array.from({ length: 5 }, (_, i) => route(`a1-ef-${i}`, [ptAt(0, "E", E), coordPt(1, 40 + i, 50), ptAt(2, "F", F)]));
  const exact = assembleSynthesisCandidates(buildSynthesisIndex([...deDonors, ...efDonors, target]), target);
  assert.equal(exact.status, "ambiguous", "20 candidates across two corridors is the inclusive boundary");
  assert.equal(exact.candidates.length, MAX_SYNTHESIS_CANDIDATES);
  assert.equal(exact.corridorCount, 2);
  assert.equal(exact.corridorsCovered, 2);
  for (const candidate of exact.candidates) {
    assert.equal(candidate.borrowedSegments.length, 2, "every product candidate carries one segment per corridor");
    assert.ok(candidate.estimatedTotalDistanceNm !== undefined, "fully covered product candidates report totals");
  }

  const over = assembleSynthesisCandidates(
    buildSynthesisIndex([...deDonors, ...Array.from({ length: 7 }, (_, i) => route(`a1-ef-x-${i}`, [ptAt(0, "E", E), coordPt(1, 70 + i, 50), ptAt(2, "F", F)])), target]),
    target,
  );
  // 4 x 7 = 28 > 20 combinations: fail closed with no candidates.
  assert.equal(over.status, "candidate-limit-exceeded");
  assert.equal(over.candidates.length, 0);
});

// ---------------------------------------------------------------------------
// Provenance aggregation cap (MAX_DONOR_PROVENANCE = 8).
// ---------------------------------------------------------------------------
test("provenance aggregates exactly 8 donors untruncated and truncates the 9th by stable index order", () => {
  // Nine donors with byte-identical D->X->E geometry but distinct flight keys.
  const donors = Array.from({ length: 9 }, (_, i) => route(`a1-prov-${i}`, [ptAt(0, "D", D), coordPt(1, 20, 30), ptAt(2, "E", E)]));
  const target = route("a1-target-prov", [ptAt(0, "C", { lat: 10, lon: 10 }), ptAt(1, "D", D), gap(2), ptAt(3, "E", E)]);
  const outcome = assembleSynthesisCandidates(buildSynthesisIndex([...donors, target]), target);
  assert.equal(outcome.status, "full", "identical geometries deduplicate to one choice with complete coverage");
  assert.equal(outcome.candidates.length, 1, "identical geometries deduplicate to one choice");
  const segment = outcome.candidates[0]!.borrowedSegments[0]!;
  assert.equal(segment.donorCount, 9, "segment donorCount reports the true pre-cap aggregate");
  assert.equal(outcome.candidates[0]!.donorTruncated, true, "candidate-level truncation flag propagates");
  assert.equal(segment.donorTruncated, true);
  assert.equal(segment.donorFlightKeys.length, MAX_DONOR_PROVENANCE);
  assert.deepEqual(segment.donorFlightKeys, Array.from({ length: 8 }, (_, i) => `a1-prov-${i}`), "truncation keeps the first 8 by index generation order");
  assert.equal(segment.donorOrdinals.length, MAX_DONOR_PROVENANCE, "donorOrdinals are capped at the same limit");
  assert.ok(!segment.donorFlightKeys.includes("a1-prov-8"), "the 9th donor is dropped, never any earlier donor");

  // Exactly 8 donors: no truncation at the inclusive boundary.
  const eight = assembleSynthesisCandidates(buildSynthesisIndex([...donors.slice(0, 8), target]), target);
  const eightSegment = eight.candidates[0]!.borrowedSegments[0]!;
  assert.equal(eight.candidates[0]!.donorCount, 8);
  assert.equal(eightSegment.donorCount, 8);
  assert.equal(eightSegment.donorTruncated, false);
  assert.equal(eightSegment.donorFlightKeys.length, 8);
});

// ---------------------------------------------------------------------------
// Visit budget: traversal itself is bounded, not just the output.
// ---------------------------------------------------------------------------
test("the product visit budget bounds traversal and keeps repeated runs byte-identical", () => {
  // 10 x 10 x 10 = 1000 leaf combinations across three corridors; the budget
  // (20 x 20 = 400 leaves) must fail closed long before full enumeration.
  const make = (prefix: string, anchorA: string, a: { lat: number; lon: number }, anchorB: string, b: { lat: number; lon: number }) =>
    Array.from({ length: 10 }, (_, i) => route(`${prefix}-${i}`, [ptAt(0, anchorA, a), coordPt(1, 5 * i + 1, 33), ptAt(2, anchorB, b)]));
  const de = make("a1-bd", "D", D, "E", E);
  const ef = make("a1-be", "E", E, "F", F);
  const g = { lat: 10, lon: 80 };
  const fg = make("a1-bf", "F", F, "G", g);
  const target = route("a1-budget-target", [
    ptAt(0, "D", D), gap(1), ptAt(2, "E", E), gap(3), ptAt(4, "F", F), gap(5), ptAt(6, "G", g),
  ]);
  const index = buildSynthesisIndex([...de, ...ef, ...fg, target]);

  const startedAt = Date.now();
  const first = assembleSynthesisCandidates(index, target);
  const elapsedMs = Date.now() - startedAt;
  assert.equal(first.status, "candidate-limit-exceeded", "a 1000-leaf product fails closed");
  assert.equal(first.candidates.length, 0);
  assert.ok(elapsedMs < 5_000, `traversal must be bounded by the visit budget, took ${elapsedMs}ms`);

  const second = assembleSynthesisCandidates(index, target);
  assert.equal(JSON.stringify(first), JSON.stringify(second), "repeated assembly is deterministic");
});

// ---------------------------------------------------------------------------
// Determinism: route-array order must not change the candidate SET.
// ---------------------------------------------------------------------------
test("building the index from reversed route order yields the identical candidate set", () => {
  const donors = [
    ...Array.from({ length: 3 }, (_, i) => route(`a1-det-de-${i}`, [ptAt(0, "D", D), coordPt(1, 20 + i, 30), ptAt(2, "E", E)])),
    ...Array.from({ length: 3 }, (_, i) => route(`a1-det-ef-${i}`, [ptAt(0, "E", E), coordPt(1, 40 + i, 50), ptAt(2, "F", F)])),
  ];
  const target = route("a1-det-target", [ptAt(0, "D", D), gap(1), ptAt(2, "E", E), gap(3), ptAt(4, "F", F)]);

  const forward = assembleSynthesisCandidates(buildSynthesisIndex([...donors, target]), target);
  const reversed = assembleSynthesisCandidates(buildSynthesisIndex([...[...donors].reverse(), target]), target);
  assert.equal(forward.status, reversed.status);
  const signatures = (o: typeof forward) => o.candidates.map((c) => c.geometrySignature).sort();
  assert.deepEqual(signatures(forward), signatures(reversed), "the candidate set must be order-invariant");
  // Provenance SETS per geometry are order-invariant; the key order within a
  // candidate legitimately follows index generation order (neutral ordering).
  const provenance = (o: typeof forward) => o.candidates
    .map((c) => `${c.geometrySignature}::${[...c.donorFlightKeys].sort().join(",")}`).sort();
  assert.deepEqual(provenance(forward), provenance(reversed), "per-candidate donor sets must be order-invariant");
});

test("index build never mutates donor routes (deep-frozen inputs survive)", () => {
  const donors = [
    route("a1-frozen-a", [ptAt(0, "D", D), coordPt(1, 20, 30), ptAt(2, "E", E)]),
    route("a1-frozen-b", [ptAt(0, "D", D), gap(1), ptAt(2, "E", E)]),
  ];
  deepFreeze(donors);
  const index = buildSynthesisIndex(donors); // would throw on any mutation attempt
  assert.ok(index.components.length > 0);
  assert.deepEqual(donors[0]!.occurrences[1], coordPt(1, 20, 30), "donor point arrays are untouched");
});

// ---------------------------------------------------------------------------
// Degenerate targets.
// ---------------------------------------------------------------------------
test("0- and 1-point targets report unavailable with no corridors and no candidates", () => {
  const index = buildSynthesisIndex([route("a1-donor", [ptAt(0, "D", D), ptAt(1, "E", E)])]);
  for (const occurrences of [[], [ptAt(0, "D", D)]] as const) {
    const outcome = assembleSynthesisCandidates(index, route("a1-degenerate", occurrences));
    assert.equal(outcome.status, "unavailable");
    assert.equal(outcome.corridorCount, 0);
    assert.equal(outcome.corridorsCovered, 0);
    assert.equal(outcome.candidates.length, 0);
  }
});

test("leading and trailing gap runs are never bridged: partial when covered, unavailable when not", () => {
  const donor = route("a1-edge-donor", [ptAt(0, "D", D), coordPt(1, 20, 30), ptAt(2, "E", E)]);

  // Gap at the very start: corridor D->E is coverable, but the leading edge
  // stays unresolved -> partial with candidates, never an estimated total.
  const leading = route("a1-leading", [gap(0), ptAt(1, "D", D), gap(2), ptAt(3, "E", E)]);
  const leadingOutcome = assembleSynthesisCandidates(buildSynthesisIndex([donor, leading]), leading);
  assert.equal(leadingOutcome.status, "partial");
  assert.equal(leadingOutcome.candidates.length, 1);
  assert.equal(leadingOutcome.candidates[0]!.estimatedTotalDistanceNm, undefined, "an unbounded edge forbids a total estimate");

  // Gap at the very end with no earlier gap: no corridor ever forms.
  const trailing = route("a1-trailing", [ptAt(0, "D", D), ptAt(1, "E", E), gap(2)]);
  const trailingOutcome = assembleSynthesisCandidates(buildSynthesisIndex([donor, trailing]), trailing);
  assert.equal(trailingOutcome.status, "unavailable");
  assert.equal(trailingOutcome.corridorCount, 0);

  // The entire recorded route is gaps: nothing to anchor.
  const allGaps = route("a1-all-gaps", [gap(0), gap(1), gap(2)]);
  const allGapsOutcome = assembleSynthesisCandidates(buildSynthesisIndex([donor, allGaps]), allGaps);
  assert.equal(allGapsOutcome.status, "unavailable");
  assert.equal(allGapsOutcome.candidates.length, 0);
});

test("adjacent anchors (zero-length gap) borrow the 2-point seam with zero interior contribution", () => {
  const donor = route("a1-adj-donor", [ptAt(0, "D", D), ptAt(1, "E", E)]);
  const target = route("a1-adj-target", [ptAt(0, "D", D), gap(1), ptAt(2, "E", E)]);
  const outcome = assembleSynthesisCandidates(buildSynthesisIndex([donor, target]), target);
  assert.equal(outcome.status, "full", "a zero-length gap with one donor geometry is complete coverage");
  assert.equal(outcome.candidates.length, 1);
  const candidate = outcome.candidates[0]!;
  const segment = candidate.borrowedSegments[0]!;
  assert.deepEqual(segment.coordinates, [D, E], "the seam slice is exactly the two anchors");
  const expectedTotal = candidate.sourceResolvedDistanceNm + haversineDistanceNm(D, E);
  assert.ok(candidate.estimatedTotalDistanceNm !== undefined);
  assert.ok(Math.abs(candidate.estimatedTotalDistanceNm! - expectedTotal) <= 1e-9, "borrowed seam distance reconciles with the total");
});

test("overlapping slices from a repeated-anchor donor stay distinct and deterministic", () => {
  // One donor containing D..E twice in a single component forces three slices
  // for the same corridor (first D->first E, first D->second E spanning the
  // repeated anchor, second D->second E): all distinct geometries must
  // survive dedupe with a stable order across repeated assembly.
  const donor = route("a1-overlap-donor", [
    ptAt(0, "D", D), coordPt(1, 21, 30), ptAt(2, "E", E),
    coordPt(3, 31, 45), ptAt(4, "D", D), coordPt(5, 22, 30), ptAt(6, "E", E),
  ]);
  const target = route("a1-overlap-target", [ptAt(0, "D", D), gap(1), ptAt(2, "E", E)]);
  const index = buildSynthesisIndex([donor, target]);
  const first = assembleSynthesisCandidates(index, target);
  assert.equal(first.status, "ambiguous");
  assert.equal(first.candidates.length, 3, "every forward slice geometry is preserved distinctly");
  assert.equal(new Set(first.candidates.map((c) => c.geometrySignature)).size, 3);
  const second = assembleSynthesisCandidates(index, target);
  assert.deepEqual(
    first.candidates.map((c) => c.geometrySignature),
    second.candidates.map((c) => c.geometrySignature),
    "candidate ordering is deterministic across repeated runs",
  );
});
