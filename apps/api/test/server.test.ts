import test from "node:test";
import assert from "node:assert/strict";
import { createApiServer, type CaasAdapter } from "../src/index.ts";
import { LIVE_FRESH_MS, LIVE_UNUSABLE_MS, REFERENCE_FRESH_MS, REFERENCE_UNUSABLE_MS, createCaasAdapter, type DatasetEvidence, type ReferenceDatasetResult } from "@flight-route-explorer/upstream-caas";
import type { FlightPlanRecord } from "@flight-route-explorer/upstream-caas";

const coordinate = (lat: number, lon: number) => Object.freeze({ lat, lon });

function evidence(family: DatasetEvidence["family"], records: number, acceptedRecords = records): DatasetEvidence {
  return { family, bytes: 100, records, acceptedRecords, rejectedRecords: records - acceptedRecords, retried: false, durationMs: 1 };
}

function references(dataset: "fixes" | "airports" | "navaids", points: Array<[string, number, number]>): ReferenceDatasetResult {
  const normalized = points.map(([identifier, lat, lon]) => ({ dataset, identifier, coordinate: coordinate(lat, lon) }));
  const index = new Map<string, readonly typeof normalized[number][] >();
  for (const point of normalized) index.set(point.identifier, [...(index.get(point.identifier) ?? []), point]);
  return { dataset, points: normalized, index, evidence: evidence(dataset, points.length) };
}

function fixtureAdapter(records: readonly FlightPlanRecord[] = defaultRecords()): CaasAdapter {
  return {
    displayAll: async () => ({ records, evidence: evidence("displayAll", records.length) }),
    airways: async () => ({ family: "airways", bytes: 20, records: 1, acceptedRecords: 1, rejectedRecords: 0, uniqueRecords: 1, retried: false, durationMs: 1 }),
    fixes: async () => references("fixes", [["DCT", 35, -90]]),
    airports: async () => references("airports", [["KJFK", 40.6413, -73.7781], ["KLAX", 33.9416, -118.4085]]),
    navaids: async () => references("navaids", [["DUP", 35, -90], ["DUP", 36, -91]]),
  };
}

function defaultRecords(): FlightPlanRecord[] {
  return [
    { id: "raw-empty-id", callsign: "TEST123", departure: "KJFK", destination: "KLAX", routeElements: [] },
    { id: "raw-gap-id", callsign: "TESTGAP", departure: "KJFK", destination: "KLAX", routeElements: [{ sequence: 0, identifier: "UNKNOWN-UPSTREAM-FIX" }, { sequence: 1, identifier: "DCT" }] },
    { id: "raw-embedded-id", callsign: "TESTEMBED", departure: "KJFK", destination: "KLAX", routeElements: [{ sequence: 0, identifier: "DCT", coordinate: coordinate(40.6413, -73.7781) }, { sequence: 1, coordinate: coordinate(35, -90) }] },
    { id: "raw-missing-id", callsign: "TESTMISSING", departure: "KJFK", destination: "KLAX" },
  ];
}

function failingAdapter(): CaasAdapter {
  return {
    displayAll: async () => { throw new Error("upstream unavailable"); },
    airways: async () => { throw new Error("upstream unavailable"); },
    fixes: async () => { throw new Error("upstream unavailable"); },
    airports: async () => { throw new Error("upstream unavailable"); },
    navaids: async () => { throw new Error("upstream unavailable"); },
  };
}

test("searches real flight plans by callsign and serves selected-flight routes", async (t) => {
  const records = [
    { ...defaultRecords()[0]!, id: "raw-a", callsign: "DUPLICATE1" },
    { ...defaultRecords()[2]!, id: "raw-b", callsign: "DUPLICATE1" },
  ];
  const server = await createApiServer({ adapter: fixtureAdapter(records), refreshSecret: "test-refresh" });
  t.after(() => server.app.close());

  assert.equal((await server.app.inject({ method: "GET", url: "/api/v1/health/live" })).statusCode, 200);
  assert.equal((await server.app.inject({ method: "GET", url: "/api/v1/health/startup" })).statusCode, 200);
  const search = await server.app.inject({ method: "POST", url: "/api/v1/callsigns/search", payload: { query: "duplicate1", limit: 1 } });
  assert.equal(search.statusCode, 200);
  const searchBody = search.json() as { data: Array<Record<string, string>>; nextCursor?: string };
  assert.equal(searchBody.data.length, 1);
  assert.ok(searchBody.nextCursor);
  assert.notEqual(searchBody.data[0]?.id, "raw-a");
  assert.equal((await server.app.inject({ method: "POST", url: "/api/v1/callsigns/search", payload: { query: "KJFK" } })).json().data.length, 0);

  const firstId = searchBody.data[0]!.id;
  const secondPage = await server.app.inject({ method: "POST", url: "/api/v1/callsigns/search", payload: { query: "DUPLICATE1", limit: 1, cursor: searchBody.nextCursor } });
  assert.equal(secondPage.statusCode, 200);
  const secondId = (secondPage.json() as { data: Array<{ id: string }> }).data[0]!.id;
  assert.notEqual(firstId, secondId);

  const options = await server.app.inject({ method: "POST", url: "/api/v1/routes/options", payload: { flightId: firstId } });
  assert.equal(options.statusCode, 200);
  const routes = (options.json() as { data: Array<Record<string, unknown>> }).data;
  assert.equal(routes.length, 2);
  assert.equal(routes.some((route) => route.flightId === firstId), true);
  assert.equal(routes.every((route) => route.callsign === "DUPLICATE1"), true);
  const route = routes.find((candidate) => candidate.flightId === firstId)!;
  assert.equal(route.complete, true);
  assert.equal("rank" in route, false);
  assert.equal("rankDistanceNm" in route, false);
  assert.equal("operationalProxy" in route, false);
  assert.equal((route.legs as unknown[]).length, 1);
  assert.deepEqual(route.gaps, []);
  assert.equal(JSON.stringify(routes).includes("raw-a"), false);

  const detail = await server.app.inject({ method: "GET", url: `/api/v1/routes/${encodeURIComponent(firstId)}` });
  assert.equal(detail.statusCode, 200);
  assert.equal((detail.json() as { data: { geometry?: unknown } }).data.geometry !== undefined, true);
});

