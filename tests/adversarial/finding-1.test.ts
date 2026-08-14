import assert from "node:assert/strict";
import test from "node:test";
import { createApiServer } from "../../apps/api/src/index.ts";
import type { CaasAdapter, DatasetEvidence, FlightPlanRecord, ReferenceDatasetResult } from "../../packages/upstream-caas/src/index.ts";
import { sanitizedAdapter } from "../fixtures/sanitized-caas.ts";

// Candidate finding: routeProjection's endpoint-adjacent dedup (apps/api/src/server.ts:691-698)
// removes any occurrence whose coordinate equals an adjacent endpoint coordinate with no check
// that it is actually a route element. For a same-airport flight with an explicit empty route
// (routeElements: []), occurrences is exactly [origin, destination]; the check treats the
// DESTINATION endpoint as the "first route occurrence" and splices it out. The result is a
// single-point projection (pointCount 1, destination dropped, complete=false, distanceNm
// undefined) — while the same endpoints with a co-located waypoint project complete at
// distanceNm=0 and with a distant waypoint complete at a non-zero distance.
//
// North-star contract: design Section 0.3 draws routes from "exact resolved waypoint/reference
// coordinates" with both endpoints resolved as airport references; design 0.4 ranks "complete
// candidates" by modeled distance and treats a zero-distance candidate as complete (route-engine
// compareDistanceOperands returns ZERO_BASELINE for a zero baseline, never INCOMPLETE_OPERAND);
// plan PLAN-3.1 deduplicates "exact semantics" for same-endpoint candidates. A projection that
// silently drops its destination endpoint is never an allowed outcome.

function evidence(family: DatasetEvidence["family"], records: number): DatasetEvidence {
  return { family, bytes: 128, records, acceptedRecords: records, rejectedRecords: 0, retried: false, durationMs: 0 };
}

function references(dataset: "fixes" | "airports" | "navaids", values: readonly (readonly [string, number, number])[]): ReferenceDatasetResult {
  const points = values.map(([identifier, lat, lon]) => ({ dataset, identifier, coordinate: { lat, lon } }));
  const index = new Map<string, readonly typeof points[number][]>();
  for (const point of points) index.set(point.identifier, [...(index.get(point.identifier) ?? []), point]);
  return { dataset, points, index, evidence: evidence(dataset, points.length) };
}

// Three same-airport (KOR1->KOR1) flights that differ only in element content:
// explicit empty route, a waypoint co-located with the endpoint coordinate, and a distant waypoint.
const SAME_ENDPOINT_RECORDS: readonly FlightPlanRecord[] = Object.freeze([
  Object.freeze({ id: "same-empty", callsign: "SAME00", departure: "KOR1", destination: "KOR1", routeElements: Object.freeze([]) }),
  Object.freeze({ id: "same-colocated", callsign: "SAME01", departure: "KOR1", destination: "KOR1", routeElements: Object.freeze([{ sequence: 0, coordinate: { lat: 40, lon: -73 } }]) }),
  Object.freeze({ id: "same-distant", callsign: "SAME02", departure: "KOR1", destination: "KOR1", routeElements: Object.freeze([{ sequence: 0, coordinate: { lat: 40, lon: -63 } }]) }),
]);

function sameAirportAdapter(): CaasAdapter {
  const base = sanitizedAdapter(SAME_ENDPOINT_RECORDS);
  return {
    ...base,
    airports: async () => references("airports", [["KOR1", 40, -73], ["KDS1", 33, -118]]),
  };
}

interface TestHarness {
  after: (fn: () => void) => void;
}

async function serverFor(t: TestHarness, adapter: CaasAdapter) {
  const server = await createApiServer({ adapter, refreshSecret: "offline-refresh-secret" });
  t.after(() => server.app.close());
  return server;
}

type ApiServer = Awaited<ReturnType<typeof createApiServer>>;

