import assert from "node:assert/strict";
import test from "node:test";
import { safeParseCoordinate } from "../../packages/contracts/src/index.ts";
import { normalizeDisplayAll } from "../../packages/upstream-caas/src/index.ts";

// Candidate finding: CoordinateInputSchema (packages/contracts/src/index.ts:172-173) accepts
// string coordinates through `z.string().trim().min(1)` then `transform((value) => Number(value))`.
// JS Number() parses hex ("0x1A" -> 26), octal ("0o11" -> 9), binary ("0b101" -> 5), and exponent
// ("1e1" -> 10) forms, so non-decimal strings silently normalize to in-range coordinates instead
// of being rejected as malformed.
//
// North-star contract: design Section 0.3 and plan section 6 bound every reference coordinate to
// the `IDENTIFIER (latitude,longitude)` parser, whose grammar (normalizers.ts IDENTIFIER_PATTERN)
// is decimal-only: [+-]?(?:\d+(?:\.\d*)?|\.\d+). The codebase's own seqNum convention
// (normalizers.ts:148-161) states "booleans and non-canonical strings must never be coerced —
// Number(false)=0, Number("0x10")=16 would fabricate sequences" and requires /^\d+$/ before
// Number(). String coordinates are likewise allowed only in canonical decimal form; hex, octal,
// binary, and exponent strings are malformed and must reject (drop the record / increment
// rejectedRecords), never silently render as fabricated coordinates.

test("non-decimal numeric strings are rejected by safeParseCoordinate (decimal-only grammar)", () => {
  // Each value below is in-range once coerced (26, 11, 9, 5, 10), so rejection must come
  // from the grammar, not the range bound.
  for (const candidate of [
    { lat: "0x1A", lon: "0x0B" },
    { lat: "0o11", lon: 0 },
    { lat: "0b101", lon: 0 },
    { lat: "1e1", lon: 0 },
    { lat: 0, lon: "0x1A" },
    { lat: 0, lon: "1e1" },
  ]) {
    const parsed = safeParseCoordinate(candidate);
    assert.equal(parsed.success, false, `expected ${JSON.stringify(candidate)} to be rejected, got ${parsed.success ? JSON.stringify(parsed.data) : parsed.error}`);
  }
});

test("canonical decimal string coordinates remain accepted", () => {
  assert.deepEqual(safeParseCoordinate({ lat: "51.4700", lon: "-0.4543" }).data, { lat: 51.47, lon: -0.4543 });
  assert.deepEqual(safeParseCoordinate({ lat: "12.5", lon: "-3.25" }).data, { lat: 12.5, lon: -3.25 });
  assert.deepEqual(safeParseCoordinate(["-0.4543", "51.4700"]).data, { lat: 51.47, lon: -0.4543 });
});

test("a flight record carrying only a non-decimal string coordinate is rejected, never rendered", () => {
  const result = normalizeDisplayAll(JSON.stringify([{
    callsign: "HEXCOORD",
    route: [{ position: { coordinate: { lat: "0x1A", lon: "0x2A" } } }],
  }]));
  assert.equal(result.records.length, 0);
  assert.equal(result.evidence.rejectedRecords, 1);
});
