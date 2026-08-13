import assert from "node:assert/strict";
import test from "node:test";
import { createApiServer } from "../../apps/api/src/index.ts";
import type { CaasAdapter, FlightPlanRecord } from "../../packages/upstream-caas/src/index.ts";
import { sanitizedAdapter } from "../fixtures/sanitized-caas.ts";

// Issue #30 evidence: pagination never silently truncates. Plan §6: "Crossing
// a hard limit fails closed with a bounded error and never silently truncates
// required results." The browse/search walk below proves every record is
// returned exactly once across pages, page sizes follow the requested limit
// (except the final page), the terminal page omits nextCursor (it is absent,
// never null), and cursors bind the generation, query, and limit so a reused
// cursor fails closed with 409 instead of drifting. All fixtures are
// sanitized; no live data is used.

function flights(count: number): readonly FlightPlanRecord[] {
  return Array.from({ length: count }, (_unused, index) => ({
    id: `fixture-flight-${index + 1}`,
    callsign: `FL${String(index + 1).padStart(4, "0")}`,
    departure: "KOR1",
    destination: "KDS1",
    routeElements: [{ sequence: 0, identifier: "MIDPT" }],
  }));
}

interface Page {
  data: Array<{ id: string; callsign: string }>;
  nextCursor?: string;
  generation: { id: string };
}

interface StatefulAdapter {
  adapter: CaasAdapter;
  setRecords: (records: readonly FlightPlanRecord[]) => void;
}

function statefulAdapter(records: readonly FlightPlanRecord[]): StatefulAdapter {
  let current = records;
  const base = sanitizedAdapter(current);
  return {
    adapter: {
      ...base,
      displayAll: async () => ({ records: current, evidence: { family: "displayAll", bytes: 128, records: current.length, acceptedRecords: current.length, rejectedRecords: 0, retried: false, durationMs: 0 } }),
    },
    setRecords(next) { current = next; },
  };
}

async function walkBrowse(server: { app: { inject: (options: { method: string; url: string }) => Promise<{ json(): unknown; statusCode: number }> } }, limit: number): Promise<{ pages: Page[]; callsigns: string[]; generations: string[]; hasNextCursor: boolean[] }> {
  const pages: Page[] = [];
  const callsigns: string[] = [];
  const generations: string[] = [];
  const hasNextCursor: boolean[] = [];
  let cursor: string | undefined;
  do {
    const url = `/api/v1/routes?limit=${limit}${cursor === undefined ? "" : `&cursor=${encodeURIComponent(cursor)}`}`;
    const response = await server.app.inject({ method: "GET", url });
    assert.equal(response.statusCode, 200, url);
    const body = response.json() as Page;
    pages.push(body);
    callsigns.push(...body.data.map((item) => item.callsign));
    generations.push(body.generation.id);
    hasNextCursor.push(Object.hasOwn(body, "nextCursor"));
    cursor = body.nextCursor;
  } while (cursor !== undefined);
  return { pages, callsigns, generations, hasNextCursor };
}

test("browse walks every record exactly once with limit=3 across 12 records", async () => {
  const server = await createApiServer({ adapter: sanitizedAdapter(flights(12)), refreshSecret: "offline-refresh-secret" });
  try {
    const { pages, callsigns, generations, hasNextCursor } = await walkBrowse(server, 3);
    assert.deepEqual(pages.map((page) => page.data.length), [3, 3, 3, 3], "every non-terminal page is exactly the requested size");
    assert.equal(callsigns.length, 12);
    assert.equal(new Set(callsigns).size, 12, "no flight appears twice across the walk");
    assert.deepEqual([...callsigns].sort(), flights(12).map((flight) => flight.callsign).sort(), "every flight appears exactly once");
    assert.deepEqual(hasNextCursor, [true, true, true, false], "the terminal page omits nextCursor rather than null");
    assert.equal(new Set(generations).size, 1, "the generation id is stable across the walk");
  } finally {
    await server.app.close();
  }
});

test("browse page sizes follow the requested limit with a short final page", async () => {
  const server = await createApiServer({ adapter: sanitizedAdapter(flights(12)), refreshSecret: "offline-refresh-secret" });
  try {
    const { pages, callsigns } = await walkBrowse(server, 5);
    assert.deepEqual(pages.map((page) => page.data.length), [5, 5, 2]);
    assert.equal(callsigns.length, 12);
    assert.equal(new Set(callsigns).size, 12);
  } finally {
    await server.app.close();
  }
});

test("browse never silently truncates at any limit", async () => {
  const server = await createApiServer({ adapter: sanitizedAdapter(flights(12)), refreshSecret: "offline-refresh-secret" });
  try {
    for (const limit of [1, 2, 4, 7, 11, 12, 100]) {
      const { callsigns } = await walkBrowse(server, limit);
      assert.equal(callsigns.length, 12, `limit=${limit} must return all 12 records`);
      assert.equal(new Set(callsigns).size, 12, `limit=${limit} must not duplicate records`);
    }
  } finally {
    await server.app.close();
  }
});

