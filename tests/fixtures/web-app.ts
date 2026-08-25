import { vi } from "vitest";

/**
 * Deterministic browser-facing fixtures for the map-first web UI.
 *
 * These mirror the real client contract in apps/web/src/api.ts against the
 * BFF: callsign search is POST /api/v1/callsigns/search with a JSON {query}
 * body (never a query string); route options is POST /api/v1/routes/options
 * returning `{ data, generation }`; the overview endpoint returns paged route
 * data with `loaded`, `total`, and an optional generation-bound cursor; point
 * lookup is POST /api/v1/points/lookup carrying { reference } in the body and
 * returning { matches } with generation-bound locationId tokens; draft
 * validation is a single POST /api/v1/routes/compare
 * carrying { baselineId, targetDraft: { origin, destination, via,
 * selections } } and returning { target, comparison }. They contain no raw
 * upstream records, credentials, or airway values, consistent with the
 * README binding contract and docs/testing/evidence-and-validation.md.
 */

export const SAFETY_NOTICE =
  "Demonstration only. Operational weather, NOTAM, ATC, fuel, aircraft suitability, and regulatory constraints are not evaluated.";

export const ROUTE_COMPARISON_EXPLANATION =
  "Recorded routes are shown in stable source order for neutral comparison. Modeled distance is descriptive only and does not identify a preferred route.";
export const COMPLETE_GROUP_TITLE = "Complete recorded routes";
export const INCOMPLETE_GROUP_TITLE = "Recorded routes with visible gaps";

export const DRAFT_SAFETY_LABEL =
  "Computationally complete; operational constraints not assessed. Endpoints are locked and every change is checked against exact reference data.";

export type StubOptions = {
  /** Fail the callsign search endpoint (500) to exercise error recovery. */
  failSearch?: boolean | undefined;
  /** Fail the route-options endpoint (500) to exercise retry. */
  failRoutes?: boolean | undefined;
  /** Fail draft validation (500) to exercise draft error recovery. */
  failDraft?: boolean | undefined;
  /**
   * Serve readiness and route-options envelopes without a generation
   * summary. Both are contract-valid (generation is optional in api.ts).
   */
  noGeneration?: boolean | undefined;
  /** Serve a generation whose timestamps are malformed (never render "Invalid Date"). */
  malformedTimestamps?: boolean | undefined;
  /**
   * Hold every draft-validation (POST /api/v1/routes/compare) response until
   * the returned releaseDraft() is called, so rapid-consecutive-edit races
   * can be exercised deterministically. Responses release in FIFO order.
   */
  deferDraft?: boolean | undefined;
  /**
   * Hold every callsign-search (POST /api/v1/callsigns/search) response until
   * the returned releaseSearch() is called, so type-ahead supersession races
   * can be exercised deterministically. Responses release in FIFO order.
   */
  deferSearch?: boolean | undefined;
  /** Fail bulk browse requests with 409 CURSOR_EXPIRED. */
  failCursor?: boolean | undefined;
  /**
   * Fail the all-flight overview (502); `"once"` fails only the first call so
   * the Retry overview recovery path is observable.
   */
  failOverview?: boolean | "once" | undefined;
  /**
   * Fail the data summary (500); `"once"` fails only the first call so the
   * Retry summary recovery path is observable.
   */
  failSummary?: boolean | "once" | undefined;
  /** Replace the default data-summary envelope (counts only, airways never valued). */
  summary?: Record<string, unknown> | undefined;
  /** Replace the default overview with this many distinct renderable flights. */
  overviewCount?: number | undefined;
  /** Return two flights with exactly overlapping rendered paths. */
  overlappingOverview?: boolean | undefined;
};

export type CapturedCall = { method: string; url: string; body?: string | undefined };

const searchMatches = [
  { id: "flight-1", flightId: "flight-1", callsign: "FIXTURE1", departure: "KOR1", destination: "KDS1", routePointCount: 3 },
  { id: "flight-2", flightId: "flight-2", callsign: "FIXTURE1", departure: "KOR1", destination: "KDS2", routePointCount: 2 },
];

