// Adversarial sweep — DOMAIN D4: upstream adapter & edge boundary.
// Owner: D4 — upstream adapter & edge boundary (parallel sweep).
// Scope: hostile payloads through the real parse/normalize boundary that the
// A7 sweep and normalizer-coercion do not pin — deep-nesting bombs,
// prototype-pollution keys at the normalizer layer, mixed-type route arrays,
// collection-wrapper depth bound, seqNum numeric edges, inclusive record/text
// length bounds, hostile unicode, and UTF-8 byte accounting in evidence.
//
// De-duped against: adv-upstream-hostile (A7: invalid JSON, hostile
// callsigns, coordinate extremes, contract-schema pollution, leakage),
// normalizer-coercion (boolean/hex/exponent seqNum, endpoint fallbacks),
// failure-surfacing (record-limit REJECTION at per-family bounds),
// packages/upstream-caas/test/adapter.test.ts (allow-list redaction).
import assert from "node:assert/strict";
import test from "node:test";
import { MAX_TEXT_LENGTH } from "../../packages/contracts/src/index.ts";
import {
  CaasAdapterError,
  MAX_ROUTE_ELEMENTS,
  normalizeAirways,
  normalizeDisplayAll,
  normalizeReferenceList,
  parseReferencePoint,
} from "../../packages/upstream-caas/src/index.ts";

function notPolluted(): void {
  assert.equal((Object.prototype as Record<string, unknown>)["pwned"], undefined, "Object.prototype must never be polluted");
  assert.equal((Object.prototype as Record<string, unknown>)["polluted"], undefined, "Object.prototype must never be polluted");
}

// ---------------------------------------------------------------------------
// 1. Deep-nesting bombs: the parse boundary is bounded, never unbounded.
// ---------------------------------------------------------------------------

test("a 50k-deep nesting bomb never escapes as an unclassified error", () => {
  const depth = 50_000;
  // The bomb replaces a flight's callsign: whatever JSON.parse decides to do
  // with the depth, the normalizer must surface a bounded outcome — an
  // evidenced rejection or an INVALID_JSON/INVALID_RECORD adapter error — and
  // NEVER a raw RangeError/stack overflow from the process.
  const bomb = `${"{\"a\":".repeat(depth)}1${"}".repeat(depth)}`;
  for (const body of [
    `[{"callsign":${bomb},"departure":"KOR1","destination":"KDS1"}]`,
    `[{"callsign":"OK","departure":"KOR1","destination":"KDS1","route":[{"coordinate":${bomb}}]}]`,
  ]) {
    try {
      const result = normalizeDisplayAll(body);
      // If the depth parsed, the bomb-shaped field must fail boundedText /
      // coordinate parsing and evidence the rejection — never leak through.
      for (const record of result.records) {
        assert.equal(typeof record.callsign, "string");
        assert.ok(record.callsign.length <= 32, "no bomb content may survive as a callsign");
      }
      assert.ok(result.evidence.rejectedRecords + result.evidence.acceptedRecords === result.evidence.records);
    } catch (error) {
      assert.ok(error instanceof CaasAdapterError, `the parse boundary must fail closed with an adapter error, got ${String(error)}`);
      assert.ok(error.code === "INVALID_JSON" || error.code === "INVALID_RECORD");
    }
  }
});

// ---------------------------------------------------------------------------
// 2. Prototype-pollution keys at the normalizer layer.
// ---------------------------------------------------------------------------

test("prototype-pollution keys never pollute prototypes and never surface in normalized output", () => {
  notPolluted();
  const hostile = JSON.stringify([
    JSON.parse('{"__proto__":{"pwned":true},"callsign":"BOMB1","departure":"KOR1","destination":"KDS1"}'),
    JSON.parse('{"constructor":{"prototype":{"polluted":true}},"callsign":"BOMB2","route":[{"__proto__":{"pwned":true},"identifier":"EVIL"}]}'),
    JSON.parse('{"prototype":{"pwned":true}}'),
  ]);
  const result = normalizeDisplayAll(hostile);
  notPolluted();
  // BOMB1/BOMB2 carry valid callsigns: they normalize, but ONLY canonical
  // fields may survive; the pollution payloads must not reach any output key.
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes("pwned"), "pollution content must never reach normalized output");
  assert.ok(!serialized.includes("polluted"));
  for (const record of result.records) {
    for (const key of Object.keys(record)) {
      assert.ok(["id", "callsign", "departure", "destination", "routeElements"].includes(key), `unexpected output key ${key}`);
    }
  }
  // The third record (pollution-only, no callsign) is evidenced as rejected.
  assert.equal(result.evidence.records, 3);
  assert.equal(result.evidence.rejectedRecords, 3 - result.records.length);
});