test("pages every flight route exactly once in the generation-bound overview", async (t) => {
  const server = await createApiServer({ adapter: fixtureAdapter(), refreshSecret: "test-refresh", refreshMinIntervalMs: 0 });
  t.after(() => server.app.close());
  const first = await server.app.inject({ method: "POST", url: "/api/v1/routes/overview", payload: { limit: 2 } });
  assert.equal(first.statusCode, 200);
  const firstBody = first.json() as { data: Array<Record<string, unknown>>; nextCursor: string; total: number; loaded: number };
  assert.equal(firstBody.data.length, 2);
  assert.equal(firstBody.loaded, 2);
  assert.equal(firstBody.total, 4);
  assert.ok(firstBody.nextCursor);
  const second = await server.app.inject({ method: "POST", url: "/api/v1/routes/overview", payload: { limit: 2, cursor: firstBody.nextCursor } });
  assert.equal(second.statusCode, 200);
  const secondBody = second.json() as { data: Array<Record<string, unknown>>; nextCursor?: string; total: number; loaded: number };
  assert.equal(secondBody.data.length, 2);
  assert.equal(secondBody.nextCursor, undefined);
  assert.equal(secondBody.loaded, 4);
  const routes = [...firstBody.data, ...secondBody.data];
  assert.equal(new Set(routes.map((route) => route.flightId)).size, 4);
  assert.equal(routes.every((route) => !("rank" in route) && !("rankDistanceNm" in route) && !("operationalProxy" in route)), true);
  assert.equal(routes[0]?.origin, "John F. Kennedy International Airport (KJFK)");
  assert.equal(routes[0]?.destination, "Los Angeles International Airport (KLAX)");
  assert.equal(Array.isArray(routes[1]?.segments), true);
  assert.equal((routes[1]?.gaps as unknown[]).length, 1);

  const refreshed = await server.app.inject({ method: "POST", url: "/api/v1/refresh", headers: { "x-refresh-token": "test-refresh" } });
  assert.equal(refreshed.statusCode, 200);
  const expired = await server.app.inject({ method: "POST", url: "/api/v1/routes/overview", payload: { limit: 2, cursor: firstBody.nextCursor } });
  assert.equal(expired.statusCode, 409);
  assert.equal((expired.json() as { error: { code: string } }).error.code, "CURSOR_EXPIRED");
});

test("overview preserves resolved interior segments between unresolved endpoints", async (t) => {
  const records: FlightPlanRecord[] = [{
    id: "raw-unresolved-endpoints",
    callsign: "INTERIOR1",
    departure: "KXXX",
    destination: "KYYY",
    routeElements: [
      { sequence: 0, coordinate: coordinate(10, 30) },
      { sequence: 1, coordinate: coordinate(20, 40) },
    ],
  }];
  const server = await createApiServer({ adapter: fixtureAdapter(records), refreshSecret: "test-refresh" });
  t.after(() => server.app.close());

  const response = await server.app.inject({ method: "POST", url: "/api/v1/routes/overview", payload: {} });
  assert.equal(response.statusCode, 200);
  const route = (response.json() as { data: Array<Record<string, unknown>> }).data[0]!;
  assert.equal(route.complete, false);
  assert.equal(route.origin, "Name unavailable (KXXX)");
  assert.equal(route.destination, "Name unavailable (KYYY)");
  assert.equal(route.pointCount, 2);
  assert.equal("distanceNm" in route, false);
  assert.equal("geometry" in route, false);
  assert.deepEqual(route.gaps, [
    { status: "gap", sequence: 0, reason: "not-found" },
    { status: "gap", sequence: 3, reason: "not-found" },
  ]);
  assert.deepEqual(route.segments, [{ type: "LineString", coordinates: [[30, 10], [40, 20]] }]);
  assert.deepEqual((route.legs as Array<{ kind: string }>).map((leg) => leg.kind), ["gap", "segment", "gap"]);
});

test("returns same-endpoint alternatives in neutral selected-first source order", async (t) => {
  const records: FlightPlanRecord[] = [
    { id: "raw-tie-selected", callsign: "TIESELECTED", departure: "KJFK", destination: "KLAX", routeElements: [{ sequence: 0, coordinate: coordinate(0, 3) }] },
    { id: "raw-tie-alternative", callsign: "TIEALTERNATIVE", departure: "KJFK", destination: "KLAX", routeElements: [{ sequence: 0, coordinate: coordinate(0, 7) }] },
    { id: "raw-tie-incomplete", callsign: "TIEINCOMPLETE", departure: "KJFK", destination: "KLAX", routeElements: [{ sequence: 0, identifier: "UNKNOWN-TIE-FIX" }] },
  ];
  const base = fixtureAdapter(records);
  const adapter: CaasAdapter = {
    ...base,
    airports: async () => references("airports", [["KJFK", 0, 0], ["KLAX", 0, 10]]),
  };
  const server = await createApiServer({ adapter, refreshSecret: "test-refresh" });
  t.after(() => server.app.close());
  const find = async (callsign: string) => (await server.app.inject({ method: "POST", url: "/api/v1/callsigns/search", payload: { query: callsign } })).json().data[0].id as string;
  const selectedId = await find("TIESELECTED");

  const options = await server.app.inject({ method: "POST", url: "/api/v1/routes/options", payload: { flightId: selectedId } });
  assert.equal(options.statusCode, 200);
  const routes = (options.json() as { data: Array<Record<string, unknown>> }).data;
  assert.equal(routes.length, 3);
  assert.equal(routes.some((route) => route.flightId === selectedId), true);
  assert.equal(routes[0]?.callsign, "TIESELECTED");
  assert.equal(routes[1]?.callsign, "TIEALTERNATIVE");
  assert.equal(routes[2]?.callsign, "TIEINCOMPLETE");
  assert.equal(routes[0]?.complete, true);
  assert.equal(routes[1]?.complete, true);
  assert.equal(routes[2]?.complete, false);
  assert.equal(routes.every((route) => !("rank" in route) && !("rankDistanceNm" in route) && !("operationalProxy" in route)), true);
  assert.equal(routes[2]?.distanceNm, undefined);
  assert.equal(JSON.stringify(routes).includes("raw-tie"), false);
  assert.equal(JSON.stringify(routes).includes("UNKNOWN-TIE-FIX"), false);
  assert.equal(JSON.stringify(routes).includes("airway"), false);
});

