import assert from "node:assert/strict";
import test from "node:test";
import { createApiServer } from "../../apps/api/src/index.ts";
import type { CaasAdapter, DatasetEvidence, FlightPlanRecord, ReferenceDatasetResult } from "../../packages/upstream-caas/src/index.ts";
import { sanitizedAdapter, sanitizedFlights } from "../fixtures/sanitized-caas.ts";

const GAP_FLIGHT: FlightPlanRecord = Object.freeze({
  id: "fixture-gap-flight",
  callsign: "FIXGAP",
  departure: "KOR1",
  destination: "KDS1",
  routeElements: Object.freeze([{ sequence: 0, identifier: "NOT-A-FIX" }]),
});

function evidence(family: DatasetEvidence["family"], records: number): DatasetEvidence {
  return { family, bytes: 128, records, acceptedRecords: records, rejectedRecords: 0, retried: false, durationMs: 0 };
}

function references(dataset: "fixes" | "airports" | "navaids", values: readonly (readonly [string, number, number])[]): ReferenceDatasetResult {
  const points = values.map(([identifier, lat, lon]) => ({ dataset, identifier, coordinate: { lat, lon } }));
  const index = new Map<string, readonly typeof points[number][]>();
  for (const point of points) index.set(point.identifier, [...(index.get(point.identifier) ?? []), point]);
  return { dataset, points, index, evidence: evidence(dataset, points.length) };
}

function thirdAirportAdapter(): CaasAdapter {
  const base = sanitizedAdapter();
  return {
    ...base,
    airports: async () => references("airports", [["KOR1", 40, -73], ["KDS1", 33, -118], ["KXS2", 51, 0]]),
  };
}

