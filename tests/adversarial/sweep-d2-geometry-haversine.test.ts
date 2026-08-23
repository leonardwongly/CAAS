// Adversarial sweep D2 — geometry & resolution core (owner: D2 sub-agent).
// Scope: haversineDistanceNm singularities in packages/route-engine/src/index.ts —
// antipodal points at arbitrary latitudes, dateline wrap, monotonicity of the
// shortest-arc normalization, degenerate subnormal deltas, and the coordinate
// input grammar at the haversine boundary.
// Non-duplication: route-engine.test.ts pins (0,0)-(0,180) antipodal and the
// 179/-179 dateline arc; A3 pins seam identity, pole invariants, symmetry near
// antipodal, and NaN/out-of-range rejection. None of those sweep antipodal
// distance at arbitrary latitude, arc monotonicity, subnormal deltas, or the
// string-coordinate grammar at this boundary.
import assert from "node:assert/strict";
import test from "node:test";
import { haversineDistanceNm } from "../../packages/route-engine/src/index.ts";

const HALF_CIRCUMFERENCE_NM = Math.PI * 3440.065;
const QUARTER_CIRCUMFERENCE_NM = (Math.PI / 2) * 3440.065;

test("exact antipodal pairs measure half the great circle at every latitude", () => {
  // (lat, lon) vs (-lat, lon ± 180) is antipodal for every valid latitude;
  // the central angle must clamp to exactly pi despite floating-point noise
  // in the a-term at these singularities.
  for (const lat of [-75, -45.5, -15, 0, 15, 45.5, 75]) {
    for (const lon of [-140, -0.5, 0, 90.25]) {
      const wrapped = lon <= 0 ? lon + 180 : lon - 180;
      const distance = haversineDistanceNm({ lat, lon }, { lat: -lat, lon: wrapped });
      assert.ok(Math.abs(distance - HALF_CIRCUMFERENCE_NM) < 1e-6, `antipodal at lat=${lat} lon=${lon}: ${distance}`);
    }
  }
});

test("shortest-arc normalization is monotone in longitudinal separation up to 180 degrees", () => {
  let previous = -1;
  for (let separation = 0; separation <= 180; separation += 7.5) {
    const distance = haversineDistanceNm({ lat: 0, lon: 0 }, { lat: 0, lon: separation });
    assert.ok(distance >= previous, `distance must not shrink as separation grows to ${separation}`);
    previous = distance;
    // East and west separations of the same magnitude are the same arc.
    assert.ok(Math.abs(distance - haversineDistanceNm({ lat: 0, lon: 0 }, { lat: 0, lon: -separation })) < 1e-9);
  }
  // Exactly 180 degrees is the half-circumference maximum, not a wrapped zero.
  assert.ok(Math.abs(haversineDistanceNm({ lat: 0, lon: 0 }, { lat: 0, lon: 180 }) - HALF_CIRCUMFERENCE_NM) < 1e-6);
  assert.ok(Math.abs(haversineDistanceNm({ lat: 0, lon: 0 }, { lat: 0, lon: -180 }) - HALF_CIRCUMFERENCE_NM) < 1e-6);
});

test("dateline-spanning arcs equal their uncontested twins away from the seam", () => {
  // A one-degree arc centered on the antimeridian matches one centered on Greenwich.
  const seamArc = haversineDistanceNm({ lat: 12.5, lon: 179.5 }, { lat: 12.5, lon: -179.5 });
  const plainArc = haversineDistanceNm({ lat: 12.5, lon: -0.5 }, { lat: 12.5, lon: 0.5 });
  assert.ok(Math.abs(seamArc - plainArc) < 1e-9);
  // The 358-degree naive difference never wins: the result is the 2-degree arc.
  assert.ok(seamArc < haversineDistanceNm({ lat: 12.5, lon: 0 }, { lat: 12.5, lon: 3 }));
});

