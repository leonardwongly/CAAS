import { afterEach, describe, expect, it, vi } from "vitest";
import {
  browseAirports,
  browseFixes,
  browseFlights,
  browseNavaids,
  fetchDataSummary,
  fetchReadiness,
  fetchRouteData,
  fetchRouteOptions,
  fetchRouteOverview,
  lookupPoint,
  refreshLiveData,
  searchCallsigns,
  validateDraft,
} from "../../apps/web/src/api.ts";

/**
 * Adversarial sweep owner: D6 — web data layer & gap model.
 *
 * Abort and ordering races at the api.ts data layer itself (the UI-level
 * supersession guards are owned by typeahead-race.test.tsx and
 * sweep-d6-webdata-races.test.tsx; abort semantics for search-only and
 * pre-abort are owned by adv-web-api-client.test.tsx).
 *
 * Covered here, previously uncovered:
 * - every exported endpoint forwards the caller's AbortSignal to fetch and
 *   surfaces a mid-flight abort as a raw AbortError, never wrapped in an
 *   ApiError or a normalized phantom result;
 * - a stale response resolving after a fresh one never contaminates the
 *   fresh result (no shared module-level response state);
 * - two concurrent paginated searches keep their cursor chains strictly
 *   separate (no shared cursor variable);
 * - two concurrent overview traversals keep their identity sets and
 *   generation state strictly separate (no shared seen-set/generation);
 * - the client is cache-free: repeated identical calls always re-request.
 */

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const GENERATION = {
  id: "gen-d6",
  retrievedAt: "2026-08-23T00:00:00.000Z",
  overall: "fresh",
  live: { state: "fresh", retrievedAt: "2026-08-23T00:00:00.000Z", freshUntil: "2026-08-24T00:00:00.000Z", staleUntil: "2026-08-25T00:00:00.000Z" },
  reference: { state: "fresh", retrievedAt: "2026-08-23T00:00:00.000Z", freshUntil: "2026-08-24T00:00:00.000Z", staleUntil: "2026-08-25T00:00:00.000Z" },
};

type Pending = { url: string; init?: RequestInit | undefined; resolve: (response: Response) => void; reject: (error: unknown) => void };

/**
 * Realistic in-flight transport: each fetch call stays pending until the
 * test resolves it, and aborting the caller's signal rejects the pending
 * request with a DOMException AbortError exactly like browser fetch.
 */
function installDeferredFetch() {
  const pending: Pending[] = [];
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    return new Promise<Response>((resolve, reject) => {
      if (init?.signal?.aborted) {
        reject(new DOMException("The operation was aborted.", "AbortError"));
        return;
      }
      pending.push({ url, init, resolve, reject });
      init?.signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")), { once: true });
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, pending };
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200 });
}

const ENDPOINTS: Array<{ name: string; url: string; invoke: (signal: AbortSignal) => Promise<unknown> }> = [
  { name: "searchCallsigns", url: "/api/v1/callsigns/search", invoke: (signal) => searchCallsigns("D6", signal) },
  { name: "fetchRouteOptions", url: "/api/v1/routes/options", invoke: (signal) => fetchRouteOptions("flight-1", signal) },
  { name: "fetchRouteOverview", url: "/api/v1/routes/overview", invoke: (signal) => fetchRouteOverview(signal) },
  { name: "fetchReadiness", url: "/api/v1/readiness", invoke: (signal) => fetchReadiness(signal) },
  { name: "refreshLiveData", url: "/api/v1/refresh", invoke: (signal) => refreshLiveData(signal) },
  { name: "fetchRouteData", url: "/api/v1/routes/detail", invoke: (signal) => fetchRouteData("route-1", signal) },
  { name: "lookupPoint", url: "/api/v1/points/lookup", invoke: (signal) => lookupPoint("MIDPT", signal) },
  { name: "validateDraft", url: "/api/v1/routes/compare", invoke: (signal) => validateDraft("A", "B", [], [], "baseline-1", signal) },
  { name: "fetchDataSummary", url: "/api/v1/data/summary", invoke: (signal) => fetchDataSummary(signal) },
  { name: "browseFlights", url: "/api/v1/data/flights", invoke: (signal) => browseFlights(50, undefined, signal) },
  { name: "browseFixes", url: "/api/v1/data/fixes", invoke: (signal) => browseFixes(50, undefined, signal) },
  { name: "browseAirports", url: "/api/v1/data/airports", invoke: (signal) => browseAirports(50, undefined, signal) },
  { name: "browseNavaids", url: "/api/v1/data/navaids", invoke: (signal) => browseNavaids(50, undefined, signal) },
];

describe("abort propagation across every endpoint (D6)", () => {
  it.each(ENDPOINTS)("$name forwards the caller signal and surfaces a mid-flight abort as a raw AbortError", async (endpoint) => {
    const { pending } = installDeferredFetch();
    const controller = new AbortController();

    const outcome = endpoint.invoke(controller.signal);
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    expect(pending[0]?.url).toBe(endpoint.url);
    // The exact caller signal must reach fetch — a dropped `signal` option
    // would silently turn every abort into a completed, wasted request.
    expect(pending[0]?.init?.signal).toBe(controller.signal);

    controller.abort();
    const error = await outcome.catch((caught) => caught);
    expect(error).toBeInstanceOf(DOMException);
    expect((error as DOMException).name).toBe("AbortError");
  });
});