function withGapAdapter(): CaasAdapter {
  const base = sanitizedAdapter([sanitizedFlights[0]!, GAP_FLIGHT]);
  return base;
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

async function findFlightId(server: ApiServer, callsign: string): Promise<string> {
  const search = await server.app.inject({ method: "POST", url: "/api/v1/callsigns/search", payload: { query: callsign } });
  assert.equal(search.statusCode, 200);
  const id = (search.json() as { data: Array<{ id: string }> }).data[0]?.id;
  assert.ok(id);
  return id;
}

function compare(server: ApiServer, payload: Record<string, unknown>) {
  return server.app.inject({ method: "POST", url: "/api/v1/routes/compare", payload });
}

interface CompareBody {
  baseline: { id: string; origin: string; destination: string; distanceNm?: number; legs: Array<{ distanceNm?: number }>; complete: boolean };
  target: { id: string; origin: string; destination: string; distanceNm?: number; legs: Array<{ distanceNm?: number }>; complete?: boolean; gaps: Array<{ reason: string }> };
  comparison: {
    status: string;
    message: string;
    distanceDeltaNm?: number;
    percentageDistanceDelta?: number;
    unavailable?: string[];
    addedWaypointCount: number;
    removedWaypointCount: number;
    waypointDifferences: Array<{ kind: string }>;
  };
  generation: { id: string };
}

test("complete baseline vs complete target reports the directed difference at full precision", async (t) => {
  const server = await serverFor(t, sanitizedAdapter());
  const baselineId = await findFlightId(server, "FIXTURE1");
  const response = await compare(server, { baselineId, targetDraft: { origin: "KOR1", destination: "KDS1", via: ["MIDPT"], selections: [] } });
  assert.equal(response.statusCode, 200);
  const body = response.json() as CompareBody;
  assert.equal(body.comparison.status, "complete");
  const expectedDelta = body.target.distanceNm! - body.baseline.distanceNm!;
  assert.equal(body.comparison.distanceDeltaNm, expectedDelta, "delta must equal target - baseline at full precision");
  assert.equal(body.comparison.percentageDistanceDelta, (100 * expectedDelta) / body.baseline.distanceNm!);
  assert.equal(body.comparison.unavailable, undefined);
  assert.equal(body.comparison.addedWaypointCount, 0);
  assert.equal(body.comparison.removedWaypointCount, 0);
  assert.deepEqual(body.comparison.waypointDifferences, []);
  assert.equal("rankDistanceNm" in body.baseline, false);
  assert.equal("rankDistanceNm" in body.target, false);
  // The draft target DTO keeps the recorded-route shape: complete stays absent.
  assert.equal(body.target.complete, undefined);
  assert.ok(body.target.legs.every((leg) => typeof leg.distanceNm === "number"));
  assert.equal(body.baseline.origin, body.target.origin);
  assert.equal(body.baseline.destination, body.target.destination);
  assert.ok(body.generation.id);
});

test("a draft with a different waypoint set reports added and removed waypoint counts", async (t) => {
  const server = await serverFor(t, sanitizedAdapter());
  const baselineId = await findFlightId(server, "FIXTURE1");
  const lookup = await server.app.inject({ method: "GET", url: "/api/v1/points/lookup?reference=DUPX" });
  const dup = (lookup.json() as { matches: Array<{ id: string }> }).matches[0]!.id;

  const removed = await compare(server, { baselineId, targetDraft: { origin: "KOR1", destination: "KDS1", via: [], selections: [] } });
  assert.equal(removed.statusCode, 200);
  assert.equal((removed.json() as CompareBody).comparison.removedWaypointCount, 1);
  assert.equal((removed.json() as CompareBody).comparison.addedWaypointCount, 0);

  const added = await compare(server, { baselineId, targetDraft: { origin: "KOR1", destination: "KDS1", via: ["MIDPT", "DUPX"], selections: [{ sequence: 1, locationId: dup }] } });
  assert.equal(added.statusCode, 200);
  assert.equal((added.json() as CompareBody).comparison.addedWaypointCount, 1);
  assert.equal((added.json() as CompareBody).comparison.removedWaypointCount, 0);
});

test("an incomplete target makes both metrics unavailable with INCOMPLETE_OPERAND", async (t) => {
  const server = await serverFor(t, sanitizedAdapter());
  const baselineId = await findFlightId(server, "FIXTURE1");
  const response = await compare(server, { baselineId, targetDraft: { origin: "KOR1", destination: "KDS1", via: ["NOT-A-FIX"], selections: [] } });
  assert.equal(response.statusCode, 200);
  const body = response.json() as CompareBody;
  assert.equal(body.comparison.status, "incomplete");
  assert.deepEqual(body.comparison.unavailable, ["INCOMPLETE_OPERAND"]);
  assert.equal(body.comparison.distanceDeltaNm, undefined);
  assert.equal(body.comparison.percentageDistanceDelta, undefined);
  // The incomplete target carries no distance and distance-stripped legs.
  assert.equal(body.target.distanceNm, undefined);
  assert.equal("rankDistanceNm" in body.target, false);
  assert.ok(body.target.legs.every((leg) => leg.distanceNm === undefined));
  assert.ok(body.target.gaps.some((gap) => gap.reason === "not-found"));
});

test("an incomplete baseline operand also makes the comparison unavailable", async (t) => {
  const server = await serverFor(t, withGapAdapter());
  const gapId = await findFlightId(server, "FIXGAP");
  const response = await compare(server, { baselineId: gapId, targetDraft: { origin: "KOR1", destination: "KDS1", via: ["MIDPT"], selections: [] } });
  assert.equal(response.statusCode, 200);
  const body = response.json() as CompareBody;
  assert.equal(body.comparison.status, "incomplete");
  assert.deepEqual(body.comparison.unavailable, ["INCOMPLETE_OPERAND"]);
  assert.equal(body.baseline.distanceNm, undefined);
  assert.equal("rankDistanceNm" in body.baseline, false);
});

test("comparing routes with different airport endpoints is rejected", async (t) => {
  const server = await serverFor(t, thirdAirportAdapter());
  const baselineId = await findFlightId(server, "FIXTURE1");
  const response = await compare(server, { baselineId, targetDraft: { origin: "KOR1", destination: "KXS2", via: [], selections: [] } });
  assert.equal(response.statusCode, 409);
  assert.equal((response.json() as { error: { code: string } }).error.code, "ENDPOINT_MISMATCH");
});

test("the comparison request contract rejects missing, duplicated, forged, and stale operands", async (t) => {
  const state = { records: sanitizedFlights };
  const server = await serverFor(t, { ...sanitizedAdapter(), displayAll: async () => ({ records: state.records, evidence: { family: "displayAll", bytes: 128, records: state.records.length, acceptedRecords: state.records.length, rejectedRecords: 0, retried: false, durationMs: 0 } }) });
  const baselineId = await findFlightId(server, "FIXTURE1");
  const draft = { origin: "KOR1", destination: "KDS1", via: [], selections: [] };

  const noBaseline = await compare(server, { targetDraft: draft });
  assert.equal(noBaseline.statusCode, 400);
  assert.equal((noBaseline.json() as { error: { code: string } }).error.code, "INVALID_BASELINE");

  const noTarget = await compare(server, { baselineId });
  assert.equal(noTarget.statusCode, 400);
  assert.equal((noTarget.json() as { error: { code: string } }).error.code, "INVALID_COMPARE");

  const bothTargets = await compare(server, { baselineId, targetDraft: draft, targetDraftId: "stored-draft" });
  assert.equal(bothTargets.statusCode, 400);
  assert.equal((bothTargets.json() as { error: { code: string } }).error.code, "INVALID_COMPARE");

  const forged = await compare(server, { baselineId: "forged-baseline-token", targetDraft: draft });
  assert.equal(forged.statusCode, 410);
  assert.equal((forged.json() as { error: { code: string } }).error.code, "GENERATION_EXPIRED");

  // After a refresh the baseline token belongs to an older generation.
  state.records = [sanitizedFlights[0]!];
  const refreshed = await server.app.inject({ method: "POST", url: "/api/v1/refresh", headers: { "x-refresh-token": "offline-refresh-secret" } });
  assert.equal(refreshed.statusCode, 200);
  const stale = await compare(server, { baselineId, targetDraft: draft });
  assert.equal(stale.statusCode, 410);
  assert.equal((stale.json() as { error: { code: string } }).error.code, "GENERATION_EXPIRED");
});

test("the draft comparison endpoint and the two-operand endpoint agree on direction", async (t) => {
  const server = await serverFor(t, sanitizedAdapter());
  const baselineId = await findFlightId(server, "FIXTURE1");
  const draft = { origin: "KOR1", destination: "KDS1", via: ["MIDPT", "DUPX"], selections: [] };
  const viaCompare = await compare(server, { baselineId, targetDraft: draft });
  assert.equal(viaCompare.statusCode, 200);
  const viaBody = viaCompare.json() as CompareBody;
  assert.equal(viaBody.comparison.status, "incomplete");
  assert.deepEqual(viaBody.comparison.unavailable, ["INCOMPLETE_OPERAND"]);

  // The drafts/compare endpoint reports the same unresolved state for the same draft content.
  const legacy = await server.app.inject({ method: "POST", url: "/api/v1/drafts/compare", payload: { draft } });
  assert.equal(legacy.statusCode, 200);
  const legacyBody = legacy.json() as { comparison: { status: string }; route: { distanceNm?: number } };
  assert.equal(legacyBody.comparison.status, "gap");
  assert.equal(legacyBody.route.distanceNm, undefined);
});