test("prefers embedded points, preserves structured gaps, and never bridges segments", async (t) => {
  const server = await createApiServer({ adapter: fixtureAdapter(), refreshSecret: "test-refresh" });
  t.after(() => server.app.close());
  const find = async (callsign: string) => (await server.app.inject({ method: "POST", url: "/api/v1/callsigns/search", payload: { query: callsign } })).json().data[0].id as string;

  const embedded = await server.app.inject({ method: "POST", url: "/api/v1/routes/options", payload: { flightId: await find("TESTEMBED") } });
  assert.equal(embedded.statusCode, 200);
  const embeddedRoutes = (embedded.json() as { data: Array<Record<string, unknown>> }).data;
  const embeddedRoute = embeddedRoutes.find((candidate) => candidate.callsign === "TESTEMBED")!;
  assert.equal(embeddedRoute.complete, true);
  assert.deepEqual((embeddedRoute.geometry as { coordinates: unknown[] }).coordinates[1], [-90, 35]);

  const gap = await server.app.inject({ method: "POST", url: "/api/v1/routes/options", payload: { flightId: await find("TESTGAP") } });
  assert.equal(gap.statusCode, 200);
  const gapRoutes = (gap.json() as { data: Array<Record<string, unknown>> }).data;
  const gapRoute = gapRoutes.find((candidate) => candidate.callsign === "TESTGAP")!;
  assert.equal(gapRoute.complete, false);
  assert.equal(gapRoute.geometry, undefined);
  assert.equal((gapRoute.segments as unknown[]).length, 1);
  assert.equal((gapRoute.gaps as Array<{ status: string; sequence: number }>)[0]?.status, "gap");
  assert.equal(JSON.stringify(gapRoute).includes("UNKNOWN-UPSTREAM-FIX"), false);
  assert.equal((gapRoute.legs as Array<{ status: string }>).some((leg) => leg.status === "gap"), true);

  const missing = await server.app.inject({ method: "POST", url: "/api/v1/routes/options", payload: { flightId: await find("TESTMISSING") } });
  const missingRoutes = (missing.json() as { data: Array<Record<string, unknown>> }).data;
  const missingRoute = missingRoutes.find((candidate) => candidate.callsign === "TESTMISSING")!;
  assert.equal(missingRoute.complete, false);
  assert.equal(missingRoute.geometry, undefined);
  assert.equal(missingRoute.segments, undefined);
  assert.equal((missingRoute.legs as Array<{ status: string }>)[0]?.status, "gap");
});

test("binds cursors and flight IDs to generation, query, limit, expiry, and refresh auth", async (t) => {
  let refresh = false;
  const first = defaultRecords();
  const second = [{ ...defaultRecords()[0]!, id: "second-raw-id", callsign: "TEST456" }];
  const base = fixtureAdapter(first);
  const adapter: CaasAdapter = {
    displayAll: async () => ({ records: refresh ? second : first, evidence: evidence("displayAll", refresh ? second.length : first.length) }),
    airways: base.airways, fixes: base.fixes, airports: base.airports, navaids: base.navaids,
  };
  const server = await createApiServer({ adapter, refreshSecret: "offline-refresh-secret" });
  t.after(() => server.app.close());
  const firstPage = await server.app.inject({ method: "POST", url: "/api/v1/callsigns/search", payload: { query: "TEST", limit: 1 } });
  const firstBody = firstPage.json() as { nextCursor?: string; data: Array<{ id: string }> };
  assert.ok(firstBody.nextCursor);
  assert.equal((await server.app.inject({ method: "POST", url: "/api/v1/callsigns/search", payload: { query: "TEST", limit: 1, cursor: firstBody.nextCursor } })).statusCode, 200);
  assert.equal((await server.app.inject({ method: "POST", url: "/api/v1/callsigns/search", payload: { query: "TEST", limit: 2, cursor: firstBody.nextCursor } })).statusCode, 409);
  assert.equal((await server.app.inject({ method: "POST", url: "/api/v1/refresh" })).statusCode, 401);
  refresh = true;
  assert.equal((await server.app.inject({ method: "POST", url: "/api/v1/refresh", headers: { "x-refresh-token": "offline-refresh-secret" } })).statusCode, 200);
  assert.equal((await server.app.inject({ method: "GET", url: `/api/v1/routes/${encodeURIComponent(firstBody.data[0]!.id)}` })).statusCode, 410);
});


test("rejects same-endpoint route populations above the hard candidate cap", async (t) => {
  const records: FlightPlanRecord[] = Array.from({ length: 501 }, (_, index) => ({
    id: `raw-cap-${index}`,
    callsign: `CAP${String(index).padStart(3, "0")}`,
    departure: "KJFK",
    destination: "KLAX",
    routeElements: [],
  }));
  const server = await createApiServer({ adapter: fixtureAdapter(records), refreshSecret: "test-refresh" });
  t.after(() => server.app.close());

  const search = await server.app.inject({ method: "POST", url: "/api/v1/callsigns/search", payload: { query: "CAP000" } });
  const flightId = (search.json() as { data: Array<{ id: string }> }).data[0]!.id;
  const options = await server.app.inject({ method: "POST", url: "/api/v1/routes/options", payload: { flightId } });
  assert.equal(options.statusCode, 409);
  assert.equal((options.json() as { error: { code: string } }).error.code, "TOO_MANY_CANDIDATES");
});
test("reports unavailable readiness and rejects startup when acquisition fails", async (t) => {
  const server = await createApiServer({ adapter: failingAdapter(), initialize: false });
  t.after(() => server.app.close());
  assert.equal((await server.app.inject({ method: "GET", url: "/readyz" })).statusCode, 503);
  assert.equal((await server.app.inject({ method: "GET", url: "/startupz" })).statusCode, 503);
  await assert.rejects(server.store.initialize(), /live data generation/);
  assert.equal((await server.app.inject({ method: "GET", url: "/readyz" })).statusCode, 503);
});