describe("out-of-order resolution never cross-contaminates (D6)", () => {
  it("a stale route-options response resolving after a fresh one leaves both results intact", async () => {
    const { pending } = installDeferredFetch();
    const staleRequest = fetchRouteOptions("flight-stale");
    const freshRequest = fetchRouteOptions("flight-fresh");
    await vi.waitFor(() => expect(pending).toHaveLength(2));

    // The fresh request settles first; the stale one lands afterwards.
    pending[1]!.resolve(jsonResponse({ options: [{ id: "fresh-route", callsign: "FRESH1" }], generation: GENERATION }));
    pending[0]!.resolve(jsonResponse({ options: [{ id: "stale-route", callsign: "STALE1" }], generation: GENERATION }));

    const [staleResult, freshResult] = await Promise.all([staleRequest, freshRequest]);
    expect(freshResult.options.map((option) => option.id)).toEqual(["fresh-route"]);
    expect(staleResult.options.map((option) => option.id)).toEqual(["stale-route"]);
  });

  it("two concurrent paginated searches keep their cursor chains strictly separate", async () => {
    const { pending } = installDeferredFetch();
    const searchOne = searchCallsigns("ONE");
    const searchTwo = searchCallsigns("TWO");
    await vi.waitFor(() => expect(pending).toHaveLength(2));

    // Release search two's first page first, each with its own cursor.
    pending[1]!.resolve(jsonResponse({ data: [{ id: "f-t2", callsign: "TWO9" }], nextCursor: "cursor-t2" }));
    pending[0]!.resolve(jsonResponse({ data: [{ id: "f-o1", callsign: "ONE1" }], nextCursor: "cursor-o2" }));
    await vi.waitFor(() => expect(pending).toHaveLength(4));

    // The follow-up page requests must each carry ONLY their own cursor.
    const followUpBodies = pending.slice(2).map((entry) => JSON.parse(String(entry.init?.body)) as { query: string; cursor?: string });
    expect(followUpBodies.sort((left, right) => left.query.localeCompare(right.query))).toEqual([
      { query: "ONE", cursor: "cursor-o2" },
      { query: "TWO", cursor: "cursor-t2" },
    ]);

    pending[2]!.resolve(jsonResponse({ data: [{ id: "f-x2", callsign: "XX2" }] }));
    pending[3]!.resolve(jsonResponse({ data: [{ id: "f-x3", callsign: "XX3" }] }));

    const [matchesOne, matchesTwo] = await Promise.all([searchOne, searchTwo]);
    const idsOne = matchesOne.map((match) => match.id).sort();
    const idsTwo = matchesTwo.map((match) => match.id).sort();
    expect(new Set([...idsOne, ...idsTwo]).size).toBe(4);
    expect(idsOne).toContain("f-o1");
    expect(idsTwo).toContain("f-t2");
    // Each search terminates on its own empty-cursor-free terminal page.
    expect(idsOne.length + idsTwo.length).toBe(4);
  });

  it("two concurrent overview traversals keep identity sets and generation state separate", async () => {
    const { pending } = installDeferredFetch();
    const overviewA = fetchRouteOverview();
    const overviewB = fetchRouteOverview();
    await vi.waitFor(() => expect(pending).toHaveLength(2));

    // Different generations across the two traversals: a module-level
    // generation variable would make one traversal fail with
    // GENERATION_CHANGED, and a shared seen-set would flag false duplicates.
    const generationA = { ...GENERATION, id: "gen-A" };
    const generationB = { ...GENERATION, id: "gen-B" };
    pending[0]!.resolve(jsonResponse({ data: [{ id: "flight-1", callsign: "AAA1" }], generation: generationA }));
    pending[1]!.resolve(jsonResponse({ data: [{ id: "flight-1", callsign: "BBB1" }], generation: generationB }));

    const [resultA, resultB] = await Promise.all([overviewA, overviewB]);
    expect(resultA.generation.id).toBe("gen-A");
    expect(resultB.generation.id).toBe("gen-B");
    expect(resultA.routes.map((route) => route.callsign)).toEqual(["AAA1"]);
    expect(resultB.routes.map((route) => route.callsign)).toEqual(["BBB1"]);
  });

  it("the client is cache-free: identical repeated calls always hit the network with fresh results", async () => {
    let callCount = 0;
    const fetchMock = vi.fn(async () => {
      callCount += 1;
      return jsonResponse({ status: callCount === 1 ? "degraded" : "ready" });
    });
    vi.stubGlobal("fetch", fetchMock);

    expect((await fetchReadiness()).status).toBe("degraded");
    expect((await fetchReadiness()).status).toBe("ready");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
