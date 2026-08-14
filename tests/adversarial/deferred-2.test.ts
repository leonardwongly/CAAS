import assert from "node:assert/strict";
import test from "node:test";
import { normalizeDisplayAll } from "../../packages/upstream-caas/src/index.ts";

// Finding: normalizers.ts `endpointValue` (line 99) returns
// `liveAerodromeValue(parent[childKey])` immediately whenever the nested
// departure/arrival shape is present — even when that nested value is
// invalid (null, non-string, over-length). A valid legacy sibling field
// (e.g. `departureAirport`) is then silently dropped, no rejection is
// counted, and the endpoint is absent from the normalized record.
//
// North-star contract basis: the codebase's own first-valid-wins convention
// (firstBoundedText/firstReferenceValue/firstCoordinateValue skip invalid
// values and continue; `normalizeRouteElement` falls back to legacy keys
// when the nested `position.designatedPoint` yields no identifier) and the
// documented null-as-absent convention ("Null follows the null-as-absent
// convention", seqNum fix). A malformed nested value must not shadow a valid
// sibling: the nested shape wins only when it yields a valid value.

function body(records: unknown[]): string {
  return JSON.stringify(records);
}

test("nested departureAerodrome null falls back to valid departureAirport legacy key", () => {
  const result = normalizeDisplayAll(body([{
    callsign: "NULLNEST",
    departure: { departureAerodrome: null },
    departureAirport: "KDEN",
  }]));
  assert.equal(result.records.length, 1);
  assert.equal(result.evidence.rejectedRecords, 0);
  assert.equal(result.records[0]!.departure, "KDEN");
});

test("nested departureAerodrome non-string falls back to valid departureAirport legacy key", () => {
  const result = normalizeDisplayAll(body([{
    callsign: "NUMSHAPE",
    departure: { departureAerodrome: 123 },
    departureAirport: "KDEN",
  }]));
  assert.equal(result.records.length, 1);
  assert.equal(result.evidence.rejectedRecords, 0);
  assert.equal(result.records[0]!.departure, "KDEN");
});

test("nested departureAerodrome over-length falls back to valid departureAirport legacy key", () => {
  const result = normalizeDisplayAll(body([{
    callsign: "LONGSHAPE",
    departure: { departureAerodrome: "X".repeat(40) },
    departureAirport: "KDEN",
  }]));
  assert.equal(result.records.length, 1);
  assert.equal(result.evidence.rejectedRecords, 0);
  assert.equal(result.records[0]!.departure, "KDEN");
});

test("nested destinationAerodrome invalid falls back to valid destinationAirport legacy key", () => {
  const result = normalizeDisplayAll(body([{
    callsign: "DESTNULL",
    arrival: { destinationAerodrome: null },
    destinationAirport: "KLAX",
  }]));
  assert.equal(result.records.length, 1);
  assert.equal(result.evidence.rejectedRecords, 0);
  assert.equal(result.records[0]!.destination, "KLAX");
});

test("a VALID nested aerodrome still wins over the legacy sibling (no over-correction)", () => {
  const result = normalizeDisplayAll(body([{
    callsign: "VALIDNEST",
    departure: { departureAerodrome: { locationId: "kdep" } },
    departureAirport: "KDEN",
  }]));
  assert.equal(result.records.length, 1);
  assert.equal(result.evidence.rejectedRecords, 0);
  assert.equal(result.records[0]!.departure, "KDEP");
});

test("nested parent without the child key already falls through to the legacy chain", () => {
  const result = normalizeDisplayAll(body([{
    callsign: "NOCHILD",
    departure: { unknownField: 1 },
    departureAirport: "KDEN",
  }]));
  assert.equal(result.records.length, 1);
  assert.equal(result.evidence.rejectedRecords, 0);
  assert.equal(result.records[0]!.departure, "KDEN");
});
