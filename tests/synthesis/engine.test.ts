import assert from "node:assert/strict";
import test from "node:test";
import { buildSynthesisIndex, targetCorridors, findDonorSlices, type ObservedRoute } from "../../packages/route-engine/src/synthesis.ts";

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
