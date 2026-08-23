import { describe, expect, it } from "vitest";
import {
  createGapDistanceFeatures,
  predictGapDistance,
  validateGapDistanceModelFile,
  type GapDistanceModelFile,
  type TrainedGapDistanceModel,
} from "../../packages/route-engine/src/gap-distance.ts";
import { analyzeIncompleteRouteDistance } from "../../apps/web/src/gapDistanceEstimate.ts";
import { BUNDLED_GAP_DISTANCE_MODEL } from "../../apps/web/src/gapDistanceModel.ts";
import type { RouteOption } from "../../apps/web/src/api.ts";

/**
 * Adversarial sweep owner: D6 — web data layer & gap model.
 *
 * Numeric boundary corruption against the gap-distance model as consumed by
 * the web layer (apps/web/src/gapDistanceModel.ts + gapDistanceEstimate.ts):
 * hostile model-JSON artifacts, interpolation/support boundaries, and
 * negative/zero distances.
 *
 * Deliberately NOT duplicating:
 * - packages/route-engine/test/gap-distance.test.ts (training pipeline and a
 *   single trivially-broken artifact),
 * - adv-engine-geometry.test.ts (Haversine extremes, identical-anchor
 *   features, masked-example fail-closed),
 * - tests/e2e/gap-distance.test.tsx (corridor grouping, multi-corridor
 *   aggregation, endpoint-only records, drawer separation).
 *
 * Covered here, previously uncovered:
 * - the bundled artifact's exact contract (validated pass-through, reason
 *   propagation into predictions and analyses);
 * - a full hostile-artifact table (edges, support, cells, residuals, digest,
 *   timestamps, validation gates) failing closed to INVALID_MODEL_ARTIFACT
 *   and degrading the analysis to lower-bound-only;
 * - exact support-boundary interpolation (min/max inclusive, one step
 *   beyond fails closed), zero-length anchors, weak cells, and degenerate
 *   confidence levels;
 * - negative/NaN resolved-leg distances poisoning no subtotal, degenerate
 *   route confidence levels, per-corridor confidence correction, and
 *   unmappable gap runs.
 */

const VALID_MODEL: TrainedGapDistanceModel = {
  schemaVersion: 1,
  status: "trained",
  modelVersion: "d6-sweep-v1",
  createdAt: "2026-08-23T00:00:00.000Z",
  distanceConvention: { method: "haversine", earthRadiusNm: 3440.065 },
  target: "log-circuity-ratio",
  spanEdgesNm: [0, 100, 300, 600, 1200, 2400, 5000],
  support: { minimumAnchorDistanceNm: 1, maximumAnchorDistanceNm: 5000 },
  minimumIndependentRouteGroupsPerCell: 10,
  training: { digestSha256: "c".repeat(64), routeGroups: 100, examples: 400, calibrationRouteGroups: 20, testRouteGroups: 20 },
  cells: [{ level: "global", medianLogCircuity: Math.log(1.05), exampleCount: 240, independentRouteGroups: 60 }],
  calibrationResidualsLog: Array.from({ length: 20 }, () => Math.log(1.1)),
  validation: { confidenceLevel: 0.9, heldOutCoverage: 0.9, heldOutMedianAbsoluteErrorNm: 12, testExamples: 80 },
};

function corrupted(label: string, mutate: (model: TrainedGapDistanceModel) => void): [string, GapDistanceModelFile] {
  const model = structuredClone(VALID_MODEL);
  mutate(model);
  return [label, model];
}