test("accepts a transport-injected adapter without exposing credentials or airway values", async (t) => {
  const previous = process.env.apikey;
  process.env.apikey = "fixture-secret";
  t.after(() => { if (previous === undefined) delete process.env.apikey; else process.env.apikey = previous; });
  const transport = {
    get: async (request: { family: string }) => {
      const bodies: Record<string, string> = {
        displayAll: JSON.stringify([{ id: "hidden-id", callsign: "TRANSPORT1", departure: "KJFK", destination: "KLAX", route: ["DCT"] }]),
        airways: JSON.stringify(["airway-secret"]), fixes: JSON.stringify(["DCT (35,-90) "]), airports: JSON.stringify(["KJFK (40,-73)", "KLAX (33,-118) "]), navaids: JSON.stringify([]),
      };
      return { status: 200, headers: { "content-type": request.family === "displayAll" ? "application/json" : "text/plain" }, body: bodies[request.family]! };
    },
  };
  const server = await createApiServer({ adapter: createCaasAdapter({ transport }), refreshSecret: "test-refresh" });
  t.after(() => server.app.close());
  const response = await server.app.inject({ method: "POST", url: "/api/v1/callsigns/search", payload: { query: "TRANSPORT1" } });
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.includes("fixture-secret"), false);
  assert.equal(response.body.includes("airway-secret"), false);
});



test("bounds server-resident drafts within the active generation", async (t) => {
  const server = await createApiServer({ adapter: fixtureAdapter(), refreshSecret: "test-refresh" });
  t.after(() => server.app.close());
  const payload = { origin: "KJFK", destination: "KLAX", via: [] };

  for (let index = 0; index < 512; index += 1) {
    const response = await server.app.inject({ method: "POST", url: "/api/v1/drafts", payload });
    assert.equal(response.statusCode, 201);
  }

  const rejected = await server.app.inject({ method: "POST", url: "/api/v1/drafts", payload });
  assert.equal(rejected.statusCode, 429);
  const body = rejected.json() as { error: { code: string; retryable: boolean } };
  assert.equal(body.error.code, "DRAFT_CAPACITY_REACHED");
  assert.equal(body.error.retryable, true);
});
test("hardens route drafts to resolved airports and withholds incomplete distances", async (t) => {
  const server = await createApiServer({ adapter: fixtureAdapter(), refreshSecret: "test-refresh" });
  t.after(() => server.app.close());
  const invalid = async (payload: unknown, expectedCode = "INVALID_DRAFT") => {
    const response = await server.app.inject({ method: "POST", url: "/api/v1/drafts", payload });
    assert.equal(response.statusCode, 400);
    assert.equal((response.json() as { error: { code: string } }).error.code, expectedCode);
  };

  await invalid({ origin: "", destination: "KLAX", via: [] });
  await invalid({ origin: "KJFK", destination: "   ", via: [] });
  await invalid({ origin: "KJFK", destination: "KLAX", via: [], unexpected: true }, "INVALID_BODY");

  const created = await server.app.inject({ method: "POST", url: "/api/v1/drafts", payload: { origin: " kjfk ", destination: " klax ", via: ["DCT"] } });
  assert.equal(created.statusCode, 201);
  const draftId = (created.json() as { id: string }).id;
  assert.equal(draftId.split(".").length, 2);
  const tamperedDraftId = `${draftId.slice(0, -1)}${draftId.endsWith("A") ? "B" : "A"}`;
  const tampered = await server.app.inject({ method: "POST", url: "/api/v1/drafts/compare", payload: { draftId: tamperedDraftId } });
  assert.equal(tampered.statusCode, 410);
  assert.equal((tampered.json() as { error: { code: string } }).error.code, "DRAFT_EXPIRED");
  const compared = await server.app.inject({ method: "POST", url: "/api/v1/drafts/compare", payload: { draftId } });
  assert.equal(compared.statusCode, 200);
  const complete = compared.json() as { route: Record<string, unknown> };
  assert.equal(complete.route.origin, "John F. Kennedy International Airport (KJFK)");
  assert.equal(complete.route.destination, "Los Angeles International Airport (KLAX)");
  assert.equal(complete.route.complete, undefined);
  assert.equal("rank" in complete.route, false);
  assert.equal(typeof complete.route.distanceNm, "number");
  assert.equal((complete.route.legs as Array<Record<string, unknown>>).every((leg) => typeof leg.distanceNm === "number"), true);

  const nestedUnknown = await server.app.inject({ method: "POST", url: "/api/v1/drafts/compare", payload: { draft: { origin: "KJFK", destination: "KLAX", via: [], unexpected: true } } });
  assert.equal(nestedUnknown.statusCode, 400);
  assert.equal((nestedUnknown.json() as { error: { code: string } }).error.code, "INVALID_DRAFT");

  const nonAirport = await server.app.inject({ method: "POST", url: "/api/v1/drafts/compare", payload: { draft: { origin: "DCT", destination: "KLAX", via: [] } } });
  assert.equal(nonAirport.statusCode, 404);
  assert.equal((nonAirport.json() as { error: { code: string } }).error.code, "AIRPORT_NOT_FOUND");

  const incompleteCreated = await server.app.inject({ method: "POST", url: "/api/v1/drafts", payload: { origin: "KJFK", destination: "KLAX", via: ["UNKNOWN-UPSTREAM-FIX"] } });
  assert.equal(incompleteCreated.statusCode, 201);
  const incompleteId = (incompleteCreated.json() as { id: string }).id;
  const incompleteResponse = await server.app.inject({ method: "POST", url: "/api/v1/drafts/compare", payload: { draftId: incompleteId } });
  assert.equal(incompleteResponse.statusCode, 200);
  const incomplete = incompleteResponse.json() as { route: Record<string, unknown>; comparison: { status: string } };
  assert.equal(incomplete.comparison.status, "gap");
  assert.equal(incomplete.route.distanceNm, undefined);
  assert.equal("rankDistanceNm" in incomplete.route, false);
  assert.equal("rank" in incomplete.route, false);
  assert.equal(incomplete.route.geometry, undefined);
  assert.equal((incomplete.route.legs as Array<Record<string, unknown>>).every((leg) => leg.distanceNm === undefined), true);
});

