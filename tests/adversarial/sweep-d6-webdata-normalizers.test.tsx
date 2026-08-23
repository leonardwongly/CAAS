import { afterEach, describe, expect, it, vi } from "vitest";
import {
  browseAirports,
  browseFixes,
  browseFlights,
  browseNavaids,
  fetchDataSummary,
  fetchDonorProof,
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
 * Hostile API response payloads driven through every apps/web/src/api.ts
 * normalizer that no earlier lane exercises: donor proof occurrences, the
 * data-summary/browse family, refresh/readiness, route detail, draft
 * comparison, point lookup, overview envelope gates, and the route/gap/leg
 * normalizer fallbacks.
 *
 * Deliberately NOT duplicating:
 * - adv-web-api-client.test.tsx (empty/unparseable bodies, null/primitive
 *   payloads, distance grammar, synthesis envelope, HTTP error mapping,
 *   abort semantics, content-type weirdness),
 * - sec-1.test.tsx (hex/null/boolean/empty-string coordinate coercion in
 *   geometry/segments/lookup), sec-3.test.tsx (URL privacy),
 * - finding-6.test.tsx (search pagination traversal),
 * - overview-api.test.tsx (cursor traversal, duplicate identity, generation
 *   change, no-progress), sec-r5/adv-api-* (server-side contracts),
 * - sec-r4-web-draft.test.tsx (draft validation UI races).
 *
 * Regressions pinned here for the D6 api.ts fixes:
 * - out-of-range coordinates in point matches, browse items, and donor proof
 *   occurrences are dropped (boundedCoordinate, sec-1 parity),
 * - blank nextCursor strings are terminal in search pagination and never
 *   mark a point lookup as truncated.
 */

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function stubJson(payload: unknown, status = 200) {
  const calls: Array<{ url: string; body?: unknown }> = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    if (init?.signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
    return new Response(JSON.stringify(payload), { status });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, calls };
}

const GENERATION = {
  id: "gen-d6",
  retrievedAt: "2026-08-23T00:00:00.000Z",
  overall: "fresh",
  live: { state: "fresh", retrievedAt: "2026-08-23T00:00:00.000Z", freshUntil: "2026-08-24T00:00:00.000Z", staleUntil: "2026-08-25T00:00:00.000Z" },
  reference: { state: "fresh", retrievedAt: "2026-08-23T00:00:00.000Z", freshUntil: "2026-08-24T00:00:00.000Z", staleUntil: "2026-08-25T00:00:00.000Z" },
};

describe("fetchDonorProof normalizes hostile occurrence payloads (D6)", () => {
  it("non-record payloads and non-record data degrade to an empty result, never a crash", async () => {
    stubJson(["not-a-record"]);
    expect(await fetchDonorProof("proof-1")).toEqual({ flightId: "", occurrences: [] });
    stubJson({ data: "not-a-record" });
    expect(await fetchDonorProof("proof-1")).toEqual({ flightId: "", occurrences: [] });
    stubJson({ data: { flightId: "flight-9" } });
    expect(await fetchDonorProof("proof-1")).toEqual({ flightId: "flight-9", occurrences: [] });
  });

  it("junk occurrences are dropped field-by-field; valid ones survive intact", async () => {
    stubJson({
      data: {
        flightId: "  flight-7  ",
        occurrences: [
          "not-a-record",
          null,
          { status: "matched" },                                            // no ordinal
          { ordinal: 2 },                                                    // no status
          { ordinal: "0x2", status: "matched" },                             // hex ordinal
          { ordinal: true, status: "matched" },                              // boolean ordinal
          { ordinal: 1, status: "matched", label: 42, reason: false },       // junk label/reason
          { ordinal: 2, status: "matched", coordinate: { lat: 10 } },        // partial coordinate
          { ordinal: 3, status: "matched", coordinate: { lat: 95, lon: 0 } },// out-of-range coordinate (D6 fix)
          { ordinal: 4, status: "matched", coordinate: { lat: -12.5, lon: 96.25 }, label: " donor pt ", reason: "nearest" },
        ],
      },
    });

    const result = await fetchDonorProof("proof-1");
    expect(result.flightId).toBe("flight-7");
    // Coordinates are optional on occurrences: an out-of-range coordinate
    // drops the coordinate (D6 fix), never the occurrence itself.
    expect(result.occurrences.map((occurrence) => occurrence.ordinal)).toEqual([1, 2, 3, 4]);
    expect(result.occurrences[0]).toEqual({ ordinal: 1, status: "matched" });
    expect(result.occurrences[1]).toEqual({ ordinal: 2, status: "matched" });
    expect(result.occurrences[2]).toEqual({ ordinal: 3, status: "matched" });
    expect(result.occurrences[3]).toEqual({ ordinal: 4, status: "matched", label: "donor pt", reason: "nearest", coordinate: { lat: -12.5, lon: 96.25 } });
  });

  it("proof occurrence coordinates at the exact legal extremes pass; one step beyond is dropped (D6 fix)", async () => {
    stubJson({
      data: {
        flightId: "flight-8",
        occurrences: [
          { ordinal: 1, status: "matched", coordinate: { lat: 90, lon: 180 } },
          { ordinal: 2, status: "matched", coordinate: { lat: -90, lon: -180 } },
          { ordinal: 3, status: "matched", coordinate: { lat: 90.0001, lon: 0 } },
          { ordinal: 4, status: "matched", coordinate: { lat: 0, lon: -180.0001 } },
        ],
      },
    });
    const result = await fetchDonorProof("proof-1");
    expect(result.occurrences.map((occurrence) => occurrence.ordinal)).toEqual([1, 2, 3, 4]);
    expect(result.occurrences[0]?.coordinate).toEqual({ lat: 90, lon: 180 });
    expect(result.occurrences[1]?.coordinate).toEqual({ lat: -90, lon: -180 });
    expect(result.occurrences[2]?.coordinate).toBeUndefined();
    expect(result.occurrences[3]?.coordinate).toBeUndefined();
  });
});

describe("fetchDataSummary gates generation and airway counts (D6)", () => {
  it("rejects payloads without a usable generation or airway counts", async () => {
    stubJson("not-a-record");
    await expect(fetchDataSummary()).rejects.toThrow(/generation/);
    stubJson({ generation: GENERATION });
    await expect(fetchDataSummary()).rejects.toThrow(/airway/);
    stubJson({ generation: GENERATION, airway: { records: "ten" } });
    await expect(fetchDataSummary()).rejects.toThrow(/airway/);
    stubJson({ generation: { id: "broken" }, airway: { records: 5 } });
    await expect(fetchDataSummary()).rejects.toThrow(/generation/);
  });

  it("drops unusable family entries and junk counters but keeps legal ones, including zero", async () => {
    stubJson({
      generation: GENERATION,
      families: [
        "junk",
        { family: "flights" },                       // no records count
        { records: 4 },                              // no family name -> "unknown"
        { family: "fixes", records: "0x5" },         // hex count
        { family: "airports", records: 0, acceptedRecords: "junk", rejectedRecords: null },
        { family: "routes", records: 12, acceptedRecords: 10, rejectedRecords: 2 },
      ],
      airway: { records: 7, acceptedRecords: 6, rejectedRecords: "junk", uniqueRecords: 5 },
    });

    const summary = await fetchDataSummary();
    expect(summary.generation.id).toBe("gen-d6");
    expect(summary.families).toEqual([
      { family: "unknown", records: 4 },
      { family: "airports", records: 0 },
      { family: "routes", records: 12, acceptedRecords: 10, rejectedRecords: 2 },
    ]);
    expect(summary.airway).toEqual({ family: "airways", records: 7, acceptedRecords: 6, uniqueRecords: 5 });
  });
});

describe("browse endpoints unwrap and normalize hostile pages (D6)", () => {
  const FLIGHT = { id: "f-1", callsign: "D6A", departure: "KAAA", destination: "KBBB", pointCount: 5 };

  it("accepts every documented envelope key, a bare array, and degrades junk to an empty page", async () => {
    for (const key of ["results", "items", "matches", "options", "routes", "data"]) {
      stubJson({ [key]: [FLIGHT], generation: GENERATION });
      const page = await browseFlights(50);
      expect(page.items.map((item) => item.id), `envelope key "${key}"`).toEqual(["f-1"]);
      expect(page.generation?.id).toBe("gen-d6");
    }
    stubJson([FLIGHT]);
    expect((await browseFlights(50)).items).toHaveLength(1);
    stubJson({ envelope: [FLIGHT] });
    expect((await browseFlights(50)).items).toEqual([]);
    stubJson("not-a-record");
    expect((await browseFlights(50)).items).toEqual([]);
  });

  it("drops identity-less flight items, defaults missing endpoints, and coerces junk counts to zero", async () => {
    stubJson({
      items: [
        { callsign: "NOID" },
        { id: "no-callsign" },
        { id: "f-2", callsign: "D6B" },
        { id: "f-3", callsign: "D6C", departure: "  KSFO  ", pointCount: "0x3" },
        { id: "f-4", callsign: "D6D", pointCount: 0 },
      ],
    });
    const page = await browseFlights(50);
    expect(page.items).toEqual([
      { id: "f-2", callsign: "D6B", departure: "Not supplied", destination: "Not supplied", pointCount: 0 },
      { id: "f-3", callsign: "D6C", departure: "KSFO", destination: "Not supplied", pointCount: 0 },
      { id: "f-4", callsign: "D6D", departure: "Not supplied", destination: "Not supplied", pointCount: 0 },
    ]);
  });

  it("reference browse items with out-of-range or junk coordinates are dropped across fixes/airports/navaids (D6 fix)", async () => {
    const payload = {
      items: [
        { id: "p-1", callsign: "OKFIX", coordinate: { lat: 51.5, lon: -0.1 } },
        { id: "p-2", callsign: "FAROUT", coordinate: { lat: 91, lon: 0 } },
        { id: "p-3", callsign: "DEEP", coordinate: { lat: 0, lon: 180.5 } },
        { id: "p-4", callsign: "NOCOORD" },
        { id: "p-5", callsign: "JUNKCOORD", coordinate: { lat: "0x1A", lon: "0x0B" } },
        { id: "p-6", callsign: "EDGE", coordinate: { latitude: 90, longitude: -180 } },
      ],
    };
    stubJson(payload);
    expect((await browseFixes(50)).items.map((item) => item.id)).toEqual(["p-1", "p-6"]);
    stubJson(payload);
    expect((await browseAirports(50)).items.map((item) => item.id)).toEqual(["p-1", "p-6"]);
    stubJson(payload);
    expect((await browseNavaids(50)).items.map((item) => item.id)).toEqual(["p-1", "p-6"]);
    expect((await browseNavaids(50)).items[1]?.coordinate).toEqual({ lat: 90, lon: -180 });
  });

  it("blank or non-string cursors never surface as a next page; junk generations are omitted", async () => {
    stubJson({ items: [FLIGHT], nextCursor: "   ", generation: GENERATION });
    expect((await browseFlights(50)).nextCursor).toBeUndefined();
    stubJson({ items: [FLIGHT], nextCursor: 42 });
    expect((await browseFlights(50)).nextCursor).toBeUndefined();
    stubJson({ items: [FLIGHT], nextCursor: "page-2", generation: { id: "incomplete" } });
    const page = await browseFlights(50);
    expect(page.nextCursor).toBe("page-2");
    expect(page.generation).toBeUndefined();
  });
});

describe("refresh, readiness, and route detail envelopes (D6)", () => {
  it("refreshLiveData demands a generation confirmation and defaults the status", async () => {
    stubJson("not-a-record");
    await expect(refreshLiveData()).rejects.toThrow(/refresh/);
    stubJson({ status: "refreshed" });
    await expect(refreshLiveData()).rejects.toThrow(/generation/);
    stubJson({ generation: GENERATION });
    expect(await refreshLiveData()).toEqual({ status: "refreshed", generation: expect.objectContaining({ id: "gen-d6" }) });
    stubJson({ status: "  partial  ", generation: GENERATION });
    expect((await refreshLiveData()).status).toBe("partial");
  });

  it("fetchReadiness trims strings and drops junk retryable/code fields", async () => {
    stubJson({ status: "  degraded  ", code: 404, retryable: "yes", generation: { broken: true } });
    expect(await fetchReadiness()).toEqual({ status: "degraded" });
    stubJson({ status: "stale", code: "GENERATION_STALE", retryable: true, generation: GENERATION });
    expect(await fetchReadiness()).toEqual({
      status: "stale",
      code: "GENERATION_STALE",
      retryable: true,
      generation: expect.objectContaining({ id: "gen-d6" }),
    });
  });

  it("fetchRouteData unwraps a data envelope, accepts a flat route, and rejects unusable bodies", async () => {
    const route = { id: "route-1", callsign: "D6R", legs: [{ id: "leg-1", from: "A", to: "B" }], gaps: [] };
    stubJson({ data: route });
    expect((await fetchRouteData("token-1")).id).toBe("route-1");
    stubJson(route);
    expect((await fetchRouteData("token-1")).id).toBe("route-1");
    stubJson({ data: { legs: [] } });
    await expect(fetchRouteData("token-1")).rejects.toThrow(/usable route data/);
    stubJson(null);
    await expect(fetchRouteData("token-1")).rejects.toThrow(/usable route data/);
  });

  it("fetchRouteOverview rejects non-record pages and pages without a generation before any traversal", async () => {
    stubJson("not-a-record");
    await expect(fetchRouteOverview()).rejects.toThrow(/not usable/);
    stubJson({ data: [] });
    await expect(fetchRouteOverview()).rejects.toThrow(/generation/);
  });
});

describe("validateDraft comparison envelope (D6)", () => {
  const TARGET = {
    id: "draft-1",
    origin: "KAAA",
    destination: "KBBB",
    legs: [
      "junk",
      { id: "leg-1", from: "KAAA", to: "MID", distanceNm: "12.5" },
      { id: "leg-2", from: "MID", to: "KBBB", distanceNm: "0x1A" },
    ],
    gaps: [{ sequence: 2, reason: "modeled distance unavailable" }, 7],
    distanceNm: "25.5",
    provenance: "  draft-model  ",
  };

  it("rejects envelopes missing target/comparison records or the draft identity", async () => {
    stubJson({ target: TARGET });
    await expect(validateDraft("KAAA", "KBBB", [], [], "baseline-1")).rejects.toThrow(/usable draft comparison/);
    stubJson({ comparison: { status: "complete", message: "ok" } });
    await expect(validateDraft("KAAA", "KBBB", [], [], "baseline-1")).rejects.toThrow(/usable draft comparison/);
    stubJson({ target: { origin: "KAAA" }, comparison: { status: "complete", message: "ok" } });
    await expect(validateDraft("KAAA", "KBBB", [], [], "baseline-1")).rejects.toThrow(/complete draft identity/);
  });

  it("normalizes hostile target/comparison fields: junk legs and deltas dropped, directed negatives kept", async () => {
    stubJson({
      target: TARGET,
      comparison: {
        status: "gap",
        message: "  One gap remains.  ",
        distanceDeltaNm: -8.25,
        percentageDistanceDelta: "0x2",
        unavailable: ["MID", 5, null, "END"],
      },
    });

    const result = await validateDraft("KAAA", "KBBB", ["MID"], [{ sequence: 1, locationId: "loc-1" }], "baseline-1");
    expect(result.id).toBe("draft-1");
    expect(result.draft.via).toEqual(["MID"]);
    expect(result.draft.selections).toEqual([{ sequence: 1, locationId: "loc-1" }]);
    // Sequence fallbacks use the RAW source index (dropped junk entries keep
    // their positional slot), so leg-1 is index 1 and leg-2 is index 2.
    expect(result.route.legs).toEqual([
      { id: "leg-1", sequence: 2, from: "KAAA", to: "MID", distanceNm: 12.5 },
      { id: "leg-2", sequence: 3, from: "MID", to: "KBBB" },
    ]);
    expect(result.route.gaps).toEqual([{ sequence: 2, status: "gap", reason: "modeled distance unavailable" }]);
    expect(result.route.distanceNm).toBe(25.5);
    expect(result.route.provenance).toBe("draft-model");
    expect(result.comparison).toEqual({
      status: "gap",
      message: "One gap remains.",
      distanceDeltaNm: -8.25,
      unavailable: ["MID", "END"],
    });
  });

  it("defaults the comparison status and message when the server omits them", async () => {
    stubJson({ target: { id: "draft-2" }, comparison: {} });
    const result = await validateDraft("KAAA", "KBBB", [], [], "baseline-1");
    expect(result.comparison.status).toBe("gap");
    expect(result.comparison.message).toBe("Draft validation completed.");
    expect(result.route.origin).toBe("KAAA");
    expect(result.route.destination).toBe("KBBB");
  });
});

describe("lookupPoint envelope boundaries (D6)", () => {
  it("accepts the single-record data fallback and hostile matches arrays", async () => {
    stubJson({ data: { id: "loc-1", callsign: "SINGLE", coordinate: { lat: 1, lon: 2 } } });
    const single = await lookupPoint("SINGLE");
    expect(single.matches.map((match) => match.locationId)).toEqual(["loc-1"]);
    expect(single.truncated).toBe(false);

    stubJson({ matches: "junk", data: null });
    expect(await lookupPoint("X")).toEqual({ matches: [], truncated: false });
  });

  it("out-of-range point coordinates drop the whole match; exact extremes pass (D6 fix)", async () => {
    stubJson({
      matches: [
        { id: "loc-a", callsign: "INRANGE", coordinate: { lat: -90, lon: 180 } },
        { id: "loc-b", callsign: "FAR", coordinate: { lat: 0, lon: 999 } },
        { id: "loc-c", callsign: "NAN", coordinate: { lat: Number.NaN, lon: 0 } },
      ],
    });
    const result = await lookupPoint("Y");
    expect(result.matches.map((match) => match.locationId)).toEqual(["loc-a"]);
  });

  it("only a non-empty cursor marks the ambiguity page as truncated (D6 fix)", async () => {
    const match = { id: "loc-1", callsign: "A", coordinate: { lat: 1, lon: 1 } };
    stubJson({ matches: [match], nextCursor: "" });
    expect((await lookupPoint("A")).truncated).toBe(false);
    stubJson({ matches: [match], nextCursor: "   " });
    expect((await lookupPoint("A")).truncated).toBe(false);
    stubJson({ matches: [match], nextCursor: 99 });
    expect((await lookupPoint("A")).truncated).toBe(false);
    stubJson({ matches: [match], nextCursor: "more" });
    expect((await lookupPoint("A")).truncated).toBe(true);
  });
});

describe("searchCallsigns pagination termination and match fallbacks (D6)", () => {
  it("a blank nextCursor terminates pagination instead of re-requesting forever (D6 fix)", async () => {
    const { fetchMock } = stubJson({
      data: [{ id: "flight-1", callsign: "D6S", departure: "KAAA", destination: "KBBB" }],
      nextCursor: "",
    });
    const matches = await searchCallsigns("D6");
    expect(matches).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("drops identity-less matches, defaults unknown endpoints, and coerces junk point counts", async () => {
    stubJson({
      data: [
        { callsign: "NOID" },
        { flightId: "flight-2" },
        { id: "flight-3", code: "  D6X  ", routePointCount: "0x4" },
        { id: "flight-4", icao: "D6Y", departure: "   ", pointCount: 7 },
      ],
    });
    expect(await searchCallsigns("D6")).toEqual([
      { id: "flight-3", flightId: "flight-3", callsign: "D6X", departure: "Unknown departure", destination: "Unknown destination", routePointCount: 0 },
      { id: "flight-4", flightId: "flight-4", callsign: "D6Y", departure: "Unknown departure", destination: "Unknown destination", routePointCount: 7 },
    ]);
  });
});

describe("route option normalizer fallbacks under hostile fields (D6)", () => {
  const optionWith = (overrides: Record<string, unknown>) => ({ id: "route-1", ...overrides });

  it("string gaps, duplicate gaps, and gap legs merge into one sorted, deduplicated gap list", async () => {
    stubJson({
      options: [optionWith({
        legs: [
          { id: "leg-1", from: "A", to: "B" },
          { sequence: 2, status: "gap", reason: "no donor coverage" },
          { id: "leg-3", from: "C", to: "D" },
        ],
        gaps: [
          "tail record missing",
          { sequence: 2, reason: "no donor coverage" },
          { sequence: 2, reason: "no donor coverage" },
          { sequence: 1, code: "G1" },
          null,
        ],
      })],
      generation: GENERATION,
    });

    const { options } = await fetchRouteOptions("flight-1");
    // Dedupe is by (sequence, reason): the two identical sequence-2 gaps
    // collapse, but two sequence-1 gaps with different reasons both survive.
    // A gap record with neither reason nor message falls back to its own
    // code as the reason.
    expect(options[0]?.gaps).toEqual([
      { sequence: 1, status: "gap", reason: "tail record missing" },
      { sequence: 1, status: "gap", reason: "G1", code: "G1" },
      { sequence: 2, status: "gap", reason: "no donor coverage" },
    ]);
  });

  it("junk sequences fall back to positional order; huge finite sequences pass unchanged", async () => {
    stubJson({
      options: [optionWith({
        legs: [{ id: "leg-1", from: "A", to: "B", sequence: "0x1" }],
        gaps: [{ sequence: Number.MAX_SAFE_INTEGER, reason: "far future" }],
      })],
      generation: GENERATION,
    });
    const { options } = await fetchRouteOptions("flight-1");
    expect(options[0]?.legs[0]?.sequence).toBe(1);
    expect(options[0]?.gaps[0]?.sequence).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("blank strings earn fallbacks: callsign, label, provenance, freshness, safety", async () => {
    stubJson({
      options: [optionWith({ callsign: "   ", label: "", provenance: "  ", freshness: null, safety: 5 })],
      generation: GENERATION,
    });
    const { options } = await fetchRouteOptions("flight-1");
    expect(options[0]).toMatchObject({ callsign: "Unknown callsign", label: "Route option 1" });
    expect(options[0]?.provenance).toBeUndefined();
    expect(options[0]?.freshness).toBeUndefined();
    expect(options[0]?.safety).toBeUndefined();
  });

  it("a generation with any missing tier field is omitted rather than partially rendered", async () => {
    stubJson({ options: [optionWith({})], generation: { ...GENERATION, reference: { ...GENERATION.reference, staleUntil: " " } } });
    const result = await fetchRouteOptions("flight-1");
    expect(result.options).toHaveLength(1);
    expect(result.generation).toBeUndefined();
  });
});