test("a polluted wrapper collection still resolves through the recognized keys without leaking", () => {
  notPolluted();
  const wrapped = JSON.parse('{"__proto__":{"pwned":true},"data":[{"callsign":"WRAPD","departure":"KOR1","destination":"KDS1"}]}');
  const result = normalizeDisplayAll(JSON.stringify(wrapped));
  notPolluted();
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0]?.callsign, "WRAPD");
});

// ---------------------------------------------------------------------------
// 3. Mixed-type route arrays: one invalid element rejects the whole record.
// ---------------------------------------------------------------------------

test("null/number/array route elements reject the record — element validity is all-or-nothing", () => {
  for (const bad of [null, 42, ["A", "B"], true]) {
    const result = normalizeDisplayAll(JSON.stringify([{ callsign: "MIXED", route: ["VALID", bad] }]));
    assert.equal(result.records.length, 0, `element ${JSON.stringify(bad)} must reject the record`);
    assert.equal(result.evidence.rejectedRecords, 1, "the rejection is evidenced, never silent");
  }
  // A homogeneous string array still normalizes with index-fallback sequences.
  const ok = normalizeDisplayAll(JSON.stringify([{ callsign: "STRROUTE", route: ["ALPHA", "BRAVO"] }]));
  assert.deepEqual(ok.records[0]?.routeElements?.map((element) => element.identifier), ["ALPHA", "BRAVO"]);
});

// ---------------------------------------------------------------------------
// 4. Collection-wrapper depth is bounded at two recognized levels.
// ---------------------------------------------------------------------------

test("collections resolve through exactly two wrapper levels — the third level fails closed", () => {
  const one = normalizeDisplayAll(JSON.stringify({ data: [{ callsign: "D1" }] }));
  assert.equal(one.records.length, 1);
  const two = normalizeDisplayAll(JSON.stringify({ data: { records: [{ callsign: "D2" }] } }));
  assert.equal(two.records.length, 1);
  assert.throws(() => normalizeDisplayAll(JSON.stringify({ data: { records: { items: [{ callsign: "D3" }] } } })), { code: "INVALID_RECORD" });
});

// ---------------------------------------------------------------------------
// 5. seqNum numeric edges: bound values, floats, and non-ASCII digits.
// ---------------------------------------------------------------------------

test("seqNum at MAX_ROUTE_ELEMENTS is honored; one over (and floats, safe-int overflow) fall back to the index", () => {
  const atBound = normalizeDisplayAll(JSON.stringify([
    { callsign: "SEQBOUND", route: [
      { seqNum: MAX_ROUTE_ELEMENTS, coordinate: { lat: 1, lon: 1 } },
      { coordinate: { lat: 2, lon: 2 } },
    ] },
  ]));
  assert.equal(atBound.records.length, 1, "seqNum == MAX_ROUTE_ELEMENTS is a legal asserted value");

  for (const seqNum of [MAX_ROUTE_ELEMENTS + 1, Number.MAX_SAFE_INTEGER, 2.5, -0.5]) {
    const result = normalizeDisplayAll(JSON.stringify([
      { callsign: "SEQFALL", route: [
        { seqNum, coordinate: { lat: 1, lon: 1 } },
        { coordinate: { lat: 2, lon: 2 } },
      ] },
    ]));
    assert.equal(result.records.length, 1, `seqNum ${seqNum} must fall back, never drop the flight`);
    assert.deepEqual(result.records[0]?.routeElements?.map((element) => element.sequence), [0, 1], "the array order stands in");
  }
});