test("invalidates draft tokens after refresh and fails closed at the live unusable boundary", async (t) => {
  let clock = 10_000;
  let activeRecords: readonly FlightPlanRecord[] = defaultRecords();
  const replacementRecords: FlightPlanRecord[] = [{ ...defaultRecords()[0]!, id: "replacement-raw-id", callsign: "REPLACED" }];
  const base = fixtureAdapter();
  const adapter: CaasAdapter = {
    ...base,
    displayAll: async () => ({ records: activeRecords, evidence: evidence("displayAll", activeRecords.length) }),
  };
  const server = await createApiServer({ adapter, now: () => clock, refreshSecret: "test-refresh" });
  t.after(() => server.app.close());

  const created = await server.app.inject({ method: "POST", url: "/api/v1/drafts", payload: { origin: "KJFK", destination: "KLAX", via: [] } });
  assert.equal(created.statusCode, 201);
  const oldDraftId = (created.json() as { id: string }).id;

  clock += 100;
  activeRecords = replacementRecords;
  const refreshed = await server.app.inject({ method: "POST", url: "/api/v1/refresh", headers: { "x-refresh-token": "test-refresh" } });
  assert.equal(refreshed.statusCode, 200);

  const oldDraft = await server.app.inject({ method: "POST", url: "/api/v1/drafts/compare", payload: { draftId: oldDraftId } });
  assert.equal(oldDraft.statusCode, 410);
  assert.equal((oldDraft.json() as { error: { code: string } }).error.code, "DRAFT_EXPIRED");

  const current = await server.app.inject({ method: "POST", url: "/api/v1/drafts", payload: { origin: "KJFK", destination: "KLAX", via: [] } });
  assert.equal(current.statusCode, 201);
  const currentDraftId = (current.json() as { id: string }).id;
  // After the 5-minute live freshness window the generation is stale but still servable.
  clock += LIVE_FRESH_MS + 1;
  const stale = await server.app.inject({ method: "POST", url: "/api/v1/drafts/compare", payload: { draftId: currentDraftId } });
  assert.equal(stale.statusCode, 200);
  assert.equal((stale.json() as { generation: { overall: string } }).generation.overall, "stale");
  // Past the 30-minute live unusable boundary the generation fails closed.
  clock += LIVE_UNUSABLE_MS + 1;
  const atExpiry = await server.app.inject({ method: "POST", url: "/api/v1/drafts/compare", payload: { draftId: currentDraftId } });
  assert.equal(atExpiry.statusCode, 503);
  assert.equal((atExpiry.json() as { error: { code: string } }).error.code, "GENERATION_STALE");
});

test("surfaces tiered freshness with exact plan §6.2 windows and fails closed when unusable", async (t) => {
  let clock = 5_000;
  const server = await createApiServer({ adapter: fixtureAdapter(), now: () => clock, refreshSecret: "test-refresh" });
  t.after(() => server.app.close());
  const search = async () => server.app.inject({ method: "POST", url: "/api/v1/callsigns/search", payload: { query: "TEST123" } });

  const fresh = await search();
  assert.equal(fresh.statusCode, 200);
  const freshGeneration = (fresh.json() as { generation: { id: string; retrievedAt: string; overall: string; live: { state: string; retrievedAt: string; freshUntil: string; staleUntil: string }; reference: { state: string; retrievedAt: string; freshUntil: string; staleUntil: string } } }).generation;
  assert.equal(freshGeneration.overall, "fresh");
  assert.equal(freshGeneration.live.state, "fresh");
  assert.equal(freshGeneration.reference.state, "fresh");
  assert.equal(freshGeneration.retrievedAt, new Date(5_000).toISOString());
  assert.equal(freshGeneration.live.retrievedAt, freshGeneration.retrievedAt);
  assert.equal(freshGeneration.live.freshUntil, new Date(5_000 + LIVE_FRESH_MS).toISOString());
  assert.equal(freshGeneration.live.staleUntil, new Date(5_000 + LIVE_UNUSABLE_MS).toISOString());
  assert.equal(freshGeneration.reference.freshUntil, new Date(5_000 + REFERENCE_FRESH_MS).toISOString());
  assert.equal(freshGeneration.reference.staleUntil, new Date(5_000 + REFERENCE_UNUSABLE_MS).toISOString());

  clock += LIVE_FRESH_MS + 1;
  const stale = await search();
  assert.equal(stale.statusCode, 200);
  assert.equal((stale.json() as { generation: { overall: string; live: { state: string } } }).generation.overall, "stale");
  assert.equal((stale.json() as { generation: { live: { state: string } } }).generation.live.state, "stale");
  const staleReady = await server.app.inject({ method: "GET", url: "/api/v1/readiness" });
  assert.equal(staleReady.statusCode, 200);
  assert.equal((staleReady.json() as { generation: { overall: string } }).generation.overall, "stale");

  clock += LIVE_UNUSABLE_MS + 1;
  const unusable = await search();
  assert.equal(unusable.statusCode, 503);
  assert.equal((unusable.json() as { error: { code: string; retryable: boolean } }).error.code, "GENERATION_STALE");
  assert.equal((await server.app.inject({ method: "GET", url: "/api/v1/readiness" })).statusCode, 503);
});