const HOSTILE_ARTIFACTS: Array<[string, GapDistanceModelFile]> = [
  corrupted("schemaVersion is a string", (model) => { (model as unknown as Record<string, unknown>).schemaVersion = "1"; }),
  corrupted("schemaVersion bumped", (model) => { (model as unknown as Record<string, unknown>).schemaVersion = 2; }),
  corrupted("unknown status", (model) => { (model as unknown as Record<string, unknown>).status = "calibrated"; }),
  corrupted("span edges not starting at zero", (model) => { model.spanEdgesNm = [50, 100, 300]; }),
  corrupted("span edges unsorted", (model) => { model.spanEdgesNm = [0, 300, 100]; }),
  corrupted("span edges duplicated", (model) => { model.spanEdgesNm = [0, 100, 100, 300]; }),
  corrupted("span edges single entry", (model) => { model.spanEdgesNm = [0]; }),
  corrupted("span edges contain NaN", (model) => { model.spanEdgesNm = [0, Number.NaN, 300]; }),
  corrupted("support minimum negative", (model) => { model.support.minimumAnchorDistanceNm = -1; }),
  corrupted("support inverted", (model) => { model.support.minimumAnchorDistanceNm = 4000; model.support.maximumAnchorDistanceNm = 10; }),
  corrupted("support NaN", (model) => { model.support.maximumAnchorDistanceNm = Number.NaN; }),
  corrupted("wrong earth radius", (model) => { (model.distanceConvention as { method: "haversine"; earthRadiusNm: number }).earthRadiusNm = 3440.1; }),
  corrupted("wrong distance method", (model) => { model.distanceConvention.method = "vincenty" as "haversine"; }),
  corrupted("wrong prediction target", (model) => { model.target = "circuity-ratio" as "log-circuity-ratio"; }),
  corrupted("minimum groups per cell zero", (model) => { model.minimumIndependentRouteGroupsPerCell = 0; }),
  corrupted("minimum groups per cell fractional", (model) => { model.minimumIndependentRouteGroupsPerCell = 1.5; }),
  corrupted("empty cell list", (model) => { model.cells = []; }),
  corrupted("cell with negative median log-circuity", (model) => { model.cells[0]!.medianLogCircuity = -0.1; }),
  corrupted("cell with NaN median log-circuity", (model) => { model.cells[0]!.medianLogCircuity = Number.NaN; }),
  corrupted("cell with fractional example count", (model) => { model.cells[0]!.exampleCount = 2.5; }),
  corrupted("cell with zero independent groups", (model) => { model.cells[0]!.independentRouteGroups = 0; }),
  corrupted("cell with unknown level", (model) => { model.cells[0]!.level = "hemisphere" as "global"; }),
  corrupted("empty calibration residuals", (model) => { model.calibrationResidualsLog = []; }),
  corrupted("unsorted calibration residuals", (model) => { model.calibrationResidualsLog = [0.2, 0.1, 0.3]; }),
  corrupted("negative calibration residual", (model) => { model.calibrationResidualsLog = [-0.1, 0.2]; }),
  corrupted("NaN calibration residual", (model) => { model.calibrationResidualsLog = [Number.NaN]; }),
  corrupted("digest one character short", (model) => { model.training.digestSha256 = "c".repeat(63); }),
  corrupted("digest uppercase", (model) => { model.training.digestSha256 = "C".repeat(64); }),
  corrupted("createdAt unparseable", (model) => { model.createdAt = "not-a-date"; }),
  corrupted("validation confidence at zero", (model) => { model.validation.confidenceLevel = 0; }),
  corrupted("validation confidence at one", (model) => { model.validation.confidenceLevel = 1; }),
  corrupted("held-out coverage above one", (model) => { model.validation.heldOutCoverage = 1.5; }),
  corrupted("held-out coverage negative", (model) => { model.validation.heldOutCoverage = -0.1; }),
  corrupted("held-out median absolute error negative", (model) => { model.validation.heldOutMedianAbsoluteErrorNm = -12; }),
  corrupted("held-out median absolute error NaN", (model) => { model.validation.heldOutMedianAbsoluteErrorNm = Number.NaN; }),
];

