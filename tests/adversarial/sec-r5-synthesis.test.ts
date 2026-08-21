import assert from "node:assert/strict";
import test from "node:test";
import { createApiServer } from "../../apps/api/src/index.ts";
import type { CaasAdapter, FlightPlanRecord, ReferenceDatasetResult } from "../../packages/upstream-caas/src/index.ts";
import { SYNTHESIS_COORDS, synthesisAdapter } from "../fixtures/synthesis-caas.ts";

// Security sweep round-5 (donor-subpath synthesis, issue #44 task 11):
// - Synthesis and source-occurrences responses never serialize upstream
//   identity: upstream flight ids (synth-r1…synth-r7) are fixture-internal
//   only, donor callsigns never surface in proof responses, no airway value
//   or internal scoring field ("rank", "operationalProxy") is emitted.
// - Forged/tampered and cross-generation donor proofs fail closed with
//   PROOF_INVALID.
// - A synthesis cursor binds `${flightIndex}|algorithmVersion`: a cursor
//   minted for one flight cannot offset another flight's candidate pages.
// - Body allow-list and empty-query hygiene fail closed on both endpoints.
// - A complete route is "not-needed" and its source DTO surface is
//   byte-equal to the overview DTO for the same flight (synthesis never
//   mutates the recorded source route).

const UPSTREAM_IDS = ["synth-r1", "synth-r2", "synth-r3", "synth-r4", "synth-r5", "synth-r6", "synth-r7"];
const UPSTREAM_CALLSIGNS = ["SYNTH1", "SYNTH2", "SYNTH3", "SYNTH4", "SYNTH5", "SYNTH6", "SYNTH7"];

type ApiServer = Awaited<ReturnType<typeof createApiServer>>;

async function flightIds(server: ApiServer): Promise<Map<string, string>> {
  const overview = await server.app.inject({ method: "POST", url: "/api/v1/routes/overview", payload: { limit: 25 } });
  assert.equal(overview.statusCode, 200);
  const map = new Map<string, string>();
  for (const route of (overview.json() as { data: Array<{ callsign: string; flightId: string }> }).data) map.set(route.callsign, route.flightId);
  return map;
}

function assertNoUpstreamIdentity(serialized: string, surface: string): void {
  for (const id of UPSTREAM_IDS) {
    assert.equal(serialized.includes(id), false, `${surface} must never serialize upstream flight id ${id}`);
  }
  for (const callsign of UPSTREAM_CALLSIGNS) {
    assert.equal(serialized.includes(callsign), false, `${surface} must never serialize donor callsign ${callsign}`);
  }
  assert.equal(/airway/i.test(serialized), false, `${surface} must never serialize an airway value`);
  assert.equal(/"rank"/.test(serialized), false, `${surface} must never serialize internal scoring field "rank"`);
  assert.equal(serialized.includes("operationalProxy"), false, `${surface} must never serialize operationalProxy`);
}

function flipBase64UrlChar(value: string, index: number): string {
  const original = value[index];
  assert.ok(original !== undefined, "flip index must be inside the token");
  const replacement = original === "A" ? "B" : "A";
  return value.slice(0, index) + replacement + value.slice(index + 1);
}

async function firstProofId(server: ApiServer, ids: Map<string, string>): Promise<string> {
  const synthesis = await server.app.inject({ method: "POST", url: "/api/v1/routes/synthesis", payload: { flightId: ids.get("SYNTH3") } });
  assert.equal(synthesis.statusCode, 200);
  const body = synthesis.json() as { candidates: Array<{ segments: Array<{ proofIds?: string[] }> }> };
  const proofIds = body.candidates.flatMap((candidate) => candidate.segments.filter((segment) => "proofIds" in segment)).flatMap((segment) => segment.proofIds ?? []);
  assert.ok(proofIds.length > 0, "the fixture target must mint at least one donor proof");
  return proofIds[0]!;
}