test("a cursor binds its limit and fails closed with 409 when reused with a different limit", async () => {
  const server = await createApiServer({ adapter: sanitizedAdapter(flights(12)), refreshSecret: "offline-refresh-secret" });
  try {
    const first = (await server.app.inject({ method: "GET", url: "/api/v1/routes?limit=3" })).json() as Page;
    assert.ok(first.nextCursor);
    const mismatched = await server.app.inject({ method: "GET", url: `/api/v1/routes?limit=5&cursor=${encodeURIComponent(first.nextCursor)}` });
    assert.equal(mismatched.statusCode, 409);
    assert.equal((mismatched.json() as { error: { code: string } }).error.code, "CURSOR_EXPIRED");
  } finally {
    await server.app.close();
  }
});

test("search matches case-insensitively and walks every match exactly once", async () => {
  const server = await createApiServer({ adapter: sanitizedAdapter(flights(12)), refreshSecret: "offline-refresh-secret" });
  try {
    // "FL000" is a substring of exactly FL0001..FL0009 (FL0010-0012 do not contain it).
    const expected = ["FL0001", "FL0002", "FL0003", "FL0004", "FL0005", "FL0006", "FL0007", "FL0008", "FL0009"];
    for (const query of ["FL000", "fl000"]) {
      const callsigns: string[] = [];
      let cursor: string | undefined;
      const hasNextCursor: boolean[] = [];
      do {
        // Search is POST-only with the query in the body (URL privacy, issue #37).
        const response = await server.app.inject({
          method: "POST",
          url: "/api/v1/search",
          payload: { query, limit: 2, ...(cursor === undefined ? {} : { cursor }) },
        });
        assert.equal(response.statusCode, 200, `search for "${query}"`);
        const body = response.json() as Page;
        callsigns.push(...body.data.map((item) => item.callsign));
        hasNextCursor.push(Object.hasOwn(body, "nextCursor"));
        cursor = body.nextCursor;
      } while (cursor !== undefined);
      assert.deepEqual(callsigns, expected, `query "${query}" must match the same nine flights`);
      assert.deepEqual(hasNextCursor, [true, true, true, true, false], "terminal search page omits nextCursor");
    }
  } finally {
    await server.app.close();
  }
});

test("a search cursor binds its query and fails closed with 409 when reused with another query", async () => {
  const server = await createApiServer({ adapter: sanitizedAdapter(flights(12)), refreshSecret: "offline-refresh-secret" });
  try {
    const first = (await server.app.inject({ method: "POST", url: "/api/v1/search", payload: { query: "FL000", limit: 1 } })).json() as Page;
    assert.ok(first.nextCursor);
    const mismatched = await server.app.inject({ method: "POST", url: "/api/v1/search", payload: { query: "FL001", limit: 1, cursor: first.nextCursor } });
    assert.equal(mismatched.statusCode, 409);
    assert.equal((mismatched.json() as { error: { code: string } }).error.code, "CURSOR_EXPIRED");
  } finally {
    await server.app.close();
  }
});

test("a cursor from a prior generation fails closed with 409 after refresh", async () => {
  const state = statefulAdapter(flights(12));
  const server = await createApiServer({ adapter: state.adapter, refreshSecret: "offline-refresh-secret" });
  try {
    const first = (await server.app.inject({ method: "GET", url: "/api/v1/routes?limit=3" })).json() as Page;
    assert.ok(first.nextCursor);
    const firstGeneration = first.generation.id;

    state.setRecords(flights(8));
    const refreshed = await server.app.inject({ method: "POST", url: "/api/v1/refresh", headers: { "x-refresh-token": "offline-refresh-secret" } });
    assert.equal(refreshed.statusCode, 200);

    const stale = await server.app.inject({ method: "GET", url: `/api/v1/routes?limit=3&cursor=${encodeURIComponent(first.nextCursor)}` });
    assert.equal(stale.statusCode, 409, "a cursor from the dropped generation must not silently drift into the new data");
    assert.equal((stale.json() as { error: { code: string } }).error.code, "CURSOR_EXPIRED");

    const { callsigns, generations } = await walkBrowse(server, 3);
    assert.equal(callsigns.length, 8, "the new generation serves exactly its own records");
    assert.equal(new Set(callsigns).size, 8);
    assert.equal(new Set(generations).size, 1, "the new walk is served by a single generation");
    assert.notEqual(generations[0], firstGeneration, "the new generation id differs from the old one");
  } finally {
    await server.app.close();
  }
});