describe("bundled gap-distance model artifact contract (D6)", () => {
  it("the bundled artifact validates as a pass-through unavailable record", () => {
    expect(BUNDLED_GAP_DISTANCE_MODEL.status).toBe("unavailable");
    if (BUNDLED_GAP_DISTANCE_MODEL.status === "unavailable") {
      expect(BUNDLED_GAP_DISTANCE_MODEL.reason).toBe("INSUFFICIENT_INDEPENDENT_COMPLETE_ROUTES");
      expect(BUNDLED_GAP_DISTANCE_MODEL.message.length).toBeGreaterThan(0);
    }
    expect(validateGapDistanceModelFile(BUNDLED_GAP_DISTANCE_MODEL)).toEqual(BUNDLED_GAP_DISTANCE_MODEL);
  });

  it("predictions and analyses propagate the bundled reason instead of a generic fallback", () => {
    const features = createGapDistanceFeatures({ anchorFrom: { lat: 0, lon: 0 }, anchorTo: { lat: 0, lon: 2 } });
    const prediction = predictGapDistance(features, BUNDLED_GAP_DISTANCE_MODEL);
    expect(prediction.status).toBe("unavailable");
    if (prediction.status === "unavailable") {
      expect(prediction.reason).toBe("INSUFFICIENT_INDEPENDENT_COMPLETE_ROUTES");
      expect(Number.isFinite(prediction.minimumNm)).toBe(true);
    }

    const analysis = analyzeIncompleteRouteDistance(twoGapRoute(), {}, BUNDLED_GAP_DISTANCE_MODEL);
    expect(analysis.status).toBe("lower-bound-only");
    expect(analysis.reason).toBe("INSUFFICIENT_INDEPENDENT_COMPLETE_ROUTES");
    expect(analysis.continuousRouteMinimumNm).toBeGreaterThan(0);
    expect(analysis.aggregateEstimate).toBeUndefined();
  });

  it("the no-model default still yields finite lower bounds", () => {
    const analysis = analyzeIncompleteRouteDistance(twoGapRoute());
    expect(analysis.status).toBe("lower-bound-only");
    expect(analysis.reason).toBe("NO_CALIBRATED_MODEL");
    expect(Number.isFinite(analysis.gapMinimumSubtotalNm)).toBe(true);
  });
});

describe("hostile model artifacts fail closed to INVALID_MODEL_ARTIFACT (D6)", () => {
  it.each(HOSTILE_ARTIFACTS)("rejects a trained artifact where: %s", (_label, artifact) => {
    const validated = validateGapDistanceModelFile(artifact);
    expect(validated.status).toBe("unavailable");
    if (validated.status === "unavailable") expect(validated.reason).toBe("INVALID_MODEL_ARTIFACT");
  });

  it("rejects non-record artifacts and unavailable records missing their explanation", () => {
    for (const hostile of [null, "trained", 42, [VALID_MODEL]]) {
      const validated = validateGapDistanceModelFile(hostile);
      expect(validated.status).toBe("unavailable");
      if (validated.status === "unavailable") expect(validated.reason).toBe("INVALID_MODEL_ARTIFACT");
    }
    const bare = validateGapDistanceModelFile({ schemaVersion: 1, status: "unavailable" });
    expect(bare.status).toBe("unavailable");
    if (bare.status === "unavailable") expect(bare.reason).toBe("INVALID_MODEL_ARTIFACT");
    const explained = validateGapDistanceModelFile({ schemaVersion: 1, status: "unavailable", reason: "R", message: "M" });
    expect(explained).toEqual({ schemaVersion: 1, status: "unavailable", reason: "R", message: "M" });
  });

  it("a corrupted bundled-class artifact degrades the analysis to lower bounds with the rejection reason", () => {
    const analysis = analyzeIncompleteRouteDistance(twoGapRoute(), {}, HOSTILE_ARTIFACTS[0]![1]);
    expect(analysis.status).toBe("lower-bound-only");
    expect(analysis.reason).toBe("INVALID_MODEL_ARTIFACT");
    expect(analysis.corridors).toHaveLength(2);
    expect(analysis.corridors.every((corridor) => Number.isFinite(corridor.minimumNm) && corridor.prediction.status === "unavailable")).toBe(true);
  });
});

