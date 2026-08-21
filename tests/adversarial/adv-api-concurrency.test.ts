// Adversarial sweep owner: parallel adversarial-testing sub-agent.
// DOMAIN A5 — API concurrency, races, resource exhaustion, state corruption.
//
// Coverage (none of this exists in tests/synthesis/api.test.ts or
// tests/adversarial/sec-r5-synthesis.test.ts, which sweep identity/proof
// security sequentially):
// - 50 concurrent synthesis requests (mixed flights + forged ids): all 200 or
//   structured errors, zero 5xx, per-flight results deterministic.
// - First-ever requests racing lazy synthesis-index build and (separately)
//   the initial snapshot acquisition: no partial state, one generation id.
// - Cursor pagination race: one page-1 cursor served to 5 concurrent page-2
//   requests amid other traffic — identical pages, cursor stays valid.
// - Synthesis + source-occurrences interleaved: proofs stay scoped to their
//   issued donor ordinal range; no cross-endpoint corruption.
// - 2 MiB response guard under concurrent load on the largest legal candidate
//   set (500-cap route options): consistent structured fail-closed, never a
//   partial/over-limit body.
// - After heavy mixed traffic, fresh sequential requests match pre-traffic
//   baselines byte-for-byte (token-normalized): no cache drift.
// - app.close() while injects are in flight: the test never hangs; observed
//   semantics documented on the test.

import assert from "node:assert/strict";
import test from "node:test";
import { createApiServer } from "../../apps/api/src/index.ts";
import type { CaasAdapter, FlightPlanRecord, ReferenceDatasetResult } from "../../packages/upstream-caas/src/index.ts";
import { SYNTHESIS_COORDS, synthesisAdapter } from "../fixtures/synthesis-caas.ts";

type ApiServer = Awaited<ReturnType<typeof createApiServer>>;
type InjectResponse = Awaited<ReturnType<ApiServer["app"]["inject"]>>;

const CALLSIGNS = ["SYNTH1", "SYNTH2", "SYNTH3", "SYNTH4", "SYNTH5", "SYNTH6", "SYNTH7"];

// Opaque tokens carry a per-issuance nonce, so exact-byte equality across
// independent issuances is impossible by design; every NON-token byte is
// pinned by normalizing only the token-valued fields.
function normalizeTokens(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => normalizeTokens(item));
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (key === "proofIds") result[key] = (entry as unknown[]).map(() => "<token>");
      else if (key === "id" || key === "flightId" || key === "routeId" || key === "candidateId" || key === "nextCursor" || key === "duplicateGroup") result[key] = "<token>";
      else result[key] = normalizeTokens(entry);
    }
    return result;
  }
  return value;
}

async function flightIdsByCallsign(server: ApiServer): Promise<Map<string, string>> {
  const overview = await server.app.inject({ method: "POST", url: "/api/v1/routes/overview", payload: { limit: 100 } });
  assert.equal(overview.statusCode, 200);
  const map = new Map<string, string>();
  for (const route of (overview.json() as { data: Array<{ callsign: string; flightId: string }> }).data) map.set(route.callsign, route.flightId);
  return map;
}

function synthesisPayload(server: ApiServer, flightId: string | undefined): { method: "POST"; url: string; payload: Record<string, unknown> } {
  void server;
  return { method: "POST", url: "/api/v1/routes/synthesis", payload: { flightId } };
}

function assertStructuredError(response: InjectResponse, statusCode: number, code: string, surface: string): void {
  assert.equal(response.statusCode, statusCode, `${surface}: expected ${statusCode}`);
  const body = response.json() as { error?: { code?: string; message?: string; retryable?: boolean } };
  assert.equal(body.error?.code, code, `${surface}: expected structured code ${code}`);
  assert.equal(typeof body.error?.message, "string", `${surface}: structured envelope must carry a bounded message`);
}

