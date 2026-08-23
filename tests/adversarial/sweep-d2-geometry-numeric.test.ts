// Adversarial sweep D2 — geometry & resolution core (owner: D2 sub-agent).
// Scope: numeric overflow & fail-closed contracts of the distance helpers in
// packages/route-engine/src/index.ts and compare.ts.
// Non-duplication: A3 (adv-engine-geometry.test.ts) covers NaN/Infinity/
// negative rejection and zero-baseline comparison; route-engine.test.ts
// covers nominal rounding precision. This file pins the overflow boundaries
// those suites leave open, including the regressions fixed by the D2 sweep.
import assert from "node:assert/strict";
import test from "node:test";
import {
  compareDistanceOperands,
  displayDistanceNm,
  sumDistanceNm,
} from "../../packages/route-engine/src/index.ts";

// Regression (D2 sweep): displayDistanceNm validates its input as finite but
// the *10 rounding step overflows finite inputs above Number.MAX_VALUE / 10,
// silently returning Infinity as "rounded" UI copy. The helper must fail
// closed instead of emitting a non-finite display value.
test("displayDistanceNm fails closed when the rounding step overflows, and stays finite just below the overflow edge", () => {
  assert.throws(() => displayDistanceNm(Number.MAX_VALUE), RangeError);
  assert.throws(() => displayDistanceNm(Number.MAX_VALUE / 2), RangeError);
  // MAX_VALUE / 10 is the largest input whose *10 step stays representable.
  const atEdge = displayDistanceNm(Number.MAX_VALUE / 10);
  assert.ok(Number.isFinite(atEdge) && atEdge >= 0);
  // A large but domain-plausible total still rounds to 0.1 NM exactly.
  assert.equal(displayDistanceNm(123456789.04), 123456789.0);
  assert.equal(displayDistanceNm(123456789.05), 123456789.1);
});

// Regression (D2 sweep): sumDistanceNm validated every element as finite but
// returned Infinity when finite legs overflowed the accumulator, letting a
// non-finite modeled total escape toward createRouteCandidate/UI copy.
test("sumDistanceNm rejects accumulator overflow while staying exact for large finite totals", () => {
  assert.throws(() => sumDistanceNm([Number.MAX_VALUE, Number.MAX_VALUE]), RangeError);
  assert.throws(() => sumDistanceNm([1, Number.MAX_VALUE, Number.MAX_VALUE]), RangeError);
  // A single maximal element does not overflow the accumulator.
  assert.equal(sumDistanceNm([Number.MAX_VALUE]), Number.MAX_VALUE);
  // MAX_VALUE / 2 + MAX_VALUE / 2 stays representable and exact.
  assert.equal(sumDistanceNm([Number.MAX_VALUE / 2, Number.MAX_VALUE / 2]), Number.MAX_VALUE);
  // Subnormal legs accumulate without precision theatre.
  assert.equal(sumDistanceNm([Number.MIN_VALUE, Number.MIN_VALUE]), 1e-323);
});

// Regression (D2 sweep): compareDistanceOperands reported status "complete"
// with percentageDistanceDelta === Infinity when a subnormal baseline divided
// into a macroscopic delta; App.tsx renders that ratio verbatim as "+Infinity%".
// The unrepresentable percentage is now withheld under NON_FINITE_PERCENTAGE
// while the exact directed delta remains available.
test("compareDistanceOperands withholds an overflowed percentage but keeps the exact delta", () => {
  const comparison = compareDistanceOperands(Number.MIN_VALUE, 1);
  assert.equal(comparison.status, "complete");
  assert.equal(comparison.distanceDeltaNm, 1, "1 - 5e-324 absorbs to exactly 1");
  assert.equal(comparison.percentageDistanceDelta, undefined);
  assert.deepEqual(comparison.unavailable, ["NON_FINITE_PERCENTAGE"]);
});

test("compareDistanceOperands keeps subnormal arithmetic exact whenever the ratio is representable", () => {
  // Both operands subnormal: the ratio is a small exact integer percentage.
  const subnormalPair = compareDistanceOperands(Number.MIN_VALUE, 2 * Number.MIN_VALUE + Number.MIN_VALUE);
  assert.equal(subnormalPair.status, "complete");
  assert.equal(subnormalPair.distanceDeltaNm, 2 * Number.MIN_VALUE);
  assert.equal(subnormalPair.percentageDistanceDelta, 200);
  assert.deepEqual(subnormalPair.unavailable, []);
  // Equal maximal operands: delta and percentage are exactly zero, no codes.
  const maximal = compareDistanceOperands(Number.MAX_VALUE, Number.MAX_VALUE);
  assert.equal(maximal.distanceDeltaNm, 0);
  assert.equal(maximal.percentageDistanceDelta, 0);
  assert.deepEqual(maximal.unavailable, []);
});

test("compareDistanceOperands treats -0 and +0 baselines identically as ZERO_BASELINE", () => {
  const negativeZero = compareDistanceOperands(-0, 7);
  const positiveZero = compareDistanceOperands(0, 7);
  assert.deepEqual(negativeZero, positiveZero);
  assert.equal(negativeZero.status, "complete");
  assert.equal(negativeZero.distanceDeltaNm, 7);
  assert.equal(negativeZero.percentageDistanceDelta, undefined);
  assert.deepEqual(negativeZero.unavailable, ["ZERO_BASELINE"]);
});
