// Adversarial sweep D1 — synthesis engine fail-closed: join-key semantics.
// Attacks the join-key contract in packages/route-engine/src/synthesis.ts:
// conflicted references must fail closed with NO coordinate fallback,
// coordinate seams join only on exact coordinates and never cross the
// reference key namespace, hostile reference ids cannot collide with
// coordinate keys, and degenerate lookups (gap endpoints, absent keys,
// empty index, sub-2-point chains) must all fail closed. Does not duplicate
// A1 (limits/boundaries), A2 (scale/exhaustion/self-donation) or
// tests/synthesis/engine.test.ts (canonical forward-only semantics).
import assert from "node:assert/strict";
import test from "node:test";
import {
  assembleSynthesisCandidates,
  buildSynthesisIndex,
  findDonorSlices,
  joinKeyToString,
  type ObservedRoute,
} from "../../packages/route-engine/src/synthesis.ts";

const pt = (ordinal: number, referenceId: string, lat: number, lon: number) =>
  ({ ordinal, referenceId, coordinate: { lat, lon }, label: referenceId });
const coordPt = (ordinal: number, lat: number, lon: number, label = `P${ordinal}`) =>
  ({ ordinal, referenceId: undefined, coordinate: { lat, lon }, label });
const gap = (ordinal: number) => ({ ordinal, gapReason: "not-found" });
const route = (flightKey: string, occurrences: ObservedRoute["occurrences"]): ObservedRoute => ({ flightKey, occurrences });

const D = { lat: 10, lon: 20 };
const E = { lat: 10, lon: 40 };

// ---------------------------------------------------------------------------
// Conflicted references: unjoinable everywhere, never a coordinate fallback.
// ---------------------------------------------------------------------------
test("a conflicted reference is unjoinable even when its coordinates match exactly", () => {
  // D is seen at two coordinates across the corpus -> conflicted. One donor
  // still carries D at the target's exact coordinate: coordinate fallback is
  // forbidden, so the corridor must fail closed.
  const cleanDonor = route("d1-conf-clean", [pt(0, "D", D.lat, D.lon), coordPt(1, 20, 30), pt(2, "E", E.lat, E.lon)]);
  const poison = route("d1-conf-poison", [pt(0, "D", 99, 99), pt(1, "W", 0, 0)]);
  const target = route("d1-conf-target", [pt(0, "D", D.lat, D.lon), gap(1), pt(2, "E", E.lat, E.lon)]);
  const index = buildSynthesisIndex([cleanDonor, poison, target]);

  assert.ok(index.conflictedReferenceIds.has("D"), "a reference at two coordinates is conflicted corpus-wide");
  assert.equal(index.pointsByKey.has("ref:D"), false, "conflicted references are never indexed for joining");
  assert.ok(index.pointsByKey.has("ref:E"), "an unconflicted reference stays joinable");
  // The clean donor's chain still exists, but its D point is unjoinable:
  // slices anchored AT D must never surface, even with exact coordinates.
  const slices = findDonorSlices(index, target.occurrences[0]!, target.occurrences[2]!, target.flightKey);
  assert.equal(slices.length, 0, "no coordinate fallback for a conflicted seam");
  const outcome = assembleSynthesisCandidates(index, target);
  assert.equal(outcome.status, "unavailable");
  assert.equal(outcome.candidates.length, 0);
});

test("a conflict declared within a single route poisons every occurrence of that reference", () => {
  const selfConflicted = route("d1-self-conf", [pt(0, "D", D.lat, D.lon), pt(1, "E", E.lat, E.lon), pt(2, "D", 70, 70)]);
  const cleanDonor = route("d1-self-conf-donor", [pt(0, "D", D.lat, D.lon), coordPt(1, 20, 30), pt(2, "E", E.lat, E.lon)]);
  const target = route("d1-self-conf-target", [pt(0, "D", D.lat, D.lon), gap(1), pt(2, "E", E.lat, E.lon)]);
  const index = buildSynthesisIndex([selfConflicted, cleanDonor, target]);
  assert.ok(index.conflictedReferenceIds.has("D"), "an intra-route coordinate split is a conflict too");
  const outcome = assembleSynthesisCandidates(index, target);
  assert.equal(outcome.status, "unavailable", "even the fully clean donor cannot donate through a conflicted seam");
  assert.equal(outcome.candidates.length, 0);
});

