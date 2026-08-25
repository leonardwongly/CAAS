import assert from "node:assert/strict";
import test from "node:test";
import { directGreatCircleAlternate, greatCircleViaWaypoint, haversineDistanceNm } from "../src/index.ts";

test("direct great-circle alternate densifies endpoints and preserves exact endpoint coordinates", () => {
  const departure = { lat: 1.35, lon: 103.98 };
  const destination = { lat: -31.94, lon: 115.97 };
  const alternate = directGreatCircleAlternate(departure, destination, 16);
  assert.equal(alternate.segmentCount, 16);
  assert.equal(alternate.coordinates.length, 17);
  assert.deepEqual(alternate.coordinates[0], departure);
  assert.deepEqual(alternate.coordinates[alternate.coordinates.length - 1], destination);
  for (const point of alternate.coordinates) {
    assert.ok(Number.isFinite(point.lat) && Number.isFinite(point.lon));
    assert.ok(point.lat >= -90 && point.lat <= 90);
    assert.ok(point.lon >= -180 && point.lon <= 180);
  }
});

test("densified great-circle legs reconcile to the direct great-circle distance", () => {
  const a = { lat: 0, lon: 0 };
  const b = { lat: 0, lon: 90 };
  const alternate = directGreatCircleAlternate(a, b, 32);
  const direct = haversineDistanceNm(a, b);
  let chained = 0;
  for (let index = 1; index < alternate.coordinates.length; index += 1) {
    chained += haversineDistanceNm(alternate.coordinates[index - 1], alternate.coordinates[index]);
  }
  assert.ok(Math.abs(chained - direct) < 1e-6, `chained ${chained} vs direct ${direct}`);
});

test("via-waypoint alternate joins two great circles exactly at the waypoint", () => {
  const a = { lat: 0, lon: 0 };
  const waypoint = { lat: 0, lon: 30 };
  const b = { lat: 0, lon: 90 };
  const via = greatCircleViaWaypoint(a, waypoint, b);
  assert.deepEqual(via.coordinates[0], a);
  assert.deepEqual(via.coordinates[via.coordinates.length - 1], b);
  const waypointIndex = via.coordinates.findIndex((point) => point.lat === waypoint.lat && point.lon === waypoint.lon);
  assert.ok(waypointIndex > 0 && waypointIndex < via.coordinates.length - 1, "the waypoint must appear as an interior join");
  let chained = 0;
  for (let index = 1; index < via.coordinates.length; index += 1) {
    chained += haversineDistanceNm(via.coordinates[index - 1], via.coordinates[index]);
  }
  const expected = haversineDistanceNm(a, waypoint) + haversineDistanceNm(waypoint, b);
  assert.ok(Math.abs(chained - expected) < 1e-6, `chained ${chained} vs expected ${expected}`);
  assert.deepEqual(via.coordinates, [...directGreatCircleAlternate(a, waypoint).coordinates.slice(0, -1), ...directGreatCircleAlternate(waypoint, b).coordinates]);
});

test("via-waypoint with a co-located waypoint degenerates to the direct great circle", () => {
  const a = { lat: 0, lon: 0 };
  const b = { lat: 0, lon: 90 };
  const via = greatCircleViaWaypoint(a, a, b);
  assert.deepEqual(via.coordinates, directGreatCircleAlternate(a, b).coordinates);
});
