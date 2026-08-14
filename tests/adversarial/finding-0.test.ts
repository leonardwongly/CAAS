import assert from "node:assert/strict";
import test from "node:test";
import { normalizeDisplayAll } from "../../packages/upstream-caas/src/index.ts";

// Finding: normalizers.ts `Number(sequenceValue)` silently coerces seqNum.
// Design Section 10.4 requires each `seqNum` to be a non-negative safe
// integer and forbids broad coercion ("Do not enable broad coercion
// globally"). The codebase convention everywhere else (??, if (value))
// treats `null` as absent. So:
//  - null seqNum behaves like a missing field and falls back to the array
//    index (source order), never fabricating a sequence number;
//  - booleans and non-integer strings (e.g. "0x10", "1e2") are malformed
//    values and reject the element/record instead of silently rendering as
//    fabricated sequence numbers.

function body(records: unknown[]): string {
  return JSON.stringify(records);
}

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
