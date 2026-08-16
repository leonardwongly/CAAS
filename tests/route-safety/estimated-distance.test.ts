import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { analyzeIncompleteRouteDistance } from "../../apps/web/src/gapDistanceEstimate.ts";
import type { RouteOption } from "../../apps/web/src/api.ts";

const unavailableModel = {
  schemaVersion: 1,
  status: "unavailable",
  reason: "NO_CORPUS",
  message: "No approved historical corpus.",
} as const;

test("estimated-distance analysis remains separate from recorded route facts", () => {
  const route: RouteOption = {
    id: "source-route",
    flightId: "source-flight",
    callsign: "SOURCE1",
    status: "incomplete",
    complete: false,
    pointCount: 4,
    legs: [
      { id: "known-a", sequence: 0, status: "resolved", from: "A", to: "B", distanceNm: 60 },
      { id: "gap", sequence: 1, status: "gap", kind: "gap", reason: "missing" },
      { id: "known-b", sequence: 2, status: "resolved", from: "C", to: "D", distanceNm: 60 },
    ],
    segments: [
      [{ lat: 0, lon: 0 }, { lat: 0, lon: 1 }],
      [{ lat: 0, lon: 3 }, { lat: 0, lon: 4 }],
    ],
    gaps: [{ sequence: 1, status: "gap", reason: "missing" }],
  };
  const sourceBefore = JSON.stringify(route);
  const analysis = analyzeIncompleteRouteDistance(route, {}, unavailableModel);
  assert.equal(JSON.stringify(route), sourceBefore);
  assert.equal(route.complete, false);
  assert.equal(route.distanceNm, undefined);
  assert.equal(analysis.status, "lower-bound-only");
  assert.equal(analysis.aggregateEstimate, undefined);
  const analysisKeys = new Set(Object.keys(analysis));
  for (const prohibited of ["distanceNm", "rank", "rankDistanceNm", "rankLabel", "operationalProxy", "complete"]) {
    assert.equal(analysisKeys.has(prohibited), false);
  }
});

test("the API server does not import, compute, or serialize the client annotation", async () => {
  const server = await readFile(new URL("../../apps/api/src/server.ts", import.meta.url), "utf8");
  assert.equal(server.includes("gap-distance"), false);
  assert.equal(server.includes("GapDistance"), false);
  assert.equal(server.includes("estimatedDistance"), false);
});
