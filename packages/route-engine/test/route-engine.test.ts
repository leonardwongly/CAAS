import assert from "node:assert/strict";
import test from "node:test";
import {
  buildRouteQueryFromDraft,
  displayDistanceNm,
  fromGeoJsonPosition,
  haversineDistanceNm,
  resolveExactReference,
  resolveRouteQuery,
  toGeoJsonLineString,
  fromGeoJsonLineString,
  toLeafletRoute,
  fromLeafletRoute,
  toGeoJsonPosition,
  toLeafletCoordinate,
} from "../src/index.ts";

const jfk = { id: "KJFK", code: "JFK", name: "John F. Kennedy", kind: "airport", coordinate: { lat: 40.6413, lon: -73.7781 }, aliases: [] } as const;
const lhr = { id: "EGLL", code: "LHR", name: "Heathrow", kind: "airport", coordinate: { lat: 51.47, lon: -0.4543 }, aliases: [] } as const;
const duplicateOne = { ...jfk, id: "JFK-1", name: "John F. Kennedy" };
const duplicateTwo = { ...jfk, id: "JFK-2", name: "John F. Kennedy" };

test("Haversine uses nautical-mile earth radius and preserves full precision", () => {
  const distance = haversineDistanceNm(jfk.coordinate, lhr.coordinate);
  assert.ok(distance > 2_990 && distance < 3_000);
  assert.equal(haversineDistanceNm(jfk.coordinate, jfk.coordinate), 0);
  assert.equal(displayDistanceNm(distance), Math.round((distance + Number.EPSILON) * 10) / 10);
});

test("exact resolution distinguishes missing and ambiguous references", () => {
  assert.equal(resolveExactReference("LHR", [jfk, lhr]).status, "resolved");
  assert.deepEqual(resolveExactReference("missing", [jfk, lhr]), {
    status: "gap", reference: { value: "MISSING", kind: "unknown" }, reason: "not-found",
  });
  const ambiguous = resolveExactReference("John F. Kennedy", [duplicateOne, duplicateTwo]);
  assert.equal(ambiguous.status, "ambiguous");
  if (ambiguous.status === "ambiguous") assert.equal(ambiguous.matches.length, 2);
});

test("route query keeps endpoint gaps explicit", () => {
  const result = resolveRouteQuery({ origin: { value: "JFK" }, destination: { value: "NOPE" } }, [jfk, lhr]);
  assert.equal(result.status, "gap");
  assert.equal(result.origin.status, "resolved");
  assert.equal(result.destination.status, "gap");
});

test("GeoJSON is longitude-latitude while Leaflet is latitude-longitude", () => {
  assert.deepEqual(toGeoJsonPosition(jfk.coordinate), [-73.7781, 40.6413]);
  assert.deepEqual(fromGeoJsonPosition([-73.7781, 40.6413]), jfk.coordinate);
  assert.deepEqual(toLeafletCoordinate(jfk.coordinate), { lat: 40.6413, lng: -73.7781 });
});

test("route projections accept the full endpoint-inclusive 256-point bound", () => {
  const points = Array.from({ length: 256 }, (_, index) => ({ lat: -90 + (index * 180) / 255, lon: -180 + (index * 360) / 255 }));
  const geoJson = toGeoJsonLineString(points);
  assert.equal(geoJson.coordinates.length, 256);
  assert.deepEqual(fromGeoJsonLineString(geoJson), points);
  const leaflet = toLeafletRoute(points);
  assert.equal(leaflet.positions.length, 256);
  assert.deepEqual(fromLeafletRoute(leaflet), points);
  assert.throws(() => toGeoJsonLineString([...points, points[0]!]), RangeError);
  assert.throws(() => toLeafletRoute([...points, points[0]!]), RangeError);
});
test("draft helpers stay safe for incomplete user input", () => {
  const result = buildRouteQueryFromDraft({ origin: "JFK", destination: "" });
  assert.equal(result.ok, false);
  assert.equal(buildRouteQueryFromDraft({ origin: "JFK", destination: "LHR" }).ok, true);
});

test("normalizes antimeridian deltas and remains finite near antipodal points", () => {
  const antimeridian = haversineDistanceNm({ lat: 0, lon: 179 }, { lat: 0, lon: -179 });
  assert.ok(Math.abs(antimeridian - 120.080921) < 0.000001);

  const antipodal = haversineDistanceNm({ lat: 0, lon: 0 }, { lat: 0, lon: 180 });
  assert.ok(Number.isFinite(antipodal));
  assert.ok(Math.abs(antipodal - 10807.282932) < 0.000001);
});
