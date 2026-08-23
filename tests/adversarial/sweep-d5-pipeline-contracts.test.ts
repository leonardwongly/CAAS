// Owner: D5 — contracts & evidence/policy pipeline (adversarial sweep 2026-08-23).
//
// Attacks the zod contract schemas in packages/contracts/src/index.ts:
//   1. Regression for the uppercase-expansion length escape: toUpperCase()
//      grows some inputs ("ß" -> "SS"), so values that exactly fit the
//      pre-transform max() used to emit identifiers longer than
//      MAX_REFERENCE_LENGTH / MAX_TEXT_LENGTH. Fixed by piping the normalized
//      output back through the same bound; these tests pin the rejection and
//      the boundary controls.
//   2. Remaining CoordinateInputSchema coercion grammar escapes beyond the
//      hex/octal/binary/exponent forms already pinned by deferred-1.test.ts:
//      leading plus, dangling decimal points, unicode digits/minus, overflow
//      strings, and non-coercible host types.
//   3. Prototype-pollution-shaped and extra/missing-field inputs: strict
//      schemas must reject unknown fields, never mutate Object.prototype, and
//      never leak injected keys into parsed output.
import assert from "node:assert/strict";
import test from "node:test";
import {
  CoordinateInputSchema,
  CoordinateSchema,
  LocationReferenceSchema,
  LocationSchema,
  MAX_REFERENCE_LENGTH,
  MAX_TEXT_LENGTH,
  RouteDraftSchema,
  RouteGapSchema,
  RouteOccurrenceSchema,
  RoutePointSchema,
  safeParseCoordinate,
} from "../../packages/contracts/src/index.ts";

test("identifiers that expand under toUpperCase are rejected, never emitted overlong", () => {
  // "ß".toUpperCase() === "SS": 32 input code units become 64, escaping the
  // declared 32-char reference bound. Pre-fix, all four parses succeeded.
  const expandingReference = "ß".repeat(MAX_REFERENCE_LENGTH);
  assert.equal(LocationReferenceSchema.safeParse({ value: expandingReference }).success, false, "reference value must not escape MAX_REFERENCE_LENGTH via uppercase expansion");
  assert.equal(
    RoutePointSchema.safeParse({ status: "point", sequence: 0, designatedIdentifier: expandingReference, coordinate: { lat: 0, lon: 0 } }).success,
    false,
    "route point identifiers must not escape MAX_REFERENCE_LENGTH via uppercase expansion",
  );
  assert.equal(
    LocationSchema.safeParse({ id: expandingReference, name: "name", kind: "place", coordinate: { lat: 0, lon: 0 } }).success,
    false,
    "location ids must not escape MAX_REFERENCE_LENGTH via uppercase expansion",
  );
  assert.equal(
    LocationSchema.safeParse({ id: "a", name: "name", kind: "place", coordinate: { lat: 0, lon: 0 }, aliases: ["ß".repeat(MAX_TEXT_LENGTH)] }).success,
    false,
    "location aliases must not escape MAX_TEXT_LENGTH via uppercase expansion",
  );
});

test("boundary controls: inputs whose uppercase form still fits remain accepted and uppercased", () => {
  // 16 code units of "ß" expand to exactly 32 — the inclusive boundary.
  const fitting = "ß".repeat(MAX_REFERENCE_LENGTH / 2);
  assert.deepEqual(LocationReferenceSchema.parse({ value: fitting }).value, "SS".repeat(MAX_REFERENCE_LENGTH / 2));
  assert.equal(LocationReferenceSchema.parse({ value: "a".repeat(MAX_REFERENCE_LENGTH) }).value, "A".repeat(MAX_REFERENCE_LENGTH));
  const location = LocationSchema.parse({ id: "kjfk", name: "John F. Kennedy", kind: "airport", coordinate: { lat: 40.6413, lon: -73.7781 }, aliases: [fitting] });
  assert.equal(location.id, "KJFK");
  assert.deepEqual(location.aliases, ["SS".repeat(MAX_REFERENCE_LENGTH / 2)]);
  // Names are not uppercased and keep the pre-transform bound.
  assert.equal(LocationSchema.parse({ id: "a", name: "n".repeat(MAX_TEXT_LENGTH), kind: "place", coordinate: { lat: 0, lon: 0 } }).name.length, MAX_TEXT_LENGTH);
});

test("coordinate string grammar rejects the remaining non-canonical decimal escapes", () => {
  // deferred-1.test.ts pins hex/octal/binary/exponent forms; these are the
  // other Number()-coercible or near-miss shapes that must never parse.
  for (const candidate of [
    { lat: "+5", lon: 0 },                    // leading plus
    { lat: 0, lon: "+5" },
    { lat: "5.", lon: 0 },                    // dangling decimal point
    { lat: ".5", lon: 0 },                    // leading decimal point
    { lat: "٥", lon: 0 },                     // Arabic-Indic digit (Number() accepts)
    { lat: "−5", lon: 0 },                    // unicode minus U+2212
    { lat: "1e309", lon: 0 },                 // overflow to Infinity once coerced
    { lat: "Infinity", lon: 0 },
    { lat: "NaN", lon: 0 },
    { lat: "5 5", lon: 0 },                   // interior whitespace
    { lat: "0 0", lon: "0" },
  ]) {
    const parsed = safeParseCoordinate(candidate);
    assert.equal(parsed.success, false, `${JSON.stringify(candidate)} must be rejected by the canonical decimal grammar`);
  }
  // Grammar-valid but out-of-range strings reject from the range bound,
  // proving the grammar and the bound are independent gates.
  const overflow = safeParseCoordinate({ lat: "9".repeat(24), lon: 0 });
  assert.equal(overflow.success, false);
});

