import assert from "node:assert/strict";
import test from "node:test";
import { normalizeDisplayAll } from "../../packages/upstream-caas/src/index.ts";
import type { FlightPlanRecord } from "../../packages/upstream-caas/src/index.ts";

// Consolidated normalizer-coercion cluster. This file merges:
//  - tests/adversarial/finding-0.test.ts (seqNum coercion: null/boolean/hex
//    rejection),
//  - tests/adversarial/deferred-2.test.ts (coordinate/endpoint coercion:
//    invalid-nested falls back to valid legacy; valid-vs-valid conflict;
//    missing child key), and
//  - the two normalizeDisplayAll tests relocated out of
//    tests/adversarial/sec-r4-0.test.ts (invalid seqNum fallback, honored
//    asserted order, padded seqNum; flat locationId-only endpoints).
//
// Shared convention across all of these tests: never coerce. Invalid values
// reject the record or fall back to the valid legacy source — silently
// fixing nothing. Design Section 10.4 requires each `seqNum` to be a
// non-negative safe integer and forbids broad coercion ("Do not enable
// broad coercion globally"); the codebase convention (??, if (value)) treats
// `null` as absent everywhere. Likewise, a malformed nested endpoint value
// must never shadow a valid legacy sibling: the nested shape wins only when
// it yields a valid value, and conflicting valid sources reject rather than
// silently arbitrate.

function body(records: unknown[]): string {
  return JSON.stringify(records);
}

// --- seqNum coercion (from finding-0.test.ts) -----------------------------

test("null seqNum falls back to array-order sequence like a missing field", () => {
  const result = normalizeDisplayAll(body([{
    callsign: "NULLSEQ",
    route: [
      { seqNum: null, coordinate: { lat: 1, lon: 1 } },
      { seqNum: null, coordinate: { lat: 2, lon: 2 } },
    ],
  }]));
  assert.equal(result.records.length, 1);
  assert.equal(result.evidence.rejectedRecords, 0);
  assert.deepEqual(result.records[0]!.routeElements, [
    { sequence: 0, coordinate: { lat: 1, lon: 1 } },
    { sequence: 1, coordinate: { lat: 2, lon: 2 } },
  ]);
});

test("boolean seqNum is rejected, never rendered as 0 and 1", () => {
  const result = normalizeDisplayAll(body([{
    callsign: "BOOLSEQ",
    route: [
      { seqNum: false, coordinate: { lat: 1, lon: 1 } },
      { seqNum: true, coordinate: { lat: 2, lon: 2 } },
    ],
  }]));
  assert.equal(result.records.length, 0);
  assert.equal(result.evidence.rejectedRecords, 1);
});

test("non-integer string seqNum that Number() would coerce is rejected", () => {
  const result = normalizeDisplayAll(body([{
    callsign: "HEXSEQ",
    route: [{ seqNum: "0x10", coordinate: { lat: 1, lon: 1 } }],
  }, {
    callsign: "EXPSEQ",
    route: [{ seqNum: "1e2", coordinate: { lat: 2, lon: 2 } }],
  }]));
  assert.equal(result.records.length, 0);
  assert.equal(result.evidence.rejectedRecords, 2);
});

// --- endpoint coercion (from deferred-2.test.ts) --------------------------

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

