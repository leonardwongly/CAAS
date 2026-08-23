// Adversarial sweep D2 — geometry & resolution core (owner: D2 sub-agent).
// Scope: packages/route-engine/src/gap-distance.ts — corridor feature
// invariants under singular geometry, smuggled non-finite coordinates,
// zero/out-of-support/insufficient-confidence prediction fallbacks, duplicate
// adjacent points in masked examples, and the per-route example cap.
// Non-duplication: gap-distance.test.ts pins convention parity, split
// leakage, training fail-closed, and one calibrated estimate; A3 pins
// identical-anchor features, degenerate masked routes, and split totality.
// This file covers the prediction fallback reasons, heading-consistency
// invariants, dateline paths, and cap endpoint preservation none of them
// touch.
import assert from "node:assert/strict";
import test from "node:test";
import type { Coordinate } from "../../packages/contracts/src/index.ts";
import {
  createGapDistanceFeatures,
  createMaskedGapDistanceExamples,
  pathDistanceNm,
  predictGapDistance,
  trainGapDistanceModel,
  type GapDistanceFeatures,
  type GapDistanceTrainingRoute,
  type TrainedGapDistanceModel,
} from "../../packages/route-engine/src/gap-distance.ts";

const CORPUS_COORDINATES: Coordinate[] = [
  { lat: 0, lon: 0 },
  { lat: 2, lon: 5 },
  { lat: 0, lon: 10 },
  { lat: 1, lon: 15 },
];

function trainSmallModel(): TrainedGapDistanceModel {
  const routes = Array.from({ length: 30 }, (_, index): GapDistanceTrainingRoute => ({
    routeGroup: `sweep-family-${index}`,
    coordinates: CORPUS_COORDINATES,
  }));
  const model = trainGapDistanceModel(routes, {
    modelVersion: "sweep-d2-model",
    createdAt: "2026-08-23T00:00:00.000Z",
    trainingDigestSha256: "b".repeat(64),
    confidenceLevel: 0.8,
    minimumIndependentRouteGroups: 30,
    minimumIndependentRouteGroupsPerCell: 3,
    minimumCalibrationRouteGroups: 6,
    minimumTestRouteGroups: 6,
    minimumHeldOutCoverage: 0.8,
  });
  assert.equal(model.status, "trained", "the sweep corpus must produce a trained model");
  return model as TrainedGapDistanceModel;
}

function classify(maximumDeviation: number | undefined): GapDistanceFeatures["headingContext"] {
  if (maximumDeviation === undefined) return "unbounded";
  if (maximumDeviation <= 15) return "aligned";
  if (maximumDeviation <= 45) return "moderate";
  return "sharp";
}

test("feature invariants hold under dateline, polar, and antipodal anchor geometry", () => {
  const cases = [
    // Corridor straddling the antimeridian with collinear neighbours.
    { anchorFrom: { lat: 0, lon: 179 }, anchorTo: { lat: 0, lon: -179 }, previousCoordinate: { lat: 0, lon: 177 }, nextCoordinate: { lat: 0, lon: -177 } },
    // Chord over the pole region with neighbours on both meridians.
    { anchorFrom: { lat: 89, lon: 0 }, anchorTo: { lat: 89, lon: 180 }, previousCoordinate: { lat: 88, lon: 0 }, nextCoordinate: { lat: 88, lon: 180 } },
    // Exact antipodal chord (bearing is singular) with adjacent waypoints.
    { anchorFrom: { lat: 0, lon: 0 }, anchorTo: { lat: 0, lon: 180 }, previousCoordinate: { lat: 0, lon: -1 }, nextCoordinate: { lat: 0, lon: 179 } },
    // Signed-zero anchors at the coordinate-box corner.
    { anchorFrom: { lat: -0, lon: -0 }, anchorTo: { lat: 0, lon: 1 }, previousCoordinate: { lat: -0, lon: -1 } },
  ];
  for (const input of cases) {
    const features = createGapDistanceFeatures(input);
    assert.ok(Number.isFinite(features.anchorDistanceNm) && features.anchorDistanceNm >= 0);
    assert.ok(features.anchorDistanceNm > 0 ? Number.isFinite(features.logAnchorDistanceNm) : features.logAnchorDistanceNm === Number.NEGATIVE_INFINITY);
    assert.ok(features.midpointAbsoluteLatitude >= 0 && features.midpointAbsoluteLatitude <= 90);
    const deviations = [features.inboundDeviationDegrees, features.outboundDeviationDegrees];
    for (const deviation of deviations) {
      if (deviation !== undefined) assert.ok(deviation >= 0 && deviation <= 180, `deviation out of range: ${deviation}`);
    }
    const maximum = deviations.filter((value): value is number => value !== undefined);
    assert.equal(features.headingContext, classify(maximum.length ? Math.max(...maximum) : undefined));
    if (features.chordBearingDegrees !== undefined) {
      assert.ok(features.chordBearingDegrees >= 0 && features.chordBearingDegrees < 360);
    }
  }
  // The collinear dateline corridor must classify as aligned, not degrade to
  // unbounded because bearings crossed the seam.
  const seam = createGapDistanceFeatures(cases[0]!);
  assert.equal(seam.headingContext, "aligned");
  assert.ok((seam.inboundDeviationDegrees ?? 0) <= 15 && (seam.outboundDeviationDegrees ?? 0) <= 15);
});