test("synthesis and source-occurrences responses never serialize upstream identity", async (t) => {
  const server = await createApiServer({ adapter: synthesisAdapter() });
  t.after(() => server.app.close());
  const ids = await flightIds(server);

  // The incomplete target (R3) and the complete route (R1) both fail the
  // identity sweep: opaque tokens, borrowed geometry, and distances only.
  for (const callsign of ["SYNTH3", "SYNTH1"]) {
    const synthesis = await server.app.inject({ method: "POST", url: "/api/v1/routes/synthesis", payload: { flightId: ids.get(callsign) } });
    assert.equal(synthesis.statusCode, 200);
    assertNoUpstreamIdentity(synthesis.body, `synthesis response for ${callsign}`);
  }

  // Every donor proof resolves, and no proof response carries upstream identity.
  const synthesis = await server.app.inject({ method: "POST", url: "/api/v1/routes/synthesis", payload: { flightId: ids.get("SYNTH3") } });
  const body = synthesis.json() as { candidates: Array<{ segments: Array<{ proofIds?: string[] }> }> };
  const proofIds = body.candidates.flatMap((candidate) => candidate.segments).flatMap((segment) => segment.proofIds ?? []);
  assert.ok(proofIds.length > 0, "the fixture target must mint at least one donor proof");
  for (const proofId of proofIds) {
    const proof = await server.app.inject({ method: "POST", url: "/api/v1/routes/source-occurrences", payload: { proofId } });
    assert.equal(proof.statusCode, 200);
    assertNoUpstreamIdentity(proof.body, "source-occurrences proof response");
  }
});

test("forged, tampered, and cross-generation donor proofs fail closed with PROOF_INVALID", async (t) => {
  const server = await createApiServer({ adapter: synthesisAdapter() });
  t.after(() => server.app.close());
  const ids = await flightIds(server);
  const proofId = await firstProofId(server, ids);

  // Flip one base64url char in the signature: HMAC verification must fail.
  const forgedSignature = flipBase64UrlChar(proofId, proofId.length - 1);
  const forged = await server.app.inject({ method: "POST", url: "/api/v1/routes/source-occurrences", payload: { proofId: forgedSignature } });
  assert.equal(forged.statusCode, 400, "a signature-tampered proof must fail closed");
  assert.equal((forged.json() as { error: { code: string } }).error.code, "PROOF_INVALID");

  // Flip one base64url char in the body: the signature no longer binds.
  const bodySeparator = proofId.indexOf(".");
  const tamperedBody = flipBase64UrlChar(proofId, Math.floor(bodySeparator / 2));
  const tampered = await server.app.inject({ method: "POST", url: "/api/v1/routes/source-occurrences", payload: { proofId: tamperedBody } });
  assert.equal(tampered.statusCode, 400, "a body-tampered proof must fail closed");
  assert.equal((tampered.json() as { error: { code: string } }).error.code, "PROOF_INVALID");

  // Cross-generation: a proof minted by a second server (its own generation
  // and token secret) must not resolve on the first server.
  const other = await createApiServer({ adapter: synthesisAdapter() });
  t.after(() => other.app.close());
  const otherIds = await flightIds(other);
  const foreignProofId = await firstProofId(other, otherIds);
  const crossGeneration = await server.app.inject({ method: "POST", url: "/api/v1/routes/source-occurrences", payload: { proofId: foreignProofId } });
  assert.equal(crossGeneration.statusCode, 400, "a proof from another generation/server must fail closed");
  assert.equal((crossGeneration.json() as { error: { code: string } }).error.code, "PROOF_INVALID");

  // Sanity: the genuine proof still resolves on its own server.
  const genuine = await server.app.inject({ method: "POST", url: "/api/v1/routes/source-occurrences", payload: { proofId } });
  assert.equal(genuine.statusCode, 200);
});

