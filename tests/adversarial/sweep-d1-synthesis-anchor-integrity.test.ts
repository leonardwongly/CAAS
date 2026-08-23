// Adversarial sweep D1 — synthesis engine fail-closed: corridor anchor integrity.
// Regression file for D1-BUG-1: assembleSynthesisCandidates re-resolved corridor
// anchors through a last-wins ordinal Map while targetCorridors selects anchors
// STRUCTURALLY (the point occurrences adjacent to the gap run). Non-unique
// ordinals silently flipped donor lookups onto a different occurrence than the
// one bounding the corridor, turning coverable corridors "unavailable" (or, in
// the symmetric case, emitting candidates whose seams never match the corridor).
// Fix: TargetCorridor carries its exact anchor occurrences.
// Targets packages/route-engine/src/synthesis.ts only. Does not duplicate
// adv-synthesis-limits.test.ts (A1), adv-synthesis-exhaustion.test.ts (A2) or
// tests/synthesis/engine.test.ts (unique-ordinal canonical fixtures).
import assert from "node:assert/strict";
import test from "node:test";
import {
  assembleSynthesisCandidates,
  buildSynthesisIndex,
  targetCorridors,
  type ObservedRoute,
} from "../../packages/route-engine/src/synthesis.ts";

const pt = (ordinal: number, referenceId: string, lat: number, lon: number) =>
  ({ ordinal, referenceId, coordinate: { lat, lon }, label: referenceId });
const gap = (ordinal: number) => ({ ordinal, gapReason: "not-found" });
const route = (flightKey: string, occurrences: ObservedRoute["occurrences"]): ObservedRoute => ({ flightKey, occurrences });

const D = { lat: 10, lon: 20 };
const E = { lat: 10, lon: 40 };
const Z = { lat: 50, lon: 50 };
const Q = { lat: -30, lon: -60 };

// Regression D1-BUG-1 (to-anchor direction): a later point reusing the corridor
// to-anchor's ordinal must not redirect the donor lookup. Before the fix, the
// last-wins ordinal map resolved ordinal 2 to Z, the D->E corridor flipped to
// D->Z, and a coverable route reported "unavailable".
test("D1-BUG-1 regression: a duplicated to-ordinal never flips the corridor anchor", () => {
  const donor = route("d1-dup-to-donor", [pt(0, "D", D.lat, D.lon), pt(1, "X", 20, 30), pt(2, "E", E.lat, E.lon)]);
  const target = route("d1-dup-to-target", [
    pt(0, "D", D.lat, D.lon),
    gap(1),
    pt(2, "E", E.lat, E.lon),
    pt(2, "Z", Z.lat, Z.lon), // hostile ordinal reuse AFTER the corridor
  ]);
  const outcome = assembleSynthesisCandidates(buildSynthesisIndex([donor, target]), target);
  assert.equal(outcome.status, "full", "the corridor is anchored at the occurrence adjacent to the gap, not the last ordinal holder");
  assert.equal(outcome.candidates.length, 1);
  const segment = outcome.candidates[0]!.borrowedSegments[0]!;
  assert.deepEqual(segment.coordinates[0], D, "the seam start is the structural from anchor");
  assert.deepEqual(segment.coordinates.at(-1), E, "the seam end is the structural to anchor E, never the ordinal impostor Z");
  assert.ok(segment.coordinates.every((coordinate) => coordinate.lat !== Z.lat && coordinate.lon !== Z.lon), "no impostor geometry leaks into the borrowed segment");
  assert.equal(outcome.candidates[0]!.estimatedTotalDistanceNm !== undefined, true, "complete structural coverage still earns the total estimate");
});

// Regression D1-BUG-1 (from-anchor direction): a later occurrence reusing the
// from-anchor's ordinal must not replace the point that bounds the gap run.
test("D1-BUG-1 regression: a duplicated from-ordinal keeps the gap-adjacent anchor", () => {
  const donor = route("d1-dup-from-donor", [pt(0, "D", D.lat, D.lon), pt(1, "X", 20, 30), pt(2, "E", E.lat, E.lon)]);
  const target = route("d1-dup-from-target", [
    pt(0, "D", D.lat, D.lon),
    gap(1),
    pt(2, "E", E.lat, E.lon),
    pt(0, "Q", Q.lat, Q.lon), // reuses the from-anchor ordinal later in the route
  ]);
  const outcome = assembleSynthesisCandidates(buildSynthesisIndex([donor, target]), target);
  assert.equal(outcome.status, "full", "the from anchor is the point directly before the gap run");
  assert.equal(outcome.candidates.length, 1);
  assert.deepEqual(outcome.candidates[0]!.borrowedSegments[0]!.coordinates[0], D, "lookup starts at D, never at the later ordinal impostor Q");
  assert.deepEqual(outcome.candidates[0]!.borrowedSegments[0]!.coordinates.at(-1), E);
});

// Ordinals are recorded metadata: non-monotonic values and a gap ordinal
// colliding with a point ordinal must not disturb corridor formation, anchor
// selection, or coverage accounting (array order is the only structure).
test("non-monotonic ordinals and gap/point ordinal collisions stay anchor-correct", () => {
  const donor = route("d1-chaos-donor", [pt(9, "D", D.lat, D.lon), pt(1, "X", 20, 30), pt(7, "E", E.lat, E.lon)]);
  const target = route("d1-chaos-target", [
    pt(5, "D", D.lat, D.lon),
    gap(3), // gap ordinal equals the to-anchor's ordinal below
    pt(3, "E", E.lat, E.lon),
  ]);
  const outcome = assembleSynthesisCandidates(buildSynthesisIndex([donor, target]), target);
  assert.equal(outcome.status, "full");
  assert.equal(outcome.corridorCount, 1);
  assert.equal(outcome.corridorsCovered, 1);
  assert.equal(outcome.candidates.length, 1);
  // Borrowed provenance reports the donor's RECORDED ordinals verbatim.
  const segment = outcome.candidates[0]!.borrowedSegments[0]!;
  assert.deepEqual(segment.donorOrdinals, [{ flightKey: "d1-chaos-donor", fromOrdinal: 9, toOrdinal: 7 }], "donor ordinals pass through unmodified, never re-sorted");
  assert.ok(outcome.candidates[0]!.estimatedTotalDistanceNm !== undefined, "the colliding ordinal does not break gap coverage accounting");
});

// targetCorridors must expose the EXACT bounding occurrences (identity), so
// downstream lookups can never re-resolve them through ordinal metadata.
test("targetCorridors anchors are the identical bounding occurrence objects", () => {
  const occurrences: ObservedRoute["occurrences"] = [
    pt(0, "D", D.lat, D.lon),
    gap(1),
    pt(2, "E", E.lat, E.lon),
    pt(2, "Z", Z.lat, Z.lon),
  ];
  const corridors = targetCorridors(occurrences);
  assert.equal(corridors.length, 1);
  assert.deepEqual({ from: corridors[0]!.fromOrdinal, to: corridors[0]!.toOrdinal, gaps: corridors[0]!.gapOrdinals }, { from: 0, to: 2, gaps: [1] });
  assert.equal(corridors[0]!.from, occurrences[0], "from anchor is the exact occurrence before the gap run");
  assert.equal(corridors[0]!.to, occurrences[2], "to anchor is the exact first occurrence after the gap run, not its ordinal twin");
  assert.notEqual(corridors[0]!.to, occurrences[3], "the later ordinal twin is never mistaken for the anchor");
});