async function flightId(server: ApiServer, callsign: string): Promise<string> {
  const search = await server.app.inject({ method: "POST", url: "/api/v1/callsigns/search", payload: { query: callsign } });
  assert.equal(search.statusCode, 200);
  const id = (search.json() as { data: Array<{ id: string }> }).data[0]?.id;
  assert.ok(id);
  return id;
}

interface RouteDetail {
  origin: string;
  destination: string;
  pointCount: number;
  complete: boolean;
  distanceNm?: number;
  legs: Array<{ from: string; to: string; distanceNm: number }>;
  segments?: unknown[];
}

async function detailFor(server: ApiServer, callsign: string): Promise<RouteDetail> {
  const id = await flightId(server, callsign);
  const response = await server.app.inject({ method: "GET", url: `/api/v1/routes/${encodeURIComponent(id)}` });
  assert.equal(response.statusCode, 200);
  return (response.json() as { data: RouteDetail }).data;
}

test("same-airport flight with an explicit empty route keeps both endpoints and completes at zero distance", async (t) => {
  const server = await serverFor(t, sameAirportAdapter());
  const route = await detailFor(server, "SAME00");

  assert.equal(route.origin, "KOR1");
  assert.equal(route.destination, "KOR1");
  // The destination endpoint must never be dropped by endpoint-adjacent dedup: a projection
  // with zero route elements still contains origin and destination as its two waypoints.
  assert.equal(route.pointCount, 2, "the destination endpoint must remain in the projection");
  assert.equal(route.complete, true, "a fully resolved same-endpoint route is complete");
  assert.equal(route.distanceNm, 0, "origin-to-destination at the same coordinate is zero distance");
  assert.equal(route.legs.length, 1, "exactly one leg spans origin to destination");
  assert.equal(route.legs[0]!.from, "KOR1");
  assert.equal(route.legs[0]!.to, "KOR1");
  assert.equal(route.legs[0]!.distanceNm, 0);
  assert.ok(route.segments && route.segments.length === 1, "the complete geometry spans both endpoints");
});

test("same-endpoint flights agree on completeness regardless of element placement", async (t) => {
  const server = await serverFor(t, sameAirportAdapter());
  const empty = await detailFor(server, "SAME00");
  const colocated = await detailFor(server, "SAME01");
  const distant = await detailFor(server, "SAME02");

  // The same endpoints (KOR1->KOR1) must not flip between complete and incomplete based on
  // whether a waypoint is present or where it sits: all three are fully resolved routes.
  for (const [label, route] of [["empty", empty], ["co-located", colocated], ["distant", distant]] as const) {
    assert.equal(route.complete, true, `${label} route must be complete`);
  }
  assert.equal(empty.distanceNm, 0);
  assert.equal(colocated.distanceNm, 0, "co-located waypoint collapses onto the endpoints at zero distance");
  assert.ok(distant.distanceNm !== undefined && distant.distanceNm > 0, "distant waypoint yields a positive modeled distance");
});

test("a zero-distance same-airport baseline yields ZERO_BASELINE with the delta, never INCOMPLETE_OPERAND", async (t) => {
  const server = await serverFor(t, sameAirportAdapter());
  const id = await flightId(server, "SAME00");
  const response = await server.app.inject({
    method: "POST",
    url: "/api/v1/routes/compare",
    payload: { baselineId: id, targetDraft: { origin: "KOR1", destination: "KOR1", via: [], selections: [] } },
  });
  assert.equal(response.statusCode, 200);
  const body = response.json() as { comparison: { status: string; distanceDeltaNm?: number; unavailable?: string[] } };
  // compareDistanceOperands: a zero-distance baseline is a complete operand; only the
  // percentage is unavailable (ZERO_BASELINE). A dropped destination (distance undefined)
  // would instead surface INCOMPLETE_OPERAND.
  assert.equal(body.comparison.status, "complete");
  assert.equal(body.comparison.distanceDeltaNm, 0);
  assert.deepEqual(body.comparison.unavailable, ["ZERO_BASELINE"]);
});