test("smuggled non-finite coordinates never produce an estimate or an example", () => {
  const trained = trainSmallModel();
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    const features = createGapDistanceFeatures({ anchorFrom: { lat: bad, lon: 0 }, anchorTo: { lat: 1, lon: 1 } });
    const prediction = predictGapDistance(features, trained);
    assert.notEqual(prediction.status, "estimated", "non-finite geometry must never estimate");
    assert.equal(createMaskedGapDistanceExamples({ routeGroup: "sweep", coordinates: [{ lat: bad, lon: 0 }, { lat: 1, lon: 5 }, { lat: 0, lon: 10 }] }).length, 0);
    assert.equal(createMaskedGapDistanceExamples({ routeGroup: "sweep", coordinates: [{ lat: 0, lon: 0 }, { lat: 1, lon: bad }, { lat: 0, lon: 10 }] }).length, 0);
  }
  // Out-of-box-but-finite coordinates are rejected by the example guard too.
  assert.equal(createMaskedGapDistanceExamples({ routeGroup: "sweep", coordinates: [{ lat: 90.5, lon: 0 }, { lat: 1, lon: 5 }, { lat: 0, lon: 10 }] }).length, 0);
  assert.equal(createMaskedGapDistanceExamples({ routeGroup: "sweep", coordinates: [{ lat: 0, lon: 180.5 }, { lat: 1, lon: 5 }, { lat: 0, lon: 10 }] }).length, 0);
});

test("trained-model fallbacks: zero anchors, out-of-support spans, and unattainable confidence each fail closed with their own reason", () => {
  const trained = trainSmallModel();
  // Identical anchors: no corridor exists — the exact zero must be reported,
  // never estimated.
  const zeroAnchor = createGapDistanceFeatures({ anchorFrom: { lat: 5, lon: 5 }, anchorTo: { lat: 5, lon: 5 } });
  assert.equal(zeroAnchor.anchorDistanceNm, 0);
  assert.equal(zeroAnchor.logAnchorDistanceNm, Number.NEGATIVE_INFINITY);
  const zeroPrediction = predictGapDistance(zeroAnchor, trained);
  assert.equal(zeroPrediction.status, "unavailable");
  if (zeroPrediction.status === "unavailable") {
    assert.equal(zeroPrediction.reason, "ZERO_LENGTH_ANCHORS");
    assert.equal(zeroPrediction.minimumNm, 0);
  }
  // A span far beyond every training anchor sits outside the calibrated support.
  const wideSpan = createGapDistanceFeatures({ anchorFrom: { lat: 0, lon: 0 }, anchorTo: { lat: 0, lon: 40 } });
  assert.ok(wideSpan.anchorDistanceNm > trained.support.maximumAnchorDistanceNm, "test geometry must exceed the trained support");
  const widePrediction = predictGapDistance(wideSpan, trained);
  assert.equal(widePrediction.status, "unavailable");
  if (widePrediction.status === "unavailable") assert.equal(widePrediction.reason, "OUTSIDE_TRAINING_SUPPORT");
  // The conformal rank ceil((n+1)p) is unattainable near certainty for a small
  // calibration set: the interval refuses rather than pretending coverage.
  const inSupport = createGapDistanceFeatures({ anchorFrom: CORPUS_COORDINATES[0]!, anchorTo: CORPUS_COORDINATES[2]!, nextCoordinate: CORPUS_COORDINATES[3]!, endpointCorridor: true, coveredGapCount: 1 });
  assert.equal(predictGapDistance(inSupport, trained, 0.8).status, "estimated");
  const overconfident = predictGapDistance(inSupport, trained, 0.9999);
  assert.equal(overconfident.status, "unavailable");
  if (overconfident.status === "unavailable") assert.equal(overconfident.reason, "INSUFFICIENT_CALIBRATION_FOR_CONFIDENCE");
});

