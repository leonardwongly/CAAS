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

  const search = await server.app.inject({ method: "GET", url: "/api/v1/callsigns/search?query=FIXTURE1" });
  assert.equal(search.statusCode, 200);
  const searchBody = search.json() as { data: Array<Record<string, unknown>>; generation: { id: string; fresh: boolean } };
  assert.equal(searchBody.data.length, 1);
  assert.equal(searchBody.generation.fresh, true);
  const flightId = String(searchBody.data[0]?.id);
  const options = await server.app.inject({ method: "POST", url: "/api/v1/routes/options", payload: { flightId } });
  assert.equal(options.statusCode, 200);
  const route = (options.json() as { data: Array<Record<string, unknown>> }).data[0]!;
  assert.equal(route.provenance, "CAAS normalized snapshot");
  assert.equal(route.safety, "For planning display only; verify operational data before use.");
  assert.deepEqual(route.gaps, []);
  assert.equal(typeof route.distanceNm, "number");
  assert.equal(typeof route.rankDistanceNm, "number");
  assert.equal(route.rank, 1);
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

test("binds browse cursors and opaque IDs to the active generation", async (t) => {
  const state = { records: sanitizedFlights };
  const server = await createApiServer({ adapter: mutableAdapter(sanitizedFlights, state), refreshSecret: "offline-refresh-secret" });
  t.after(() => server.app.close());

  const first = await server.app.inject({ method: "GET", url: "/api/v1/routes?limit=1" });
  assert.equal(first.statusCode, 200);
  const firstBody = first.json() as { nextCursor?: string; data: Array<{ id: string }> };
  assert.ok(firstBody.nextCursor);
  assert.ok(firstBody.data[0]?.id);
  assert.equal((await server.app.inject({ method: "GET", url: `/api/v1/routes?limit=1&cursor=${encodeURIComponent(firstBody.nextCursor!)}` })).statusCode, 200);

  const unauthorized = await server.app.inject({ method: "POST", url: "/api/v1/refresh" });
  assert.equal(unauthorized.statusCode, 401);
  state.records = [sanitizedFlights[1]!];
  const refreshed = await server.app.inject({ method: "POST", url: "/api/v1/refresh", headers: { "x-refresh-token": "offline-refresh-secret" } });
  assert.equal(refreshed.statusCode, 200);
  const staleCursor = await server.app.inject({ method: "GET", url: `/api/v1/routes?limit=1&cursor=${encodeURIComponent(firstBody.nextCursor!)}` });
  assert.equal(staleCursor.statusCode, 409);
  assert.equal((staleCursor.json() as { error: { code: string } }).error.code, "CURSOR_EXPIRED");
  const staleId = await server.app.inject({ method: "GET", url: `/api/v1/routes/${encodeURIComponent(firstBody.data[0]!.id)}` });
  assert.equal(staleId.statusCode, 410);
  assert.equal((staleId.json() as { error: { code: string } }).error.code, "GENERATION_EXPIRED");
  const expiredDraft = await server.app.inject({ method: "POST", url: "/api/v1/drafts/compare", payload: { draftId: "not-a-live-draft" } });
  assert.equal(expiredDraft.statusCode, 410);
});

test("fails closed on cold, stale, or incomplete acquisition", async (t) => {
  const failing: CaasAdapter = {
    displayAll: async () => { throw new Error("offline fixture unavailable"); },
    airways: async () => { throw new Error("offline fixture unavailable"); },
    fixes: async () => { throw new Error("offline fixture unavailable"); },
    airports: async () => { throw new Error("offline fixture unavailable"); },
    navaids: async () => { throw new Error("offline fixture unavailable"); },
  };
  const server = await createApiServer({ adapter: failing, initialize: false });
  t.after(() => server.app.close());
  assert.equal((await server.app.inject({ method: "GET", url: "/readyz" })).statusCode, 503);
  await assert.rejects(server.store.initialize(), /live data generation/);
  assert.equal((await server.app.inject({ method: "GET", url: "/readyz" })).statusCode, 503);
});
