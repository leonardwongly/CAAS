import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchRouteOptions, lookupPoint } from "../../apps/web/src/api.ts";

/**
 * Regression test for finding sec-1: the web client's coordinate normalizers
 * in apps/web/src/api.ts coerce hostile values with bare Number():
 *
 *   - geoJsonCoordinate (api.ts:109-114): Number("0x1A")=26, Number("")=0,
 *     Number(null)=0, Number(true)=1 all pass the [-90,90]/[-180,180] range
 *     check and become real map geometry.
 *   - normalizeGeometry record branch (api.ts:126-133): same coercion and no
 *     range bounds at all, so even out-of-range numbers pass.
 *   - finiteNumber (api.ts:91-98) via normalizePointMatch (api.ts:447):
 *     lat:"" -> 0 and lat:"0x1A" -> 26, rendered as fabricated coordinates.
 *
 * The server-side pipeline rejects exactly these values (deferred-1.test.ts:
 * safeParseCoordinate / normalizeDisplayAll enforce a decimal-only grammar
 * and drop the record, incrementing rejectedRecords). The client must behave
 * the same way.
 *
 * North-star contract (README binding contract): "Use exact reference
 * resolution. Preserve duplicate matches and unresolved positions as explicit
 * ambiguity/gaps; never infer by proximity." A value that is not a canonical
 * decimal coordinate is unresolved — it must never be coerced into a
 * fabricated (0,0) or hex-parsed point that is then drawn as if it were an
 * exact resolved reference. Plan §6 bounds every reference coordinate to the
 * decimal-only IDENTIFIER (latitude,longitude) grammar, and the codebase
 * convention (finding-0, deferred-1) is "booleans and non-canonical strings
 * must never be coerced".
 *
 * These normalizers are module-private, so they are exercised through the
 * exported API functions with a fetch stub, exactly as finding-6 does for
 * searchCallsigns.
 */

const GENERATION = {
  id: "gen-1",
  retrievedAt: "2026-08-14T00:00:00.000Z",
  overall: "fresh",
  live: { state: "fresh", retrievedAt: "2026-08-14T00:00:00.000Z", freshUntil: "2026-08-15T00:00:00.000Z", staleUntil: "2026-08-16T00:00:00.000Z" },
  reference: { state: "fresh", retrievedAt: "2026-08-13T00:00:00.000Z", freshUntil: "2026-08-15T00:00:00.000Z", staleUntil: "2026-08-16T00:00:00.000Z" },
};

function installFetch(payloadFor: (url: string) => unknown) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const payload = payloadFor(url);
    if (payload === undefined) {
      return { ok: false, status: 404, json: async () => ({ error: { message: `Unhandled ${url}` } }) };
    }
    return { ok: true, status: 200, json: async () => payload };
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function routeOption(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "route-1",
    flightId: "flight-1",
    callsign: "HOSTILE",
    legs: [{ id: "leg-1", from: "KAAA", to: "KBBB", sequence: 1 }],
    ...overrides,
  };
}

describe("client coordinate normalizers must never coerce hostile values into fabricated coordinates (finding sec-1)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("fetchRouteOptions: LineString geometry with hex-string coordinates is dropped, never parsed as (lat,lon)", async () => {
    installFetch((url) => url === "/api/v1/routes/options"
      ? { options: [routeOption({ geometry: { type: "LineString", coordinates: [["0x1A", "0x0B"], ["0x1C", "0x0D"]] } })], generation: GENERATION }
      : undefined);

    const result = await fetchRouteOptions("flight-1");

    // Number("0x1A")=26, Number("0x0B")=11, Number("0x1C")=28, Number("0x0D")=13 —
    // all in range, so the buggy normalizer renders {lat:11,lon:26},{lat:13,lon:28}.
    expect(
      result.options[0]?.geometry,
      "hex-string coordinates must be rejected (decimal-only grammar, plan §6), not Number()-coerced into real map geometry",
    ).toBeUndefined();
  });

  it("fetchRouteOptions: LineString geometry with null/boolean coordinates is dropped, never rendered as (0,0)/(1,0)", async () => {
    installFetch((url) => url === "/api/v1/routes/options"
      ? { options: [routeOption({ geometry: { type: "LineString", coordinates: [[null, null], [true, false]] } })], generation: GENERATION }
      : undefined);

    const result = await fetchRouteOptions("flight-1");

    // geoJsonCoordinate: Number(null)=0, Number(true)=1, Number(false)=0 —
    // all in range for the buggy normalizer, which renders {lat:0,lon:0},{lat:0,lon:1}.
    expect(result.options[0]?.geometry, "null/boolean coordinates must be rejected, never coerced to (0,0)").toBeUndefined();
  });

  it("fetchRouteOptions: record-branch segments with empty/hex strings are dropped, never rendered as (0,0)/(26,42)", async () => {
    installFetch((url) => url === "/api/v1/routes/options"
      ? { options: [routeOption({ segments: [[{ lat: "", lon: "" }, { lat: "0x1A", lon: "0x2A" }]] })], generation: GENERATION }
      : undefined);

    const result = await fetchRouteOptions("flight-1");

    // Record branch: Number("")=0, Number("0x1A")=26, Number("0x2A")=42.
    expect(result.options[0]?.segments, "empty/hex string coordinates in the record branch must be rejected, never coerced").toBeUndefined();
  });

  it("fetchRouteOptions: record-branch segments must enforce the same [-90,90]/[-180,180] bounds as the array branch", async () => {
    installFetch((url) => url === "/api/v1/routes/options"
      ? { options: [routeOption({ segments: [[{ lat: 200, lon: 300 }, { lat: -91, lon: 400 }]] })], generation: GENERATION }
      : undefined);

    const result = await fetchRouteOptions("flight-1");

    expect(
      result.options[0]?.segments,
      "out-of-range numeric coordinates in the record branch must be rejected; the record branch must apply the same bounds as the array branch",
    ).toBeUndefined();
  });

  it("lookupPoint: a match with empty-string coordinate is dropped, never rendered as a (0,0) marker", async () => {
    installFetch((url) => url.startsWith("/api/v1/points/")
      ? { matches: [{ id: "loc-1", callsign: "EMPTYCOORD", coordinate: { lat: "", lon: "" } }] }
      : undefined);

    const result = await lookupPoint("EMPTYCOORD");

    expect(result.matches, "a match whose coordinate is an empty string must be rejected, never rendered as (0,0)").toHaveLength(0);
  });

  it("lookupPoint: a match with hex-string coordinate is dropped, never rendered as (26,11)", async () => {
    installFetch((url) => url.startsWith("/api/v1/points/")
      ? { matches: [{ id: "loc-2", callsign: "HEXCOORD", coordinate: { lat: "0x1A", lon: "0x0B" } }] }
      : undefined);

    const result = await lookupPoint("HEXCOORD");

    // finiteNumber: Number("0x1A")=26, Number("0x0B")=11 — the buggy
    // normalizer accepts the match with coordinate {lat:26, lon:11}.
    expect(result.matches, "hex-string coordinates must be rejected, never coerced").toHaveLength(0);
  });

  it("lookupPoint: a match with boolean coordinate is dropped, never rendered as (1,0)", async () => {
    installFetch((url) => url.startsWith("/api/v1/points/")
      ? { matches: [{ id: "loc-3", callsign: "BOOLCOORD", coordinate: { lat: true, lon: false } }] }
      : undefined);

    const result = await lookupPoint("BOOLCOORD");

    // finiteNumber only coerces numbers/strings: boolean -> NaN -> rejected already.
    expect(result.matches, "boolean coordinates must be rejected").toHaveLength(0);
  });
});
