// Adversarial sweep: DOMAIN A3 — route-engine geometry, bounds, validation
// (degenerate and boundary inputs). Owner: adv-engine-geometry sub-agent.
// Scope: packages/route-engine/src/index.ts + compare.ts.
// Non-duplication: existing coverage in packages/route-engine/test/* (256-point
// to* bounds, JFK/LHR haversine, antimeridian/antipodal, display rounding at
// 0.05/10.05, compareDistanceOperands undefined/zero-baseline) is not repeated.
import assert from "node:assert/strict";
import test from "node:test";
import { MAX_ROUTE_POINTS } from "../../packages/contracts/src/index.ts";
import {
  compareDistanceOperands,
  displayDistanceNm,
  fromGeoJsonLineString,
  fromGeoJsonPosition,
  fromLeafletRoute,
  haversineDistanceNm,
  normalizeRouteDraft,
  safeParseRouteCandidate,
  safeParseRouteQuery,
  sumDistanceNm,
  toGeoJsonLineString,
  toLeafletRoute,
} from "../../packages/route-engine/src/index.ts";

const EARTH_RADIUS_NM = 3440.065;
const HALF_CIRCUMFERENCE_NM = Math.PI * EARTH_RADIUS_NM;

test("haversine treats lon -180 and 180 as the same meridian, consistently", () => {
  // Antimeridian seam: the two extreme representations of one meridian are identical points.
  assert.equal(haversineDistanceNm({ lat: 0, lon: -180 }, { lat: 0, lon: 180 }), 0);
  assert.equal(haversineDistanceNm({ lat: -45.5, lon: -180 }, { lat: -45.5, lon: 180 }), 0);
  // A one-degree arc straddling the seam is the same length whichever side carries the extreme.
  const leftSeam = haversineDistanceNm({ lat: 0, lon: -179 }, { lat: 0, lon: 180 });
  const rightSeam = haversineDistanceNm({ lat: 0, lon: 179 }, { lat: 0, lon: -180 });
  assert.ok(Math.abs(leftSeam - rightSeam) < 1e-9);
  // And equals the uncontested one-degree arc away from the seam.
  const plainDegree = haversineDistanceNm({ lat: 0, lon: 10 }, { lat: 0, lon: 11 });
  assert.ok(Math.abs(leftSeam - plainDegree) < 1e-9);
});

test("haversine at exact extremes: poles, full-range coordinates, sanity invariants", () => {
  // Pole-to-pole is exactly half the great circle at this radius.
  const poleToPole = haversineDistanceNm({ lat: 90, lon: 0 }, { lat: -90, lon: 0 });
  assert.ok(Math.abs(poleToPole - HALF_CIRCUMFERENCE_NM) < 1e-6);
  // From a pole the distance depends only on the target latitude, never on either longitude.
  const a = haversineDistanceNm({ lat: 90, lon: 0 }, { lat: 0, lon: 123 });
  const b = haversineDistanceNm({ lat: 90, lon: 180 }, { lat: 0, lon: -45 });
  assert.ok(Math.abs(a - b) < 1e-9);
  assert.ok(Math.abs(a - HALF_CIRCUMFERENCE_NM / 2) < 1e-6);
  // Distances are never negative and stay finite arbitrarily close to antipodal.
  for (const [from, to] of [
    [{ lat: 0, lon: 0 }, { lat: 0, lon: 179.9999999 }],
    [{ lat: 89.9999, lon: 0 }, { lat: -89.9999, lon: 180 }],
    [{ lat: -90, lon: -180 }, { lat: 90, lon: 180 }],
  ] as const) {
    const forward = haversineDistanceNm(from, to);
    const backward = haversineDistanceNm(to, from);
    assert.ok(Number.isFinite(forward) && forward >= 0);
    assert.ok(Math.abs(forward - backward) < 1e-6, "symmetry at extremes");
  }
  // Out-of-range coordinates are rejected at the schema boundary, not computed.
  assert.throws(() => haversineDistanceNm({ lat: 90.0000001, lon: 0 }, { lat: 0, lon: 0 }));
  assert.throws(() => haversineDistanceNm({ lat: 0, lon: -180.0000001 }, { lat: 0, lon: 0 }));
  assert.throws(() => haversineDistanceNm({ lat: Number.NaN, lon: 0 }, { lat: 0, lon: 0 }));
});

test("display rounding helper fails closed on unreachable-for-routes numeric inputs", () => {
  assert.equal(displayDistanceNm(0), 0);
  assert.ok(Number.isFinite(displayDistanceNm(1e9)));
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -0.0000001, -1]) {
    assert.throws(() => displayDistanceNm(bad), RangeError);
  }
});

test("sumDistanceNm accepts an empty leg set and rejects non-finite or negative legs", () => {
  assert.equal(sumDistanceNm([]), 0);
  assert.equal(sumDistanceNm([1, 2.5]), 3.5);
  for (const bad of [[Number.NaN], [Number.POSITIVE_INFINITY], [-1], [1, -0.0000001]]) {
    assert.throws(() => sumDistanceNm(bad), RangeError);
  }
});

