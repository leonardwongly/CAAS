import test from "node:test";
import assert from "node:assert/strict";
import {
  LIVE_FRESH_MS,
  LIVE_UNUSABLE_MS,
  REFERENCE_FRESH_MS,
  REFERENCE_UNUSABLE_MS,
  freshnessState,
  isGenerationUsable,
  liveFreshnessState,
  referenceFreshnessState,
  worseGenerationState,
} from "../src/index.ts";

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

test("plan §6.2 windows are exactly 5 minutes, 30 minutes, 24 hours, and 7 days", () => {
  assert.equal(LIVE_FRESH_MS, 5 * MINUTE_MS);
  assert.equal(LIVE_UNUSABLE_MS, 30 * MINUTE_MS);
  assert.equal(REFERENCE_FRESH_MS, 24 * HOUR_MS);
  assert.equal(REFERENCE_UNUSABLE_MS, 7 * DAY_MS);
});

test("live tier: fresh at and below 5 minutes, stale to 30 minutes, unusable after", () => {
  assert.equal(liveFreshnessState(0), "fresh");
  assert.equal(liveFreshnessState(5 * MINUTE_MS), "fresh");
  assert.equal(liveFreshnessState(5 * MINUTE_MS + 1), "stale");
  assert.equal(liveFreshnessState(30 * MINUTE_MS), "stale");
  assert.equal(liveFreshnessState(30 * MINUTE_MS + 1), "unusable");
  assert.equal(liveFreshnessState(DAY_MS), "unusable");
});

test("reference tier: fresh at and below 24 hours, stale to 7 days, unusable after", () => {
  assert.equal(referenceFreshnessState(0), "fresh");
  assert.equal(referenceFreshnessState(24 * HOUR_MS), "fresh");
  assert.equal(referenceFreshnessState(24 * HOUR_MS + 1), "stale");
  assert.equal(referenceFreshnessState(7 * DAY_MS), "stale");
  assert.equal(referenceFreshnessState(7 * DAY_MS + 1), "unusable");
});

test("general state function honors inclusive boundaries and rejects bad windows", () => {
  assert.equal(freshnessState(10, 10, 20), "fresh");
  assert.equal(freshnessState(11, 10, 20), "stale");
  assert.equal(freshnessState(20, 10, 20), "stale");
  assert.equal(freshnessState(21, 10, 20), "unusable");
  assert.throws(() => freshnessState(-1, 10, 20), RangeError);
  assert.throws(() => freshnessState(NaN, 10, 20), RangeError);
  assert.throws(() => freshnessState(1, 20, 20), RangeError);
  assert.throws(() => freshnessState(1, -1, 20), RangeError);
});

test("overall state is the more severe tier state", () => {
  assert.equal(worseGenerationState("fresh", "fresh"), "fresh");
  assert.equal(worseGenerationState("fresh", "stale"), "stale");
  assert.equal(worseGenerationState("stale", "fresh"), "stale");
  assert.equal(worseGenerationState("stale", "unusable"), "unusable");
  assert.equal(worseGenerationState("unusable", "fresh"), "unusable");
});

test("only unusable generations are not servable", () => {
  assert.equal(isGenerationUsable("fresh"), true);
  assert.equal(isGenerationUsable("stale"), true);
  assert.equal(isGenerationUsable("unusable"), false);
});