const routeOptions = [
  {
    id: "route-1",
    flightId: "flight-1",
    callsign: "FIXTURE1",
    status: "complete",
    complete: true,
    label: "Recorded via MIDPT",
    origin: "KOR1",
    destination: "KDS1",
    pointCount: 3,
    legs: [
      { id: "leg-1", sequence: 1, kind: "segment", from: "KOR1", to: "MIDPT", distanceNm: 240.5, status: "resolved" },
      { id: "leg-2", sequence: 2, kind: "segment", from: "MIDPT", to: "KDS1", distanceNm: 271.9, status: "resolved" },
    ],
    geometry: { type: "LineString", coordinates: [[-73, 40], [-90, 35], [-118, 33]] },
    distanceNm: 512.4,
    provenance: "CAAS normalized live generation",
    gaps: [],
  },
  {
    id: "route-3",
    flightId: "flight-3",
    callsign: "FIXTURE1",
    status: "complete",
    complete: true,
    label: "Recorded via alternate routing",
    origin: "KOR1",
    destination: "KDS1",
    pointCount: 3,
    legs: [
      { id: "leg-3a", sequence: 1, kind: "segment", from: "KOR1", to: "MIDPT", distanceNm: 251.2, status: "resolved" },
      { id: "leg-3b", sequence: 2, kind: "segment", from: "MIDPT", to: "KDS1", distanceNm: 282.9, status: "resolved" },
    ],
    geometry: { type: "LineString", coordinates: [[-73, 40], [-86, 39], [-118, 33]] },
    distanceNm: 534.1,
    provenance: "CAAS normalized live generation",
    gaps: [],
  },
  {
    id: "route-2",
    flightId: "flight-4",
    callsign: "FIXTURE1",
    status: "incomplete",
    complete: false,
    label: "Recorded with unresolved gap",
    origin: "KOR1",
    destination: "KDS1",
    pointCount: 4,
    legs: [
      { id: "leg-1", sequence: 1, kind: "segment", from: "KOR1", to: "WEST01", status: "resolved" },
      { id: "leg-2", sequence: 2, kind: "gap", reason: "MIDPT could not be resolved to a single reference", status: "gap" },
      { id: "leg-3", sequence: 3, kind: "segment", from: "EAST01", to: "KDS1", status: "resolved" },
    ],
    segments: [
      [{ lat: 40, lon: -73 }, { lat: 39, lon: -80 }],
      [{ lat: 38.8, lon: -80.5 }, { lat: 33, lon: -118 }],
    ],
    gaps: [{ sequence: 2, status: "gap", reason: "MIDPT could not be resolved to a single reference" }],
  },
];

function overviewRoutesFor(options: StubOptions) {
  if (options.overlappingOverview) {
    return routeOptions.slice(0, 2).map((route, index) => ({
      ...route,
      id: `overlap-route-${index + 1}`,
      flightId: `overlap-flight-${index + 1}`,
      callsign: `OVERLAP${index + 1}`,
      label: `Overlapping route ${index + 1}`,
      geometry: routeOptions[0]!.geometry,
    }));
  }
  if (options.overviewCount !== undefined) {
    return Array.from({ length: options.overviewCount }, (_, index) => ({
      ...routeOptions[0]!,
      id: `bulk-route-${index + 1}`,
      flightId: `bulk-flight-${index + 1}`,
      callsign: `BULK${String(index + 1).padStart(2, "0")}`,
      label: `Recorded bulk route ${index + 1}`,
      geometry: { type: "LineString", coordinates: [[-73, 40], [-90 + index / 10, 35], [-118, 33]] },
      distanceNm: 500 + index,
    }));
  }
  return routeOptions;
}

/**
 * Generation envelope matching apps/web/src/api.ts normalizeGeneration. The
 * live tier is "fresh" so the merged freshness strip renders the chip and
 * refresh button on every state without the stale/unusable banner (which is
 * also role="status" and would trip single-status assertions).
 */
const generation = {
  id: "gen-1",
  retrievedAt: "2026-08-14T00:00:00.000Z",
  live: {
    state: "fresh",
    retrievedAt: "2026-08-14T00:00:00.000Z",
    freshUntil: "2026-08-15T00:00:00.000Z",
    staleUntil: "2026-08-16T00:00:00.000Z",
  },
  reference: {
    state: "fresh",
    retrievedAt: "2026-08-13T00:00:00.000Z",
    freshUntil: "2026-08-15T00:00:00.000Z",
    staleUntil: "2026-08-16T00:00:00.000Z",
  },
  overall: "fresh",
};

