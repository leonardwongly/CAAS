// Owner: R2-D6 — fixture integrity (round-2 adversarial sweep 2026-08-23).
//
// tests/fixtures/web-app.ts installs the fetch stub that ~15 browser suites
// exercise apps/web/src/api.ts against. This lane pins the stub to reality:
//   1. Surface diff: every endpoint the live client calls is served by the
//      stub, and the stub invents no endpoint the client never calls (the one
//      documented exception is the intentional 404 airways guard).
//   2. Behavioral parity: every exported client function consumes the stub
//      responses successfully and yields fully normalized results, and every
//      stub failure mode surfaces exactly the ApiError(status, code) pair the
//      live client rejects with.
//   3. Contract parsing: stub payloads that represent API data survive real
//      packages/contracts schemas — bounded coordinates, the live reference
//      kind vocabulary, request bodies, and the verbatim persistent safety
//      copy.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { vi } from "vitest";
import {
  CoordinateSchema,
  GeoJsonPositionSchema,
  PERSISTENT_SAFETY_COPY,
  ReferenceKindSchema,
  RouteDraftSchema,
} from "../../packages/contracts/src/index.ts";
import {
  ApiError,
  browseAirports,
  browseFixes,
  browseFlights,
  browseNavaids,
  fetchDataSummary,
  fetchReadiness,
  fetchAlternates,
  fetchRouteData,
  fetchRouteOptions,
  fetchRouteOverview,
  lookupPoint,
  refreshLiveData,
  searchCallsigns,
  validateDraft,
} from "../../apps/web/src/api.ts";
import { installApiStub, SAFETY_NOTICE, type StubOptions } from "../fixtures/web-app.ts";

const root = resolve(import.meta.dirname, "../..");

function install(t: { after: (fn: () => void) => void }, options: StubOptions = {}) {
  const stub = installApiStub(options);
  t.after(() => vi.unstubAllGlobals());
  return stub;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function rawJson(method: string, url: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(url, body === undefined ? { method } : { method, body: JSON.stringify(body) });
  return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}

function positionsOf(geometry: unknown): Array<[number, number]> {
  assert.ok(isRecord(geometry) && geometry.type === "LineString" && Array.isArray(geometry.coordinates), "geometry is a GeoJSON LineString");
  return geometry.coordinates as Array<[number, number]>;
}

test("stub endpoint surface equals the live client surface", async () => {
  const endpointPattern = /"(\/api\/v1\/[^"]+)"/g;
  const endpointsOf = (source: string): Set<string> => new Set(
    [...source.matchAll(endpointPattern)].map((match) => match[1]!).filter((path) => !path.endsWith("/")),
  );
  const clientEndpoints = endpointsOf(await readFile(resolve(root, "apps/web/src/api.ts"), "utf8"));
  const stubEndpoints = endpointsOf(await readFile(resolve(root, "tests/fixtures/web-app.ts"), "utf8"));
  assert.ok(clientEndpoints.size >= 14, "the live client exposes a real endpoint surface");
  for (const endpoint of clientEndpoints) {
    assert.ok(stubEndpoints.has(endpoint), `the stub must serve every endpoint the live client calls: ${endpoint}`);
  }
  // The stub may only add endpoints the client never calls as an explicit,
  // documented rejection — the airways browse guard answers 404 because the
  // browse contract never values airway records.
  const intentionalGuards = new Set(["/api/v1/data/airways"]);
  for (const endpoint of stubEndpoints) {
    assert.ok(clientEndpoints.has(endpoint) || intentionalGuards.has(endpoint), `the stub must not invent endpoints the client never calls: ${endpoint}`);
  }
});

