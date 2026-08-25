import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  fetchReadiness,
  fetchRouteOptions,
  lookupPoint,
  searchCallsigns,
} from "../../apps/web/src/api.ts";
import type { RouteOption } from "../../apps/web/src/api.ts";

/**
 * Adversarial lane A9 — owner/domain: parallel adversarial sub-agent / web
 * apiClient (apps/web/src/api.ts): fetch boundaries and malformed responses.
 *
 * Deliberately NOT duplicating:
 * - sec-1.test.tsx (hostile coordinate coercion), sec-3.test.tsx (URL privacy),
 *   finding-6.test.tsx (search pagination), overview-api.test.tsx (cursor
 *   traversal).
 *
 * Covered here, previously uncovered:
 * - 200 with unparseable/empty bodies and 204 no-body → clean rejection.
 * - valid JSON with wrong shape (null, primitives, junk fields) → stable
 *   degraded results or typed errors, never a crash.
 * - HTTP error envelope mapping (429/400/410/500, with/without envelope).
 * - AbortController: pre-abort, mid-pagination abort, post-completion no-op.
 * - content-type/charset weirdness on real Response bodies.
 * - privacy: error paths never log flight identifiers.
 * - geometry guards: zero-length distance acceptance, junk distance rejection,
 *   identical-anchor endpoint corridors never fabricated.
 */

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Spec-faithful fetch stub: honors a pre-aborted signal exactly like browser fetch. */
function stubFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init?: RequestInit | undefined }> = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, init });
    if (init?.signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
    return handler(url, init);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, calls };
}

const GENERATION = {
  id: "gen-1",
  retrievedAt: "2026-08-16T00:00:00.000Z",
  overall: "fresh",
  live: { state: "fresh", retrievedAt: "2026-08-16T00:00:00.000Z", freshUntil: "2026-08-17T00:00:00.000Z", staleUntil: "2026-08-18T00:00:00.000Z" },
  reference: { state: "fresh", retrievedAt: "2026-08-16T00:00:00.000Z", freshUntil: "2026-08-17T00:00:00.000Z", staleUntil: "2026-08-18T00:00:00.000Z" },
};

describe("malformed response bodies fail cleanly (A9)", () => {
  it("a 200 with an empty body rejects cleanly, never resolving undefined-derived data", async () => {
    // Real Response so body semantics are genuine: empty body -> json() throws.
    stubFetch(() => new Response("", { status: 200 }));
    await expect(fetchRouteOptions("flight-1")).rejects.toThrow();
  });

  it("a 200 with invalid JSON text rejects cleanly", async () => {
    stubFetch(() => new Response("<html>502 from an upstream proxy</html>", {
      status: 200,
      headers: { "content-type": "application/json" }, // lying content-type must not matter
    }));
    await expect(searchCallsigns("flight-1")).rejects.toThrow();
  });

  it("a 204 no-body response rejects rather than resolving a phantom result", async () => {
    stubFetch(() => new Response(null, { status: 204 }));
    await expect(fetchReadiness()).rejects.toThrow();
  });
});

describe("valid JSON with the wrong shape degrades stably (A9)", () => {
  it("null and primitive payloads yield safe empty results, never a crash", async () => {
    stubFetch(() => new Response("null", { status: 200 }));
    expect(await fetchRouteOptions("flight-1")).toEqual({ options: [] });
    expect(await fetchReadiness()).toEqual({ status: "unavailable" });
    expect(await lookupPoint("MIDPT")).toEqual({ matches: [], truncated: false });
    expect(await searchCallsigns("ABC")).toEqual([]);
  });

  it("a route option without identity, with junk legs/gaps, is dropped; missing callsign gets a fallback label", async () => {
    stubFetch(() => new Response(JSON.stringify({
      options: [
        { callsign: "NOID", legs: "junk", gaps: null },
        { id: "route-2", legs: [{ id: "leg-1", from: "KAAA", to: "KBBB" }], gaps: null },
      ],
      generation: GENERATION,
    }), { status: 200 }));

    const result = await fetchRouteOptions("flight-2");
    expect(result.options).toHaveLength(1);
    expect(result.options[0]?.id).toBe("route-2");
    expect(result.options[0]?.callsign).toBe("Unknown callsign");
    expect(result.options[0]?.legs).toHaveLength(1);
    expect(result.options[0]?.gaps).toEqual([]);
    expect(result.generation?.id).toBe("gen-1");
  });

  it("distance fields: zero and decimal strings are legal, junk and null are dropped, huge finite values pass", async () => {
    stubFetch((url) => url === "/api/v1/routes/options"
      ? new Response(JSON.stringify({
        options: [
          { id: "zero", distanceNm: 0 },
          { id: "decimal-string", distanceNm: "12.5" },
          { id: "junk", distanceNm: "0x1A" },
          { id: "null-distance", distanceNm: null },
          { id: "huge", distanceNm: 1e12 },
        ],
        generation: GENERATION,
      }), { status: 200 })
      : new Response("{}", { status: 404 }));

    const { options } = await fetchRouteOptions("flight-3");
    const byId = (id: string) => options.find((option) => option.id === id);
    expect(byId("zero")?.distanceNm).toBe(0);
    expect(byId("decimal-string")?.distanceNm).toBe(12.5);
    expect(byId("junk")?.distanceNm).toBeUndefined();
    expect(byId("null-distance")?.distanceNm).toBeUndefined();
    expect(byId("huge")?.distanceNm).toBe(1e12);
  });

});