function generationFor(options: StubOptions) {
  if (!options.malformedTimestamps) return generation;
  return {
    ...generation,
    retrievedAt: "not-a-date",
    live: { ...generation.live, retrievedAt: "not-a-date", freshUntil: "not-a-date", staleUntil: "not-a-date" },
    reference: { ...generation.reference, retrievedAt: "not-a-date", freshUntil: "not-a-date", staleUntil: "not-a-date" },
  };
}

/** The merged client posts one two-operand comparison and reads target + comparison. */
const draftCompareTarget = {
  id: "draft-1",
  origin: "KOR1",
  destination: "KDS1",
  legs: [
    { id: "leg-1", sequence: 1, kind: "segment", from: "KOR1", to: "MIDPT", distanceNm: 240.5, status: "resolved" },
    { id: "leg-2", sequence: 2, kind: "segment", from: "MIDPT", to: "KDS1", distanceNm: 271.9, status: "resolved" },
  ],
  gaps: [],
  distanceNm: 512.4,
  geometry: { type: "LineString", coordinates: [[-73, 40], [-90, 35], [-118, 33]] },
  provenance: "CAAS normalized live generation",
  freshness: "2026-08-14T00:00:00.000Z",
  safety: SAFETY_NOTICE,
};

const draftCompareComparison = {
  status: "complete",
  message: "Draft validation completed.",
  distanceDeltaNm: 0,
  percentageDistanceDelta: 0,
};

const pointMatches: Record<string, unknown> = {
  KOR1: { matches: [{ id: "loc-KOR1", callsign: "KOR1", name: "KOR1", kind: "airport", coordinate: { lat: 40, lon: -73 } }] },
  KDS1: { matches: [{ id: "loc-KDS1", callsign: "KDS1", name: "KDS1", kind: "airport", coordinate: { lat: 33, lon: -118 } }] },
  MIDPT: { matches: [{ id: "loc-MIDPT", callsign: "MIDPT", name: "MIDPT", kind: "place", coordinate: { lat: 35, lon: -90 } }] },
};

type StubResponse = {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
};