test("coordinate coercion accepts canonical boundary values and documented alias forms", () => {
  assert.deepEqual(safeParseCoordinate({ lat: 90, lon: 180 }).data, { lat: 90, lon: 180 });
  assert.deepEqual(safeParseCoordinate({ lat: -90, lon: -180 }).data, { lat: -90, lon: -180 });
  assert.deepEqual(safeParseCoordinate({ lat: "-90", lon: "180" }).data, { lat: -90, lon: 180 });
  assert.deepEqual(safeParseCoordinate({ lat: -0, lon: 0 }).data, { lat: -0, lon: 0 });
  assert.deepEqual(safeParseCoordinate({ lat: 5e-324, lon: 0 }).data, { lat: 5e-324, lon: 0 });
  // Alias precedence and whitespace-trimmed canonical strings.
  assert.deepEqual(safeParseCoordinate({ latitude: "5", longitude: "6" }).data, { lat: 5, lon: 6 });
  assert.deepEqual(safeParseCoordinate({ lat: " 7 ", lng: " 8 " }).data, { lat: 7, lon: 8 });
  // GeoJSON positions may carry an altitude; the third element is ignored.
  assert.deepEqual(safeParseCoordinate(["10", "20", "3000"]).data, { lat: 20, lon: 10 });
});

test("non-coercible host types and partial coordinates never fabricate a position", () => {
  for (const candidate of [
    { lat: NaN, lon: 0 },
    { lat: Infinity, lon: 0 },
    { lat: 0, lon: -Infinity },
    { lat: true, lon: 0 },                    // Number(true) === 1
    { lat: false, lon: 0 },                   // Number(false) === 0
    { lat: null, lon: null },
    { lat: 5 },                               // missing lon
    { lon: 5 },                               // missing lat
    [],                                       // empty array
    [undefined, 5],
    [5],
    new Map([["lat", 5], ["lon", 6]]),
    new Date(),
    "51.47,-0.45",                            // no bare-string coordinate form
    51.47,
    { lat: { valueOf: () => 5 }, lon: 0 },    // object coercion never applies
    { lat: [5], lon: 0 },
  ]) {
    const parsed = safeParseCoordinate(candidate);
    assert.equal(parsed.success, false, `${String(candidate)} must be rejected`);
  }
});

test("prototype-pollution-shaped inputs parse without polluting or leaking injected keys", () => {
  const before = Object.keys(Object.prototype);
  // JSON.parse creates "__proto__" as an OWN property — the classic injection
  // shape. None of the schemas may copy it, apply it, or emit it.
  assert.equal(CoordinateInputSchema.safeParse(JSON.parse('{"lat":5,"lon":6,"__proto__":{"polluted":true}}')).success, true);
  assert.equal(LocationReferenceSchema.safeParse(JSON.parse('{"value":"KJFK","__proto__":{"polluted":true}}')).success, true);
  assert.equal(RouteDraftSchema.safeParse(JSON.parse('{"origin":"A","destination":"B","__proto__":{"polluted":true}}')).success, true);
  const location = LocationSchema.parse(JSON.parse('{"id":"a","name":"x","kind":"place","coordinate":{"lat":0,"lon":0},"__proto__":{"polluted":true}}'));
  assert.deepEqual(Object.keys(Object.prototype), before, "Object.prototype must never be mutated by schema parsing");
  assert.equal("polluted" in ({}), false);
  assert.equal("polluted" in location, false, "injected keys must never leak into parsed output");
  assert.deepEqual(Object.keys(location).sort(), ["aliases", "code", "coordinate", "id", "kind", "name"]);
});

test("strict schemas reject unknown and missing fields on coordinate and occurrence shapes", () => {
  assert.equal(CoordinateSchema.safeParse({ lat: 0, lon: 0, altitude: 100 }).success, false, "CoordinateSchema is strict");
  assert.equal(CoordinateInputSchema.safeParse({ lat: 0, lon: 0, extra: "dropped" }).success, true, "preprocess maps known aliases only");
  assert.deepEqual(CoordinateInputSchema.parse({ lat: 0, lon: 0, extra: "dropped" }), { lat: 0, lon: 0 }, "extra input fields never reach the output");
  const point = { status: "point", sequence: 0, designatedIdentifier: null, coordinate: { lat: 0, lon: 0 } };
  assert.equal(RouteOccurrenceSchema.safeParse({ ...point, surprise: true }).success, false, "occurrence shapes are strict");
  assert.equal(RouteGapSchema.safeParse({ status: "gap", sequence: 1, reference: null, reason: "missing", extra: 1 }).success, false);
  assert.equal(RouteGapSchema.safeParse({ status: "gap", sequence: 1, reference: null }).success, false, "missing reason rejects");
  assert.equal(RouteOccurrenceSchema.safeParse({ status: "POINT", sequence: 0, coordinate: { lat: 0, lon: 0 } }).success, false, "discriminator is exact-case");
  assert.equal(RoutePointSchema.safeParse({ status: "point", sequence: 2 ** 53, designatedIdentifier: null, coordinate: { lat: 0, lon: 0 } }).success, false, "unsafe-integer sequences reject");
});