test("a VALID nested aerodrome alone still normalizes; a conflicting legacy sibling rejects the record", () => {
  // Canonical-shape record: the nested aerodrome is the only source.
  const canonical = normalizeDisplayAll(body([{
    callsign: "VALIDNEST",
    departure: { departureAerodrome: { locationId: "kdep" } },
  }]));
  assert.equal(canonical.records.length, 1);
  assert.equal(canonical.records[0]!.departure, "KDEP");
  // Hybrid record with CONFLICTING sources (nested vs legacy disagree):
  // rejected with evidence — no arbitrary precedence may let junk in either
  // shape silently shadow a valid value in the other (round-4c).
  const hybrid = normalizeDisplayAll(body([{
    callsign: "HYBRID",
    departure: { departureAerodrome: { locationId: "kdep" } },
    departureAirport: "KDEN",
  }]));
  assert.equal(hybrid.records.length, 0, "conflicting endpoint sources reject the record");
  assert.equal(hybrid.evidence.rejectedRecords, 1, "the conflict is surfaced in evidence");
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

// --- seqNum fallback / asserted order / padded seqNum ---------------------
// (relocated from sec-r4-0.test.ts; bodies kept verbatim, including their
// own { flights: [...] } envelope and direct normalizers.ts import)

test("normalizers: flat endpoint objects carrying only locationId resolve, and one bad seqNum never drops a flight", async () => {
  const { normalizeDisplayAll } = await import("../../packages/upstream-caas/src/normalizers.ts");
  const body = JSON.stringify({
    flights: [
      {
        aircraftIdentification: "SQ321",
        departure: { locationId: "WSSS" },
        arrival: { locationId: "WMKK" },
        routeElements: [
          { seqNum: 0, identifier: "A" },
          { identifier: "B" }, // missing seqNum → index fallback collides with the next explicit value
          { seqNum: 1, identifier: "C" },
        ],
      },
    ],
  });
  const result = normalizeDisplayAll(body);
  assert.equal(result.records.length, 1, "the flight must survive its anomalous route metadata");
  const record = result.records[0] as FlightPlanRecord & { routeElements?: { sequence: number; identifier?: string }[] };
  assert.equal(record.departure, "WSSS", "locationId-only departure must resolve");
  assert.equal(record.destination, "WMKK", "locationId-only destination must resolve");
  assert.deepEqual(record.routeElements?.map((element) => element.sequence), [0, 1, 2], "array order renumbers the anomalous sequences");
});

test("normalizers: invalid seqNums fall back, asserted orders are honored, contradictions are rejected", async () => {
  const { normalizeDisplayAll } = await import("../../packages/upstream-caas/src/normalizers.ts");
  const wrap = (records: unknown) => normalizeDisplayAll(JSON.stringify({ flights: records }));

  // A negative, float, or over-range seqNum must not erase the flight: the
  // element falls back to its array index.
  const invalid = wrap([{ aircraftIdentification: "SQ1", departure: "WSSS", arrival: "WMKK", routeElements: [{ seqNum: -1, identifier: "A" }, { seqNum: 1.5, identifier: "B" }, { seqNum: 255, identifier: "C" }] }]);
  assert.equal(invalid.records.length, 1, "one invalid seqNum must not erase the whole flight");
  assert.deepEqual(invalid.records[0]!.routeElements?.map((element) => element.sequence), [0, 1, 2], "invalid seqNums fall back to array order");

  // Unique asserted seqNums that disagree with array order: the asserted
  // order is honored by sorting — never silently reversed.
  const reversed = wrap([{ aircraftIdentification: "SQ2", departure: "WSSS", arrival: "WMKK", routeElements: [{ seqNum: 1, identifier: "BBBB" }, { seqNum: 0, identifier: "AAAA" }] }]);
  assert.equal(reversed.records.length, 1);
  assert.deepEqual(reversed.records[0]!.routeElements?.map((element) => element.identifier), ["AAAA", "BBBB"], "asserted seqNum order is honored");

  // Contradictory explicit seqNums (duplicates) are rejected, never fabricated.
  const duplicate = wrap([{ aircraftIdentification: "SQ3", departure: "WSSS", arrival: "WMKK", routeElements: [{ seqNum: 0, identifier: "A" }, { seqNum: 0, identifier: "B" }] }]);
  assert.equal(duplicate.records.length, 0, "contradictory asserted sequences reject the record");

  // Contradictory endpoint sources are REJECTED, never arbitrated — in
  // either direction. No junk value silently shadows a valid one.
  const nestedJunk = wrap([{ aircraftIdentification: "SQ5", departureAirport: "KOR1", departure: { departureAerodrome: { locationId: "JUNK" } }, arrival: "WMKK", routeElements: [{ seqNum: 0, identifier: "A" }] }]);
  assert.equal(nestedJunk.records.length, 0, "junk nested child value conflicting with a valid legacy field rejects the record");
  assert.equal(nestedJunk.evidence.rejectedRecords, 1, "the conflict is surfaced in evidence");
  const legacyJunk = wrap([{ aircraftIdentification: "SQ6", departure: { locationId: "WSSS" }, departureAirport: "TBD", arrival: "WMKK", routeElements: [{ seqNum: 0, identifier: "A" }] }]);
  assert.equal(legacyJunk.records.length, 0, "junk legacy value conflicting with a valid nested parent rejects the record");
  const parentJunk = wrap([{ aircraftIdentification: "SQ4", departure: { locationId: "TBD" }, departureAirport: "KOR1", arrival: { locationId: "KDS1" } }]);
  assert.equal(parentJunk.records.length, 0, "junk parent-direct value conflicting with a valid legacy field rejects the record");

  // Whitespace-padded digit seqNums are recovered, not flight-erasing.
  const padded = wrap([{ aircraftIdentification: "SQ7", departure: "WSSS", arrival: "WMKK", routeElements: [{ seqNum: "3 ", identifier: "A" }, { seqNum: 0, identifier: "B" }] }]);
  assert.equal(padded.records.length, 1, "a whitespace-padded seqNum must fall back, never erase the flight");
});