test("route projection bounds: from* accept exactly MAX_ROUTE_POINTS, reject MAX+1, empty, single", () => {
  const positions = Array.from({ length: MAX_ROUTE_POINTS }, (_, index) => [index - 128, (index * 180) / (MAX_ROUTE_POINTS - 1) - 90] as [number, number]);
  assert.equal(fromGeoJsonLineString({ type: "LineString", coordinates: positions }).length, MAX_ROUTE_POINTS);
  const leafletPositions = positions.map(([lon, lat]) => ({ lat, lng: lon }));
  assert.equal(fromLeafletRoute({ type: "polyline", positions: leafletPositions }).length, MAX_ROUTE_POINTS);
  for (const badLine of [
    { type: "LineString", coordinates: [...positions, [0, 0]] },
    { type: "LineString", coordinates: positions.slice(0, 1) },
    { type: "LineString", coordinates: [] },
    { type: "Point", coordinates: positions },
    null,
    "LineString",
  ]) {
    assert.throws(() => fromGeoJsonLineString(badLine), TypeError);
  }
  for (const badRoute of [
    { type: "polyline", positions: [...leafletPositions, { lat: 0, lng: 0 }] },
    { type: "polyline", positions: leafletPositions.slice(0, 1) },
    { type: "polyline", positions: [] },
    undefined,
  ]) {
    assert.throws(() => fromLeafletRoute(badRoute), TypeError);
  }
  // to* reject the empty and single-point ends (MAX+1 already covered upstream).
  assert.throws(() => toGeoJsonLineString([]), RangeError);
  assert.throws(() => toGeoJsonLineString([{ lat: 0, lon: 0 }]), RangeError);
  assert.throws(() => toLeafletRoute([]), RangeError);
  assert.throws(() => toLeafletRoute([{ lat: 0, lon: 0 }]), RangeError);
});

test("projections accept coordinates at the exact extremes and never mutate inputs", () => {
  const extremes = [{ lat: 90, lon: 180 }, { lat: -90, lon: -180 }];
  const snapshot = JSON.stringify(extremes);
  const geoJson = toGeoJsonLineString(extremes);
  const leaflet = toLeafletRoute(extremes);
  assert.deepEqual(geoJson.coordinates, [[180, 90], [-180, -90]]);
  assert.deepEqual(leaflet.positions, [{ lat: 90, lng: 180 }, { lat: -90, lng: -180 }]);
  assert.equal(JSON.stringify(extremes), snapshot);
  // Exact boundary values round-trip without drift in both conventions.
  assert.deepEqual(fromGeoJsonPosition([180, 90]), { lat: 90, lon: 180 });
  assert.deepEqual(fromGeoJsonPosition([-180, -90]), { lat: -90, lon: -180 });
});

test("comparison operands: non-finite or negative distances are INCOMPLETE, zero baseline is complete", () => {
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -5]) {
    assert.deepEqual(compareDistanceOperands(bad, 10), { status: "incomplete", unavailable: ["INCOMPLETE_OPERAND"] });
    assert.deepEqual(compareDistanceOperands(10, bad), { status: "incomplete", unavailable: ["INCOMPLETE_OPERAND"] });
  }
  const zeroBaseline = compareDistanceOperands(0, 7);
  assert.equal(zeroBaseline.status, "complete");
  assert.equal(zeroBaseline.distanceDeltaNm, 7);
  assert.equal(zeroBaseline.percentageDistanceDelta, undefined);
  assert.deepEqual(zeroBaseline.unavailable, ["ZERO_BASELINE"]);
  const equal = compareDistanceOperands(42.5, 42.5);
  assert.equal(equal.distanceDeltaNm, 0);
  assert.equal(equal.percentageDistanceDelta, 0);
  assert.deepEqual(equal.unavailable, []);
  const reversed = compareDistanceOperands(200, 100);
  assert.equal(reversed.distanceDeltaNm, -100);
  assert.equal(reversed.percentageDistanceDelta, -50);
});

test("safe-parse validation boundaries fail closed with structured issues, never thrown errors", () => {
  const badCandidate = safeParseRouteCandidate({ id: "x", origin: { value: "A" }, destination: { value: "B" }, legs: [], distanceNm: -1 });
  assert.equal(badCandidate.ok, false);
  assert.ok(Array.isArray(badCandidate.issues) && badCandidate.issues.length >= 2);
  for (const issue of badCandidate.issues!) {
    assert.ok(typeof issue.code === "string" && Array.isArray(issue.path) && typeof issue.message === "string");
  }
  assert.ok(badCandidate.issues!.some((issue) => issue.path.join(".") === "legs"));
  assert.equal(safeParseRouteCandidate(null).ok, false);
  assert.equal(safeParseRouteQuery(null).ok, false);
  assert.equal(safeParseRouteQuery({ origin: { value: "" }, destination: { value: "B" } }).ok, false);
  const badDraft = normalizeRouteDraft({ origin: 5 });
  assert.equal(badDraft.ok, false);
  assert.deepEqual(badDraft.issues!.map((issue) => issue.path), [["origin"]]);
});

// Regression: malformed individual positions must surface as the function's
// own TypeError — matching the outer shape check — never as a raw zod
// ZodError escaping to callers that catch TypeError to fail closed.
// (Found by adversarial sweep A3.)
test("from* route projections throw their own TypeError for malformed positions, not ZodError", () => {
  // GeoJSON position carrying a third (altitude) element.
  assert.throws(
    () => fromGeoJsonLineString({ type: "LineString", coordinates: [[0, 0], [1, 1, 500]] }),
    TypeError,
  );
  // Out-of-range coordinate inside an otherwise valid-shaped line.
  assert.throws(
    () => fromGeoJsonLineString({ type: "LineString", coordinates: [[0, 0], [200, 0]] }),
    TypeError,
  );
  assert.throws(
    () => fromLeafletRoute({ type: "polyline", positions: [{ lat: 0, lng: 0 }, { lat: 95, lng: 1 }] }),
    TypeError,
  );
});
