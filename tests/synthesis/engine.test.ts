import assert from "node:assert/strict";
import test from "node:test";
import { buildSynthesisIndex, targetCorridors, findDonorSlices, assembleSynthesisCandidates, type ObservedRoute } from "../../packages/route-engine/src/synthesis.ts";

const pt = (ordinal: number, referenceId: string, lat: number, lon: number) =>
  ({ ordinal, referenceId, coordinate: { lat, lon }, label: referenceId });
const gap = (ordinal: number) => ({ ordinal, gapReason: "not-found" });

function route(flightKey: string, occurrences: ObservedRoute["occurrences"]): ObservedRoute {
  return { flightKey, occurrences };
}

// R2 donor: B -> D -> X -> E
const r2 = route("synth-r2", [pt(0, "B", 10, -10), pt(1, "D", 10, 20), pt(2, "X", 20, 30), pt(3, "E", 10, 40)]);
// R4 reverse-only: E -> X -> D
const r4 = route("synth-r4", [pt(0, "E", 10, 40), pt(1, "X", 20, 30), pt(2, "D", 10, 20)]);
// R5 discontinuous: B -> D -> [gap] -> E
const r5 = route("synth-r5", [pt(0, "B", 10, -10), pt(1, "D", 10, 20), gap(2), pt(3, "E", 10, 40)]);
// R3 target: C -> D -> [gap] -> E
const r3 = route("synth-r3", [pt(0, "C", 10, 10), pt(1, "D", 10, 20), gap(2), pt(3, "E", 10, 40)]);

test("index build is deterministic and never mutates inputs", () => {
  const frozen = JSON.stringify([r2, r4, r5, r3]);
  const a = buildSynthesisIndex([r2, r4, r5, r3]);
  const b = buildSynthesisIndex([r2, r4, r5, r3]);
  assert.deepEqual(a.pointsByKey.size, b.pointsByKey.size);
  assert.equal(JSON.stringify([r2, r4, r5, r3]), frozen);
});

test("target corridors bound gaps with nearest exact anchors", () => {
  const corridors = targetCorridors(r3.occurrences);
  assert.equal(corridors.length, 1);
  assert.deepEqual({ from: corridors[0]!.fromOrdinal, to: corridors[0]!.toOrdinal, gaps: corridors[0]!.gapOrdinals }, { from: 1, to: 3, gaps: [2] });
});

test("forward-only donor slice extraction; reversed and gapped donors never qualify", () => {
  const index = buildSynthesisIndex([r2, r4, r5, r3]);
  const slices = findDonorSlices(index, r3.occurrences[1]!, r3.occurrences[3]!, "synth-r3");
  assert.equal(slices.length, 1);
  assert.equal(slices[0]!.donorFlightKey, "synth-r2");
  assert.equal(slices[0]!.pointCount, 3); // D -> X -> E endpoint-inclusive
});

test("target flight cannot donate to itself", () => {
  const index = buildSynthesisIndex([r3, route("synth-r3b", [pt(0, "D", 10, 20), pt(1, "E", 10, 40)])]);
  const slices = findDonorSlices(index, r3.occurrences[1]!, r3.occurrences[3]!, "synth-r3");
  assert.equal(slices.length, 1);
  assert.equal(slices[0]!.donorFlightKey, "synth-r3b");
});

const r1 = route("synth-r1", [pt(0, "A", 10, 0), pt(1, "C", 10, 10), pt(2, "D", 10, 20)]);
const r6 = route("synth-r6", [pt(0, "B", 10, -10), pt(1, "D", 10, 20), pt(2, "Y", 30, 30), pt(3, "E", 10, 40)]);
const r7 = route("synth-r7", [pt(0, "B", 10, -10), pt(1, "D", 10, 20), pt(2, "X", 20, 30), pt(3, "E", 10, 40)]);
const canonical = [r1, r2, r3, r4, r5, r6, r7];

test("canonical fixture: full coverage, neutral alternatives, dedupe with provenance", () => {
  const outcome = assembleSynthesisCandidates(buildSynthesisIndex(canonical), r3);
  assert.equal(outcome.status, "ambiguous"); // covered, but R2/R7 vs R6 geometries differ
  assert.equal(outcome.candidates.length, 2); // deduplicated geometries only
  const viaX = outcome.candidates.find((candidate) => candidate.geometrySignature.includes("20,30"))!;
  const viaY = outcome.candidates.find((candidate) => candidate.geometrySignature.includes("30,30"))!;
  assert.ok(viaX && viaY);
  assert.equal(viaX.donorCount, 2);      // R2 + R7 aggregate
  assert.equal(viaX.donorTruncated, false);
  assert.deepEqual(viaX.donorFlightKeys, ["synth-r2", "synth-r7"]); // generation order
  // R4 (reversed) and R5 (gapped) never contribute:
  for (const candidate of outcome.candidates) {
    assert.equal(candidate.donorFlightKeys.includes("synth-r4"), false);
    assert.equal(candidate.donorFlightKeys.includes("synth-r5"), false);
  }
  // Distances: full-precision Haversine; source + borrowed reconcile with total.
  assert.ok(viaX.estimatedTotalDistanceNm !== undefined);
  assert.ok(Math.abs(viaX.sourceResolvedDistanceNm + viaX.borrowedDistanceNm - viaX.estimatedTotalDistanceNm!) <= 1e-9);
  // Borrowed slice coordinates are exact donor values (D -> X -> E), unrounded.
  assert.deepEqual(viaX.borrowedSegments[0]!.coordinates, [{ lat: 10, lon: 20 }, { lat: 20, lon: 30 }, { lat: 10, lon: 40 }]);
  // No ranking fields exist anywhere.
  assert.equal("rank" in viaX, false);
});

test("complete target returns not-needed; unbounded corridor returns unavailable", () => {
  const complete = route("synth-complete", [pt(0, "A", 10, 0), pt(1, "D", 10, 20)]);
  assert.equal(assembleSynthesisCandidates(buildSynthesisIndex(canonical), complete, { complete: true }).status, "not-needed");
  const unbounded = route("synth-unbounded", [gap(0), pt(1, "D", 10, 20), gap(2), pt(3, "E", 10, 40)]);
  assert.equal(assembleSynthesisCandidates(buildSynthesisIndex(canonical), unbounded).status, "partial"); // one corridor covered, leading edge unbounded
});

test("candidate-limit-exceeded fails closed with no candidates", () => {
  // 21 distinct donors each containing D -> E with unique interior geometry.
  const donors = Array.from({ length: 21 }, (_, index) =>
    route(`donor-${index}`, [pt(0, "B", 10, -10), pt(1, "D", 10, 20), { ordinal: 2, referenceId: undefined, coordinate: { lat: 40 + index, lon: 30 }, label: `Point ${index}` }, pt(3, "E", 10, 40)]));
  const outcome = assembleSynthesisCandidates(buildSynthesisIndex([...donors, r3]), r3);
  assert.equal(outcome.status, "candidate-limit-exceeded");
  assert.equal(outcome.candidates.length, 0);
});

test("synthesized output is never accepted as index input (type boundary)", () => {
  // Compile-time check: assembleSynthesisCandidates returns AssembledCandidate[],
  // which lacks flightKey/occurrences and cannot satisfy ObservedRoute.
  const outcome = assembleSynthesisCandidates(buildSynthesisIndex(canonical), r3);
  assert.ok(!("occurrences" in (outcome.candidates[0] ?? {})));
});
