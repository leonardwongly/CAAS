import type { GapDistanceModelFile } from "../../packages/route-engine/src/gap-distance.ts";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import App from "../../apps/web/src/App.tsx";
import { analyzeIncompleteRouteDistance } from "../../apps/web/src/gapDistanceEstimate.ts";
import { GAP_DISTANCE_ANNOTATION_CAVEAT } from "../../apps/web/src/labels.ts";
import type { RouteOption } from "../../apps/web/src/api.ts";
import { installApiStub } from "../fixtures/web-app.ts";

const unavailableModel = {
  schemaVersion: 1,
  status: "unavailable",
  reason: "TEST_NO_CORPUS",
  message: "No independent historical calibration corpus is available.",
} as const;

const calibratedModel: GapDistanceModelFile = {
  schemaVersion: 1,
  status: "trained",
  modelVersion: "test-multi-corridor-v1",
  createdAt: "2026-08-16T00:00:00.000Z",
  distanceConvention: { method: "haversine", earthRadiusNm: 3440.065 },
  target: "log-circuity-ratio",
  spanEdgesNm: [0, 100, 300, 600, 1200, 2400, 5000],
  support: { minimumAnchorDistanceNm: 1, maximumAnchorDistanceNm: 5000 },
  minimumIndependentRouteGroupsPerCell: 10,
  training: { digestSha256: "b".repeat(64), routeGroups: 100, examples: 400, calibrationRouteGroups: 20, testRouteGroups: 20 },
  cells: [{ level: "global", medianLogCircuity: Math.log(1.05), exampleCount: 240, independentRouteGroups: 60 }],
  calibrationResidualsLog: Array.from({ length: 20 }, () => Math.log(1.1)),
  validation: { confidenceLevel: 0.9, heldOutCoverage: 0.9, heldOutMedianAbsoluteErrorNm: 12, testExamples: 80 },
};

function sia216LikeRoute(): RouteOption {
  return {
    id: "sia216-route",
    flightId: "sia216-flight",
    callsign: "SIA216",
    status: "incomplete",
    complete: false,
    origin: "YPPH",
    destination: "WSSS",
    pointCount: 8,
    legs: [
      { id: "resolved-0", sequence: 0, kind: "segment", status: "resolved", from: "YPPH", to: "AVNEX", distanceNm: 68.07962218682569 },
      { id: "gap-1", sequence: 1, kind: "gap", status: "gap", reason: "not-found" },
      { id: "gap-3", sequence: 3, kind: "gap", status: "gap", reason: "ambiguous" },
      { id: "resolved-5", sequence: 5, kind: "segment", status: "resolved", from: "SOPAT", to: "SAPDA", distanceNm: 272.9333276717673 },
      { id: "resolved-6", sequence: 6, kind: "segment", status: "resolved", from: "SAPDA", to: "DOLTA", distanceNm: 526.3226486955265 },
      { id: "resolved-7", sequence: 7, kind: "segment", status: "resolved", from: "DOLTA", to: "REPOV", distanceNm: 343.06183543942024 },
      { id: "resolved-end", kind: "segment", status: "resolved", from: "REPOV", to: "WSSS", distanceNm: 65.5431535732857 },
    ],
    segments: [
      [{ lat: -31.94, lon: 115.97 }, { lat: -30.81, lon: 115.86 }],
      [{ lat: -16.28, lon: 113.01 }, { lat: -12, lon: 111.43 }, { lat: -5.13, lon: 105.92 }, { lat: 0.27, lon: 104.05 }, { lat: 1.36, lon: 103.99 }],
    ],
    gaps: [
      { sequence: 1, status: "gap", reason: "not-found" },
      { sequence: 3, status: "gap", reason: "ambiguous" },
    ],
  };
}