test("A5: 50 concurrent synthesis requests are deterministic per flight with zero 5xx", async (t) => {
  const server = await createApiServer({ adapter: synthesisAdapter() });
  t.after(() => server.app.close());
  const ids = await flightIdsByCallsign(server);

  // 42 valid requests (6 per flight) + 8 forged-token requests = 50 concurrent.
  const valid = Array.from({ length: 42 }, (_, index) => synthesisPayload(server, ids.get(CALLSIGNS[index % CALLSIGNS.length]!)));
  const forged = Array.from({ length: 8 }, () => synthesisPayload(server, "forged-token.forged-signature"));
  const responses = await Promise.all([...valid, ...forged].map((request) => server.app.inject(request)));

  for (const [index, response] of responses.entries()) {
    assert.notEqual(response.statusCode, 500, `request ${index} must never be an unstructured 500`);
    assert.ok(response.statusCode < 500, `request ${index} must never be a 5xx`);
  }
  const validResponses = responses.slice(0, 42);
  const forgedResponses = responses.slice(42);
  for (const [index, response] of forgedResponses.entries()) {
    assertStructuredError(response, 410, "GENERATION_EXPIRED", `forged concurrent request ${index}`);
  }

  // Every valid response is a 200; all share exactly one generation id.
  const generations = new Set<string>();
  const byFlight = new Map<string, unknown[]>();
  for (const response of validResponses) {
    assert.equal(response.statusCode, 200, "a concurrent valid synthesis must succeed");
    const body = response.json() as { generation: { id: string }; flightId: string };
    generations.add(body.generation.id);
    byFlight.set(body.flightId, [...(byFlight.get(body.flightId) ?? []), normalizeTokens(body)]);
  }
  assert.equal(generations.size, 1, "every concurrent response must share one generation id");
  assert.equal(byFlight.size, CALLSIGNS.length, "all seven flights must be represented");
  for (const [flightId, bodies] of byFlight) {
    assert.equal(bodies.length, 6, "six concurrent requests per flight");
    for (const body of bodies.slice(1)) {
      assert.deepEqual(body, bodies[0], `concurrent synthesis for one flight must be deterministic (${flightId})`);
    }
  }

  // After the burst, fresh sequential requests still match the burst results
  // (no accumulated state corruption or cache drift).
  for (const callsign of CALLSIGNS) {
    const sequential = await server.app.inject(synthesisPayload(server, ids.get(callsign)!));
    assert.equal(sequential.statusCode, 200);
    const body = normalizeTokens(sequential.json()) as Record<string, unknown>;
    const burst = byFlight.get(ids.get(callsign)!)?.[0];
    assert.deepEqual(body, burst, `post-burst sequential synthesis for ${callsign} must equal the concurrent result`);
  }
});

test("A5: first-ever synthesis requests racing the lazy index build never observe partial state", async (t) => {
  const server = await createApiServer({ adapter: synthesisAdapter() });
  t.after(() => server.app.close());
  const ids = await flightIdsByCallsign(server);

  // The very first synthesis call for a snapshot lazily builds the synthesis
  // index; every flight's FIRST synthesis request fires in one batch.
  const responses = await Promise.all(CALLSIGNS.map((callsign) => server.app.inject(synthesisPayload(server, ids.get(callsign)!))));
  const generations = new Set<string>();
  for (const [index, response] of responses.entries()) {
    assert.equal(response.statusCode, 200, `first-ever synthesis ${index} must not observe a partial index build`);
    const body = response.json() as { generation: { id: string }; status: string; candidates: unknown[] };
    assert.ok(typeof body.status === "string" && Array.isArray(body.candidates), "every racing response must be a complete synthesis payload");
    generations.add(body.generation.id);
  }
  assert.equal(generations.size, 1, "no duplicate or divergent generation may emerge from the race");

  // A second identical batch must be byte-identical (token-normalized): the
  // index built under the race is the one permanently served.
  const rerun = await Promise.all(CALLSIGNS.map((callsign) => server.app.inject(synthesisPayload(server, ids.get(callsign)!))));
  for (const [index, response] of rerun.entries()) {
    assert.deepEqual(normalizeTokens(response.json()), normalizeTokens(responses[index]!.json()), "the raced index must serve deterministically afterwards");
  }
});