// The canonical R1-R7 fixture never produces more than SYNTHESIS_PAGE (5)
// candidates for any target, so it never mints a synthesis cursor. To prove
// the cursor binds `${flightIndex}|version`, this local fixture adds six
// donors with distinct D->E geometries so the first page issues a nextCursor.
function pagedFixtureAdapter(): CaasAdapter {
  const airports = [
    ["C", SYNTHESIS_COORDS.C[0], SYNTHESIS_COORDS.C[1]],
    ["D", SYNTHESIS_COORDS.D[0], SYNTHESIS_COORDS.D[1]],
    ["E", SYNTHESIS_COORDS.E[0], SYNTHESIS_COORDS.E[1]],
  ] as const;
  const fixes = Array.from({ length: 6 }, (_, index) => [`PGZ${index}`, 20 + index, 30] as const);
  const records: FlightPlanRecord[] = [
    // Target: C -> D -> [gap] -> E (single D->E corridor).
    { id: "pg-target", callsign: "PGT0", departure: "C", destination: "E", routeElements: [{ sequence: 0, identifier: "D" }, { sequence: 1, identifier: "PGMISS" }] },
    // Six donors with distinct D->Z_i->E geometries: 6 candidates > page of 5.
    ...Array.from({ length: 6 }, (_, index): FlightPlanRecord => ({
      id: `pg-donor-${index}`, callsign: `PGD${index}`, departure: "C", destination: "E",
      routeElements: [{ sequence: 0, identifier: "D" }, { sequence: 1, identifier: `PGZ${index}` }],
    })),
  ];
  const referenceData = (dataset: "fixes" | "airports" | "navaids", values: readonly (readonly [string, number, number])[]): ReferenceDatasetResult => {
    const points = values.map(([identifier, lat, lon]) => ({ dataset, identifier, coordinate: { lat, lon } }));
    const index = new Map<string, typeof points>();
    for (const point of points) index.set(point.identifier, [...(index.get(point.identifier) ?? []), point]);
    return { dataset, points, index, evidence: { family: dataset, bytes: 64, records: points.length, acceptedRecords: points.length, rejectedRecords: 0, retried: false, durationMs: 0 } };
  };
  return {
    displayAll: async () => ({ records, evidence: { family: "displayAll", bytes: 128, records: records.length, acceptedRecords: records.length, rejectedRecords: 0, retried: false, durationMs: 0 } }),
    airways: async () => ({ family: "airways", bytes: 64, records: 0, acceptedRecords: 0, rejectedRecords: 0, uniqueRecords: 0, retried: false, durationMs: 0 }),
    fixes: async () => referenceData("fixes", fixes),
    airports: async () => referenceData("airports", airports),
    navaids: async () => referenceData("navaids", []),
  };
}

test("a synthesis cursor minted for one flight cannot offset another flight's page", async (t) => {
  const server = await createApiServer({ adapter: pagedFixtureAdapter() });
  t.after(() => server.app.close());
  const ids = await flightIds(server);

  const page = await server.app.inject({ method: "POST", url: "/api/v1/routes/synthesis", payload: { flightId: ids.get("PGT0") } });
  assert.equal(page.statusCode, 200);
  const body = page.json() as { status: string; candidates: unknown[]; nextCursor?: string };
  assert.equal(body.candidates.length, 5, "the first page is bounded to SYNTHESIS_PAGE candidates");
  assert.ok(body.nextCursor, "a target with more candidates than the page size mints a next cursor");

  // The cursor still works for its own flight (page 2 carries the remainder).
  const sameFlight = await server.app.inject({ method: "POST", url: "/api/v1/routes/synthesis", payload: { flightId: ids.get("PGT0"), cursor: body.nextCursor } });
  assert.equal(sameFlight.statusCode, 200, "the cursor must still page its own flight");
  assert.equal((sameFlight.json() as { candidates: unknown[] }).candidates.length, 1, "page 2 carries the remaining candidate");

  // Reused for another flight, the q-binding (`${flightIndex}|version`) fails closed.
  const otherFlight = await server.app.inject({ method: "POST", url: "/api/v1/routes/synthesis", payload: { flightId: ids.get("PGD0"), cursor: body.nextCursor } });
  assert.equal(otherFlight.statusCode, 409, "a cursor minted for one flight must never offset another flight");
  assert.equal((otherFlight.json() as { error: { code: string } }).error.code, "CURSOR_EXPIRED");
});