test("every live client function consumes the default stub payloads", async (t) => {
  install(t);
  const matches = await searchCallsigns("FIXTURE");
  assert.equal(matches.length, 2, "both fixture matches surface");
  for (const match of matches) {
    assert.ok(match.id && match.flightId && match.callsign, "matches carry opaque ids and callsigns");
    assert.equal(typeof match.routePointCount, "number");
  }

  const options = await fetchRouteOptions("flight-1");
  assert.equal(options.options.length, 3, "all three recorded route options surface");
  assert.equal(options.generation?.id, "gen-1", "the generation summary normalizes");
  const complete = options.options.find((option) => option.id === "route-1");
  assert.ok(complete && complete.complete && complete.geometry && complete.geometry.length === 3, "complete route normalizes with geometry");
  const gapped = options.options.find((option) => option.id === "route-2");
  assert.ok(gapped && !gapped.complete && gapped.gaps.length === 1 && gapped.segments?.length === 2, "gapped route keeps its visible gap and two segments");

  const overview = await fetchRouteOverview();
  assert.equal(overview.routes.length, 3, "the overview loads every fixture flight");
  assert.equal(overview.generation.id, "gen-1");

  const readiness = await fetchReadiness();
  assert.equal(readiness.status, "ready");
  assert.ok(readiness.generation, "readiness carries the generation");

  const refreshed = await refreshLiveData();
  assert.equal(refreshed.status, "refreshed");
  assert.equal(refreshed.generation.id, "gen-2", "refresh advances the generation id");

  const detail = await fetchRouteData("route-1");
  assert.equal(detail.id, "route-1");

  const alternates = await fetchAlternates("flight-1");
  assert.equal(alternates.length, 2, "both alternate candidates surface");
  assert.equal(alternates[0]!.kind, "direct-great-circle");
  assert.equal(alternates[1]!.kind, "via-waypoint");
  assert.ok(alternates.every((candidate) => candidate.geometry.length >= 2 && candidate.distanceNm > 0), "alternate candidates normalize geometry and distance");

  const lookup = await lookupPoint("MIDPT");
  assert.equal(lookup.matches.length, 1, "the fixture fix resolves to one match");
  assert.equal(lookup.matches[0]!.locationId, "loc-MIDPT");
  assert.equal(lookup.matches[0]!.identifier, "MIDPT");
  assert.equal(lookup.truncated, false);
  assert.equal((await lookupPoint("NOSUCH")).matches.length, 0, "unknown references resolve to an empty match set");

  const comparison = await validateDraft("KOR1", "KDS1", ["MIDPT"], [], "route-1");
  assert.equal(comparison.id, "draft-1");
  assert.equal(comparison.comparison.status, "complete");
  assert.equal(comparison.comparison.distanceDeltaNm, 0);
  assert.equal(comparison.route.legs.length, 2);

  const summary = await fetchDataSummary();
  assert.equal(summary.families.length, 4);
  assert.equal(summary.airway.records, 3);
  assert.ok(summary.generation, "the summary carries the generation");

  const flights = await browseFlights(50);
  assert.equal(flights.items.length, 12, "the flight browse loads both pages' worth of fixture flights");
  assert.equal(flights.nextCursor, undefined, "a full page terminates the cursor");
  const paged = await browseFlights(10);
  assert.equal(paged.items.length, 10);
  assert.equal(paged.nextCursor, "p1");
  const rest = await browseFlights(50, "p1");
  assert.equal(rest.items.length, 2, "the cursor advances to the terminal page");
  assert.equal((await browseFixes()).items.length, 1);
  assert.equal((await browseAirports()).items.length, 2);
  assert.equal((await browseNavaids()).items.length, 0);
});

test("stub failure modes surface exactly the ApiError the live client rejects", async (t) => {
  install(t, { failSearch: true, failRoutes: true, failDraft: true, failCursor: true });
  await assert.rejects(searchCallsigns("FIXTURE"), (error: unknown) => error instanceof ApiError && error.status === 500 && error.code === "SEARCH_FAIL");
  await assert.rejects(fetchRouteOptions("flight-1"), (error: unknown) => error instanceof ApiError && error.status === 500 && error.code === "ROUTES_FAIL");
  await assert.rejects(validateDraft("KOR1", "KDS1", [], [], "route-1"), (error: unknown) => error instanceof ApiError && error.status === 500 && error.code === "DRAFT_FAIL");
  await assert.rejects(browseFlights(10), (error: unknown) => error instanceof ApiError && error.status === 409 && error.code === "CURSOR_EXPIRED");
});

