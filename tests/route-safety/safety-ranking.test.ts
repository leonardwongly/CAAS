import assert from "node:assert/strict";
import test from "node:test";
import { createApiServer } from "../../apps/api/src/index.ts";
import { compareDistanceOperands, displayDistanceNm } from "../../packages/route-engine/src/index.ts";
import type { CaasAdapter, DatasetEvidence, FlightPlanRecord, ReferenceDatasetResult } from "../../packages/upstream-caas/src/index.ts";
import { PERSISTENT_SAFETY_COPY } from "../../packages/contracts/src/index.ts";
import { sanitizedAdapter } from "../fixtures/sanitized-caas.ts";

function evidence(family: DatasetEvidence["family"], records: number): DatasetEvidence {
  return { family, bytes: 128, records, acceptedRecords: records, rejectedRecords: 0, retried: false, durationMs: 0 };
}

function references(dataset: "fixes" | "airports" | "navaids", values: readonly (readonly [string, number, number])[]): ReferenceDatasetResult {
  const points = values.map(([identifier, lat, lon]) => ({ dataset, identifier, coordinate: { lat, lon } }));
  const index = new Map<string, readonly typeof points[number][]>();
  for (const point of points) index.set(point.identifier, [...(index.get(point.identifier) ?? []), point]);
  return { dataset, points, index, evidence: evidence(dataset, points.length) };
}

// The complete records have equal modeled totals but distinct route signatures.
// Their order must remain source-derived rather than distance-derived.
const NEUTRAL_RECORDS: readonly FlightPlanRecord[] = Object.freeze([
  Object.freeze({ id: "source-a", callsign: "SOURCE1", departure: "EK00", destination: "EW10", routeElements: Object.freeze([{ sequence: 0, coordinate: { lat: 0, lon: 3 } }]) }),
  Object.freeze({ id: "source-b", callsign: "SOURCE2", departure: "EK00", destination: "EW10", routeElements: Object.freeze([{ sequence: 0, coordinate: { lat: 0, lon: 7 } }]) }),
  Object.freeze({ id: "source-c", callsign: "SOURCE3", departure: "EK00", destination: "EW10", routeElements: Object.freeze([{ sequence: 0, coordinate: { lat: 0, lon: 5 } }]) }),
  Object.freeze({ id: "source-gap", callsign: "SOURCEGAP", departure: "EK00", destination: "EW10", routeElements: Object.freeze([{ sequence: 0, identifier: "NOT-A-FIX" }]) }),
]);

const GAP_ONLY_RECORDS: readonly FlightPlanRecord[] = Object.freeze([NEUTRAL_RECORDS[3]!]);