test("pathDistanceNm crosses the dateline on the short arc, never the 358-degree wrap", () => {
  const seam = pathDistanceNm([{ lat: 0, lon: 179 }, { lat: 0, lon: -179 }]);
  const plain = pathDistanceNm([{ lat: 0, lon: 0 }, { lat: 0, lon: 2 }]);
  assert.ok(Math.abs(seam - plain) < 1e-9);
  // A multi-leg path alternating across the seam sums leg-by-leg short arcs.
  const zigzag = pathDistanceNm([{ lat: 0, lon: 179 }, { lat: 0, lon: -179 }, { lat: 0, lon: 179 }, { lat: 0, lon: -179 }]);
  assert.ok(Math.abs(zigzag - 3 * plain) < 1e-9, "three 2-degree seam legs must equal three plain 2-degree legs");
});

test("duplicate adjacent points never corrupt masked examples: circuity stays >= 1 and finite", () => {
  const route: GapDistanceTrainingRoute = {
    routeGroup: "duplicates",
    coordinates: [
      { lat: 0, lon: 0 },
      { lat: 0, lon: 0 },
      { lat: 1, lon: 5 },
      { lat: 1, lon: 5 },
      { lat: 0, lon: 10 },
    ],
  };
  const examples = createMaskedGapDistanceExamples(route);
  assert.ok(examples.length > 0);
  for (const example of examples) {
    assert.ok(Number.isFinite(example.observedPathNm) && example.observedPathNm > 0);
    assert.ok(example.logCircuity >= 0, "zero-length legs can only add path length, never shorten it");
    assert.ok(Number.isFinite(example.features.anchorDistanceNm) && example.features.anchorDistanceNm > 0);
    assert.equal(example.mask.hiddenPointCount, example.mask.toIndex - example.mask.fromIndex - 1);
  }
  // A fully duplicated interior must not change the outer anchor's observed
  // path beyond the recorded zero-length legs.
  const collapsed = examples.find((example) => example.mask.fromIndex === 0 && example.mask.toIndex === 4)!;
  const cleanRoute: GapDistanceTrainingRoute = { routeGroup: "clean", coordinates: [{ lat: 0, lon: 0 }, { lat: 1, lon: 5 }, { lat: 0, lon: 10 }] };
  const clean = createMaskedGapDistanceExamples(cleanRoute)[0]!;
  assert.equal(collapsed.observedPathNm, clean.observedPathNm, "zero-length duplicate legs contribute exactly zero");
  // An all-identical route yields nothing rather than a zero-distance example.
  assert.equal(createMaskedGapDistanceExamples({ routeGroup: "sweep", coordinates: [{ lat: 3, lon: 3 }, { lat: 3, lon: 3 }, { lat: 3, lon: 3 }] }).length, 0);
});

test("the per-route example cap preserves enumeration endpoints and degrades without throwing", () => {
  const coordinates = Array.from({ length: 30 }, (_, index): Coordinate => ({ lat: (index % 3) - 1, lon: index * 2 }));
  const uncapped = createMaskedGapDistanceExamples({ routeGroup: "long", coordinates });
  assert.ok(uncapped.length > 5, "the fixture must exceed the cap");
  const first = uncapped[0]!;
  const last = uncapped[uncapped.length - 1]!;
  const capped = createMaskedGapDistanceExamples({ routeGroup: "long", coordinates }, 5);
  assert.equal(capped.length, 5);
  assert.ok(capped.some((example) => example.mask.fromIndex === first.mask.fromIndex && example.mask.toIndex === first.mask.toIndex), "the first enumerated mask survives the cap");
  assert.ok(capped.some((example) => example.mask.fromIndex === last.mask.fromIndex && example.mask.toIndex === last.mask.toIndex), "the last enumerated mask survives the cap");
  // Degenerate caps: zero keeps a single example, NaN fails closed to none,
  // and neither throws.
  assert.equal(createMaskedGapDistanceExamples({ routeGroup: "long", coordinates }, 0).length, 1);
  assert.equal(createMaskedGapDistanceExamples({ routeGroup: "long", coordinates }, Number.NaN).length, 0);
  // Fractional caps truncate rather than sample out of bounds.
  const fractional = createMaskedGapDistanceExamples({ routeGroup: "long", coordinates }, 3.9);
  assert.equal(fractional.length, 3);
});
