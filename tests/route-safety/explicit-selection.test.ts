import assert from "node:assert/strict";
import test from "node:test";
import { createApiServer } from "../../apps/api/src/index.ts";
import type { CaasAdapter, FlightPlanRecord } from "../../packages/upstream-caas/src/index.ts";
import { sanitizedAdapter, sanitizedFlights } from "../fixtures/sanitized-caas.ts";

function mutableAdapter(records: readonly FlightPlanRecord[], state: { records: readonly FlightPlanRecord[] }): CaasAdapter {
  const base = sanitizedAdapter(records);
  return {
    ...base,
    displayAll: async () => ({ records: state.records, evidence: { family: "displayAll", bytes: 128, records: state.records.length, acceptedRecords: state.records.length, rejectedRecords: 0, retried: false, durationMs: 0 } }),
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

async function ambiguousMatches(server: ApiServer, reference: string): Promise<Array<{ id: string; coordinate: { lat: number; lon: number } }>> {
  const response = await server.app.inject({ method: "GET", url: `/api/v1/points/lookup?reference=${reference}` });
  assert.equal(response.statusCode, 200);
  const body = response.json() as { status: string; matches: Array<{ id: string; coordinate: { lat: number; lon: number } }> };
  assert.equal(body.status, "ambiguous");
  assert.ok(body.matches.length >= 2);
  return body.matches;
}

async function findFlightId(server: ApiServer, callsign: string): Promise<string> {
  const search = await server.app.inject({ method: "POST", url: "/api/v1/callsigns/search", payload: { query: callsign } });
  assert.equal(search.statusCode, 200);
  const id = (search.json() as { data: Array<{ id: string }> }).data[0]?.id;
  assert.ok(id);
  return id;
}

function draftCompare(server: ApiServer, payload: Record<string, unknown>) {
  return server.app.inject({ method: "POST", url: "/api/v1/drafts/compare", payload });
}

function compareRoutes(server: ApiServer, payload: Record<string, unknown>) {
  return server.app.inject({ method: "POST", url: "/api/v1/routes/compare", payload });
}

test("ambiguous draft waypoints fail closed without an explicit selection", async (t) => {
  const server = await serverFor(t, sanitizedAdapter());
  const response = await draftCompare(server, { draft: { origin: "KOR1", destination: "KDS1", via: ["DUPX"], selections: [] } });
  assert.equal(response.statusCode, 200);
  const body = response.json() as {
    route: { distanceNm?: number; rankDistanceNm?: number; geometry?: unknown; gaps: Array<{ sequence: number; reason: string }>; legs: Array<{ status: string }> };
    comparison: { status: string };
  };
  // The draft is never resolved by proximity: it stays a gap until an explicit selection binds a coordinate.
  assert.equal(body.comparison.status, "gap");
  assert.equal(body.route.distanceNm, undefined);
  assert.equal(body.route.rankDistanceNm, undefined);
  assert.equal(body.route.geometry, undefined);
  assert.deepEqual(body.route.gaps.map((gap) => gap.reason), ["ambiguous"]);
  assert.ok(body.route.legs.some((leg) => leg.status === "gap"));
});

test("an explicit generation-bound selection binds the exact coordinate and completes the waypoint", async (t) => {
  const server = await serverFor(t, sanitizedAdapter());
  const [first, second] = await ambiguousMatches(server, "DUPX");
  assert.ok(first);
  assert.ok(second);
  assert.notEqual(first.id, second.id);

  const selected = await draftCompare(server, { draft: { origin: "KOR1", destination: "KDS1", via: ["DUPX"], selections: [{ sequence: 0, locationId: first.id }] } });
  assert.equal(selected.statusCode, 200);
  const selectedBody = selected.json() as {
    route: { distanceNm: number; rankDistanceNm: number; geometry: { coordinates: Array<[number, number]> }; gaps: unknown[] };
    comparison: { status: string };
  };
  assert.equal(selectedBody.comparison.status, "complete");
  assert.equal(typeof selectedBody.route.distanceNm, "number");
  assert.equal(typeof selectedBody.route.rankDistanceNm, "number");
  assert.deepEqual(selectedBody.route.gaps, []);
  // The geometry passes through the chosen exact coordinate, never a nearby guess.
  assert.ok(
    selectedBody.route.geometry.coordinates.some(([lon, lat]) => Math.abs(lat - first.coordinate.lat) < 1e-9 && Math.abs(lon - first.coordinate.lon) < 1e-9),
    "geometry must include the selected coordinate",
  );

  const other = await draftCompare(server, { draft: { origin: "KOR1", destination: "KDS1", via: ["DUPX"], selections: [{ sequence: 0, locationId: second.id }] } });
  assert.equal(other.statusCode, 200);
  const otherBody = other.json() as { route: { distanceNm: number } };
  assert.notEqual(otherBody.route.distanceNm, selectedBody.route.distanceNm, "different exact coordinates must produce different modeled distances");
});

test("the same selection protocol binds on the two-operand comparison endpoint", async (t) => {
  const server = await serverFor(t, sanitizedAdapter());
  const baselineId = await findFlightId(server, "FIXTURE1");
  const [match] = await ambiguousMatches(server, "DUPX");
  assert.ok(match);

  const gapped = await compareRoutes(server, { baselineId, targetDraft: { origin: "KOR1", destination: "KDS1", via: ["DUPX"], selections: [] } });
  assert.equal(gapped.statusCode, 200);
  // The two-operand comparison reports the unavailable metrics as "incomplete".
  assert.equal((gapped.json() as { comparison: { status: string } }).comparison.status, "incomplete");

  const bound = await compareRoutes(server, { baselineId, targetDraft: { origin: "KOR1", destination: "KDS1", via: ["DUPX"], selections: [{ sequence: 0, locationId: match.id }] } });
  assert.equal(bound.statusCode, 200);
  assert.equal((bound.json() as { comparison: { status: string } }).comparison.status, "complete");
});

test("forged, tampered, stale, and mismatched selections fail closed", async (t) => {
  const state = { records: sanitizedFlights };
  const server = await serverFor(t, mutableAdapter(sanitizedFlights, state));
  const [match] = await ambiguousMatches(server, "DUPX");
  assert.ok(match);

  const forge = await draftCompare(server, { draft: { origin: "KOR1", destination: "KDS1", via: ["DUPX"], selections: [{ sequence: 0, locationId: "client-forged-token" }] } });
  assert.equal(forge.statusCode, 400);
  assert.equal((forge.json() as { error: { code: string } }).error.code, "TOKEN_INVALID");

  const tampered = match.id.endsWith("A") ? match.id.slice(0, -1) + "B" : match.id.slice(0, -1) + "A";
  const tamper = await draftCompare(server, { draft: { origin: "KOR1", destination: "KDS1", via: ["DUPX"], selections: [{ sequence: 0, locationId: tampered }] } });
  assert.equal(tamper.statusCode, 400);
  assert.equal((tamper.json() as { error: { code: string } }).error.code, "TOKEN_INVALID");

  // A valid token for DUPX paired with a different waypoint reference must not silently rebind.
  const mismatch = await draftCompare(server, { draft: { origin: "KOR1", destination: "KDS1", via: ["MIDPT"], selections: [{ sequence: 0, locationId: match.id }] } });
  assert.equal(mismatch.statusCode, 409);
  assert.equal((mismatch.json() as { error: { code: string } }).error.code, "SELECTION_MISMATCH");

  // After a refresh the selection token belongs to an older generation and is rejected.
  state.records = [sanitizedFlights[0]!];
  const refreshed = await server.app.inject({ method: "POST", url: "/api/v1/refresh", headers: { "x-refresh-token": "offline-refresh-secret" } });
  assert.equal(refreshed.statusCode, 200);
  const stale = await draftCompare(server, { draft: { origin: "KOR1", destination: "KDS1", via: ["DUPX"], selections: [{ sequence: 0, locationId: match.id }] } });
  assert.equal(stale.statusCode, 410);
  assert.equal((stale.json() as { error: { code: string } }).error.code, "GENERATION_EXPIRED");
});

test("selection shape and pairing bounds reject malformed drafts", async (t) => {
  const server = await serverFor(t, sanitizedAdapter());
  const baselineId = await findFlightId(server, "FIXTURE1");
  const compare = (targetDraft: unknown) => compareRoutes(server, { baselineId, targetDraft });

  // A selection must reference an existing waypoint sequence.
  const outOfRange = await compare({ origin: "KOR1", destination: "KDS1", via: [], selections: [{ sequence: 0, locationId: "token" }] });
  assert.equal(outOfRange.statusCode, 400);
  assert.equal((outOfRange.json() as { error: { code: string } }).error.code, "INVALID_DRAFT");

  // Duplicate sequences are rejected.
  const duplicated = await compare({ origin: "KOR1", destination: "KDS1", via: ["DUPX"], selections: [{ sequence: 0, locationId: "a" }, { sequence: 0, locationId: "b" }] });
  assert.equal(duplicated.statusCode, 400);
  assert.equal((duplicated.json() as { error: { code: string } }).error.code, "INVALID_DRAFT");

  // Oversized locationIds are rejected by the schema before any resolution attempt.
  const oversized = await compare({ origin: "KOR1", destination: "KDS1", via: ["DUPX"], selections: [{ sequence: 0, locationId: "x".repeat(513) }] });
  assert.equal(oversized.statusCode, 400);
  assert.equal((oversized.json() as { error: { code: string } }).error.code, "INVALID_DRAFT");

  // Negative and non-integer sequences are rejected.
  const negative = await compare({ origin: "KOR1", destination: "KDS1", via: ["DUPX"], selections: [{ sequence: -1, locationId: "a" }] });
  assert.equal(negative.statusCode, 400);
  const fractional = await compare({ origin: "KOR1", destination: "KDS1", via: ["DUPX"], selections: [{ sequence: 0.5, locationId: "a" }] });
  assert.equal(fractional.statusCode, 400);
});
