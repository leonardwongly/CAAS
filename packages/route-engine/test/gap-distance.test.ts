import assert from "node:assert/strict";
import test from "node:test";
import { haversineDistanceNm } from "../src/index.ts";
import {
  assignGapDistanceSplits,
  createGapDistanceFeatures,
  createMaskedGapDistanceExamples,
  predictGapDistance,
  trainGapDistanceModel,
  validateGapDistanceModelFile,
  type GapDistanceTrainingRoute,
} from "../src/gap-distance.ts";

const digest = "a".repeat(64);
const unavailableModel = {
  schemaVersion: 1,
  status: "unavailable",
  reason: "NO_CORPUS",
  message: "No approved corpus.",
} as const;

test("gap estimator uses the same Haversine convention as source modeled distance", () => {
  const from = { lat: -30.81, lon: 115.86 };
  const to = { lat: -16.28, lon: 113.01 };
  const features = createGapDistanceFeatures({ anchorFrom: from, anchorTo: to });
  assert.equal(features.anchorDistanceNm, haversineDistanceNm(from, to));
  assert.ok(Math.abs(features.anchorDistanceNm - 886.261965478468) < 1e-9);
});

test("masked examples change their label but not visible features when only a hidden point changes", () => {
  const base: GapDistanceTrainingRoute = {
    routeGroup: "family-a",
    coordinates: [
      { lat: 0, lon: 0 },
      { lat: 2, lon: 5 },
      { lat: 0, lon: 10 },
      { lat: 0, lon: 15 },
    ],
  };
  const changed: GapDistanceTrainingRoute = {
    ...base,
    coordinates: [base.coordinates[0]!, { lat: 8, lon: 5 }, base.coordinates[2]!, base.coordinates[3]!],
  };
  const original = createMaskedGapDistanceExamples(base).find((example) => example.mask.fromIndex === 0 && example.mask.toIndex === 2)!;
  const replacement = createMaskedGapDistanceExamples(changed).find((example) => example.mask.fromIndex === 0 && example.mask.toIndex === 2)!;
  assert.deepEqual(replacement.features, original.features);
  assert.notEqual(replacement.observedPathNm, original.observedPathNm);
  assert.notEqual(replacement.logCircuity, original.logCircuity);
});

test("all examples from one route group receive one leakage-safe split", () => {
  const assignments = assignGapDistanceSplits(Array.from({ length: 30 }, (_, index) => `family-${index}`), "fixed-test-salt");
  assert.equal(assignments.size, 30);
  assert.deepEqual(new Set(assignments.values()), new Set(["train", "calibration", "test"]));
  assert.equal(assignments.get("family-4"), assignGapDistanceSplits(["family-4", "other", "third"], "fixed-test-salt").get("family-4"));
});

test("training fails closed when independent complete-route support is insufficient", () => {
  const result = trainGapDistanceModel([
    { routeGroup: "only-family", coordinates: [{ lat: 0, lon: 0 }, { lat: 1, lon: 5 }, { lat: 0, lon: 10 }] },
  ], {
    modelVersion: "test-model",
    createdAt: "2026-08-16T00:00:00.000Z",
    trainingDigestSha256: digest,
  });
  assert.equal(result.status, "unavailable");
  if (result.status === "unavailable") assert.equal(result.reason, "INSUFFICIENT_INDEPENDENT_COMPLETE_ROUTES");
});

test("trained artifacts contain aggregates only and produce calibrated estimates", () => {
  const coordinates = [
    { lat: 0, lon: 0 },
    { lat: 2, lon: 5 },
    { lat: 0, lon: 10 },
    { lat: 1, lon: 15 },
  ];
  const routes = Array.from({ length: 30 }, (_, index): GapDistanceTrainingRoute => ({
    routeGroup: `private-family-${index}`,
    coordinates,
    retrievedAt: "2026-08-15T00:00:00.000Z",
  }));
  const model = trainGapDistanceModel(routes, {
    modelVersion: "test-calibrated-v1",
    createdAt: "2026-08-16T00:00:00.000Z",
    trainingDigestSha256: digest,
    confidenceLevel: 0.8,
    minimumIndependentRouteGroups: 30,
    minimumIndependentRouteGroupsPerCell: 3,
    minimumCalibrationRouteGroups: 6,
    minimumTestRouteGroups: 6,
    minimumHeldOutCoverage: 0.8,
  });
  assert.equal(model.status, "trained");
  if (model.status !== "trained") return;
  assert.equal(model.training.routeGroups, 30);
  assert.equal(model.validation.heldOutCoverage, 1);
  const serialized = JSON.stringify(model);
  assert.equal(serialized.includes("private-family"), false);
  assert.equal(/\"routeGroup\"\s*:/.test(serialized), false);

  const features = createGapDistanceFeatures({ anchorFrom: coordinates[0]!, anchorTo: coordinates[2]!, nextCoordinate: coordinates[3]!, endpointCorridor: true, coveredGapCount: 1 });
  const prediction = predictGapDistance(features, model, 0.8);
  assert.equal(prediction.status, "estimated");
  if (prediction.status === "estimated") {
    assert.ok(prediction.medianNm >= prediction.minimumNm);
    assert.ok(prediction.interval.lowerNm >= prediction.minimumNm);
    assert.ok(prediction.interval.upperNm >= prediction.medianNm);
    assert.equal(prediction.interval.confidenceLevel, 0.8);
  }
});

test("invalid or unavailable artifacts never produce a statistical estimate", () => {
  const features = createGapDistanceFeatures({ anchorFrom: { lat: 0, lon: 0 }, anchorTo: { lat: 0, lon: 2 } });
  assert.equal(predictGapDistance(features, unavailableModel).status, "unavailable");
  const invalid = validateGapDistanceModelFile({ schemaVersion: 1, status: "trained", modelVersion: "broken" });
  assert.equal(invalid.status, "unavailable");
  if (invalid.status === "unavailable") assert.equal(invalid.reason, "INVALID_MODEL_ARTIFACT");
});