describe("interpolation and support boundaries (D6)", () => {
  const ANCHOR_FROM = { lat: 0, lon: 0 };
  const ANCHOR_TO = { lat: 0, lon: 3 };
  const FEATURES = createGapDistanceFeatures({ anchorFrom: ANCHOR_FROM, anchorTo: ANCHOR_TO });
  const anchorNm = FEATURES.anchorDistanceNm;

  const modelWithSupport = (minimumAnchorDistanceNm: number, maximumAnchorDistanceNm: number): GapDistanceModelFile =>
    structuredClone({ ...VALID_MODEL, support: { minimumAnchorDistanceNm, maximumAnchorDistanceNm } });

  it("support bounds are inclusive: exactly min and exactly max still estimate", () => {
    for (const model of [modelWithSupport(anchorNm, 5000), modelWithSupport(1, anchorNm)]) {
      const prediction = predictGapDistance(FEATURES, model);
      expect(prediction.status, `support ${JSON.stringify((model as TrainedGapDistanceModel).support)}`).toBe("estimated");
      if (prediction.status === "estimated") {
        expect(prediction.medianNm).toBeGreaterThanOrEqual(prediction.minimumNm);
        expect(prediction.interval.lowerNm).toBeGreaterThanOrEqual(prediction.minimumNm);
      }
    }
  });

  it("one step beyond either support bound fails closed to OUTSIDE_TRAINING_SUPPORT", () => {
    for (const model of [modelWithSupport(anchorNm + 0.001, 5000), modelWithSupport(1, anchorNm - 0.001)]) {
      const prediction = predictGapDistance(FEATURES, model);
      expect(prediction.status).toBe("unavailable");
      if (prediction.status === "unavailable") expect(prediction.reason).toBe("OUTSIDE_TRAINING_SUPPORT");
    }
  });

  it("a zero-length anchor never estimates, whatever the model", () => {
    const zeroSpan = createGapDistanceFeatures({ anchorFrom: { lat: 10, lon: 10 }, anchorTo: { lat: 10, lon: 10 } });
    expect(zeroSpan.anchorDistanceNm).toBe(0);
    expect(zeroSpan.logAnchorDistanceNm).toBe(Number.NEGATIVE_INFINITY);
    const prediction = predictGapDistance(zeroSpan, VALID_MODEL);
    expect(prediction.status).toBe("unavailable");
    if (prediction.status === "unavailable") expect(prediction.reason).toBe("ZERO_LENGTH_ANCHORS");
  });

  it("a cell weaker than the per-cell independence floor fails closed to INSUFFICIENT_MATCHED_ROUTES", () => {
    const weak = structuredClone(VALID_MODEL);
    weak.cells[0]!.independentRouteGroups = weak.minimumIndependentRouteGroupsPerCell - 1;
    const prediction = predictGapDistance(FEATURES, weak);
    expect(prediction.status).toBe("unavailable");
    if (prediction.status === "unavailable") expect(prediction.reason).toBe("INSUFFICIENT_MATCHED_ROUTES");
  });

  it("degenerate confidence levels (0 or 1) fail closed instead of fabricating intervals", () => {
    for (const confidence of [0, 1, Number.NaN]) {
      const prediction = predictGapDistance(FEATURES, VALID_MODEL, confidence);
      expect(prediction.status, `confidence ${confidence}`).toBe("unavailable");
      if (prediction.status === "unavailable") expect(prediction.reason).toBe("INSUFFICIENT_CALIBRATION_FOR_CONFIDENCE");
    }
  });
});

function twoGapRoute(): RouteOption {
  return {
    id: "d6-route",
    flightId: "d6-flight",
    callsign: "D6GAP",
    status: "incomplete",
    complete: false,
    pointCount: 6,
    legs: [
      { id: "known-a", sequence: 0, status: "resolved", from: "A", to: "B", distanceNm: 40 },
      { id: "gap-a", sequence: 1, status: "gap", kind: "gap", reason: "missing" },
      { id: "known-b", sequence: 2, status: "resolved", from: "C", to: "D", distanceNm: 0 },
      { id: "gap-b", sequence: 3, status: "gap", kind: "gap", reason: "ambiguous" },
      { id: "known-c", sequence: 4, status: "resolved", from: "E", to: "F", distanceNm: 55.25 },
    ],
    segments: [
      [{ lat: 0, lon: 0 }, { lat: 0, lon: 1 }],
      [{ lat: 0, lon: 3 }, { lat: 0, lon: 4 }],
      [{ lat: 0, lon: 7 }, { lat: 0, lon: 8 }],
    ],
    gaps: [
      { sequence: 1, status: "gap", reason: "missing" },
      { sequence: 3, status: "gap", reason: "ambiguous" },
    ],
  };
}