test("fails closed with REQUEST_DEADLINE_EXCEEDED when a warm request outlives the deadline", async (t) => {
  const slowAdapter: CaasAdapter = {
    displayAll: async () => { await new Promise((resolve) => setTimeout(resolve, 250)); return { records: defaultRecords(), evidence: evidence("displayAll", defaultRecords().length) }; },
    airways: async () => { throw new Error("not reached"); },
    fixes: async () => { throw new Error("not reached"); },
    airports: async () => { throw new Error("not reached"); },
    navaids: async () => { throw new Error("not reached"); },
  };
  const startedAt = Date.now();
  const server = await createApiServer({ adapter: slowAdapter, initialize: false, warmRequestDeadlineMs: 25, refreshSecret: "test-refresh" });
  t.after(() => server.app.close());
  const response = await server.app.inject({ method: "POST", url: "/api/v1/refresh", headers: { "x-refresh-token": "test-refresh" } });
  assert.equal(response.statusCode, 503);
  assert.equal((response.json() as { error: { code: string; retryable: boolean } }).error.code, "REQUEST_DEADLINE_EXCEEDED");
  assert.equal((response.json() as { error: { retryable: boolean } }).error.retryable, true);
  assert.ok(Date.now() - startedAt < 150, "the deadline must fail closed promptly");
});

test("serves warm requests normally when upstream stays within the deadline", async (t) => {
  const server = await createApiServer({ adapter: fixtureAdapter(), warmRequestDeadlineMs: 25, refreshSecret: "test-refresh" });
  t.after(() => server.app.close());
  const response = await server.app.inject({ method: "POST", url: "/api/v1/callsigns/search", payload: { query: "TEST123" } });
  assert.equal(response.statusCode, 200);
});

test("keeps serving the retained generation with retrieval time after a failed refresh", async (t) => {
  let failing = false;
  const base = fixtureAdapter();
  const adapter: CaasAdapter = {
    ...base,
    displayAll: async () => {
      if (failing) throw new Error("upstream unavailable");
      return { records: defaultRecords(), evidence: evidence("displayAll", defaultRecords().length) };
    },
  };
  const server = await createApiServer({ adapter, refreshSecret: "test-refresh" });
  t.after(() => server.app.close());
  const initial = await server.app.inject({ method: "POST", url: "/api/v1/callsigns/search", payload: { query: "TEST123" } });
  assert.equal(initial.statusCode, 200);
  const initialGeneration = (initial.json() as { generation: { id: string; live: { state: string; retrievedAt: string } } }).generation;
  assert.equal(initialGeneration.live.state, "fresh");

  failing = true;
  const refresh = await server.app.inject({ method: "POST", url: "/api/v1/refresh", headers: { "x-refresh-token": "test-refresh" } });
  assert.equal(refresh.statusCode, 503);
  const refreshBody = refresh.json() as { error: { code: string }; retained: { generation: { id: string; live: { state: string; retrievedAt: string } } } };
  assert.equal(refreshBody.error.code, "REFRESH_FAILED");
  assert.equal(refreshBody.retained.generation.id, initialGeneration.id);
  assert.equal(refreshBody.retained.generation.live.state, "fresh");
  assert.equal(refreshBody.retained.generation.live.retrievedAt, initialGeneration.live.retrievedAt);

  const after = await server.app.inject({ method: "POST", url: "/api/v1/callsigns/search", payload: { query: "TEST123" } });
  assert.equal(after.statusCode, 200);
});

test("retains at most one previous generation and prunes it once unusable", async (t) => {
  let clock = 0;
  const server = await createApiServer({ adapter: fixtureAdapter(), now: () => clock, refreshSecret: "test-refresh", refreshMinIntervalMs: 0 });
  t.after(() => server.app.close());
  const first = server.store.active!.id;
  clock += 1_000;
  await server.app.inject({ method: "POST", url: "/api/v1/refresh", headers: { "x-refresh-token": "test-refresh" } });
  const second = server.store.active!.id;
  assert.equal(server.store.previous?.id, first);
  clock += 1_000;
  await server.app.inject({ method: "POST", url: "/api/v1/refresh", headers: { "x-refresh-token": "test-refresh" } });
  assert.equal(server.store.previous?.id, second);
  // Past the live unusable boundary both the active and retained generations fail closed.
  clock = LIVE_UNUSABLE_MS + 3_000;
  assert.equal((await server.app.inject({ method: "GET", url: "/api/v1/readiness" })).statusCode, 503);
  assert.equal(server.store.previous, undefined);
});

test("keeps callsign search state out of URLs: POST-only with no query string", async (t) => {
  const server = await createApiServer({ adapter: fixtureAdapter(), refreshSecret: "test-refresh" });
  t.after(() => server.app.close());
  for (const url of ["/api/v1/callsigns/search", "/api/v1/search", "/api/v1/flights/search"]) {
    const rejected = await server.app.inject({ method: "GET", url: `${url}?query=TEST123` });
    assert.equal(rejected.statusCode, 405);
    assert.equal(rejected.headers.allow, "POST");
    assert.equal((rejected.json() as { error: { code: string } }).error.code, "METHOD_NOT_ALLOWED");
    const urlLeak = await server.app.inject({ method: "POST", url: `${url}?query=TEST123`, payload: { query: "TEST123" } });
    assert.equal(urlLeak.statusCode, 400);
    assert.equal((urlLeak.json() as { error: { code: string } }).error.code, "INVALID_QUERY");
    const body = await server.app.inject({ method: "POST", url, payload: { query: "TEST123" } });
    assert.equal(body.statusCode, 200);
  }
});