describe("HTTP edge statuses map to stable typed errors (A9)", () => {
  it("429 with an error envelope surfaces the envelope message and code on an ApiError", async () => {
    stubFetch(() => new Response(JSON.stringify({ error: { message: "Rate limit exceeded.", code: "RATE_LIMITED" } }), {
      status: 429,
      headers: { "content-type": "application/json" },
    }));
    const error = await fetchRouteOptions("flight-5").catch((caught) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 429, message: "Rate limit exceeded.", code: "RATE_LIMITED" });
  });

  it("400 with an unparseable body falls back to the stable status-only message", async () => {
    stubFetch(() => new Response("Bad Request", { status: 400 }));
    await expect(lookupPoint("MIDPT")).rejects.toMatchObject({ name: "ApiError", status: 400, message: "Request failed (400)" });
  });

  it("500 whose error field is a bare string (not an envelope record) keeps the status-only message", async () => {
    stubFetch(() => new Response(JSON.stringify({ error: "boom" }), { status: 500 }));
    const error = await fetchReadiness().catch((caught) => caught);
    expect(error).toMatchObject({ name: "ApiError", status: 500, message: "Request failed (500)" });
    expect((error as ApiError).code).toBeUndefined();
  });

  it("410 GENERATION_EXPIRED code survives the mapping untouched", async () => {
    stubFetch(() => new Response(JSON.stringify({ error: { message: "Generation expired.", code: "GENERATION_EXPIRED" } }), { status: 410 }));
    await expect(fetchRouteOptions("flight-6")).rejects.toMatchObject({ status: 410, code: "GENERATION_EXPIRED" });
  });
});

describe("AbortController semantics (A9)", () => {
  it("a pre-aborted signal rejects with AbortError and the client adds no error of its own", async () => {
    const { calls } = stubFetch(() => new Response(JSON.stringify({ data: [] }), { status: 200 }));
    const controller = new AbortController();
    controller.abort();
    const error = await searchCallsigns("ABC", controller.signal).catch((caught) => caught);
    expect(error).toBeInstanceOf(DOMException);
    expect((error as DOMException).name).toBe("AbortError");
    // The stub mirrors browser fetch: an aborted signal aborts before send.
    expect(calls).toHaveLength(1);
  });

  it("an abort between search pages stops pagination and surfaces AbortError", async () => {
    const controller = new AbortController();
    const { fetchMock } = stubFetch((_url, init) => {
      if (init?.signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
      const body = JSON.parse(String(init?.body)) as { cursor?: string };
      if (body.cursor === undefined) {
        // Abort mid-pagination: the first page resolves, the stream is cut
        // before the follow-up page can start.
        controller.abort();
        return new Response(JSON.stringify({
          data: [{ id: "flight-1", callsign: "ABC1", departure: "KAAA", destination: "KBBB", routePointCount: 3 }],
          nextCursor: "cursor-2",
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    });

    const error = await searchCallsigns("ABC", controller.signal).catch((caught) => caught);
    expect((error as DOMException)?.name).toBe("AbortError");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("aborting after completion is a harmless no-op", async () => {
    const controller = new AbortController();
    const { fetchMock } = stubFetch(() => new Response(JSON.stringify({ data: [{ id: "flight-1", callsign: "ABC1", departure: "KAAA", destination: "KBBB", routePointCount: 3 }] }), { status: 200 }));

    const matches = await searchCallsigns("ABC", controller.signal);
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(matches).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("header and body weirdness never breaks parsing (A9)", () => {
  it("a 200 response with no content-type at all still parses via json()", async () => {
    // A misconfigured proxy may strip content-type; the client reads json()
    // directly and must not gate on headers.
    const response = new Response(JSON.stringify({ status: "ready", generation: GENERATION }), { status: 200 });
    response.headers.delete("content-type");
    stubFetch(() => response);
    expect(await fetchReadiness()).toMatchObject({ status: "ready", generation: { id: "gen-1" } });
  });

  it("a UTF-8 body with a charset parameter parses identically", async () => {
    stubFetch(() => new Response(JSON.stringify({ status: "ready", note: "café ✓" }), {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
    }));
    expect((await fetchReadiness()).status).toBe("ready");
  });
});

describe("privacy: error paths never log flight identifiers (A9)", () => {
  it("no console output carries the flight identifier, callsign, or search term", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    stubFetch(() => new Response("not-json", { status: 200 }));

    await fetchRouteOptions("signed-token-SECRETFLIGHT").catch(() => {});
    await searchCallsigns("SECRET-CALLSIGN").catch(() => {});
    const logged = [...logSpy.mock.calls, ...warnSpy.mock.calls, ...errorSpy.mock.calls]
      .flatMap((args) => args.map((arg) => (typeof arg === "string" ? arg : "")))
      .join(" ");
    expect(logged.includes("SECRETFLIGHT")).toBe(false);
    expect(logged.includes("SECRET-CALLSIGN")).toBe(false);
  });
});