test("stub payloads survive real contract parsing", async (t) => {
  install(t);
  // Generation envelopes: every timestamp is a parseable instant and every tier is complete.
  const overview = (await rawJson("POST", "/api/v1/routes/overview", { limit: 25 })).json;
  const generation = overview.generation;
  assert.ok(isRecord(generation), "overview carries a generation");
  for (const tier of [generation.live, generation.reference]) {
    assert.ok(isRecord(tier), "generation tier present");
    assert.ok(typeof tier.state === "string" && tier.state.length > 0, "tier state is a non-empty string");
    for (const field of ["retrievedAt", "freshUntil", "staleUntil"]) {
      const value = tier[field];
      assert.ok(typeof value === "string" && Number.isFinite(Date.parse(value)), `${field} is a parseable timestamp`);
    }
  }
  assert.ok(Number.isFinite(Date.parse(String(generation.retrievedAt))), "generation retrievedAt parses");

  // Route payloads: every geometry position honors the GeoJSON bound schema and
  // every {lat,lon} segment point honors CoordinateSchema.
  const routes = overview.data;
  assert.ok(Array.isArray(routes) && routes.length > 0, "overview carries routes");
  for (const route of routes as Array<Record<string, unknown>>) {
    if (route.geometry !== undefined) for (const position of positionsOf(route.geometry)) assert.doesNotThrow(() => GeoJsonPositionSchema.parse(position), "geometry position is bounded");
    if (Array.isArray(route.segments)) {
      for (const segment of route.segments as Array<Array<Record<string, unknown>>>) {
        for (const point of segment) assert.doesNotThrow(() => CoordinateSchema.parse(point), "segment point is bounded");
      }
    }
    assert.ok(route.status === "complete" || route.status === "incomplete", "route status uses the live vocabulary");
  }

  // Point lookups: kinds come from the live reference-kind vocabulary — a
  // value like "fix" can never leave the real BFF (ReferenceKindSchema).
  const kindVocabulary = new Set<string>(ReferenceKindSchema.options);
  for (const reference of ["KOR1", "KDS1", "MIDPT"]) {
    const body = (await rawJson("POST", "/api/v1/points/lookup", { reference })).json;
    const matches = body.matches;
    assert.ok(Array.isArray(matches) && matches.length > 0, `${reference} resolves`);
    for (const match of matches as Array<Record<string, unknown>>) {
      assert.ok(kindVocabulary.has(String(match.kind)), `point kind ${String(match.kind)} is in the live vocabulary`);
      assert.doesNotThrow(() => CoordinateSchema.parse(match.coordinate), "match coordinate is bounded");
    }
  }

  // Draft validation: the request's targetDraft parses through RouteDraftSchema
  // and the response carries the verbatim persistent safety copy.
  assert.doesNotThrow(() => RouteDraftSchema.parse({ origin: "KOR1", destination: "KDS1", via: ["MIDPT"], selections: [] }), "the stub's draft request body is contract-valid");
  const compared = (await rawJson("POST", "/api/v1/routes/compare", { baselineId: "route-1", targetDraft: { origin: "KOR1", destination: "KDS1", via: ["MIDPT"], selections: [] } })).json;
  assert.ok(isRecord(compared.target) && isRecord(compared.comparison), "compare returns target + comparison");
  assert.equal((compared.target as Record<string, unknown>).safety, PERSISTENT_SAFETY_COPY, "the draft safety copy is verbatim");
  assert.equal(SAFETY_NOTICE, PERSISTENT_SAFETY_COPY, "the fixture safety notice is the contracts copy, not a paraphrase");

  // Browse payloads: reference items carry bounded coordinates and the live
  // family kinds; flight items carry the normalized DTO fields.
  const fixes = (await rawJson("POST", "/api/v1/data/fixes", { limit: 50 })).json;
  for (const item of fixes.data as Array<Record<string, unknown>>) {
    assert.ok(kindVocabulary.has(String(item.kind)), "browse kind is in the live vocabulary");
    assert.doesNotThrow(() => CoordinateSchema.parse(item.coordinate), "browse coordinate is bounded");
  }
  const flights = (await rawJson("POST", "/api/v1/data/flights", { limit: 50 })).json;
  assert.ok(Array.isArray(flights.data) && (flights.data as unknown[]).length > 0, "flight browse carries records");
  for (const item of flights.data as Array<Record<string, unknown>>) {
    for (const field of ["id", "callsign", "departure", "destination"]) {
      assert.ok(typeof item[field] === "string" && String(item[field]).length > 0, `flight item carries ${field}`);
    }
    assert.ok(typeof item.pointCount === "number" && Number.isFinite(item.pointCount), "flight item carries a finite pointCount");
  }
});