test("A5: concurrent requests racing the initial snapshot acquisition get only complete structured responses", async (t) => {
  // Slow acquisition widens the race window: requests arriving while the
  // first-ever snapshot is building must fail closed with a structured 503,
  // never a partial snapshot, and acquisition must run exactly once.
  let displayCalls = 0;
  const base = synthesisAdapter();
  const slowAdapter: CaasAdapter = {
    ...base,
    displayAll: async (signal) => {
      displayCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 150));
      return base.displayAll(signal);
    },
  };
  const server = await createApiServer({ adapter: slowAdapter, initialize: false });
  t.after(() => server.app.close());

  const initialize = server.store.initialize();
  const racing = await Promise.all(
    Array.from({ length: 12 }, () => server.app.inject({ method: "POST", url: "/api/v1/routes/synthesis", payload: { flightId: "racing.race" } })),
  );
  const snapshot = await initialize;
  for (const [index, response] of racing.entries()) {
    assert.notEqual(response.statusCode, 500, `racing request ${index} must never 500`);
    assert.ok(response.statusCode === 503 || response.statusCode === 410, `racing request ${index} is either not-ready (503) or token-invalid (410), got ${response.statusCode}`);
    const body = response.json() as { error: { code: string } };
    assert.ok(typeof body.error?.code === "string" && body.error.code.length > 0, "every racing response carries a structured code");
    if (response.statusCode === 503) {
      assert.equal(body.error.code, "NOT_INITIALIZED", "a request before the first snapshot must report NOT_INITIALIZED");
    }
  }
  assert.equal(displayCalls, 1, "the racing traffic must not trigger duplicate snapshot acquisition");

  // Once ready, the store serves exactly the generation the race installed.
  const ids = await flightIdsByCallsign(server);
  const served = await server.app.inject(synthesisPayload(server, ids.get("SYNTH3")!));
  assert.equal(served.statusCode, 200);
  assert.equal((served.json() as { generation: { id: string } }).generation.id, snapshot.id, "the served generation must be the single raced-into-existence generation");
});

