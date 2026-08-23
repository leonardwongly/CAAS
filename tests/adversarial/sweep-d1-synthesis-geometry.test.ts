// Adversarial sweep D1 — synthesis engine fail-closed: hostile geometry & coverage.
// Attacks coordinate edge cases (antimeridian crossings, poles, stationary
// zero-length legs), multi-corridor coverage honesty, and assembly at the
// maximum contract corridor count in packages/route-engine/src/synthesis.ts.
// Does not duplicate A1 (limits/boundary values), A2 (scale/exhaustion) or
// tests/synthesis/engine.test.ts (canonical fixtures).
import assert from "node:assert/strict";
import test from "node:test";
import { MAX_ROUTE_POINTS } from "../../packages/contracts/src/index.ts";
import { haversineDistanceNm } from "../../packages/route-engine/src/index.ts";
import {
  assembleSynthesisCandidates,
  buildSynthesisIndex,
  type ObservedRoute,
} from "../../packages/route-engine/src/synthesis.ts";

const pt = (ordinal: number, referenceId: string, lat: number, lon: number) =>
  ({ ordinal, referenceId, coordinate: { lat, lon }, label: referenceId });
const coordPt = (ordinal: number, lat: number, lon: number, label = `P${ordinal}`) =>
  ({ ordinal, referenceId: undefined, coordinate: { lat, lon }, label });
const gap = (ordinal: number) => ({ ordinal, gapReason: "not-found" });
const route = (flightKey: string, occurrences: ObservedRoute["occurrences"]): ObservedRoute => ({ flightKey, occurrences });

// ---------------------------------------------------------------------------
// Antimeridian: borrowed distance must use the shortest arc, never the
// long way around, and coordinates pass through exactly as recorded.
// ---------------------------------------------------------------------------
test("an antimeridian-crossing slice measures the short arc and reconciles", () => {
  const A = { lat: 0, lon: 179 };
  const B = { lat: 0, lon: -178 };
  const donor = route("d1-am-donor", [pt(0, "A", A.lat, A.lon), coordPt(1, 0, -179), pt(2, "B", B.lat, B.lon)]);
  const target = route("d1-am-target", [pt(0, "A", A.lat, A.lon), gap(1), pt(2, "B", B.lat, B.lon)]);
  const outcome = assembleSynthesisCandidates(buildSynthesisIndex([donor, target]), target);
  assert.equal(outcome.status, "full");
  const candidate = outcome.candidates[0]!;
  const segment = candidate.borrowedSegments[0]!;
  // 3 degrees of equatorial arc is ~180nm; the naive long way would exceed
  // 20,000nm. The shortest-arc rule is the only honest reading.
  assert.ok(segment.distanceNm > 100 && segment.distanceNm < 400, `short-arc distance expected, got ${segment.distanceNm}`);
  const expected = haversineDistanceNm(A, { lat: 0, lon: -179 }) + haversineDistanceNm({ lat: 0, lon: -179 }, B);
  assert.ok(Math.abs(segment.distanceNm - expected) <= 1e-9, "segment distance is the exact leg sum across the antimeridian");
  assert.equal(candidate.sourceResolvedDistanceNm, 0, "recorded points separated by a gap contribute no source distance");
  assert.ok(candidate.estimatedTotalDistanceNm !== undefined);
  assert.ok(Math.abs(candidate.estimatedTotalDistanceNm! - (candidate.sourceResolvedDistanceNm + candidate.borrowedDistanceNm)) <= 1e-9, "the total reconciles with source + borrowed");
  // Coordinates are never re-normalized: -179 stays -179, never 181.
  assert.deepEqual(segment.coordinates[1], { lat: 0, lon: -179 });
});

// ---------------------------------------------------------------------------
// Poles: extreme latitudes produce finite, sensible distances.
// ---------------------------------------------------------------------------
test("a slice crossing the pole stays finite and measures the polar path", () => {
  const N1 = { lat: 89, lon: 0 };
  const N2 = { lat: 89, lon: 180 };
  const donor = route("d1-pole-donor", [pt(0, "N1", N1.lat, N1.lon), coordPt(1, 90, 0), pt(2, "N2", N2.lat, N2.lon)]);
  const target = route("d1-pole-target", [pt(0, "N1", N1.lat, N1.lon), gap(1), pt(2, "N2", N2.lat, N2.lon)]);
  const outcome = assembleSynthesisCandidates(buildSynthesisIndex([donor, target]), target);
  assert.equal(outcome.status, "full");
  const candidate = outcome.candidates[0]!;
  for (const value of [candidate.sourceResolvedDistanceNm, candidate.borrowedDistanceNm, candidate.estimatedTotalDistanceNm!, candidate.borrowedSegments[0]!.distanceNm]) {
    assert.ok(Number.isFinite(value), `every distance stays finite at the pole, got ${value}`);
  }
  // 1 degree over the pole plus 1 degree back down: ~120nm, never 0 or NaN.
  assert.ok(candidate.borrowedDistanceNm > 100 && candidate.borrowedDistanceNm < 150, `polar path expected ~120nm, got ${candidate.borrowedDistanceNm}`);
});

