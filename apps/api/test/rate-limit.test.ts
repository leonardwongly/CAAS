import test from "node:test";
import assert from "node:assert/strict";
import { createApiServer, type CaasAdapter } from "../src/index.ts";
import type { DatasetEvidence, ReferenceDatasetResult } from "@flight-route-explorer/upstream-caas";

const coordinate = (lat: number, lon: number) => Object.freeze({ lat, lon });

function evidence(family: DatasetEvidence["family"], records: number): DatasetEvidence {
  return { family, bytes: 100, records, acceptedRecords: records, rejectedRecords: 0, retried: false, durationMs: 1 };
}

function references(dataset: "fixes" | "airports" | "navaids", points: Array<[string, number, number]>): ReferenceDatasetResult {
  const normalized = points.map(([identifier, lat, lon]) => ({ dataset, identifier, coordinate: coordinate(lat, lon) }));
  const index = new Map<string, readonly typeof normalized[number][]>();
  for (const point of normalized) index.set(point.identifier, [...(index.get(point.identifier) ?? []), point]);
  return { dataset, points: normalized, index, evidence: evidence(dataset, points.length) };
}

function fixtureAdapter(): CaasAdapter {
  return {
    displayAll: async () => ({ records: [], evidence: evidence("displayAll", 0) }),
    airways: async () => ({ family: "airways", bytes: 20, records: 1, acceptedRecords: 1, rejectedRecords: 0, uniqueRecords: 1, retried: false, durationMs: 1 }),
    fixes: async () => references("fixes", [["DCT", 35, -90]]),
    airports: async () => references("airports", [["KJFK", 40.6413, -73.7781], ["KLAX", 33.9416, -118.4085]]),
    navaids: async () => references("navaids", [["DUP", 35, -90], ["DUP", 36, -91]]),
  };
}

const RATE_LIMIT: { windowMs: number; max: number } = { windowMs: 60_000, max: 3 };
const CLIENT_A = "203.0.113.10";
const CLIENT_B = "203.0.113.20";

async function search(server: Awaited<ReturnType<typeof createApiServer>>, cfIp: string) {
  return server.app.inject({ method: "POST", url: "/api/v1/callsigns/search", headers: { "cf-connecting-ip": cfIp }, payload: { query: "X", limit: 1 } });
}

test("rate limits a single client on the data surface and returns 429", async (t) => {
  const server = await createApiServer({ adapter: fixtureAdapter(), refreshSecret: "test-refresh", rateLimit: RATE_LIMIT });
  t.after(() => server.app.close());

  for (let i = 0; i < RATE_LIMIT.max; i++) {
    assert.equal((await search(server, CLIENT_A)).statusCode, 200, `request ${i + 1} should be allowed`);
  }
  const limited = await search(server, CLIENT_A);
  assert.equal(limited.statusCode, 429);
  assert.equal(limited.json().error.code, "RATE_LIMITED");
  assert.match(String(limited.headers["retry-after"]), /^[1-9][0-9]*$/);

  // A different client is in a separate bucket and is not throttled.
  assert.equal((await search(server, CLIENT_B)).statusCode, 200);
});

test("health probes are never rate-limited", async (t) => {
  const server = await createApiServer({ adapter: fixtureAdapter(), refreshSecret: "test-refresh", rateLimit: RATE_LIMIT });
  t.after(() => server.app.close());

  for (let i = 0; i < 20; i++) {
    const res = await server.app.inject({ method: "GET", url: "/api/v1/health/live", headers: { "cf-connecting-ip": CLIENT_A } });
    assert.equal(res.statusCode, 200);
  }
});

test("disableRateLimit bypasses the throttle entirely", async (t) => {
  const server = await createApiServer({ adapter: fixtureAdapter(), refreshSecret: "test-refresh", rateLimit: RATE_LIMIT, disableRateLimit: true });
  t.after(() => server.app.close());

  for (let i = 0; i < RATE_LIMIT.max * 2; i++) {
    assert.equal((await search(server, CLIENT_A)).statusCode, 200);
  }
});

test("loopback callers (no forwarded client IP) are not throttled", async (t) => {
  const server = await createApiServer({ adapter: fixtureAdapter(), refreshSecret: "test-refresh", rateLimit: RATE_LIMIT });
  t.after(() => server.app.close());

  for (let i = 0; i < RATE_LIMIT.max * 2; i++) {
    const res = await server.app.inject({ method: "POST", url: "/api/v1/callsigns/search", payload: { query: "X", limit: 1 } });
    assert.equal(res.statusCode, 200);
  }
});
