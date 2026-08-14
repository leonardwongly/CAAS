import assert from "node:assert/strict";
import test from "node:test";
import { createApiServer } from "../../apps/api/src/index.ts";
import type { CaasAdapter, ReferenceDatasetResult, ReferencePoint } from "../../packages/upstream-caas/src/index.ts";
import { sanitizedAdapter } from "../fixtures/sanitized-caas.ts";

// Plan §6.1 quantitative policy: "Ambiguity page | 50 results" and
// "Ambiguity hard total | 500; above this require a narrower term", under the
// §6 preamble "Crossing a hard limit fails closed with a bounded error and
// never silently truncates required results." An exact point lookup
// (GET /api/v1/points/:reference) whose reference matches many locations must
// therefore serve at most 50 matches per page and fail closed with a bounded
// 4xx error once a reference matches more than 500 locations. It must never
// answer 200 with every match dumped into one unbounded response.

function ambiguousAdapter(matching: number): CaasAdapter {
  const base = sanitizedAdapter();
  const points: ReferencePoint[] = Array.from({ length: matching }, (_unused, index) => ({
    dataset: "navaids",
    identifier: "DUPX",
    coordinate: { lat: 35 + index / 10000, lon: -90 + index / 10000 },
  }));
  const index = new Map<string, readonly ReferencePoint[]>();
  index.set("DUPX", points);
  return {
    ...base,
    navaids: async (): Promise<ReferenceDatasetResult> => ({
      dataset: "navaids",
      points,
      index,
      evidence: { family: "navaids", bytes: 128, records: matching, acceptedRecords: matching, rejectedRecords: 0, retried: false, durationMs: 0 },
    }),
  };
}

interface AmbiguousResponse {
  status?: unknown;
  matches?: unknown[];
}

interface ErrorResponse {
  error?: { code?: unknown; message?: unknown };
}

test("plan §6.1: exactly 50 matching locations is the allowed ambiguity-page boundary", async () => {
  const server = await createApiServer({ adapter: ambiguousAdapter(50), refreshSecret: "offline-refresh-secret" });
  try {
    const response = await server.app.inject({ method: "GET", url: "/api/v1/points/DUPX" });
    assert.equal(response.statusCode, 200, "50 matches is within the 500 hard total and must be served");
    const body = response.json() as AmbiguousResponse;
    assert.equal(body.status, "ambiguous");
    assert.equal(body.matches?.length, 50, "a full ambiguity page is exactly 50 results");
  } finally {
    await server.app.close();
  }
});

test("plan §6.1: 51 matching locations must not exceed one 50-result page", async () => {
  const server = await createApiServer({ adapter: ambiguousAdapter(51), refreshSecret: "offline-refresh-secret" });
  try {
    const response = await server.app.inject({ method: "GET", url: "/api/v1/points/DUPX" });
    // 51 is within the 500 hard total, so the page bound applies: one page of
    // at most 50 results (the remainder is reachable via pagination).
    assert.equal(response.statusCode, 200, "51 matches is within the 500 hard total and must not fail closed");
    const body = response.json() as AmbiguousResponse;
    assert.ok(body.matches === undefined || body.matches.length <= 50, `an ambiguity page holds at most 50 results, got ${body.matches?.length}`);
  } finally {
    await server.app.close();
  }
});

test("plan §6.1: 501 matching locations fails closed at the 500 hard total with a bounded error", async () => {
  const server = await createApiServer({ adapter: ambiguousAdapter(501), refreshSecret: "offline-refresh-secret" });
  try {
    const response = await server.app.inject({ method: "GET", url: "/api/v1/points/DUPX" });
    assert.notEqual(response.statusCode, 200, "a reference matching more than 500 locations must never return a 200 with all matches");
    assert.ok(response.statusCode >= 400 && response.statusCode < 500, `fail closed with a bounded 4xx error, got ${response.statusCode}`);
    const body = response.json() as ErrorResponse;
    assert.equal(typeof body.error?.code, "string", "the bounded error names a machine-readable code");
    assert.equal(typeof body.error?.message, "string", "the bounded error explains the need for a narrower term");
    assert.ok(typeof body.error?.code === "string" && body.error.code.length > 0, "the error code is never empty");
  } finally {
    await server.app.close();
  }
});
