import assert from "node:assert/strict";
import test from "node:test";
import { createApiServer } from "../../apps/api/src/index.ts";
import { sanitizedAdapter } from "../fixtures/sanitized-caas.ts";

// Golden DTO surfaces captured from the pre-refactor server. Token-like values
// (keys id/flightId/routeId/nextCursor) are regenerated per process and
// generation timestamps move with the clock, so both are normalized before the
// byte-stability comparison; every other byte of the DTO surface is pinned.
const TOKEN_KEYS = new Set(["id", "flightId", "routeId", "nextCursor"]);
const TIMESTAMP_KEYS = new Set(["freshness", "retrievedAt", "freshUntil", "staleUntil"]);

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => normalize(item));
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (typeof entry === "string" && TOKEN_KEYS.has(key)) result[key] = "<token>";
      else if (typeof entry === "string" && TIMESTAMP_KEYS.has(key)) result[key] = "<timestamp>";
      else result[key] = normalize(entry);
    }
    return result;
  }
  return value;
}

const GOLDEN_OVERVIEW = JSON.parse(`{"data":[{"id":"<token>","flightId":"<token>","callsign":"FIXTURE1","status":"complete","label":"FIXTURE1 route","origin":"Name unavailable (KOR1)","destination":"Name unavailable (KDS1)","pointCount":3,"complete":true,"legs":[{"id":"<token>","sequence":0,"kind":"segment","status":"resolved","from":"Name unavailable (KOR1)","to":"MIDPT","distanceNm":861.9162052838809},{"id":"<token>","sequence":9007199254740991,"kind":"segment","status":"resolved","from":"MIDPT","to":"Name unavailable (KDS1)","distanceNm":1394.3296742569005}],"distanceNm":2256.2458795407815,"geometry":{"type":"LineString","coordinates":[[-73,40],[-90,35],[-118,33]]},"segments":[{"type":"LineString","coordinates":[[-73,40],[-90,35],[-118,33]]}],"provenance":"CAAS normalized live generation","freshness":"<timestamp>","safety":"Demonstration only. Operational weather, NOTAM, ATC, fuel, aircraft suitability, and regulatory constraints are not evaluated.","gaps":[]},{"id":"<token>","flightId":"<token>","callsign":"FIXTURE2","status":"complete","label":"FIXTURE2 route","origin":"Name unavailable (KOR1)","destination":"Name unavailable (KDS1)","pointCount":3,"complete":true,"legs":[{"id":"<token>","sequence":0,"kind":"segment","status":"resolved","from":"Name unavailable (KOR1)","to":"MIDPT","distanceNm":861.9162052838809},{"id":"<token>","sequence":9007199254740991,"kind":"segment","status":"resolved","from":"MIDPT","to":"Name unavailable (KDS1)","distanceNm":1394.3296742569005}],"distanceNm":2256.2458795407815,"geometry":{"type":"LineString","coordinates":[[-73,40],[-90,35],[-118,33]]},"segments":[{"type":"LineString","coordinates":[[-73,40],[-90,35],[-118,33]]}],"provenance":"CAAS normalized live generation","freshness":"<timestamp>","safety":"Demonstration only. Operational weather, NOTAM, ATC, fuel, aircraft suitability, and regulatory constraints are not evaluated.","gaps":[]}],"generation":{"id":"<token>","retrievedAt":"<timestamp>","live":{"state":"fresh","retrievedAt":"<timestamp>","freshUntil":"<timestamp>","staleUntil":"<timestamp>"},"reference":{"state":"fresh","retrievedAt":"<timestamp>","freshUntil":"<timestamp>","staleUntil":"<timestamp>"},"overall":"fresh"},"loaded":2,"total":2}`) as unknown;

