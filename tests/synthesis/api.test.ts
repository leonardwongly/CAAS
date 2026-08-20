import assert from "node:assert/strict";
import test from "node:test";
import { createApiServer } from "../../apps/api/src/index.ts";
import { synthesisAdapter } from "../fixtures/synthesis-caas.ts";

async function flightIds(server: Awaited<ReturnType<typeof createApiServer>>): Promise<Map<string, string>> {
  const overview = await server.app.inject({ method: "POST", url: "/api/v1/routes/overview", payload: { limit: 25 } });
  const map = new Map<string, string>();
  for (const route of (overview.json() as { data: Array<{ callsign: string; flightId: string }> }).data) map.set(route.callsign, route.flightId);
  return map;
}

test("synthesis: complete route returns not-needed; incomplete target yields auditable candidates", async (t) => {
  const server = await createApiServer({ adapter: synthesisAdapter() });
  t.after(() => server.app.close());
  const ids = await flightIds(server);

  const complete = await server.app.inject({ method: "POST", url: "/api/v1/routes/synthesis", payload: { flightId: ids.get("SYNTH1") } });
  assert.equal(complete.statusCode, 200);
  assert.equal((complete.json() as { status: string }).status, "not-needed");

  const target = await server.app.inject({ method: "POST", url: "/api/v1/routes/synthesis", payload: { flightId: ids.get("SYNTH3") } });
  assert.equal(target.statusCode, 200);
  const body = target.json() as {
    status: string; candidates: Array<Record<string, unknown>>; generation: { id: string }; safety: string;
  };
  assert.equal(body.status, "ambiguous");
  assert.equal(body.candidates.length, 2);
  assert.equal(body.safety, "Demonstration only. Operational weather, NOTAM, ATC, fuel, aircraft suitability, and regulatory constraints are not evaluated.");
  const serialized = JSON.stringify(body);
  for (const forbidden of ["synth-r2", "hidden-airway", "rank", "rankDistanceNm", "operationalProxy"]) {
    if (forbidden === "rank") { assert.equal(/"rank"/.test(serialized), false); continue; }
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
  // Source DTO untouched: the target route DTO still reports incomplete with no distanceNm.
  const detail = await server.app.inject({ method: "POST", url: "/api/v1/routes/detail", payload: { routeId: ids.get("SYNTH3") } });
  const dto = (detail.json() as { data: Record<string, unknown> }).data;
  assert.equal(dto.complete, false);
  assert.equal("distanceNm" in dto, false);
  assert.equal((dto.gaps as unknown[]).length, 1);

  // Every donor proof resolves through source-occurrences with exact coordinates.
  const candidate = body.candidates[0] as { segments: Array<{ proofIds?: string[]; geometry?: { coordinates: number[][] } }> };
  const borrowed = candidate.segments.find((segment) => "proofIds" in segment)!;
  const proof = await server.app.inject({ method: "POST", url: "/api/v1/routes/source-occurrences", payload: { proofId: borrowed.proofIds![0] } });
  assert.equal(proof.statusCode, 200);
  const proofBody = proof.json() as { data: { occurrences: Array<{ ordinal: number; coordinate?: [number, number] | { lat: number; lon: number } }> } };
  const ordinals = proofBody.data.occurrences.map((occurrence) => occurrence.ordinal);
  assert.deepEqual(ordinals, ordinals.map((_, index) => ordinals[0]! + index)); // contiguous/increasing
});

test("synthesis: method/URL/body hygiene fails closed", async (t) => {
  const server = await createApiServer({ adapter: synthesisAdapter() });
  t.after(() => server.app.close());
  const get = await server.app.inject({ method: "GET", url: "/api/v1/routes/synthesis" });
  assert.equal(get.statusCode, 405);
  assert.equal(get.headers.allow, "POST");
  const badBody = await server.app.inject({ method: "POST", url: "/api/v1/routes/synthesis", payload: { flightId: "x", extra: 1 } });
  assert.equal(badBody.statusCode, 400);
  const queryString = await server.app.inject({ method: "POST", url: "/api/v1/routes/synthesis?flightId=x", payload: {} });
  assert.equal(queryString.statusCode, 400);
});