test("summarizes data family record counts without emitting airway values", async (t) => {
  const server = await createApiServer({ adapter: fixtureAdapter(), refreshSecret: "test-refresh" });
  t.after(() => server.app.close());
  const response = await server.app.inject({ method: "GET", url: "/api/v1/data/summary" });
  assert.equal(response.statusCode, 200);
  const body = response.json() as Record<string, unknown>;
  assert.deepEqual(Object.keys(body).sort(), ["airway", "families", "generation"]);
  const families = body.families as Array<Record<string, unknown>>;
  assert.equal(families.length, 5);
  assert.deepEqual(families.map((item) => item.family), ["flights", "airways", "fixes", "airports", "navaids"]);
  for (const item of families) {
    assert.deepEqual(Object.keys(item).sort(), ["acceptedRecords", "family", "records", "rejectedRecords"]);
  }
  assert.deepEqual(families[0], { family: "flights", records: 4, acceptedRecords: 4, rejectedRecords: 0 });
  assert.deepEqual(families[1], { family: "airways", records: 1, acceptedRecords: 1, rejectedRecords: 0 });
  assert.deepEqual(families[2], { family: "fixes", records: 1, acceptedRecords: 1, rejectedRecords: 0 });
  assert.deepEqual(families[3], { family: "airports", records: 2, acceptedRecords: 2, rejectedRecords: 0 });
  assert.deepEqual(families[4], { family: "navaids", records: 2, acceptedRecords: 2, rejectedRecords: 0 });
  const airway = body.airway as Record<string, unknown>;
  assert.deepEqual(Object.keys(airway).sort(), ["acceptedRecords", "family", "records", "rejectedRecords", "uniqueRecords"]);
  assert.deepEqual(airway, { family: "airways", records: 1, acceptedRecords: 1, rejectedRecords: 0, uniqueRecords: 1 });
  // Hard rule: counts only — no airway value/type/evidence field anywhere.
  const keys = new Set<string>();
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) { for (const nested of value) walk(nested); return; }
    if (value && typeof value === "object") {
      for (const [key, nested] of Object.entries(value as Record<string, unknown>)) { keys.add(key); walk(nested); }
    }
  };
  walk(body);
  for (const forbidden of ["bytes", "durationMs", "retried", "identifier", "value", "route", "routeElements", "callsign", "coordinate"]) {
    assert.equal(keys.has(forbidden), false, `summary must not contain the ${forbidden} field`);
  }
  // No parameters: a query string is rejected outright.
  const withQuery = await server.app.inject({ method: "GET", url: "/api/v1/data/summary?limit=2" });
  assert.equal(withQuery.statusCode, 400);
  assert.equal((withQuery.json() as { error: { code: string } }).error.code, "INVALID_QUERY");
});

test("pages flights via POST /api/v1/data/flights with complete disjoint pages", async (t) => {
  const server = await createApiServer({ adapter: fixtureAdapter(), refreshSecret: "test-refresh" });
  t.after(() => server.app.close());
  const first = await server.app.inject({ method: "POST", url: "/api/v1/data/flights", payload: { limit: 2 } });
  assert.equal(first.statusCode, 200);
  const firstBody = first.json() as { data: Array<{ id: string; flightId: string; callsign: string }>; nextCursor?: string };
  assert.deepEqual(Object.keys(firstBody).sort(), ["data", "generation", "nextCursor"]);
  assert.equal(firstBody.data.length, 2);
  assert.ok(firstBody.nextCursor);
  assert.equal(firstBody.data[0]?.callsign, "TEST123");
  assert.equal(firstBody.data[0]?.id, firstBody.data[0]?.flightId);
  const second = await server.app.inject({ method: "POST", url: "/api/v1/data/flights", payload: { limit: 2, cursor: firstBody.nextCursor } });
  assert.equal(second.statusCode, 200);
  const secondBody = second.json() as { data: Array<{ id: string }>; nextCursor?: string };
  assert.deepEqual(Object.keys(secondBody).sort(), ["data", "generation"]);
  assert.equal(secondBody.data.length, 2);
  assert.equal(secondBody.nextCursor, undefined);
  const firstIds = new Set(firstBody.data.map((item) => item.id));
  const secondIds = new Set(secondBody.data.map((item) => item.id));
  assert.equal([...firstIds].every((id) => !secondIds.has(id)), true);
  assert.equal(new Set([...firstIds, ...secondIds]).size, 4);
});

test("expires /api/v1/data cursors when the generation refreshes", async (t) => {
  let refresh = false;
  const first = defaultRecords();
  const second = [{ ...defaultRecords()[0]!, id: "second-raw-id", callsign: "TEST456" }];
  const base = fixtureAdapter(first);
  const adapter: CaasAdapter = {
    displayAll: async () => ({ records: refresh ? second : first, evidence: evidence("displayAll", refresh ? second.length : first.length) }),
    airways: base.airways, fixes: base.fixes, airports: base.airports, navaids: base.navaids,
  };
  const server = await createApiServer({ adapter, refreshSecret: "offline-refresh-secret" });
  t.after(() => server.app.close());
  const page = await server.app.inject({ method: "POST", url: "/api/v1/data/flights", payload: { limit: 2 } });
  const pageBody = page.json() as { nextCursor: string };
  assert.ok(pageBody.nextCursor);
  const refreshed = await server.app.inject({ method: "POST", url: "/api/v1/refresh", headers: { "x-refresh-token": "offline-refresh-secret" } });
  assert.equal(refreshed.statusCode, 200);
  const stale = await server.app.inject({ method: "POST", url: "/api/v1/data/flights", payload: { limit: 2, cursor: pageBody.nextCursor } });
  assert.equal(stale.statusCode, 409);
  assert.equal((stale.json() as { error: { code: string } }).error.code, "CURSOR_EXPIRED");
});

