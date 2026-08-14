import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchRouteData, lookupPoint, searchCallsigns } from "../../apps/web/src/api.ts";

/**
 * Regression test for finding sec-3: flight tokens, user lookup terms, and
 * cursor tokens travel in URLs, contradicting the binding
 * all-flight-and-user-state-out-of-URLs boundary.
 *
 * North-star contract:
 * - docs/security/safety-and-secrets.md:51 (route-diagram privacy):
 *   "Do not put callsigns, flight identifiers, coordinates, route state, or
 *   tokens in URLs."
 * - Plan §2.4 (implementation-plan.md:909): "URLs contain no live flight
 *   identifiers, callsigns, coordinates, tokens, or query state."
 * - Plan §2.4 conformance (safety-and-secrets.md:53) is implemented for
 *   callsign search only (POST-only, `400 INVALID_QUERY` on any query
 *   string, `405` on GET); the same obligation applies to every flow.
 *
 * Mechanism verified against the real code:
 * - api.ts lookupPoint(): `request(\`/api/v1/points/${encodeURIComponent(reference)}\`)`
 *   issues a GET whose path embeds the user-typed reference term (a
 *   callsign-like identifier, e.g. an airport code or fix name). The server
 *   already registers POST /api/v1/points/lookup carrying { reference } in
 *   the body (server.ts), so the client could keep the term out of the URL
 *   but does not. App.tsx calls lookupPoint on every draft point search
 *   (line 469) and for route-map endpoint resolution (lines 519-520).
 * - api.ts fetchRouteData(): `request(\`/api/v1/routes/${encodeURIComponent(routeId)}\`)`
 *   issues a GET whose path embeds routeId — an HMAC-SHA256 signed flight
 *   token (scopedToken(snapshot, "flight", { i }) encoding the generation id
 *   and flight index) — replayable from any access log.
 *
 * Correct behavior asserted here: neither the reference term nor the signed
 * flight token may ever appear in a request URL; each travels in a POST
 * body. The positive control (searchCallsigns) proves the interception
 * harness does catch URL-embedded data, so any failure above is a real
 * violation, not a harness artifact.
 */

type CapturedCall = { method: string; url: string; body?: string | undefined };

/** A plausible signed token shape (base64url body `.` base64url HMAC), like scopedToken in server.ts. */
const SIGNED_FLIGHT_TOKEN = "eyJnIjoiZ2VuLTEiLCJ0IjoiZmxpZ2h0IiwiaSI6MTJ9.7wQq9Zk0r2cVb1nXm8Yp3aT5sD6fG7hJ8kL9zX0cVbN";

/** A user-typed reference term as entered in the draft point search box. */
const USER_TERM = "KOR1";

function routeEnvelope(routeId: string) {
  return {
    data: {
      id: routeId,
      flightId: routeId,
      callsign: "SQ321",
      status: "complete",
      legs: [],
      gaps: [],
    },
  };
}

/**
 * Server-mirroring fetch stub: serves the endpoints the client requests
 * (GET /api/v1/points/:reference, GET /api/v1/routes/:routeId,
 * POST /api/v1/callsigns/search) so the flows complete, while recording
 * every call for the URL-hygiene assertions.
 */
function installStub() {
  const calls: CapturedCall[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ method: (init?.method ?? "GET").toUpperCase(), url, body: typeof init?.body === "string" ? init.body : undefined });
    if (url.startsWith("/api/v1/callsigns/search")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: [{ id: "flight-1", flightId: "flight-1", callsign: "SQ321", departure: "WSSS", destination: "WSSS", routePointCount: 4 }],
        }),
      } as unknown as Response;
    }
    if (url.startsWith("/api/v1/points/")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          status: "resolved",
          data: { id: "loc-token-1", name: USER_TERM, callsign: USER_TERM, coordinate: { lat: 1.35, lon: 103.82 } },
        }),
      } as unknown as Response;
    }
    if (url.startsWith("/api/v1/routes/")) {
      return { ok: true, status: 200, json: async () => routeEnvelope(SIGNED_FLIGHT_TOKEN) } as unknown as Response;
    }
    return { ok: false, status: 404, json: async () => ({ error: { message: `Unhandled ${url}` } }) } as unknown as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls };
}

describe("flight tokens and user lookup terms must never appear in request URLs (sec-3)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("point lookup carries the user-typed reference term in a POST body, never in the URL", async () => {
    const { calls } = installStub();

    await lookupPoint(USER_TERM);

    const inUrl = calls.some((call) => call.url.includes(USER_TERM) || call.url.includes(encodeURIComponent(USER_TERM)));
    expect(
      inUrl,
      `lookupPoint("${USER_TERM}") issued a request whose URL contains the user term (recorded: ${calls.map((c) => `${c.method} ${c.url}`).join(", ")}). safety-and-secrets.md: "Do not put callsigns, flight identifiers, coordinates, route state, or tokens in URLs"; PLAN-2.4: "URLs contain no live flight identifiers, callsigns, coordinates, tokens, or query state". The server already accepts POST /api/v1/points/lookup with { reference } in the body — the term must travel there, not in the URL path.`,
    ).toBe(false);

    const carrying = calls.find((call) => call.method === "POST" && call.url.includes("/api/v1/points/"));
    expect(
      carrying,
      "the lookup term must be carried by a POST request with the reference in the body (e.g. POST /api/v1/points/lookup), not by a GET whose path embeds the term",
    ).toBeTruthy();
    const body = carrying?.body ? (JSON.parse(carrying.body) as { reference?: unknown }) : undefined;
    expect(body?.reference).toBe(USER_TERM);
  });

  it("route detail carries the signed flight token in a POST body, never in the URL", async () => {
    const { calls } = installStub();

    await fetchRouteData(SIGNED_FLIGHT_TOKEN);

    const inUrl = calls.some((call) => call.url.includes(SIGNED_FLIGHT_TOKEN) || call.url.includes(encodeURIComponent(SIGNED_FLIGHT_TOKEN)));
    expect(
      inUrl,
      `fetchRouteData() issued a request whose URL embeds the signed flight token (recorded: ${calls.map((c) => `${c.method} ${c.url}`).join(", ")}). The routeId is an HMAC-signed token encoding the generation id and flight index; a token in a URL is replayable from any access log. PLAN-2.4: "URLs contain no live flight identifiers, callsigns, coordinates, tokens, or query state".`,
    ).toBe(false);

    const carrying = calls.find((call) => call.method === "POST" && call.url.includes("/api/v1/routes/"));
    expect(
      carrying,
      "the flight token must be carried by a POST request with the token in the body, never by a GET whose path embeds it",
    ).toBeTruthy();
    const body = carrying?.body ? (JSON.parse(carrying.body) as { routeId?: unknown }) : undefined;
    expect(body?.routeId).toBe(SIGNED_FLIGHT_TOKEN);
  });

  it("positive control: callsign search keeps the query out of the URL (interception harness catches violations)", async () => {
    const { calls } = installStub();

    await searchCallsigns("SQ321");

    const inUrl = calls.some((call) => call.url.includes("SQ321"));
    expect(inUrl, "searchCallsigns must stay POST-only with the query in the body (plan §2.4)").toBe(false);
    expect(calls[0]?.method).toBe("POST");
    const body = calls[0]?.body ? (JSON.parse(calls[0].body) as { query?: unknown }) : undefined;
    expect(body?.query).toBe("SQ321");
  });
});