// Six distinct D->E donor geometries push the target past SYNTHESIS_PAGE (5),
// so page 1 mints a nextCursor — same shape as the sec-r5 paging fixture,
// rebuilt locally because that one is not exported.
function pagedFixtureAdapter(): CaasAdapter {
  const airports = [
    ["C", SYNTHESIS_COORDS.C[0], SYNTHESIS_COORDS.C[1]],
    ["D", SYNTHESIS_COORDS.D[0], SYNTHESIS_COORDS.D[1]],
    ["E", SYNTHESIS_COORDS.E[0], SYNTHESIS_COORDS.E[1]],
  ] as const;
  const fixes = Array.from({ length: 6 }, (_, index) => [`PGZ${index}`, 20 + index, 30] as const);
  const records: FlightPlanRecord[] = [
    { id: "pg-target", callsign: "PGT0", departure: "C", destination: "E", routeElements: [{ sequence: 0, identifier: "D" }, { sequence: 1, identifier: "PGMISS" }] },
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

test("A5: one page-1 cursor served to 5 concurrent page-2 requests yields identical pages under traffic", async (t) => {
  const server = await createApiServer({ adapter: pagedFixtureAdapter() });
  t.after(() => server.app.close());
  const ids = await flightIdsByCallsign(server);
  const targetId = ids.get("PGT0")!;

  const page1 = await server.app.inject({ method: "POST", url: "/api/v1/routes/synthesis", payload: { flightId: targetId } });
  assert.equal(page1.statusCode, 200);
  const first = page1.json() as { candidates: unknown[]; nextCursor?: string };
  assert.equal(first.candidates.length, 5, "page 1 is bounded to SYNTHESIS_PAGE");
  assert.ok(first.nextCursor, "the fixture target mints a next cursor");

  // Five concurrent page-2 requests with the SAME cursor, interleaved with
  // fresh page-1 requests and another flight's synthesis (background traffic).
  const page2 = { method: "POST", url: "/api/v1/routes/synthesis", payload: { flightId: targetId, cursor: first.nextCursor } } as const;
  const traffic = [
    ...Array.from({ length: 5 }, () => page2),
    ...Array.from({ length: 3 }, () => ({ method: "POST", url: "/api/v1/routes/synthesis", payload: { flightId: targetId } } as const)),
    ...Array.from({ length: 3 }, () => ({ method: "POST", url: "/api/v1/routes/synthesis", payload: { flightId: ids.get("PGD2")! } } as const)),
  ];
  const responses = await Promise.all(traffic.map((request) => server.app.inject(request)));
  for (const response of responses) {
    assert.equal(response.statusCode, 200, "concurrent paging traffic must all succeed");
  }
  const page2Bodies = responses.slice(0, 5).map((response) => normalizeTokens(response.json()));
  for (const body of page2Bodies.slice(1)) {
    assert.deepEqual(body, page2Bodies[0], "all five concurrent page-2 responses must be identical (token-normalized)");
  }
  assert.equal((page2Bodies[0] as { candidates: unknown[] }).candidates.length, 1, "page 2 carries exactly the remaining candidate");

  // The cursor stays valid after the concurrent traffic: no burn/rotation.
  const after = await server.app.inject(page2);
  assert.equal(after.statusCode, 200, "the cursor must remain valid across concurrent traffic");
  assert.deepEqual(normalizeTokens(after.json()), page2Bodies[0], "a post-traffic cursor page must match the concurrent pages");
});

test("A5: interleaved synthesis and source-occurrences keep proofs scoped with no cross-endpoint corruption", async (t) => {
  const server = await createApiServer({ adapter: synthesisAdapter() });
  t.after(() => server.app.close());
  const ids = await flightIdsByCallsign(server);

  // Baseline: mint the donor proofs for the gap target and decode their ranges.
  const baseline = await server.app.inject(synthesisPayload(server, ids.get("SYNTH3")!));
  assert.equal(baseline.statusCode, 200);
  const baselineBody = baseline.json() as { candidates: Array<{ segments: Array<{ proofIds?: string[] }> }> };
  const proofs = baselineBody.candidates.flatMap((candidate) => candidate.segments.flatMap((segment) => segment.proofIds ?? []));
  assert.ok(proofs.length > 0, "the fixture target must mint donor proofs");
  const ranges = proofs.map((proof) => {
    const decoded = JSON.parse(Buffer.from(proof.split(".")[0]!, "base64url").toString("utf8")) as { i: number; f: number; u: number };
    return { proof, from: decoded.f, to: decoded.u };
  });

  // Interleave: 3x synthesis per flight + 2x source-occurrences per proof.
  const requests = [
    ...CALLSIGNS.flatMap((callsign) => Array.from({ length: 3 }, () => synthesisPayload(server, ids.get(callsign)!))),
    ...ranges.flatMap(({ proof }) => Array.from({ length: 2 }, () => ({ method: "POST", url: "/api/v1/routes/source-occurrences", payload: { proofId: proof } } as const))),
  ];
  const responses = await Promise.all(requests.map((request) => server.app.inject(request)));
  for (const [index, response] of responses.entries()) {
    assert.equal(response.statusCode, 200, `interleaved request ${index} must succeed`);
    assert.notEqual(response.statusCode, 500);
  }

  // Every proof response stays scoped to its issued ordinal range and its
  // donor flight — no cross-endpoint state corruption.
  const proofResponses = responses.slice(CALLSIGNS.length * 3);
  for (const [index, response] of proofResponses.entries()) {
    const range = ranges[Math.floor(index / 2)]!;
    const body = response.json() as { data: { flightId: string; occurrences: Array<{ ordinal: number; status: string }> } };
    assert.ok(body.data.flightId, "a proof response must carry its donor flight id");
    assert.ok(body.data.occurrences.length > 0, "a proof must resolve to occurrences");
    for (const occurrence of body.data.occurrences) {
      assert.ok(occurrence.ordinal >= range.from && occurrence.ordinal <= range.to, `proof occurrence ordinal ${occurrence.ordinal} must stay inside the issued range [${range.from}, ${range.to}]`);
      assert.ok(occurrence.status === "point" || occurrence.status === "gap", "occurrences keep their structured status");
    }
  }

  // The interleaved synthesis results remain deterministic against baseline.
  for (const [index, response] of responses.slice(0, CALLSIGNS.length * 3).entries()) {
    const callsign = CALLSIGNS[Math.floor(index / 3)]!;
    if (callsign === "SYNTH3") {
      assert.deepEqual(normalizeTokens(response.json()), normalizeTokens(baselineBody), "interleaved SYNTH3 synthesis must match its pre-traffic baseline");
    }
  }
});

// Largest legal candidate set: the same-endpoint options surface admits up to
// 500 candidates (MAX_SAME_ENDPOINT_CANDIDATES). 60 donors x 250-point routes
// serialize far past 2 MiB (each dto alone is ~70 KB of leg tokens/geometry),
// so the guard must fail closed with the structured 409 — under concurrent
// load as well.
function oversizeOptionsAdapter(): CaasAdapter {
  const donorCount = 60;
  const routeLength = 250;
  const poolSize = donorCount + routeLength - 1;
  const airports = [["P", 0, 0], ["Q", 5, 60]] as const;
  const fixes = Array.from({ length: poolSize }, (_, index) => [`G${String(index).padStart(4, "0")}`, -89 + index * 0.1, -179 + index * 0.2] as const);
  const records: FlightPlanRecord[] = Array.from({ length: donorCount }, (_, donor): FlightPlanRecord => ({
    id: `os-donor-${donor}`,
    callsign: `OSD${donor}`,
    departure: "P",
    destination: "Q",
    // Each donor traverses a distinct 250-fix window: distinct signatures,
    // so deduplication keeps all candidates and the payload stays oversize.
    routeElements: Array.from({ length: routeLength }, (_, position) => ({ sequence: position, identifier: `G${String(donor + position).padStart(4, "0")}` })),
  }));
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

test("A5: the 2 MiB response guard fails closed consistently under concurrent load", async (t) => {
  const server = await createApiServer({ adapter: oversizeOptionsAdapter() });
  t.after(() => server.app.close());
  const overview = await server.app.inject({ method: "POST", url: "/api/v1/routes/overview", payload: { limit: 1 } });
  assert.equal(overview.statusCode, 200);
  const selectedFlightId = (overview.json() as { data: Array<{ flightId: string }> }).data[0]!.flightId;

  const request = { method: "POST", url: "/api/v1/routes/options", payload: { flightId: selectedFlightId } } as const;
  // Sequential sanity first: the fixture truly crosses the guard.
  const sequential = await server.app.inject(request);
  assertStructuredError(sequential, 409, "RESPONSE_TOO_LARGE", "the oversize candidate set must fail closed sequentially");

  const concurrent = await Promise.all(Array.from({ length: 6 }, () => server.app.inject(request)));
  for (const [index, response] of concurrent.entries()) {
    assertStructuredError(response, 409, "RESPONSE_TOO_LARGE", `concurrent oversize request ${index}`);
    const body = response.json() as { error: { retryable?: boolean }; data?: unknown };
    assert.equal(body.data, undefined, `concurrent oversize response ${index} must never carry a partial data payload`);
    assert.ok(Buffer.byteLength(response.body, "utf8") <= 2 * 1024 * 1024, "the fail-closed envelope must itself be bounded");
  }

  // The guard must not corrupt subsequent serving: a normal endpoint still 200s.
  const detail = await server.app.inject({ method: "POST", url: "/api/v1/routes/detail", payload: { routeId: selectedFlightId } });
  assert.equal(detail.statusCode, 200, "the server must keep serving after repeated guard trips");
});

test("A5: app.close() with in-flight requests never hangs the suite", async (t) => {
  const server = await createApiServer({ adapter: synthesisAdapter() });
  const ids = await flightIdsByCallsign(server);

  // Observed semantics: Fastify's close() awaits in-flight light-my-request
  // injects, so pending requests still settle with complete responses and the
  // close promise resolves; nothing rejects or hangs. The race below makes a
  // regression (a hung close) fail this test instead of stalling the suite.
  const inflight = Promise.allSettled(CALLSIGNS.map((callsign) => server.app.inject(synthesisPayload(server, ids.get(callsign)!))));
  const closeOutcome = await Promise.race([
    Promise.all([inflight, server.app.close()]).then(([results]) => ({ settled: true as const, results })),
    new Promise<{ settled: false }>((resolve) => setTimeout(() => resolve({ settled: false }), 5_000)),
  ]);
  assert.equal(closeOutcome.settled, true, "close() with pending injects must resolve within the timeout");
  if (closeOutcome.settled) {
    for (const result of closeOutcome.results) {
      assert.equal(result.status, "fulfilled", "an in-flight inject must settle, not reject, when the server closes");
      if (result.status === "fulfilled") {
        assert.ok(typeof result.value.statusCode === "number", "a settled in-flight inject delivers a complete response");
      }
    }
  }
});