describe("non-operational gap-distance analysis", () => {
  it("groups two explicit missing records into one anchor-bounded corridor", () => {
    const route = sia216LikeRoute();
    const before = structuredClone(route);
    const analysis = analyzeIncompleteRouteDistance(route, {}, unavailableModel);

    expect(analysis.status).toBe("lower-bound-only");
    expect(analysis.corridors).toHaveLength(1);
    expect(analysis.corridors[0]?.gapSequences).toEqual([1, 3]);
    expect(analysis.corridors[0]?.minimumNm).toBeCloseTo(886.261965478468, 9);
    expect(analysis.sourceResolvedLegSubtotalNm).toBeCloseTo(1275.940587566825, 9);
    expect(analysis.continuousRouteMinimumNm).toBeCloseTo(2162.202553045294, 9);
    expect(route).toEqual(before);
    expect(route.distanceNm).toBeUndefined();
    expect(route.complete).toBe(false);
  });

  it("keeps multiple disconnected corridors separate and sums each once", () => {
    const route: RouteOption = {
      id: "multi-gap-route",
      flightId: "multi-gap-flight",
      callsign: "MULTIGAP",
      status: "incomplete",
      complete: false,
      pointCount: 6,
      legs: [
        { id: "known-a", sequence: 0, status: "resolved", from: "A", to: "B" },
        { id: "gap-a", sequence: 1, status: "gap", kind: "gap", reason: "missing" },
        { id: "known-b", sequence: 2, status: "resolved", from: "C", to: "D" },
        { id: "gap-b", sequence: 3, status: "gap", kind: "gap", reason: "ambiguous" },
        { id: "known-c", sequence: 4, status: "resolved", from: "E", to: "F" },
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
    const analysis = analyzeIncompleteRouteDistance(route, {}, unavailableModel);
    expect(analysis.corridors).toHaveLength(2);
    expect(analysis.corridors.map((corridor) => corridor.gapSequences)).toEqual([[1], [3]]);
    expect(analysis.gapMinimumSubtotalNm).toBeCloseTo(300.20230250000005, 5);
    expect(analysis.continuousRouteMinimumNm).toBeCloseTo(480.323684, 5);
  });

  it("aggregates calibrated multi-corridor intervals without assuming independence", () => {
    const route: RouteOption = {
      id: "calibrated-route",
      flightId: "calibrated-flight",
      callsign: "CALIBRATED",
      status: "incomplete",
      complete: false,
      pointCount: 6,
      legs: [
        { id: "known-a", sequence: 0, status: "resolved", from: "A", to: "B" },
        { id: "gap-a", sequence: 1, status: "gap", kind: "gap", reason: "missing" },
        { id: "known-b", sequence: 2, status: "resolved", from: "C", to: "D" },
        { id: "gap-b", sequence: 3, status: "gap", kind: "gap", reason: "ambiguous" },
        { id: "known-c", sequence: 4, status: "resolved", from: "E", to: "F" },
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
    const analysis = analyzeIncompleteRouteDistance(route, {}, calibratedModel, 0.9);
    expect(analysis.status).toBe("estimated");
    expect(analysis.corridors.every((corridor) => corridor.prediction.status === "estimated")).toBe(true);
    expect(analysis.aggregateEstimate?.label).toBe("sum-of-corridor-medians");
    expect(analysis.aggregateEstimate?.interval.confidenceLevel).toBe(0.9);
    expect(analysis.aggregateEstimate!.centralNm).toBeGreaterThan(analysis.continuousRouteMinimumNm!);
    expect(analysis.aggregateEstimate!.interval.lowerNm).toBeGreaterThanOrEqual(analysis.continuousRouteMinimumNm!);
    expect(analysis.aggregateEstimate!.interval.upperNm).toBeGreaterThanOrEqual(analysis.aggregateEstimate!.centralNm);
  });

  it("does not fabricate distance for an endpoint-only source record", () => {
    const route: RouteOption = {
      id: "no-geometry-route",
      flightId: "no-geometry-flight",
      callsign: "NOGEOMETRY",
      status: "incomplete",
      complete: false,
      pointCount: 2,
      legs: [{ id: "gap", sequence: 0, kind: "gap", status: "gap", reason: "missing" }],
      gaps: [{ sequence: 0, status: "gap", reason: "missing" }],
    };
    const analysis = analyzeIncompleteRouteDistance(route, { origin: { lat: 0, lon: 0 }, destination: { lat: 0, lon: 10 } }, unavailableModel);
    expect(analysis.status).toBe("unavailable");
    expect(analysis.reason).toBe("NO_RECORDED_GEOMETRY");
    expect(analysis.continuousRouteMinimumNm).toBeUndefined();
  });

  it("shows lower-bound data and the fail-closed calibration state in the left drawer", async () => {
    installApiStub();
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole("button", { name: "Show visual estimate" }));
    const drawer = await screen.findByRole("region", { name: "Estimated gap preview" });
    await user.click(within(drawer).getByRole("button", { name: /Recorded with unresolved gap/ }));

    await waitFor(() => expect(within(drawer).getByText("Continuous-route minimum")).toBeTruthy());
    expect(within(drawer).getByText("Gap anchor minimum")).toBeTruthy();
    expect(within(drawer).getByText("Recorded geometry")).toBeTruthy();
    expect(within(drawer).getByText("Statistical estimate")).toBeTruthy();
    expect(within(drawer).getByText("Historical release gates not met")).toBeTruthy();
    expect(within(drawer).getByText(GAP_DISTANCE_ANNOTATION_CAVEAT)).toBeTruthy();
    expect(within(drawer).getByText(/Lower bounds remain available/)).toBeTruthy();
    expect(within(drawer).getByText(/Gap position 3: minimum/)).toBeTruthy();
  });
});