describe("numeric boundaries in the incomplete-route analysis (D6)", () => {
  it("negative or NaN resolved-leg distances poison the whole resolved subtotal (fail closed)", () => {
    const negative = twoGapRoute();
    negative.legs[0]!.distanceNm = -5;
    expect(analyzeIncompleteRouteDistance(negative, {}, VALID_MODEL).sourceResolvedLegSubtotalNm).toBeUndefined();

    const notANumber = twoGapRoute();
    notANumber.legs[4]!.distanceNm = Number.NaN;
    expect(analyzeIncompleteRouteDistance(notANumber, {}, VALID_MODEL).sourceResolvedLegSubtotalNm).toBeUndefined();

    // Zero is legal and must be summed, not treated as missing.
    const legal = analyzeIncompleteRouteDistance(twoGapRoute(), {}, VALID_MODEL);
    expect(legal.sourceResolvedLegSubtotalNm).toBeCloseTo(95.25, 10);
  });

  it("a route confidence of 1 fails closed to lower bounds, never a bogus interval", () => {
    // Per-corridor confidence = 1 - (1 - 1) / n = 1, and the conformal
    // radius is undefined at confidence 1: the analysis must degrade.
    const analysis = analyzeIncompleteRouteDistance(twoGapRoute(), {}, VALID_MODEL, 1);
    expect(analysis.status).toBe("lower-bound-only");
    expect(analysis.reason).toBe("INSUFFICIENT_CALIBRATION_FOR_CONFIDENCE");
    expect(analysis.aggregateEstimate).toBeUndefined();
    expect(Number.isFinite(analysis.continuousRouteMinimumNm)).toBe(true);
  });

  it("a route confidence of 0 still yields intervals, labeled at the requested level", () => {
    // Zero route confidence maps each corridor to confidence 1 - 1/n (here
    // 0.5): a conservative but real interval, labeled with the requested 0.
    const analysis = analyzeIncompleteRouteDistance(twoGapRoute(), {}, VALID_MODEL, 0);
    expect(analysis.status).toBe("estimated");
    expect(analysis.aggregateEstimate?.interval.confidenceLevel).toBe(0);
    for (const corridor of analysis.corridors) {
      if (corridor.prediction.status === "estimated") {
        expect(corridor.prediction.interval.confidenceLevel).toBeCloseTo(0.5, 10);
      }
    }
  });

  it("per-corridor intervals carry the multiplicity-corrected confidence, not the route-level one", () => {
    const analysis = analyzeIncompleteRouteDistance(twoGapRoute(), {}, VALID_MODEL, 0.9);
    expect(analysis.status).toBe("estimated");
    expect(analysis.corridors).toHaveLength(2);
    // Two corridors: per-corridor confidence = 1 - (1 - 0.9) / 2 = 0.95.
    for (const corridor of analysis.corridors) {
      expect(corridor.prediction.status).toBe("estimated");
      if (corridor.prediction.status === "estimated") {
        expect(corridor.prediction.interval.confidenceLevel).toBeCloseTo(0.95, 10);
      }
    }
    // The aggregate keeps the route-level confidence label.
    expect(analysis.aggregateEstimate?.interval.confidenceLevel).toBe(0.9);
  });

  it("gap runs that cannot map one-to-one onto recorded spans fail closed as unbounded", () => {
    const route = twoGapRoute();
    // Two disconnected gap runs over geometry that yields one interior span:
    // the mapping invariant (runs == spans) must refuse to guess.
    route.segments = [
      [{ lat: 0, lon: 0 }, { lat: 0, lon: 1 }],
      [{ lat: 0, lon: 3 }, { lat: 0, lon: 8 }],
    ];
    const analysis = analyzeIncompleteRouteDistance(route, {}, VALID_MODEL);
    expect(analysis.status).toBe("unavailable");
    expect(analysis.reason).toBe("UNBOUNDED_OR_UNMAPPED_GAPS");
    expect(analysis.corridors).toEqual([]);
    expect(analysis.continuousRouteMinimumNm).toBeUndefined();
  });

  it("a route marked complete is never distance-estimated, even if gap records linger", () => {
    const route = twoGapRoute();
    route.complete = true;
    const analysis = analyzeIncompleteRouteDistance(route, {}, VALID_MODEL);
    expect(analysis.status).toBe("unavailable");
    expect(analysis.reason).toBe("ROUTE_NOT_INCOMPLETE");
    // The recorded-geometry subtotal is still reported for transparency.
    expect(analysis.recordedGeometrySubtotalNm).toBeGreaterThan(0);
  });
});