const GOLDEN_OPTIONS = JSON.parse(`{"data":[{"id":"<token>","flightId":"<token>","callsign":"FIXTURE1","status":"complete","label":"FIXTURE1 route","origin":"Name unavailable (KOR1)","destination":"Name unavailable (KDS1)","pointCount":3,"complete":true,"legs":[{"id":"<token>","sequence":0,"kind":"segment","status":"resolved","from":"Name unavailable (KOR1)","to":"MIDPT","distanceNm":861.9162052838809},{"id":"<token>","sequence":9007199254740991,"kind":"segment","status":"resolved","from":"MIDPT","to":"Name unavailable (KDS1)","distanceNm":1394.3296742569005}],"distanceNm":2256.2458795407815,"geometry":{"type":"LineString","coordinates":[[-73,40],[-90,35],[-118,33]]},"segments":[{"type":"LineString","coordinates":[[-73,40],[-90,35],[-118,33]]}],"provenance":"CAAS normalized live generation","freshness":"<timestamp>","safety":"Demonstration only. Operational weather, NOTAM, ATC, fuel, aircraft suitability, and regulatory constraints are not evaluated.","gaps":[]}],"generation":{"id":"<token>","retrievedAt":"<timestamp>","live":{"state":"fresh","retrievedAt":"<timestamp>","freshUntil":"<timestamp>","staleUntil":"<timestamp>"},"reference":{"state":"fresh","retrievedAt":"<timestamp>","freshUntil":"<timestamp>","staleUntil":"<timestamp>"},"overall":"fresh"}}`) as unknown;

const GOLDEN_DETAIL = JSON.parse(`{"data":{"id":"<token>","flightId":"<token>","callsign":"FIXTURE1","status":"complete","label":"FIXTURE1 route","origin":"Name unavailable (KOR1)","destination":"Name unavailable (KDS1)","pointCount":3,"complete":true,"legs":[{"id":"<token>","sequence":0,"kind":"segment","status":"resolved","from":"Name unavailable (KOR1)","to":"MIDPT","distanceNm":861.9162052838809},{"id":"<token>","sequence":9007199254740991,"kind":"segment","status":"resolved","from":"MIDPT","to":"Name unavailable (KDS1)","distanceNm":1394.3296742569005}],"distanceNm":2256.2458795407815,"geometry":{"type":"LineString","coordinates":[[-73,40],[-90,35],[-118,33]]},"segments":[{"type":"LineString","coordinates":[[-73,40],[-90,35],[-118,33]]}],"provenance":"CAAS normalized live generation","freshness":"<timestamp>","safety":"Demonstration only. Operational weather, NOTAM, ATC, fuel, aircraft suitability, and regulatory constraints are not evaluated.","gaps":[]},"generation":{"id":"<token>","retrievedAt":"<timestamp>","live":{"state":"fresh","retrievedAt":"<timestamp>","freshUntil":"<timestamp>","staleUntil":"<timestamp>"},"reference":{"state":"fresh","retrievedAt":"<timestamp>","freshUntil":"<timestamp>","staleUntil":"<timestamp>"},"overall":"fresh"}}`) as unknown;

