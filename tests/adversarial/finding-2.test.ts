import assert from "node:assert/strict";
import test from "node:test";
import { createApiServer } from "../../apps/api/src/index.ts";
import type { CaasAdapter, ReferenceDatasetResult, ReferencePoint } from "../../packages/upstream-caas/src/index.ts";
import { sanitizedAdapter } from "../fixtures/sanitized-caas.ts";

// Plan §6.1 quantitative policy: "Ambiguity page | 50 results" and
// "Ambiguity hard total | 500; above this require a narrower term", under the
// §6 preamble "Crossing a hard limit fails closed with a bounded error and
// never silently truncates required results." An exact point lookup whose
// reference matches many locations must therefore serve at most 50 matches
// per page (remainder reachable via a generation-bound cursor) and fail
// closed with a bounded 4xx error once a reference matches more than 500
// locations. It must never answer 200 with every match dumped into one
// unbounded response. (Consolidated from the former finding-2 and finding-5
// suites, which shared the same code path.)

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
  nextCursor?: string;
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
    assert.equal(body.nextCursor, undefined, "a full page with no remainder carries no cursor");
  } finally {
    await server.app.close();
  }
});

test("plan §6.1: 51 matching locations serve one 50-result page whose cursor reaches the remainder", async () => {
  const server = await createApiServer({ adapter: ambiguousAdapter(51), refreshSecret: "offline-refresh-secret" });
  try {
    const first = await server.app.inject({ method: "GET", url: "/api/v1/points/DUPX" });
    assert.equal(first.statusCode, 200, "51 matches is within the 500 hard total and must not fail closed");
    const firstBody = first.json() as AmbiguousResponse;
    assert.equal(firstBody.status, "ambiguous");
    assert.equal(firstBody.matches?.length, 50, `an ambiguity page holds at most 50 results, got ${firstBody.matches?.length}`);
    assert.ok(typeof firstBody.nextCursor === "string" && firstBody.nextCursor.length > 0, "a page at the bound must carry a non-empty cursor rather than silently truncate");

    const second = await server.app.inject({ method: "GET", url: `/api/v1/points/DUPX?cursor=${encodeURIComponent(firstBody.nextCursor!)}` });
    assert.equal(second.statusCode, 200, "the cursor must be accepted by the same reference lookup");
    const secondBody = second.json() as AmbiguousResponse;
    assert.equal(secondBody.matches?.length, 1, "the remaining match is reachable via the cursor");
    assert.equal(secondBody.nextCursor, undefined, "the terminal page carries no cursor");
  } finally {
    await server.app.close();
  }
});

test("plan §6.1: 501 matching locations fails closed at the 500 hard total with the named bounded error", async () => {
  const server = await createApiServer({ adapter: ambiguousAdapter(501), refreshSecret: "offline-refresh-secret" });
  try {
    const response = await server.app.inject({ method: "GET", url: "/api/v1/points/DUPX" });
    assert.equal(response.statusCode, 400, "a reference matching more than 500 locations must fail closed with a bounded error");
    const body = response.json() as ErrorResponse;
    assert.equal(body.error?.code, "TOO_MANY_MATCHES", "the bounded error names the machine-readable code");
    assert.ok(typeof body.error?.message === "string" && /narrower term/i.test(body.error.message), "the bounded error explains the need for a narrower term");
  } finally {
    await server.app.close();
  }
});