test("degenerate deltas: subnormal separations collapse to zero while tiny representable ones stay ordered", () => {
  // True subnormal degree deltas underflow in the radian conversion: the
  // result is exactly zero — never negative, never NaN.
  for (const delta of [Number.MIN_VALUE, 2 * Number.MIN_VALUE, 1e-320]) {
    const distance = haversineDistanceNm({ lat: 0, lon: 0 }, { lat: delta, lon: delta });
    assert.equal(distance, 0);
  }
  // Just above the underflow edge the distance must stay positive, finite,
  // and strictly ordered — tiny separations never snap to zero or invert.
  const tiny = [1e-15, 1e-12, 1e-9].map((delta) => haversineDistanceNm({ lat: 0, lon: 0 }, { lat: delta, lon: 0 }));
  for (const distance of tiny) assert.ok(Number.isFinite(distance) && distance > 0);
  assert.ok(tiny[0]! < tiny[1]! && tiny[1]! < tiny[2]!);
  // -0 and +0 describe identical points on both axes.
  assert.equal(haversineDistanceNm({ lat: -0, lon: -0 }, { lat: 0, lon: 0 }), 0);
  assert.equal(haversineDistanceNm({ lat: -90, lon: -0 }, { lat: -90, lon: 0 }), 0);
});

test("every corner of the coordinate box pairs finitely and symmetrically", () => {
  const corners = [
    { lat: 90, lon: 180 },
    { lat: 90, lon: -180 },
    { lat: -90, lon: 180 },
    { lat: -90, lon: -180 },
  ];
  for (const a of corners) {
    for (const b of corners) {
      const forward = haversineDistanceNm(a, b);
      const backward = haversineDistanceNm(b, a);
      assert.ok(Number.isFinite(forward) && forward >= 0);
      assert.ok(Math.abs(forward - backward) < 1e-9);
      // Both poles are single points regardless of longitude representation.
      if (Math.sign(a.lat) === Math.sign(b.lat)) assert.equal(forward, 0);
    }
  }
});

test("equator-to-pole arcs are quarter circles independent of both longitudes", () => {
  // A3 varies only the target longitude against axis poles; this pins the
  // full two-longitude freedom: any equator point to any pole representation.
  for (const [from, to] of [
    [{ lat: 0, lon: 137 }, { lat: 90, lon: -42 }],
    [{ lat: 0, lon: -179.9 }, { lat: -90, lon: 0.1 }],
    [{ lat: -0, lon: 180 }, { lat: 90, lon: 180 }],
  ] as const) {
    const distance = haversineDistanceNm(from, to);
    assert.ok(Math.abs(distance - QUARTER_CIRCUMFERENCE_NM) < 1e-6, `${JSON.stringify([from, to])}: ${distance}`);
  }
});

test("haversine accepts canonical decimal string coordinates and rejects every non-canonical grammar", () => {
  const numeric = haversineDistanceNm({ lat: 40.5, lon: -73.25 }, { lat: 51.5, lon: -0.125 });
  // Canonical decimals (including surrounding whitespace) coerce identically.
  assert.equal(haversineDistanceNm({ lat: "40.5", lon: "-73.25" }, { lat: " 51.5 ", lon: "-0.125" }), numeric);
  assert.equal(haversineDistanceNm(["-73.25", "40.5"], ["-0.125", "51.5"]), numeric);
  // Non-canonical numeric grammars that Number() would silently accept are
  // rejected at this boundary: no hex, octal, binary, exponent, or Infinity.
  for (const bad of ["0x1A", "0o11", "0b101", "1e1", "Infinity", "-Infinity", "NaN", ""]) {
    assert.throws(() => haversineDistanceNm({ lat: bad, lon: 0 }, { lat: 0, lon: 0 }));
    assert.throws(() => haversineDistanceNm({ lat: 0, lon: bad }, { lat: 0, lon: 0 }));
  }
  // In-range strings outside the coordinate box still fail the bounds pipe.
  assert.throws(() => haversineDistanceNm({ lat: "90.0000001", lon: "0" }, { lat: 0, lon: 0 }));
});
