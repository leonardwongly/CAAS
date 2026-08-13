import { vi } from "vitest";

/**
 * Deterministic browser-facing fixtures for the map-first web UI.
 *
 * These mirror the BFF response shapes (apps/api/src/server.ts) that
 * apps/web/src/api.ts normalizes: `{ data: [...] }` envelopes, opaque
 * identifiers, exact coordinates, and explicit gap markers. They contain no
 * raw upstream records, credentials, or airway values, consistent with the
 * README binding contract and docs/testing/evidence-and-validation.md.
 */

export const SAFETY_NOTICE =
  "Demonstration only. Operational weather, NOTAM, ATC, fuel, aircraft suitability, and regulatory constraints are not evaluated.";

export const RANK_CRITERION =
  "Routes are ranked by shortest recorded distance among routes with the same departure and arrival. Rank 1 is the shortest route in this retrieved set.";

export const DRAFT_SAFETY_LABEL =
  "Computationally complete; operational constraints not assessed. Endpoints are locked and every change is checked against exact reference data.";

export type StubOptions = {
  /** Fail the callsign search endpoint (500) to exercise error recovery. */
  failSearch?: boolean | undefined;
  /** Fail the route-options endpoint (500) to exercise retry. */
  failRoutes?: boolean | undefined;
  /** Fail draft validation (500) to exercise draft error recovery. */
  failDraft?: boolean | undefined;
};

export type CapturedCall = { method: string; url: string };

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

const draftCompare = {
  id: "draft-1",
  route: {
    id: "draft-1",
    origin: "KOR1",
    destination: "KDS1",
    legs: [
      { id: "leg-1", sequence: 1, kind: "direct", from: "KOR1", to: "MIDPT", distanceNm: 240.5, status: "resolved" },
      { id: "leg-2", sequence: 2, kind: "direct", from: "MIDPT", to: "KDS1", distanceNm: 271.9, status: "resolved" },
    ],
    gaps: [],
    distanceNm: 512.4,
  },
  draft: { origin: "KOR1", destination: "KDS1", via: ["MIDPT"] },
  comparison: { status: "complete", message: "Draft validation completed." },
};

const pointMatches: Record<string, unknown> = {
  KOR1: { matches: [{ callsign: "KOR1", name: "KOR1", kind: "airport", coordinate: { lat: 40, lon: -73 } }] },
  KDS1: { matches: [{ callsign: "KDS1", name: "KDS1", kind: "airport", coordinate: { lat: 33, lon: -118 } }] },
  MIDPT: { matches: [{ callsign: "MIDPT", name: "MIDPT", kind: "fix", coordinate: { lat: 35, lon: -90 } }] },
};

type StubResponse = {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
};

function jsonResponse(body: unknown, status = 200): StubResponse {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

/**
 * Installs a deterministic `fetch` stub over the app's same-origin API paths
 * and returns the captured calls plus the underlying mock. Use
 * `vi.unstubAllGlobals()` in cleanup.
 */
export function installApiStub(options: StubOptions = {}): { calls: CapturedCall[]; fetchMock: ReturnType<typeof vi.fn> } {
  const calls: CapturedCall[] = [];
  // The BFF validates a draft in two steps: create (posts origin/destination/
  // via) then compare by draftId. The created draft's via list is echoed so
  // edits (add/remove/reorder) behave exactly as against locked reference data.
  let latestDraftVia: string[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<StubResponse> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ method, url });

    if (method === "GET" && url.startsWith("/api/v1/callsigns/search")) {
      if (options.failSearch) return jsonResponse({ error: { message: "Search service unavailable (stub).", code: "SEARCH_FAIL" } }, 500);
      const query = new URL(url, "http://localhost").searchParams.get("query") ?? "";
      return jsonResponse({ data: searchMatches.filter((match) => match.callsign.startsWith(query.toUpperCase())) });
    }
    if (method === "POST" && url.startsWith("/api/v1/routes/options")) {
      if (options.failRoutes) return jsonResponse({ error: { message: "Route options unavailable (stub).", code: "ROUTES_FAIL" } }, 500);
      return jsonResponse({ data: routeOptions });
    }
    if (method === "GET" && url.startsWith("/api/v1/points/")) {
      const reference = decodeURIComponent(url.split("/").pop() ?? "").toUpperCase();
      return jsonResponse(pointMatches[reference] ?? { matches: [] });
    }
    if (method === "POST" && url.startsWith("/api/v1/drafts/compare")) {
      if (options.failDraft) return jsonResponse({ error: { message: "Draft validation unavailable (stub).", code: "DRAFT_FAIL" } }, 500);
      return jsonResponse({ ...draftCompare, draft: { ...draftCompare.draft, via: latestDraftVia } });
    }
    if (method === "POST" && url.startsWith("/api/v1/drafts")) {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      if (Array.isArray(body?.via)) latestDraftVia = body.via;
      return jsonResponse({ id: "draft-1" }, 201);
    }
    return jsonResponse({ error: { message: `Unhandled stub request ${method} ${url}.`, code: "STUB" } }, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls, fetchMock };
}