function jsonResponse(body: unknown, status = 200): StubResponse {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function bodyOf(init?: RequestInit): Record<string, unknown> {
  if (!init?.body) return {};
  try {
    const parsed = JSON.parse(String(init.body));
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

/**
 * Installs a deterministic `fetch` stub over the app's same-origin API paths
 * and returns the captured calls plus the underlying mock. Use
 * `vi.unstubAllGlobals()` in cleanup.
 */
export function installApiStub(options: StubOptions = {}): { calls: CapturedCall[]; fetchMock: ReturnType<typeof vi.fn>; releaseDraft: () => void; releaseSearch: () => void } {
  const calls: CapturedCall[] = [];
  const overviewRoutes = overviewRoutesFor(options);
  const draftResolvers: Array<() => void> = [];
  const searchResolvers: Array<() => void> = [];
  let overviewFailuresRemaining = options.failOverview === "once" ? 1 : 0;
  let summaryFailuresRemaining = options.failSummary === "once" ? 1 : 0;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<StubResponse> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ method, url, ...(typeof init?.body === "string" ? { body: init.body } : {}) });

    // The app loads every overview page before declaring the map/list ready.
    if (method === "POST" && url === "/api/v1/routes/overview") {
      if (options.failOverview === true || overviewFailuresRemaining > 0) {
        if (overviewFailuresRemaining > 0) overviewFailuresRemaining -= 1;
        return jsonResponse({ error: { message: "All-flight overview unavailable (stub).", code: "OVERVIEW_FAIL" } }, 502);
      }
      return jsonResponse({ data: overviewRoutes, generation: generationFor(options), loaded: overviewRoutes.length, total: overviewRoutes.length });
    }
    // Callsign search: POST with the query in the body only; the query never
    // appears in the request URL (plan §2.4).
    if (method === "POST" && url === "/api/v1/callsigns/search") {
      if (options.failSearch) return jsonResponse({ error: { message: "Search service unavailable (stub).", code: "SEARCH_FAIL" } }, 500);
      const query = String(bodyOf(init).query ?? "").toUpperCase();
      const respond = () => jsonResponse({ data: searchMatches.filter((match) => match.callsign.startsWith(query)) });
      if (options.deferSearch) return new Promise<StubResponse>((resolve) => { searchResolvers.push(() => resolve(respond())); });
      return respond();
    }
    // Route options: POST { flightId }, neutral envelope { data, generation }.
    if (method === "POST" && url === "/api/v1/routes/options") {
      if (options.failRoutes) return jsonResponse({ error: { message: "Route options unavailable (stub).", code: "ROUTES_FAIL" } }, 500);
      return jsonResponse(options.noGeneration ? { data: routeOptions } : { data: routeOptions, generation });
    }
    // Point lookup: POST { reference } -> { matches } with locationId tokens
    // (the user term travels in the body only; plan §2.4).
    if (method === "POST" && url === "/api/v1/points/lookup") {
      const reference = String(bodyOf(init).reference ?? "").toUpperCase();
      return jsonResponse(pointMatches[reference] ?? { matches: [] });
    }
    // Route detail: POST { routeId } -> { data } (the signed token travels in
    // the body only; plan §2.4).
    if (method === "POST" && url === "/api/v1/routes/detail") {
      return jsonResponse({ data: routeOptions[0] });
    }
    // Direct great-circle alternate: POST { flightId } -> { data, generation }.
    if (method === "POST" && url === "/api/v1/routes/alternate") {
      return jsonResponse({
        data: {
          flightId: String(bodyOf(init).flightId ?? ""),
          callsign: "FIXTURE1",
          origin: "KOR1",
          destination: "KDS1",
          kind: "direct-great-circle",
          label: "Direct (great-circle) alternate",
          geometry: { type: "LineString", coordinates: [[-73, 40], [-118, 33]] },
          distanceNm: 2100,
          provenance: "CAAS normalized live generation",
          freshness: "2026-08-23T00:00:00.000Z",
          safety: SAFETY_NOTICE,
        },
        generation: generationFor(options),
      });
    }
    // Alternate selection: POST { flightId } -> { data: { alternates } }.
    if (method === "POST" && url === "/api/v1/routes/alternates") {
      return jsonResponse({
        data: {
          alternates: [
            {
              flightId: String(bodyOf(init).flightId ?? ""),
              callsign: "FIXTURE1",
              origin: "KOR1",
              destination: "KDS1",
              kind: "direct-great-circle",
              label: "Direct (great-circle) alternate",
              geometry: { type: "LineString", coordinates: [[-73, 40], [-118, 33]] },
              distanceNm: 2100,
              provenance: "CAAS normalized live generation",
              freshness: "2026-08-23T00:00:00.000Z",
              safety: SAFETY_NOTICE,
            },
            {
              flightId: String(bodyOf(init).flightId ?? ""),
              callsign: "FIXTURE1",
              origin: "KOR1",
              destination: "KDS1",
              kind: "via-waypoint",
              label: "Via MIDPT (great-circle)",
              geometry: { type: "LineString", coordinates: [[-73, 40], [-90, 35], [-118, 33]] },
              distanceNm: 2300,
              provenance: "CAAS normalized live generation",
              freshness: "2026-08-23T00:00:00.000Z",
              safety: SAFETY_NOTICE,
            },
          ],
        },
        generation: generationFor(options),
      });
    }
    // Draft validation: single two-operand POST carrying baselineId + targetDraft.
    if (method === "POST" && url === "/api/v1/routes/compare") {
      if (options.failDraft) return jsonResponse({ error: { message: "Draft validation unavailable (stub).", code: "DRAFT_FAIL" } }, 500);
      const targetDraft = bodyOf(init).targetDraft as Record<string, unknown> | undefined;
      if (options.deferDraft) {
        return new Promise<StubResponse>((resolve) => { draftResolvers.push(() => resolve(jsonResponse({ target: draftCompareTarget, comparison: draftCompareComparison }))); });
      }
      return jsonResponse({ target: draftCompareTarget, comparison: draftCompareComparison });
    }
    // Readiness on mount and live refresh.
    if (method === "GET" && url === "/api/v1/readiness") {
      if (options.noGeneration) return jsonResponse({ status: "ready" });
      if (options.malformedTimestamps) {
        return jsonResponse({
          status: "ready",
          generation: {
            ...generation,
            retrievedAt: "not-a-date",
            live: { ...generation.live, retrievedAt: "not-a-date", freshUntil: "not-a-date", staleUntil: "not-a-date" },
            reference: { ...generation.reference, retrievedAt: "not-a-date", freshUntil: "not-a-date", staleUntil: "not-a-date" },
          },
        });
      }
      return jsonResponse({ status: "ready", generation });
    }
    if (method === "POST" && url === "/api/v1/refresh") {
      return jsonResponse({ status: "refreshed", generation: { ...generation, id: "gen-2", retrievedAt: "2026-08-14T01:00:00.000Z", live: { ...generation.live, retrievedAt: "2026-08-14T01:00:00.000Z" } } });
    }
    // Bulk data browse: summary (counts only, airways never valued) and
    // paged family endpoints. Cursors are stubbed as opaque strings.
    if (method === "GET" && url === "/api/v1/data/summary") {
      if (options.failSummary === true || summaryFailuresRemaining > 0) {
        if (summaryFailuresRemaining > 0) summaryFailuresRemaining -= 1;
        return jsonResponse({ error: { message: "Data summary unavailable (stub).", code: "SUMMARY_FAIL" } }, 500);
      }
      if (options.summary) return jsonResponse(options.summary);
      return jsonResponse({
        generation: generationFor(options),
        families: [
          { family: "flights", records: 3, acceptedRecords: 3, rejectedRecords: 0 },
          { family: "fixes", records: 1, acceptedRecords: 1, rejectedRecords: 0 },
          { family: "airports", records: 2, acceptedRecords: 2, rejectedRecords: 0 },
          { family: "navaids", records: 0, acceptedRecords: 0, rejectedRecords: 0 },
        ],
        airway: { family: "airways", records: 3, acceptedRecords: 3, rejectedRecords: 0, uniqueRecords: 2 },
      });
    }
    if (method === "POST" && url.startsWith("/api/v1/data/")) {
      if (options.failCursor) return jsonResponse({ error: { message: "The browse cursor has expired.", code: "CURSOR_EXPIRED" } }, 409);
      const body = bodyOf(init) as Record<string, unknown>;
      const cursor = typeof body.cursor === "string" ? body.cursor : undefined;
      const requested = typeof body.limit === "number" ? body.limit : 50;
      if (url === "/api/v1/data/flights") {
        const flights = [
          ...Array.from({ length: 10 }, (_, index) => ({ id: `flight-${index + 1}`, callsign: "FIXTURE1", departure: "KOR1", destination: "KDS1", pointCount: 3 })),
          { id: "flight-11", callsign: "FIXTURE3", departure: "KDS1", destination: "KOR1", pointCount: 3 },
          { id: "flight-12", callsign: "FIXTURE3", departure: "KDS2", destination: "KDS1", pointCount: 2 },
        ];
        const start = cursor === "p1" ? 10 : 0;
        const end = Math.min(flights.length, start + requested);
        const page = flights.slice(start, end);
        return jsonResponse({ data: page, generation, ...(end < flights.length ? { nextCursor: "p1" } : {}) });
      }
      if (url === "/api/v1/data/fixes") return jsonResponse({ data: [{ id: "loc-MIDPT", callsign: "MIDPT", name: "MIDPT", kind: "place", coordinate: { lat: 35, lon: -90 } }], generation });
      if (url === "/api/v1/data/airports") return jsonResponse({ data: [
        { id: "loc-KOR1", callsign: "KOR1", name: "KOR1", kind: "airport", coordinate: { lat: 40, lon: -73 } },
        { id: "loc-KDS1", callsign: "KDS1", name: "KDS1", kind: "airport", coordinate: { lat: 33, lon: -118 } },
      ], generation });
      if (url === "/api/v1/data/navaids") return jsonResponse({ data: [], generation });
      if (url === "/api/v1/data/airways") return jsonResponse({ error: { message: "Not found.", code: "NOT_FOUND" } }, 404);
    }
    return jsonResponse({ error: { message: `Unhandled stub request ${method} ${url}.`, code: "STUB" } }, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  return {
    calls,
    fetchMock,
    releaseDraft: () => { while (draftResolvers.length > 0) draftResolvers.shift()?.(); },
    releaseSearch: () => { while (searchResolvers.length > 0) searchResolvers.shift()?.(); },
  };
}