test("pages reference families by kind via POST /api/v1/data endpoints", async (t) => {
  const server = await createApiServer({ adapter: fixtureAdapter(), refreshSecret: "test-refresh" });
  t.after(() => server.app.close());
  const fixes = await server.app.inject({ method: "POST", url: "/api/v1/data/fixes", payload: {} });
  assert.equal(fixes.statusCode, 200);
  const fixesBody = fixes.json() as { data: Array<{ id: string; callsign: string; name: string; kind: string; coordinate: { lat: number; lon: number } }>; nextCursor?: string };
  assert.deepEqual(Object.keys(fixesBody).sort(), ["data", "generation"]);
  assert.equal(fixesBody.data.length, 1);
  assert.deepEqual(Object.keys(fixesBody.data[0]!).sort(), ["callsign", "coordinate", "id", "kind", "name"]);
  assert.equal(fixesBody.data[0]?.kind, "place");
  assert.equal(fixesBody.data[0]?.callsign, "DCT");
  assert.equal(fixesBody.data[0]?.name, "DCT");
  assert.deepEqual(fixesBody.data[0]?.coordinate, { lat: 35, lon: -90 });
  assert.equal(fixesBody.nextCursor, undefined);

  const airports = await server.app.inject({ method: "POST", url: "/api/v1/data/airports", payload: {} });
  assert.equal(airports.statusCode, 200);
  const airportsBody = airports.json() as { data: Array<{ kind: string; callsign: string }> };
  assert.equal(airportsBody.data.length, 2);
  assert.deepEqual(airportsBody.data.map((item) => item.kind), ["airport", "airport"]);
  assert.deepEqual(airportsBody.data.map((item) => item.callsign), ["KJFK", "KLAX"]);

  const navaids = await server.app.inject({ method: "POST", url: "/api/v1/data/navaids", payload: {} });
  assert.equal(navaids.statusCode, 200);
  const navaidsBody = navaids.json() as { data: Array<{ kind: string }> };
  assert.equal(navaidsBody.data.length, 2);
  assert.deepEqual(navaidsBody.data.map((item) => item.kind), ["station", "station"]);

  const airportPage = await server.app.inject({ method: "POST", url: "/api/v1/data/airports", payload: { limit: 1 } });
  assert.equal(airportPage.statusCode, 200);
  const airportPageBody = airportPage.json() as { data: Array<{ callsign: string }>; nextCursor?: string };
  assert.deepEqual(Object.keys(airportPage.json()).sort(), ["data", "generation", "nextCursor"]);
  assert.ok(airportPageBody.nextCursor);
  const airportPage2 = await server.app.inject({ method: "POST", url: "/api/v1/data/airports", payload: { limit: 1, cursor: airportPageBody.nextCursor } });
  assert.equal(airportPage2.statusCode, 200);
  assert.equal((airportPage2.json() as { data: Array<{ callsign: string }> }).data[0]?.callsign, "KLAX");
});

test("rejects invalid limits and unknown body fields on /api/v1/data endpoints", async (t) => {
  const server = await createApiServer({ adapter: fixtureAdapter(), refreshSecret: "test-refresh" });
  t.after(() => server.app.close());
  for (const payload of [{ limit: 0 }, { limit: 101 }, { limit: "abc" }]) {
    const response = await server.app.inject({ method: "POST", url: "/api/v1/data/flights", payload });
    assert.equal(response.statusCode, 400);
    assert.equal((response.json() as { error: { code: string } }).error.code, "INVALID_LIMIT");
  }
  const unknown = await server.app.inject({ method: "POST", url: "/api/v1/data/flights", payload: { limit: 2, bogus: true } });
  assert.equal(unknown.statusCode, 400);
  assert.equal((unknown.json() as { error: { code: string } }).error.code, "INVALID_BODY");
  const urlLeak = await server.app.inject({ method: "POST", url: "/api/v1/data/flights?limit=2", payload: { limit: 2 } });
  assert.equal(urlLeak.statusCode, 400);
  assert.equal((urlLeak.json() as { error: { code: string } }).error.code, "INVALID_QUERY");
});

test("binds /api/v1/data cursors to their family", async (t) => {
  const base = fixtureAdapter();
  const adapter: CaasAdapter = {
    ...base,
    fixes: async () => references("fixes", [["DCT", 35, -90], ["ABC", 36, -91]]),
  };
  const server = await createApiServer({ adapter, refreshSecret: "test-refresh" });
  t.after(() => server.app.close());
  const fixes = await server.app.inject({ method: "POST", url: "/api/v1/data/fixes", payload: { limit: 1 } });
  assert.equal(fixes.statusCode, 200);
  const fixesBody = fixes.json() as { nextCursor?: string };
  assert.ok(fixesBody.nextCursor);
  const sameFamily = await server.app.inject({ method: "POST", url: "/api/v1/data/fixes", payload: { limit: 1, cursor: fixesBody.nextCursor } });
  assert.equal(sameFamily.statusCode, 200);
  const crossFamily = await server.app.inject({ method: "POST", url: "/api/v1/data/airports", payload: { limit: 1, cursor: fixesBody.nextCursor } });
  assert.equal(crossFamily.statusCode, 409);
  assert.equal((crossFamily.json() as { error: { code: string } }).error.code, "CURSOR_EXPIRED");
});

test("404s /api/v1/data/airways because no airways route is registered", async (t) => {
  const server = await createApiServer({ adapter: fixtureAdapter(), refreshSecret: "test-refresh" });
  t.after(() => server.app.close());
  const response = await server.app.inject({ method: "GET", url: "/api/v1/data/airways" });
  assert.equal(response.statusCode, 404);
  assert.equal((response.json() as { error: { code: string } }).error.code, "NOT_FOUND");
});

test("serves a genuine computed direct great-circle alternate from resolved airport coordinates", async (t) => {
  const server = await createApiServer({ adapter: fixtureAdapter(), refreshSecret: "test-refresh" });
  t.after(() => server.app.close());
  const search = await server.app.inject({ method: "POST", url: "/api/v1/callsigns/search", payload: { query: "TEST123" } });
  assert.equal(search.statusCode, 200);
  const flightId = (search.json() as { data: Array<{ id: string }> }).data[0]!.id;
  const response = await server.app.inject({ method: "POST", url: "/api/v1/routes/alternate", payload: { flightId } });
  assert.equal(response.statusCode, 200);
  const body = response.json() as { data: { kind: string; origin: string; destination: string; distanceNm: number; geometry: { type: string; coordinates: number[][] } } };
  assert.equal(body.data.kind, "direct-great-circle");
  assert.ok(body.data.origin.includes("KJFK"));
  assert.ok(body.data.destination.includes("KLAX"));
  assert.ok(Number.isFinite(body.data.distanceNm) && body.data.distanceNm > 0);
  assert.equal(body.data.geometry.type, "LineString");
  assert.ok(body.data.geometry.coordinates.length >= 2);
  assert.deepEqual(body.data.geometry.coordinates[0], [-73.7781, 40.6413]);
  assert.deepEqual(body.data.geometry.coordinates[body.data.geometry.coordinates.length - 1], [-118.4085, 33.9416]);
});
