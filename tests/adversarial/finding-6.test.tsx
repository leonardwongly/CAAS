import { afterEach, describe, expect, it, vi } from "vitest";
import { searchCallsigns } from "../../apps/web/src/api.ts";

/**
 * Regression test for finding 6: the web client's searchCallsigns silently
 * truncates at the server's default page limit of 50 and discards the
 * nextCursor the server emits whenever more matches exist.
 *
 * Mechanism (verified against the real code):
 * - server.ts searchCallsigns handler: POST /api/v1/callsigns/search accepts
 *   { query, limit, cursor }, defaults limit to 50 (parseLimit), and replies
 *   { data, generation, nextCursor? } with nextCursor present whenever
 *   offset+data.length < matches.length.
 * - api.ts searchCallsigns: POSTs only { query } (no limit, no cursor) and
 *   returns unwrap(payload) — the "data" array — discarding nextCursor.
 * - App.tsx runSearch: reports `${matches.length} flight plan matches found`
 *   from the returned array alone, so a 50/60 partial page is presented as
 *   the complete answer with no hint that matches are missing.
 *
 * North-star contract (plan §6; design AC-POC-BROWSE-01): "Crossing a hard
 * limit fails closed with a bounded error and never silently truncates
 * required results"; callsign search is exercised "without omission,
 * duplication, silent truncation". Search results are required results:
 * every matching flight must be returned (the client pages through the
 * server's nextCursor) or an explicit "more results" signal must be
 * surfaced — never a partial list presented as complete. The current API
 * surface (Promise<CallsignMatch[]>) has no signal channel, so the only
 * correct behavior expressible today is to page to the end.
 *
 * The fetch stub below mirrors the real server's handler faithfully: 60
 * flights whose callsign contains "ABC", default limit 50, nextCursor
 * present on the first page only.
 */

const FLIGHT_COUNT = 60;
const DEFAULT_LIMIT = 50;

function makeFlight(index: number) {
  const id = `flight-${String(index + 1).padStart(3, "0")}`;
  return { id, flightId: id, callsign: `ABC${String(index + 1).padStart(3, "0")}`, departure: "KAAA", destination: "KBBB", routePointCount: 3 };
}

/** Server-shaped stub for POST /api/v1/callsigns/search (mirrors server.ts). */
function installSearchStub() {
  const flights = Array.from({ length: FLIGHT_COUNT }, (_, index) => makeFlight(index));
  const bodies: Record<string, unknown>[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    if (method !== "POST" || url !== "/api/v1/callsigns/search") {
      return { ok: false, status: 404, json: async () => ({ error: { message: `Unhandled ${method} ${url}` } }) };
    }
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    bodies.push(body);
    const limit = typeof body.limit === "number" ? body.limit : DEFAULT_LIMIT;
    const offset = typeof body.cursor === "string" ? Number(body.cursor) : 0;
    const data = flights.slice(offset, offset + limit);
    const nextOffset = offset + data.length;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        data,
        generation: {
          id: "gen-1",
          retrievedAt: "2026-08-14T00:00:00.000Z",
          overall: "fresh",
          live: { state: "fresh", retrievedAt: "2026-08-14T00:00:00.000Z", freshUntil: "2026-08-15T00:00:00.000Z", staleUntil: "2026-08-16T00:00:00.000Z" },
          reference: { state: "fresh", retrievedAt: "2026-08-13T00:00:00.000Z", freshUntil: "2026-08-15T00:00:00.000Z", staleUntil: "2026-08-16T00:00:00.000Z" },
        },
        ...(nextOffset < flights.length ? { nextCursor: String(nextOffset) } : {}),
      }),
    };
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, bodies };
}

describe("searchCallsigns must not silently truncate at the server default limit of 50 (finding 6)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns every matching flight when more than 50 match (paging through nextCursor)", async () => {
    const { bodies } = installSearchStub();

    const matches = await searchCallsigns("ABC");

    expect(
      matches.length,
      `expected all ${FLIGHT_COUNT} matching flights; got ${matches.length}. The server returns at most ${DEFAULT_LIMIT} per page plus a nextCursor; the client must page through it (or surface an explicit more-results signal) rather than present a partial page as complete (plan §6: never silently truncate required results).`,
    ).toBe(FLIGHT_COUNT);
    expect(new Set(matches.map((match) => match.id)).size, "paged results must not duplicate flights").toBe(FLIGHT_COUNT);

    const secondRequest = bodies[1];
    expect(
      secondRequest,
      "a second request carrying the server's nextCursor is required to reach the remaining matches; the client made only one request, so it dropped the cursor and silently truncated",
    ).toBeTruthy();
    expect(secondRequest?.cursor, "the follow-up page must send the nextCursor in the POST body").toBe(String(DEFAULT_LIMIT));
    expect(secondRequest?.query).toBe("ABC");
  });
});
