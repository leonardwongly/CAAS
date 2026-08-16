import assert from "node:assert/strict";
import test from "node:test";
import { createApiServer } from "../apps/api/src/index.ts";
import type { CaasAdapter, FlightPlanRecord } from "../packages/upstream-caas/src/index.ts";
import { sanitizedAdapter, sanitizedFlights } from "./fixtures/sanitized-caas.ts";

function mutableAdapter(records: readonly FlightPlanRecord[], state: { records: readonly FlightPlanRecord[] }): CaasAdapter {
  const base = sanitizedAdapter(records);
  return {
    ...base,
    displayAll: async () => ({ records: state.records, evidence: { family: "displayAll", bytes: 128, records: state.records.length, acceptedRecords: state.records.length, rejectedRecords: 0, retried: false, durationMs: 0 } }),
  };
}

test("exposes stable DTOs with provenance, safety, visible gaps, and no raw upstream fields", async (t) => {
  const server = await createApiServer({ adapter: sanitizedAdapter() });
  t.after(() => server.app.close());

  const search = await server.app.inject({ method: "POST", url: "/api/v1/callsigns/search", payload: { query: "FIXTURE1" } });
  assert.equal(search.statusCode, 200);
  const searchBody = search.json() as { data: Array<Record<string, unknown>>; generation: { id: string; retrievedAt: string; overall: string; live: { state: string; retrievedAt: string; freshUntil: string; staleUntil: string }; reference: { state: string; retrievedAt: string; freshUntil: string; staleUntil: string } } };
  assert.equal(searchBody.data.length, 1);
  assert.equal(searchBody.generation.overall, "fresh");
  assert.equal(searchBody.generation.live.state, "fresh");
  assert.equal(searchBody.generation.reference.state, "fresh");
  assert.equal(searchBody.generation.live.retrievedAt, searchBody.generation.retrievedAt);
  assert.ok(Date.parse(searchBody.generation.live.freshUntil) > Date.parse(searchBody.generation.retrievedAt));
  assert.ok(Date.parse(searchBody.generation.live.staleUntil) > Date.parse(searchBody.generation.live.freshUntil));
  const flightId = String(searchBody.data[0]?.id);
  const options = await server.app.inject({ method: "POST", url: "/api/v1/routes/options", payload: { flightId } });
  assert.equal(options.statusCode, 200);
  const route = (options.json() as { data: Array<Record<string, unknown>> }).data[0]!;
  assert.equal(route.provenance, "CAAS normalized live generation");
  assert.equal(route.safety, "Demonstration only. Operational weather, NOTAM, ATC, fuel, aircraft suitability, and regulatory constraints are not evaluated.");
  assert.deepEqual(route.gaps, []);
  assert.equal(typeof route.distanceNm, "number");
  for (const field of ["rank", "rankDistanceNm", "rankLabel", "operationalProxy"]) assert.equal(field in route, false);
  const serialized = JSON.stringify(options.json());
  for (const forbidden of ["fixture-flight-1", "hidden-airway-value", "offline-fixture-key", "raw"]) assert.equal(serialized.includes(forbidden), false, forbidden);

  const lookup = await server.app.inject({ method: "GET", url: "/api/v1/points/lookup?reference=DUPX" });
  assert.equal(lookup.statusCode, 200);
  assert.equal((lookup.json() as { status: string; matches: unknown[] }).status, "ambiguous");
  assert.equal((lookup.json() as { matches: unknown[] }).matches.length, 2);

  const draft = await server.app.inject({ method: "POST", url: "/api/v1/drafts", payload: { origin: "KOR1", via: ["MISSING"], destination: "KDS1" } });
  assert.equal(draft.statusCode, 201);
  const draftId = (draft.json() as { id: string }).id;
  const comparison = await server.app.inject({ method: "POST", url: "/api/v1/drafts/compare", payload: { draftId } });
  assert.equal(comparison.statusCode, 200);
  const comparisonBody = comparison.json() as { comparison: { status: string; message: string }; route: { gaps: string[]; distanceNm?: number } };
  assert.equal(comparisonBody.comparison.status, "gap");
  assert.equal(comparisonBody.route.distanceNm, undefined);
  assert.equal(comparisonBody.route.gaps.length, 1);
  assert.match(comparisonBody.comparison.message, /inferred/);
});

test("applies same-origin security headers to API responses", async (t) => {
  const server = await createApiServer({ adapter: sanitizedAdapter() });
  t.after(() => server.app.close());

  const response = await server.app.inject({ method: "GET", url: "/api/v1/health/live" });
  assert.equal(response.statusCode, 200);
  assert.match(String(response.headers["content-security-policy"]), /default-src 'self'/);
  // The single authorized external destination: OSM raster tiles (owner
  // authorization 2026-08-15). connect-src stays same-origin.
  assert.match(String(response.headers["content-security-policy"]), /img-src 'self' data: https:\/\/tile\.openstreetmap\.org/);
  assert.equal(response.headers["referrer-policy"], "strict-origin-when-cross-origin");
  assert.equal(response.headers["x-content-type-options"], "nosniff");
  assert.equal(response.headers["x-frame-options"], "DENY");
});
