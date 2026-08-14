import { vi } from "vitest";

/**
 * Deterministic browser-facing fixtures for the map-first web UI.
 *
 * These mirror the real client contract in apps/web/src/api.ts against the
 * BFF: callsign search is POST /api/v1/callsigns/search with a JSON {query}
 * body (never a query string); route options is POST /api/v1/routes/options
 * returning an envelope { data, rankLabel, generation }; point lookup is
 * GET /api/v1/points/:reference returning { matches } with generation-bound
 * locationId tokens; draft validation is a single POST /api/v1/routes/compare
 * carrying { baselineId, targetDraft: { origin, destination, via,
 * selections } } and returning { target, comparison }. They contain no raw
 * upstream records, credentials, or airway values, consistent with the
 * README binding contract and docs/testing/evidence-and-validation.md.
 */

export const SAFETY_NOTICE =
  "Demonstration only. Operational weather, NOTAM, ATC, fuel, aircraft suitability, and regulatory constraints are not evaluated.";

/** Matches apps/web/src/labels.ts exactly (RANK_CRITERION). */
export const RANK_CRITERION =
  "Routes are ranked by shortest modeled distance among complete candidates with the same departure and arrival. Ties share a rank; the ranking does not assess operational safety.";

/** Matches apps/web/src/labels.ts exactly (RANK_ONE_LABEL); the rank-1 group heading. */
export const RANK_ONE_LABEL = "Rank 1 by shortest modeled distance among complete candidates.";

export const COMPLETE_RANKED_GROUP_TITLE = "Complete routes — ranked by modeled distance";
export const INCOMPLETE_GROUP_TITLE = "Incomplete routes — not ranked";

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
};

export type CapturedCall = { method: string; url: string; body?: string | undefined };

const searchMatches = [
  { id: "flight-1", flightId: "flight-1", callsign: "FIXTURE1", departure: "KOR1", destination: "KDS1", routePointCount: 3 },
  { id: "flight-2", flightId: "flight-2", callsign: "FIXTURE1", departure: "KOR1", destination: "KDSS", routePointCount: 2 },
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
      { id: "leg-1", sequence: 1, kind: "direct", from: "KOR1", to: "MIDPT", distanceNm: 240.5, status: "resolved" },
      { id: "leg-2", sequence: 2, kind: "direct", from: "MIDPT", to: "KDS1", distanceNm: 271.9, status: "resolved" },
    ],
    geometry: { type: "LineString", coordinates: [[-73, 40], [-90, 35], [-118, 33]] },
    distanceNm: 512.4,
    rankDistanceNm: 512.4,
    rank: 1,
    operationalProxy: {
      mode: "operational-proxy",
      eligible: true,
      criterion: "distance only",
      summary: "complete",
      rank: 1,
    },
    provenance: "CAAS normalized live generation",
    gaps: [],
  },
  {
    id: "route-3",
    flightId: "flight-1",
    callsign: "FIXTURE1",
    status: "complete",
    complete: true,
    label: "Recorded via alternate routing",
    origin: "KOR1",
    destination: "KDS1",
    pointCount: 3,
    legs: [
      { id: "leg-3a", sequence: 1, kind: "direct", from: "KOR1", to: "MIDPT", distanceNm: 251.2, status: "resolved" },
      { id: "leg-3b", sequence: 2, kind: "direct", from: "MIDPT", to: "KDS1", distanceNm: 282.9, status: "resolved" },
    ],
    geometry: { type: "LineString", coordinates: [[-73, 40], [-90, 35], [-118, 33]] },
    distanceNm: 534.1,
    rankDistanceNm: 534.1,
    rank: 2,
    operationalProxy: {
      mode: "operational-proxy",
      eligible: true,
      criterion: "distance only",
      summary: "complete",
      rank: 2,
    },
    provenance: "CAAS normalized live generation",
    gaps: [],
  },
  {
    id: "route-2",
    flightId: "flight-1",
    callsign: "FIXTURE1",
    status: "incomplete",
    complete: false,
    label: "Recorded with unresolved gap",
    origin: "KOR1",
    destination: "KDS1",
    pointCount: 2,
    legs: [
      { id: "leg-1", sequence: 1, kind: "direct", from: "KOR1", to: "KDS1", distanceNm: 512.4, status: "resolved" },
      { id: "leg-2", sequence: 2, kind: "gap", reason: "MIDPT could not be resolved to a single reference", status: "gap" },
    ],
    operationalProxy: {
      mode: "operational-proxy",
      eligible: false,
      criterion: "distance only",
      summary: "incomplete",
      exclusion: "This route has unresolved waypoints and cannot be ranked.",
    },
    gaps: [{ sequence: 2, status: "gap", reason: "MIDPT could not be resolved to a single reference" }],
  },
];

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

/** The merged client posts one two-operand comparison and reads target + comparison. */
const draftCompareTarget = {
  id: "draft-1",
  origin: "KOR1",
  destination: "KDS1",
  legs: [
    { id: "leg-1", sequence: 1, kind: "direct", from: "KOR1", to: "MIDPT", distanceNm: 240.5, status: "resolved" },
    { id: "leg-2", sequence: 2, kind: "direct", from: "MIDPT", to: "KDS1", distanceNm: 271.9, status: "resolved" },
  ],
  gaps: [],
  distanceNm: 512.4,
  rankDistanceNm: 512.4,
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
  MIDPT: { matches: [{ id: "loc-MIDPT", callsign: "MIDPT", name: "MIDPT", kind: "fix", coordinate: { lat: 35, lon: -90 } }] },
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
export function installApiStub(options: StubOptions = {}): { calls: CapturedCall[]; fetchMock: ReturnType<typeof vi.fn>; releaseDraft: () => void } {
  const calls: CapturedCall[] = [];
  const draftResolvers: Array<() => void> = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<StubResponse> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ method, url, ...(typeof init?.body === "string" ? { body: init.body } : {}) });

    // Callsign search: POST with the query in the body only; the query never
    // appears in the request URL (plan §2.4).
    if (method === "POST" && url === "/api/v1/callsigns/search") {
      if (options.failSearch) return jsonResponse({ error: { message: "Search service unavailable (stub).", code: "SEARCH_FAIL" } }, 500);
      const query = String(bodyOf(init).query ?? "").toUpperCase();
      return jsonResponse({ data: searchMatches.filter((match) => match.callsign.startsWith(query)) });
    }
    // Route options: POST { flightId }, envelope { data, rankLabel, generation }.
    if (method === "POST" && url === "/api/v1/routes/options") {
      if (options.failRoutes) return jsonResponse({ error: { message: "Route options unavailable (stub).", code: "ROUTES_FAIL" } }, 500);
      return jsonResponse(options.noGeneration
        ? { data: routeOptions, rankLabel: RANK_ONE_LABEL }
        : { data: routeOptions, rankLabel: RANK_ONE_LABEL, generation });
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
    return jsonResponse({ error: { message: `Unhandled stub request ${method} ${url}.`, code: "STUB" } }, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  return {
    calls,
    fetchMock,
    releaseDraft: () => { while (draftResolvers.length > 0) draftResolvers.shift()?.(); },
  };
}
