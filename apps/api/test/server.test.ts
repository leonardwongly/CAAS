import test from "node:test";
import assert from "node:assert/strict";
import { createApiServer, type CaasAdapter } from "../src/index.ts";
import { createCaasAdapter, type DatasetEvidence, type ReferenceDatasetResult } from "@flight-route-explorer/upstream-caas";
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
  const search = await server.app.inject({ method: "GET", url: "/api/v1/callsigns/search?query=duplicate1&limit=1" });
  assert.equal(search.statusCode, 200);
  const searchBody = search.json() as { data: Array<Record<string, string>>; nextCursor?: string };
  assert.equal(searchBody.data.length, 1);
  assert.ok(searchBody.nextCursor);
  assert.notEqual(searchBody.data[0]?.id, "raw-a");
  assert.equal((await server.app.inject({ method: "GET", url: "/api/v1/callsigns/search?query=KJFK" })).json().data.length, 0);

  const firstId = searchBody.data[0]!.id;
  const secondPage = await server.app.inject({ method: "GET", url: `/api/v1/callsigns/search?query=DUPLICATE1&limit=1&cursor=${encodeURIComponent(searchBody.nextCursor!)}` });
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
  assert.equal(route.rank, 1);
  assert.equal((route.legs as unknown[]).length, 1);
  assert.deepEqual(route.gaps, []);
  assert.equal(JSON.stringify(routes).includes("raw-a"), false);

  const detail = await server.app.inject({ method: "GET", url: `/api/v1/routes/${encodeURIComponent(firstId)}` });
  assert.equal(detail.statusCode, 200);
  assert.equal((detail.json() as { data: { geometry?: unknown } }).data.geometry !== undefined, true);
});

test("returns same-endpoint alternatives, preserves tied ranks, and leaves incomplete candidates unranked", async (t) => {
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
  const find = async (callsign: string) => (await server.app.inject({ method: "GET", url: `/api/v1/callsigns/search?query=${callsign}` })).json().data[0].id as string;
  const selectedId = await find("TIESELECTED");

  const options = await server.app.inject({ method: "POST", url: "/api/v1/routes/options", payload: { flightId: selectedId } });
  assert.equal(options.statusCode, 200);
  const routes = (options.json() as { data: Array<Record<string, unknown>> }).data;
  assert.equal(routes.length, 3);
  assert.equal(routes.some((route) => route.flightId === selectedId), true);
  assert.equal(routes[0]?.complete, true);
  assert.equal(routes[1]?.complete, true);
  assert.equal(routes[2]?.complete, false);
  assert.equal(routes[0]?.rank, 1);
  assert.equal(routes[1]?.rank, 1);
  assert.equal(routes[0]?.rankDistanceNm, routes[1]?.rankDistanceNm);
  assert.deepEqual(routes[0]?.operationalProxy, {
    mode: "operational-proxy",
    eligible: true,
    criterion: "minimum-modeled-distance-nm",
    summary: "Shortest complete normalized observed route among same-endpoint candidates returned by this fresh generation.",
    rank: 1,
  });
  assert.deepEqual(routes[2]?.operationalProxy, {
    mode: "operational-proxy",
    eligible: false,
    criterion: "minimum-modeled-distance-nm",
    summary: "Shortest complete normalized observed route among same-endpoint candidates returned by this fresh generation.",
    exclusion: "Route geometry is incomplete or unresolved.",
  });
  assert.equal(routes[2]?.rank, undefined);
  assert.equal(routes[2]?.distanceNm, undefined);
  assert.equal(JSON.stringify(routes).includes("raw-tie"), false);
  assert.equal(JSON.stringify(routes).includes("UNKNOWN-TIE-FIX"), false);
  assert.equal(JSON.stringify(routes).includes("airway"), false);
});

test("prefers embedded points, preserves structured gaps, and never bridges segments", async (t) => {
  const server = await createApiServer({ adapter: fixtureAdapter(), refreshSecret: "test-refresh" });
  t.after(() => server.app.close());
  const find = async (callsign: string) => (await server.app.inject({ method: "GET", url: `/api/v1/callsigns/search?query=${callsign}` })).json().data[0].id as string;

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
  const firstPage = await server.app.inject({ method: "GET", url: "/api/v1/callsigns/search?query=TEST&limit=1" });
  const firstBody = firstPage.json() as { nextCursor?: string; data: Array<{ id: string }> };
  assert.ok(firstBody.nextCursor);
  assert.equal((await server.app.inject({ method: "GET", url: `/api/v1/callsigns/search?query=TEST&limit=1&cursor=${encodeURIComponent(firstBody.nextCursor!)}` })).statusCode, 200);
  assert.equal((await server.app.inject({ method: "GET", url: `/api/v1/callsigns/search?query=TEST&limit=2&cursor=${encodeURIComponent(firstBody.nextCursor!)}` })).statusCode, 409);
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

  const search = await server.app.inject({ method: "GET", url: "/api/v1/callsigns/search?query=CAP000" });
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
  const response = await server.app.inject({ method: "GET", url: "/api/v1/callsigns/search?query=TRANSPORT1" });
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
  assert.equal(complete.route.origin, "KJFK");
  assert.equal(complete.route.destination, "KLAX");
  assert.equal(complete.route.complete, undefined);
  assert.equal(complete.route.rank, undefined);
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
  assert.equal(incomplete.route.rankDistanceNm, undefined);
  assert.equal(incomplete.route.rank, undefined);
  assert.equal(incomplete.route.geometry, undefined);
  assert.equal((incomplete.route.legs as Array<Record<string, unknown>>).every((leg) => leg.distanceNm === undefined), true);
});

test("invalidates draft tokens after refresh and at the exact generation expiry", async (t) => {
  let clock = 10_000;
  let activeRecords: readonly FlightPlanRecord[] = defaultRecords();
  const replacementRecords: FlightPlanRecord[] = [{ ...defaultRecords()[0]!, id: "replacement-raw-id", callsign: "REPLACED" }];
  const base = fixtureAdapter();
  const adapter: CaasAdapter = {
    ...base,
    displayAll: async () => ({ records: activeRecords, evidence: evidence("displayAll", activeRecords.length) }),
  };
  const server = await createApiServer({ adapter, now: () => clock, generationTtlMs: 1_000, refreshSecret: "test-refresh" });
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
  clock += 1_000;
  const atExpiry = await server.app.inject({ method: "POST", url: "/api/v1/drafts/compare", payload: { draftId: currentDraftId } });
  assert.equal(atExpiry.statusCode, 503);
  assert.equal((atExpiry.json() as { error: { code: string } }).error.code, "GENERATION_STALE");
});