// ---------------------------------------------------------------------------
// Stationary legs: repeated identical coordinates are preserved, never
// silently deduplicated, and contribute zero distance.
// ---------------------------------------------------------------------------
test("a stationary donor run keeps every recorded point and adds zero distance", () => {
  const D = { lat: 10, lon: 20 };
  const E = { lat: 10, lon: 40 };
  const X = { lat: 20, lon: 30 };
  const donor = route("d1-still-donor", [pt(0, "D", D.lat, D.lon), coordPt(1, X.lat, X.lon), coordPt(2, X.lat, X.lon), pt(3, "E", E.lat, E.lon)]);
  const target = route("d1-still-target", [pt(0, "D", D.lat, D.lon), gap(1), pt(2, "E", E.lat, E.lon)]);
  const outcome = assembleSynthesisCandidates(buildSynthesisIndex([donor, target]), target);
  assert.equal(outcome.status, "full");
  const segment = outcome.candidates[0]!.borrowedSegments[0]!;
  assert.equal(segment.coordinates.length, 4, "both stationary occurrences survive; the engine never dedupes geometry");
  assert.deepEqual(segment.coordinates, [D, X, X, E]);
  const expected = haversineDistanceNm(D, X) + haversineDistanceNm(X, E);
  assert.ok(Math.abs(segment.distanceNm - expected) <= 1e-9, "the zero-length leg contributes exactly zero");
});

// ---------------------------------------------------------------------------
// Coverage honesty: a product with ANY uncovered corridor emits nothing.
// ---------------------------------------------------------------------------
test("one uncovered corridor among covered ones fails closed: partial, zero candidates", () => {
  const D = { lat: 10, lon: 20 };
  const E = { lat: 10, lon: 40 };
  const F = { lat: 10, lon: 60 };
  const G = { lat: 10, lon: 80 };
  // Two distinct D->E geometries: the covered corridor has real choices.
  const donors = [
    route("d1-partial-d1", [pt(0, "D", D.lat, D.lon), coordPt(1, 20, 30), pt(2, "E", E.lat, E.lon)]),
    route("d1-partial-d2", [pt(0, "D", D.lat, D.lon), coordPt(1, 25, 30), pt(2, "E", E.lat, E.lon)]),
  ];
  const target = route("d1-partial-target", [
    pt(0, "D", D.lat, D.lon), gap(1), pt(2, "E", E.lat, E.lon),
    pt(3, "F", F.lat, F.lon), gap(4), pt(5, "G", G.lat, G.lon), // F->G has no donor
  ]);
  const outcome = assembleSynthesisCandidates(buildSynthesisIndex([...donors, target]), target);
  assert.equal(outcome.status, "partial", "a mix of covered and uncovered corridors never claims more than partial");
  assert.equal(outcome.corridorCount, 2);
  assert.equal(outcome.corridorsCovered, 1);
  assert.equal(outcome.candidates.length, 0, "no half-assembled candidate may escape: coverage is all-or-nothing per assembly");
});

// ---------------------------------------------------------------------------
// Maximum contract corridor density: 255 occurrences -> 127 corridors, each
// covered by exactly one donor. Assembly must stay linear and truthful.
// ---------------------------------------------------------------------------
test("127 corridors at the MAX_ROUTE_POINTS occurrence bound assemble linearly into one candidate", () => {
  const anchorCount = Math.floor((MAX_ROUTE_POINTS + 1) / 2); // 128 anchors, 127 gaps, 255 occurrences
  const anchor = (i: number) => ({ lat: 0, lon: i });
  const donors: ObservedRoute[] = [];
  let expectedBorrowed = 0;
  for (let corridor = 0; corridor + 1 < anchorCount; corridor += 1) {
    const mid = { lat: 0.5, lon: corridor + 0.5 };
    donors.push(route(`d1-many-${corridor}`, [
      pt(0, `A${corridor}`, anchor(corridor).lat, anchor(corridor).lon),
      coordPt(1, mid.lat, mid.lon),
      pt(2, `A${corridor + 1}`, anchor(corridor + 1).lat, anchor(corridor + 1).lon),
    ]));
    expectedBorrowed += haversineDistanceNm(anchor(corridor), mid) + haversineDistanceNm(mid, anchor(corridor + 1));
  }
  const occurrences: Array<ObservedRoute["occurrences"][number]> = [];
  for (let i = 0; i < anchorCount; i += 1) {
    if (i > 0) occurrences.push(gap(2 * i - 1));
    occurrences.push(pt(2 * i, `A${i}`, anchor(i).lat, anchor(i).lon));
  }
  const target = route("d1-many-target", occurrences);

  const startedAt = Date.now();
  const outcome = assembleSynthesisCandidates(buildSynthesisIndex([...donors, target]), target);
  const elapsedMs = Date.now() - startedAt;
  assert.ok(elapsedMs < 3_000, `127-corridor assembly must stay linear, took ${elapsedMs}ms`);
  assert.equal(outcome.status, "full", "every corridor covered by a single geometry is complete coverage");
  assert.equal(outcome.corridorCount, anchorCount - 1);
  assert.equal(outcome.corridorsCovered, anchorCount - 1);
  assert.equal(outcome.candidates.length, 1, "one choice per corridor multiplies to exactly one product candidate");
  const candidate = outcome.candidates[0]!;
  assert.equal(candidate.borrowedSegments.length, anchorCount - 1, "one borrowed segment per corridor");
  assert.equal(candidate.donorCount, anchorCount - 1, "every corridor donor is distinct and aggregated");
  assert.equal(new Set(candidate.donorFlightKeys).size, candidate.donorCount);
  assert.equal(candidate.donorTruncated, false);
  assert.ok(candidate.estimatedTotalDistanceNm !== undefined);
  assert.ok(Math.abs(candidate.borrowedDistanceNm - expectedBorrowed) <= 1e-6, "the borrowed total is the exact 127-corridor leg sum");
  assert.ok(Math.abs(candidate.estimatedTotalDistanceNm! - expectedBorrowed) <= 1e-6, "zero source distance plus borrowed equals the estimate");
  assert.equal(candidate.geometrySignature.split("#").length, anchorCount - 1, "the signature carries one part per corridor");
});