function equatorAdapter(records: readonly FlightPlanRecord[]): CaasAdapter {
  const base = sanitizedAdapter(records);
  return {
    ...base,
    airports: async () => references("airports", [["EK00", 0, 0], ["EW10", 0, 10]]),
    displayAll: async () => ({ records, evidence: evidence("displayAll", records.length) }),
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

const FORBIDDEN_WORDS = /\b(valid|recommended|safe|cleared|best)\b/i;
const FORBIDDEN_PREFERENCE_FIELDS = ["rank", "rankDistanceNm", "rankLabel", "operationalProxy"] as const;

function assertNoPreferenceFields(value: unknown): void {
  const serialized = JSON.stringify(value);
  for (const field of FORBIDDEN_PREFERENCE_FIELDS) assert.equal(serialized.includes(`"${field}"`), false, `${field} must not be public`);
}

test("engine display rounding and directed comparison retain full-precision semantics", () => {
  assert.equal(displayDistanceNm(10.04), 10);
  assert.equal(displayDistanceNm(10.05), 10.1);
  assert.equal(displayDistanceNm(0.0499), 0);
  assert.equal(displayDistanceNm(0.05), 0.1);

  const full = compareDistanceOperands(0.1, 0.3);
  assert.equal(full.status, "complete");
  assert.equal(full.distanceDeltaNm, 0.3 - 0.1);
  assert.equal(full.percentageDistanceDelta, (100 * (0.3 - 0.1)) / 0.1);
  assert.deepEqual(full.unavailable, []);

  const plain = compareDistanceOperands(10, 15);
  assert.equal(plain.status, "complete");
  assert.equal(plain.distanceDeltaNm, 5);
  assert.equal(plain.percentageDistanceDelta, 50);

  const missingBaseline = compareDistanceOperands(undefined, 5);
  assert.equal(missingBaseline.status, "incomplete");
  assert.deepEqual(missingBaseline.unavailable, ["INCOMPLETE_OPERAND"]);
  assert.equal(missingBaseline.distanceDeltaNm, undefined);
  assert.equal(missingBaseline.percentageDistanceDelta, undefined);

  const missingTarget = compareDistanceOperands(5, undefined);
  assert.equal(missingTarget.status, "incomplete");
  assert.deepEqual(missingTarget.unavailable, ["INCOMPLETE_OPERAND"]);

  const zeroBaseline = compareDistanceOperands(0, 5);
  assert.equal(zeroBaseline.status, "complete");
  assert.equal(zeroBaseline.distanceDeltaNm, 5);
  assert.equal(zeroBaseline.percentageDistanceDelta, undefined);
  assert.deepEqual(zeroBaseline.unavailable, ["ZERO_BASELINE"]);
});

test("route options are selected-first then source-ordered with no preference fields", async (t) => {
  const server = await serverFor(t, equatorAdapter(NEUTRAL_RECORDS));
  const id = await flightId(server, "SOURCE2");
  const response = await server.app.inject({ method: "POST", url: "/api/v1/routes/options", payload: { flightId: id } });
  assert.equal(response.statusCode, 200);
  const body = response.json() as {
    data: Array<{ flightId: string; callsign: string; complete: boolean; distanceNm?: number; safety: string }>;
  };
  assertNoPreferenceFields(body);
  assert.deepEqual(body.data.map((candidate) => candidate.callsign), ["SOURCE2", "SOURCE1", "SOURCE3", "SOURCEGAP"]);
  assert.equal(body.data[0]?.flightId, id);
  const complete = body.data.filter((candidate) => candidate.complete);
  const incomplete = body.data.filter((candidate) => !candidate.complete);
  assert.equal(complete.length, 3);
  assert.ok(complete.every((candidate) => typeof candidate.distanceNm === "number"));
  assert.equal(incomplete.length, 1);
  assert.equal(incomplete[0]?.distanceNm, undefined);
  assert.ok(body.data.every((candidate) => candidate.safety === PERSISTENT_SAFETY_COPY));
});

test("an all-gap route remains visible without distance or preference metadata", async (t) => {
  const server = await serverFor(t, equatorAdapter(GAP_ONLY_RECORDS));
  const id = await flightId(server, "SOURCEGAP");
  const response = await server.app.inject({ method: "POST", url: "/api/v1/routes/options", payload: { flightId: id } });
  assert.equal(response.statusCode, 200);
  const body = response.json() as { data: Array<{ complete: boolean; distanceNm?: number; gaps: unknown[] }> };
  assertNoPreferenceFields(body);
  assert.equal(body.data.length, 1);
  assert.equal(body.data[0]?.complete, false);
  assert.equal(body.data[0]?.distanceNm, undefined);
  assert.equal(body.data[0]?.gaps.length, 1);
});

test("the persistent safety copy appears exactly on options, detail, drafts, and comparison operands", async (t) => {
  const server = await serverFor(t, sanitizedAdapter());
  const id = await flightId(server, "FIXTURE1");

  const options = await server.app.inject({ method: "POST", url: "/api/v1/routes/options", payload: { flightId: id } });
  assert.equal(options.statusCode, 200);
  assert.equal((options.json() as { data: Array<{ safety: string }> }).data[0]?.safety, PERSISTENT_SAFETY_COPY);

  const detail = await server.app.inject({ method: "GET", url: `/api/v1/routes/${encodeURIComponent(id)}` });
  assert.equal(detail.statusCode, 200);
  assert.equal((detail.json() as { data: { safety: string } }).data.safety, PERSISTENT_SAFETY_COPY);

  const legacy = await server.app.inject({ method: "POST", url: "/api/v1/drafts/compare", payload: { draft: { origin: "KOR1", destination: "KDS1", via: [], selections: [] } } });
  assert.equal(legacy.statusCode, 200);
  assert.equal((legacy.json() as { route: { safety: string } }).route.safety, PERSISTENT_SAFETY_COPY);

  const comparison = await server.app.inject({ method: "POST", url: "/api/v1/routes/compare", payload: { baselineId: id, targetDraft: { origin: "KOR1", destination: "KDS1", via: [], selections: [] } } });
  assert.equal(comparison.statusCode, 200);
  const body = comparison.json() as { baseline: { safety: string }; target: { safety: string } };
  assert.equal(body.baseline.safety, PERSISTENT_SAFETY_COPY);
  assert.equal(body.target.safety, PERSISTENT_SAFETY_COPY);
});

test("no API payload qualifies a route as valid, recommended, safe, cleared, or best", async (t) => {
  const server = await serverFor(t, equatorAdapter(NEUTRAL_RECORDS));
  const id = await flightId(server, "SOURCE1");
  const responses = [
    await server.app.inject({ method: "POST", url: "/api/v1/routes/options", payload: { flightId: id } }),
    await server.app.inject({ method: "GET", url: `/api/v1/routes/${encodeURIComponent(id)}` }),
    await server.app.inject({ method: "POST", url: "/api/v1/drafts/compare", payload: { draft: { origin: "EK00", destination: "EW10", via: [], selections: [] } } }),
    await server.app.inject({ method: "POST", url: "/api/v1/routes/compare", payload: { baselineId: id, targetDraft: { origin: "EK00", destination: "EW10", via: [], selections: [] } } }),
  ];
  for (const response of responses) {
    assert.equal(response.statusCode, 200);
    const serialized = JSON.stringify(response.json());
    assert.equal(FORBIDDEN_WORDS.test(serialized), false, `forbidden qualifier found: ${serialized.match(FORBIDDEN_WORDS)?.[0]}`);
  }
});

test("draft route payloads carry descriptive distance but no preference fields", async (t) => {
  const server = await serverFor(t, sanitizedAdapter());
  const response = await server.app.inject({ method: "POST", url: "/api/v1/drafts/compare", payload: { draft: { origin: "KOR1", destination: "KDS1", via: ["MIDPT"], selections: [] } } });
  assert.equal(response.statusCode, 200);
  const route = (response.json() as { route: Record<string, unknown> }).route;
  assertNoPreferenceFields(route);
  assert.equal("complete" in route, false);
  assert.equal("status" in route, false);
  assert.equal(typeof route.distanceNm, "number");

  const baselineId = await flightId(server, "FIXTURE1");
  const comparison = await server.app.inject({ method: "POST", url: "/api/v1/routes/compare", payload: { baselineId, targetDraft: { origin: "KOR1", destination: "KDS1", via: ["MIDPT"], selections: [] } } });
  assert.equal(comparison.statusCode, 200);
  const target = (comparison.json() as { target: Record<string, unknown> }).target;
  assertNoPreferenceFields(target);
  assert.equal("complete" in target, false);
});