test("signed, non-ASCII-digit, and fractional string seqNums are structural rejections; padded digits recover", () => {
  // Number("+5")=5 and Number("٠١")=1 would silently fabricate positions —
  // the same coercion ban that rejects "0x10"/"1e2" applies to these shapes.
  for (const seqNum of ["+5", "٠١", "0b10", "1.0"]) {
    const result = normalizeDisplayAll(JSON.stringify([{ callsign: "STRSEQ", route: [{ seqNum, coordinate: { lat: 1, lon: 1 } }] }]));
    assert.equal(result.records.length, 0, `seqNum ${JSON.stringify(seqNum)} must reject the record`);
    assert.equal(result.evidence.rejectedRecords, 1);
  }
  // Whitespace-padded digit strings are the one recoverable string shape.
  const padded = normalizeDisplayAll(JSON.stringify([{ callsign: "PADSEQ", route: [{ seqNum: " 7 ", coordinate: { lat: 1, lon: 1 } }] }]));
  assert.equal(padded.records.length, 1);
  assert.equal(padded.records[0]?.routeElements?.[0]?.sequence, 7);
});

// ---------------------------------------------------------------------------
// 6. Length bounds are inclusive at exactly the limit.
// ---------------------------------------------------------------------------

test("record counts at exactly the limit are accepted in every normalizer", () => {
  const flights = Array.from({ length: 5 }, (_unused, index) => ({ callsign: `L${index}` }));
  assert.equal(normalizeDisplayAll(JSON.stringify(flights), 5).records.length, 5);
  assert.throws(() => normalizeDisplayAll(JSON.stringify([...flights, { callsign: "L5" }]), 5), { code: "RECORD_LIMIT" });

  const points = ["P0 (0,0)", "P1 (1,1)"];
  assert.equal(normalizeReferenceList(JSON.stringify(points), "fixes", 2).points.length, 2);
  assert.throws(() => normalizeReferenceList(JSON.stringify([...points, "P2 (2,2)"]), "fixes", 2), { code: "RECORD_LIMIT" });
});

test("airway text at exactly MAX_TEXT_LENGTH is accepted; one character over is rejected", () => {
  const atLimit = "A".repeat(MAX_TEXT_LENGTH);
  const over = "A".repeat(MAX_TEXT_LENGTH + 1);
  const result = normalizeAirways(JSON.stringify([atLimit, over]));
  assert.equal(result.acceptedRecords, 1, "the inclusive bound admits exactly MAX_TEXT_LENGTH");
  assert.equal(result.rejectedRecords, 1, "one character over is evidenced as rejected");
});

test("reference identifiers are bounded at exactly MAX_REFERENCE_LENGTH by the line grammar", () => {
  assert.ok(parseReferencePoint(`${"A".repeat(32)} (1,2)`, "fixes"), "a 32-character identifier must parse");
  assert.equal(parseReferencePoint(`${"A".repeat(33)} (1,2)`, "fixes"), null, "a 33-character identifier must reject");
});

// ---------------------------------------------------------------------------
// 7. Hostile unicode and byte accounting.
// ---------------------------------------------------------------------------

test("zero-width-only callsigns reject; lone surrogates pass bounded without crashing", () => {
  const result = normalizeDisplayAll(JSON.stringify([
    { callsign: "\u200b\u200c\u200d" }, // invisible-formatting-only identifier
    { callsign: "OK\ud800SURR" }, // lone surrogate: bounded, never a crash
  ]));
  assert.equal(result.evidence.records, 2);
  assert.equal(result.evidence.rejectedRecords, 1, "the zero-width-only callsign must reject");
  assert.equal(result.records.length, 1, "the surrogate-bearing callsign stays bounded, never throws");
  assert.ok(result.records[0]?.callsign.startsWith("OK"));
});

test("evidence bytes are UTF-8 BYTES, not UTF-16 units — multibyte payloads are accounted honestly", () => {
  const body = JSON.stringify([{ callsign: "UNI\u00e9" }]); // é is 2 bytes in UTF-8
  const result = normalizeDisplayAll(body);
  assert.equal(result.evidence.bytes, new TextEncoder().encode(body).byteLength);
  assert.ok(result.evidence.bytes > body.length, "multibyte characters must count their full byte width");
});