test("body allow-list and empty-query hygiene fail closed on both endpoints", async (t) => {
  const server = await createApiServer({ adapter: synthesisAdapter() });
  t.after(() => server.app.close());
  const ids = await flightIds(server);

  const extraField = await server.app.inject({ method: "POST", url: "/api/v1/routes/synthesis", payload: { flightId: ids.get("SYNTH3"), extra: 1 } });
  assert.equal(extraField.statusCode, 400, "a synthesis body over the allow-list must fail closed");
  assert.equal((extraField.json() as { error: { code: string } }).error.code, "INVALID_BODY");

  const queryString = await server.app.inject({ method: "POST", url: "/api/v1/routes/synthesis?flightId=x", payload: {} });
  assert.equal(queryString.statusCode, 400, "a non-empty query string must fail closed");
  assert.equal((queryString.json() as { error: { code: string } }).error.code, "INVALID_QUERY");

  const proofExtraField = await server.app.inject({ method: "POST", url: "/api/v1/routes/source-occurrences", payload: { proofId: "x", extra: 1 } });
  assert.equal(proofExtraField.statusCode, 400, "a source-occurrences body over the allow-list must fail closed");
  assert.equal((proofExtraField.json() as { error: { code: string } }).error.code, "INVALID_BODY");

  const proofQueryString = await server.app.inject({ method: "POST", url: "/api/v1/routes/source-occurrences?proofId=x", payload: {} });
  assert.equal(proofQueryString.statusCode, 400, "a non-empty query string must fail closed on source-occurrences");
  assert.equal((proofQueryString.json() as { error: { code: string } }).error.code, "INVALID_QUERY");
});

test("a complete route is not-needed and its source DTO is byte-equal to the overview DTO", async (t) => {
  const server = await createApiServer({ adapter: synthesisAdapter() });
  t.after(() => server.app.close());
  const ids = await flightIds(server);

  const synthesis = await server.app.inject({ method: "POST", url: "/api/v1/routes/synthesis", payload: { flightId: ids.get("SYNTH1") } });
  assert.equal(synthesis.statusCode, 200);
  const body = synthesis.json() as { status: string; corridorCount: number; corridorsCovered: number; candidates: unknown[] };
  assert.equal(body.status, "not-needed");
  assert.equal(body.corridorCount, 0);
  assert.equal(body.corridorsCovered, 0);
  assert.deepEqual(body.candidates, []);

  // The source DTO surface must be untouched by synthesis: the detail DTO for
  // the complete flight is byte-equal to its overview DTO in the same
  // generation. Opaque tokens carry a per-issuance nonce (identities rotate
  // on every mint), so the comparison normalizes token values only — every
  // other byte is pinned.
  const normalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map((item) => normalize(item));
    if (value && typeof value === "object") {
      const result: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(value)) {
        result[key] = typeof entry === "string" && (key === "id" || key === "flightId" || key === "routeId" || key === "nextCursor") ? "<token>" : normalize(entry);
      }
      return result;
    }
    return value;
  };
  const overview = await server.app.inject({ method: "POST", url: "/api/v1/routes/overview", payload: { limit: 25 } });
  const overviewDto = (overview.json() as { data: Array<Record<string, unknown> & { callsign: string }> }).data.find((route) => route.callsign === "SYNTH1");
  assert.ok(overviewDto, "the overview must carry the complete flight's DTO");
  const detail = await server.app.inject({ method: "POST", url: "/api/v1/routes/detail", payload: { routeId: ids.get("SYNTH1") } });
  assert.equal(detail.statusCode, 200);
  const detailDto = (detail.json() as { data: Record<string, unknown> }).data;
  assert.deepEqual(normalize(detailDto), normalize(overviewDto), "the source DTO must be byte-equal to the overview DTO for the same flight");
  assert.equal(detailDto.complete, true);
});