const GOLDEN_COMPARE = JSON.parse(`{"baseline":{"id":"<token>","flightId":"<token>","callsign":"FIXTURE1","status":"complete","label":"FIXTURE1 route","origin":"Name unavailable (KOR1)","destination":"Name unavailable (KDS1)","pointCount":3,"complete":true,"legs":[{"id":"<token>","sequence":0,"kind":"segment","status":"resolved","from":"Name unavailable (KOR1)","to":"MIDPT","distanceNm":861.9162052838809},{"id":"<token>","sequence":9007199254740991,"kind":"segment","status":"resolved","from":"MIDPT","to":"Name unavailable (KDS1)","distanceNm":1394.3296742569005}],"distanceNm":2256.2458795407815,"geometry":{"type":"LineString","coordinates":[[-73,40],[-90,35],[-118,33]]},"segments":[{"type":"LineString","coordinates":[[-73,40],[-90,35],[-118,33]]}],"provenance":"CAAS normalized live generation","freshness":"<timestamp>","safety":"Demonstration only. Operational weather, NOTAM, ATC, fuel, aircraft suitability, and regulatory constraints are not evaluated.","gaps":[]},"target":{"id":"<token>","origin":"Name unavailable (KOR1)","destination":"Name unavailable (KDS1)","legs":[{"id":"<token>","sequence":0,"kind":"segment","status":"resolved","from":"Name unavailable (KOR1)","to":"MIDPT","distanceNm":861.9162052838809},{"id":"<token>","sequence":1,"kind":"segment","status":"resolved","from":"MIDPT","to":"Name unavailable (KDS1)","distanceNm":1394.3296742569005}],"gaps":[],"distanceNm":2256.2458795407815,"geometry":{"type":"LineString","coordinates":[[-73,40],[-90,35],[-118,33]]},"provenance":"CAAS normalized live generation","freshness":"<timestamp>","safety":"Demonstration only. Operational weather, NOTAM, ATC, fuel, aircraft suitability, and regulatory constraints are not evaluated."},"comparison":{"status":"complete","message":"Directional modeled-distance difference from baseline to target. This is not an operational recommendation.","distanceDeltaNm":0,"percentageDistanceDelta":0,"addedWaypointCount":0,"removedWaypointCount":0,"waypointDifferences":[]},"generation":{"id":"<token>","retrievedAt":"<timestamp>","live":{"state":"fresh","retrievedAt":"<timestamp>","freshUntil":"<timestamp>","staleUntil":"<timestamp>"},"reference":{"state":"fresh","retrievedAt":"<timestamp>","freshUntil":"<timestamp>","staleUntil":"<timestamp>"},"overall":"fresh"}}`) as unknown;

test("source projection DTO surface is byte-stable across the synthesis refactor", async (t) => {
  const server = await createApiServer({ adapter: sanitizedAdapter() });
  t.after(() => server.app.close());

  const overview = await server.app.inject({ method: "POST", url: "/api/v1/routes/overview", payload: { limit: 25 } });
  assert.equal(overview.statusCode, 200);
  const firstFlightId = ((overview.json() as { data: Array<{ flightId: string }> }).data[0]!).flightId;
  const options = await server.app.inject({ method: "POST", url: "/api/v1/routes/options", payload: { flightId: firstFlightId } });
  assert.equal(options.statusCode, 200);
  const detail = await server.app.inject({ method: "POST", url: "/api/v1/routes/detail", payload: { routeId: firstFlightId } });
  assert.equal(detail.statusCode, 200);
  const compare = await server.app.inject({ method: "POST", url: "/api/v1/routes/compare", payload: { baselineId: firstFlightId, targetDraft: { origin: "KOR1", destination: "KDS1", via: ["MIDPT"] } } });
  assert.equal(compare.statusCode, 200);

  const overviewAgain = await server.app.inject({ method: "POST", url: "/api/v1/routes/overview", payload: { limit: 25 } });
  assert.deepEqual(normalize(overviewAgain.json()), normalize(overview.json()), "overview DTO surface is deterministic across calls");
  const overviewBody = overview.json() as { data: Array<Record<string, unknown>> };
  assert.equal(overviewBody.data.length, 2);
  for (const route of overviewBody.data) {
    assert.equal(route.complete, true);
    assert.equal(route.provenance, "CAAS normalized live generation");
    assert.deepEqual(route.gaps, []);
    assert.equal(typeof route.distanceNm, "number");
  }

  // Byte-stability fixture: normalized golden surfaces captured from the
  // pre-refactor server. Any DTO shape, ordering, labeling, or numeric drift
  // fails these comparisons.
  assert.deepEqual(normalize(overview.json()), GOLDEN_OVERVIEW, "overview DTO surface drifted from the golden fixture");
  assert.deepEqual(normalize(options.json()), GOLDEN_OPTIONS, "options DTO surface drifted from the golden fixture");
  assert.deepEqual(normalize(detail.json()), GOLDEN_DETAIL, "detail DTO surface drifted from the golden fixture");
  assert.deepEqual(normalize(compare.json()), GOLDEN_COMPARE, "compare DTO surface drifted from the golden fixture");
});