test("a conflicted point INSIDE a slice never blocks the seam-anchored lookup", () => {
  // Conflict only governs join seams: a donor chain anchored at clean A and E
  // may still traverse a conflicted D as an interior point.
  const poison = route("d1-int-poison", [pt(0, "D", 99, 99), pt(1, "W", 0, 0)]);
  const donor = route("d1-int-donor", [pt(0, "A", 10, 10), pt(1, "D", D.lat, D.lon), pt(2, "E", E.lat, E.lon)]);
  const target = route("d1-int-target", [pt(0, "A", 10, 10), gap(1), pt(2, "E", E.lat, E.lon)]);
  const index = buildSynthesisIndex([poison, donor, target]);
  assert.ok(index.conflictedReferenceIds.has("D"));
  const outcome = assembleSynthesisCandidates(index, target);
  assert.equal(outcome.status, "full", "interior conflicted points do not invalidate a seam-clean slice");
  assert.equal(outcome.candidates.length, 1);
  assert.deepEqual(outcome.candidates[0]!.borrowedSegments[0]!.coordinates, [{ lat: 10, lon: 10 }, D, E]);
});

// ---------------------------------------------------------------------------
// Coordinate seams: exact-only, and never crossing the reference namespace.
// ---------------------------------------------------------------------------
test("coordinate seams join only on exact coordinates and never cross key namespaces", () => {
  const refDonor = route("d1-xref-donor", [pt(0, "D", D.lat, D.lon), coordPt(1, 20, 30), pt(2, "E", E.lat, E.lon)]);

  // Coordinate-only target seams at the SAME coordinates as ref:D/ref:E must
  // NOT join the reference-keyed donor: key namespaces are disjoint.
  const coordTarget = route("d1-xref-target", [coordPt(0, D.lat, D.lon, "start"), gap(1), coordPt(2, E.lat, E.lon, "end")]);
  const crossOutcome = assembleSynthesisCandidates(buildSynthesisIndex([refDonor, coordTarget]), coordTarget);
  assert.equal(crossOutcome.status, "unavailable", "a coordinate seam never joins a reference-keyed donor");

  // The inverse direction: coordinate-keyed donor, reference-keyed seams.
  const coordDonor = route("d1-xref-donor2", [coordPt(0, D.lat, D.lon), coordPt(1, 20, 30), coordPt(2, E.lat, E.lon)]);
  const refTarget = route("d1-xref-target2", [pt(0, "D", D.lat, D.lon), gap(1), pt(2, "E", E.lat, E.lon)]);
  const inverseOutcome = assembleSynthesisCandidates(buildSynthesisIndex([coordDonor, refTarget]), refTarget);
  assert.equal(inverseOutcome.status, "unavailable", "a reference seam never joins a coordinate-keyed donor");

  // Coordinate-to-coordinate joins are exact: an epsilon shift breaks the join.
  const exactTarget = route("d1-xref-target3", [coordPt(0, D.lat, D.lon), gap(1), coordPt(2, E.lat, E.lon)]);
  const exactOutcome = assembleSynthesisCandidates(buildSynthesisIndex([coordDonor, exactTarget]), exactTarget);
  assert.equal(exactOutcome.status, "full", "identical coordinates join coordinate-to-coordinate");
  assert.equal(exactOutcome.candidates[0]!.borrowedSegments[0]!.matchMethod, "exact-coordinate");

  const shiftedTarget = route("d1-xref-target4", [coordPt(0, D.lat + 1e-9, D.lon), gap(1), coordPt(2, E.lat, E.lon)]);
  const shiftedOutcome = assembleSynthesisCandidates(buildSynthesisIndex([coordDonor, shiftedTarget]), shiftedTarget);
  assert.equal(shiftedOutcome.status, "unavailable", "a 1e-9 coordinate drift must fail closed, never fuzzy-match");

  // One coordinate seam is enough to flip the match method.
  const mixedTarget = route("d1-xref-target5", [pt(0, "D", D.lat, D.lon), gap(1), coordPt(2, E.lat, E.lon)]);
  const mixedDonor = route("d1-xref-donor3", [pt(0, "D", D.lat, D.lon), coordPt(1, 20, 30), coordPt(2, E.lat, E.lon)]);
  const mixedOutcome = assembleSynthesisCandidates(buildSynthesisIndex([mixedDonor, mixedTarget]), mixedTarget);
  assert.equal(mixedOutcome.status, "full");
  assert.equal(mixedOutcome.candidates[0]!.borrowedSegments[0]!.matchMethod, "exact-coordinate", "any coordinate seam dominates the method");
  // Reference-only seams report the reference method.
  const refOnly = assembleSynthesisCandidates(buildSynthesisIndex([refDonor, refTarget]), refTarget);
  assert.equal(refOnly.candidates[0]!.borrowedSegments[0]!.matchMethod, "reference");
});

// ---------------------------------------------------------------------------
// Hostile key-space: reference ids engineered to collide with coordinate keys.
// ---------------------------------------------------------------------------
test("reference ids shaped like coordinate keys never collide across namespaces", () => {
  assert.equal(joinKeyToString({ kind: "reference", id: "10,20" }), "ref:10,20");
  assert.equal(joinKeyToString({ kind: "coordinate", lat: 10, lon: 20 }), "coord:10,20");
  assert.notEqual(joinKeyToString({ kind: "reference", id: "10,20" }), joinKeyToString({ kind: "coordinate", lat: 10, lon: 20 }));
  assert.equal(joinKeyToString({ kind: "unjoinable" }), "unjoinable");
  // A reference id literally spelling out another key prefix stays namespaced.
  assert.equal(joinKeyToString({ kind: "reference", id: "coord:10,20" }), "ref:coord:10,20");

  // Behavioral proof: a donor anchored by reference "10,20" cannot serve a
  // coordinate corridor at (10,20), and vice versa.
  const hostileDonor = route("d1-keyspace-donor", [pt(0, "10,20", 1, 1), coordPt(1, 5, 5), pt(2, "E", E.lat, E.lon)]);
  const coordTarget = route("d1-keyspace-target", [coordPt(0, 10, 20), gap(1), coordPt(2, E.lat, E.lon)]);
  const outcome = assembleSynthesisCandidates(buildSynthesisIndex([hostileDonor, coordTarget]), coordTarget);
  assert.equal(outcome.status, "unavailable", "a hostile reference id must never impersonate a coordinate key");
});

// ---------------------------------------------------------------------------
// Degenerate lookups: every malformed endpoint fails closed, never throws.
// ---------------------------------------------------------------------------
test("findDonorSlices fails closed on gap endpoints, absent keys, and conflicted seams", () => {
  const donor = route("d1-guard-donor", [pt(0, "D", D.lat, D.lon), coordPt(1, 20, 30), pt(2, "E", E.lat, E.lon)]);
  const target = route("d1-guard-target", [pt(0, "D", D.lat, D.lon), gap(1), pt(2, "E", E.lat, E.lon)]);
  const index = buildSynthesisIndex([donor, target]);

  assert.deepEqual(findDonorSlices(index, gap(0), target.occurrences[2]!, target.flightKey), [], "a gap from-endpoint yields no slices");
  assert.deepEqual(findDonorSlices(index, target.occurrences[0]!, gap(2), target.flightKey), [], "a gap to-endpoint yields no slices");
  const stranger = pt(0, "NOWHERE", 1, 1);
  assert.deepEqual(findDonorSlices(index, stranger, target.occurrences[2]!, target.flightKey), [], "an unindexed reference yields no slices");
  assert.deepEqual(findDonorSlices(index, target.occurrences[0]!, target.occurrences[0]!, "nobody").filter((slice) => slice.pointCount < 2), [], "no zero/negative-length slice ever escapes a same-endpoint lookup");
});

test("an empty corpus builds an empty index and every target fails closed on it", () => {
  const index = buildSynthesisIndex([]);
  assert.equal(index.routes.length, 0);
  assert.equal(index.components.length, 0);
  assert.equal(index.pointsByKey.size, 0);
  assert.equal(index.conflictedReferenceIds.size, 0);
  const target = route("d1-empty-target", [pt(0, "D", D.lat, D.lon), gap(1), pt(2, "E", E.lat, E.lon)]);
  const outcome = assembleSynthesisCandidates(index, target);
  assert.equal(outcome.status, "unavailable");
  assert.equal(outcome.corridorCount, 1, "the corridor exists structurally");
  assert.equal(outcome.corridorsCovered, 0);
  assert.equal(outcome.candidates.length, 0);
});

// ---------------------------------------------------------------------------
// Component formation: only gap-free chains of >= 2 points are joinable.
// ---------------------------------------------------------------------------
test("single-point chains between gaps are never indexed; two-point chains are", () => {
  const fragmented = route("d1-frag", [
    pt(0, "A", 1, 1), // isolated before a gap: never joinable
    gap(1),
    pt(2, "B", 2, 2), pt(3, "C", 3, 3), // one 2-point component
    gap(4),
    pt(5, "F", 6, 6), // isolated after a gap: never joinable
  ]);
  const index = buildSynthesisIndex([fragmented]);
  assert.equal(index.components.length, 1, "only the B-C chain forms a component");
  assert.equal(index.components[0]!.points.length, 2);
  assert.equal(index.pointsByKey.has("ref:A"), false, "an isolated point is not indexed");
  assert.equal(index.pointsByKey.has("ref:F"), false);
  assert.equal(index.pointsByKey.get("ref:B")?.length, 1);
  assert.equal(index.pointsByKey.get("ref:C")?.length, 1);
  // A one-point route contributes nothing at all.
  assert.equal(buildSynthesisIndex([route("d1-single", [pt(0, "A", 1, 1)])]).components.length, 0);
});

// A corridor whose anchors are the SAME location (a loop gap) is legal: the
// lookup scans strictly forward, so a donor revisiting the anchor qualifies.
test("a loop corridor (same from and to anchor) borrows the forward return leg", () => {
  const donor = route("d1-loop-donor", [pt(0, "D", D.lat, D.lon), coordPt(1, 20, 30), pt(2, "D", D.lat, D.lon)]);
  const target = route("d1-loop-target", [pt(0, "D", D.lat, D.lon), gap(1), pt(2, "D", D.lat, D.lon)]);
  const index = buildSynthesisIndex([donor, target]);
  const slices = findDonorSlices(index, target.occurrences[0]!, target.occurrences[2]!, target.flightKey);
  assert.equal(slices.length, 1, "the forward D->...->D slice qualifies");
  assert.equal(slices[0]!.pointCount, 3);
  const outcome = assembleSynthesisCandidates(index, target);
  assert.equal(outcome.status, "full");
  const segment = outcome.candidates[0]!.borrowedSegments[0]!;
  assert.deepEqual(segment.coordinates, [D, { lat: 20, lon: 30 }, D], "the loop geometry is borrowed in full");
  assert.ok(segment.distanceNm > 0, "the out-and-back distance is real, not collapsed");
});
