// Adversarial sweep — DOMAIN A7: upstream-caas adapter & offline source.
// Owner: A7 adversarial-testing sub-agent (parallel sweep).
// Scope: hostile/malformed/boundary data through the real parse boundary —
// normalizeDisplayAll/normalizeReferenceList/parseReferencePoint, the zod
// contracts schemas, adapter error privacy, and offline fixture integrity.
// Deliberately avoids duplicating tests/upstream-bounds/* (retry/backoff,
// transport policy, record-limit wiring), upstream-adapter-contract.test.ts,
// deferred-1/deferred-2, and sec-r4-0 seqNum coverage.
import assert from "node:assert/strict";
import test from "node:test";
import {
  CoordinateSchema,
  MAX_ROUTE_POINTS,
  RouteDraftSchema,
  safeParseCoordinate,
} from "../../packages/contracts/src/index.ts";
import {
  CaasAdapterError,
  FAMILY_POLICIES,
  createCaasAdapter,
  normalizeDisplayAll,
  normalizeReferenceList,
  parseReferencePoint,
  type CaasTransport,
  type CaasTransportRequest,
  type CaasTransportResponse,
} from "../../packages/upstream-caas/src/index.ts";
import { sanitizedAdapter, sanitizedFlights, sanitizedLocations } from "../fixtures/sanitized-caas.ts";
import { synthesisAdapter, synthesisFlights } from "../fixtures/synthesis-caas.ts";

const previousKey = process.env.apikey;
test.after(() => {
  if (previousKey === undefined) delete process.env.apikey;
  else process.env.apikey = previousKey;
});

function transportServing(body: string, contentType = "application/json", status = 200): CaasTransport {
  return { async get(_request: CaasTransportRequest): Promise<CaasTransportResponse> { return { status, headers: { "content-type": contentType }, body }; } };
}

function flightRecord(overrides: Record<string, unknown>): Record<string, unknown> {
  return { callsign: "FX1", departure: "KOR1", destination: "KDS1", ...overrides };
}

// ---------------------------------------------------------------------------
// 1. Parse-boundary hostility: non-JSON, non-collection, hostile field types.
// ---------------------------------------------------------------------------

test("non-JSON upstream bodies fail closed with INVALID_JSON and never echo the hostile payload", () => {
  const hostile = '{"aircraftIdentification":"SECRET-CALLSIGN-LEAK", broken';
  for (const body of [hostile, "not json at all", "\u0000\u0001binary-ish"]) {
    assert.throws(
      () => normalizeDisplayAll(body),
      (error: unknown) => {
        assert.ok(error instanceof CaasAdapterError, "error must be the bounded adapter error type");
        assert.equal(error.code, "INVALID_JSON");
        assert.ok(!error.message.includes("SECRET-CALLSIGN-LEAK"), "the hostile body must never leak into the error message");
        assert.ok(!error.message.includes(body), "raw body must never appear in the error message");
        return true;
      },
    );
  }
});

test("JSON that is not a bounded collection fails with INVALID_RECORD; canonical wrappers are honored", () => {
  for (const body of ["123", '"a string"', "null", "true", "{}", '{"data":42}', '{"data":{"records":{"items":[]}}}']) {
    assert.throws(() => normalizeDisplayAll(body), { code: "INVALID_RECORD" }, `body ${body} must be rejected`);
  }
  // A collection nested behind one recognized wrapper key still normalizes.
  const wrapped = normalizeDisplayAll(JSON.stringify({ flights: [flightRecord({})] }));
  assert.equal(wrapped.records.length, 1);
  assert.equal(wrapped.records[0]?.callsign, "FX1");
});

test("hostile callsign shapes reject the record and are counted, never coerced", () => {
  const hostileCallsigns: unknown[] = [42, true, null, [], { callsign: "NESTED" }, "WITH\u0000CONTROL", "X".repeat(33), "   ", "\u202eBIDI-TRICK"];
  const body = JSON.stringify(hostileCallsigns.map((callsign) => flightRecord({ callsign })));
  const result = normalizeDisplayAll(body);
  assert.equal(result.records.length, 0, "no hostile callsign may normalize");
  assert.equal(result.evidence.rejectedRecords, hostileCallsigns.length, "every rejection is evidenced, never silent");
});

test("a record with absent endpoints survives with null departure/destination", () => {
  const result = normalizeDisplayAll(JSON.stringify([{ callsign: "NOENDPOINTS" }]));
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0]?.departure, null);
  assert.equal(result.records[0]?.destination, null);
  assert.equal(result.evidence.rejectedRecords, 0);
});

test("duplicate flight ids are preserved (no silent dedupe, no crash)", () => {
  const result = normalizeDisplayAll(JSON.stringify([
    flightRecord({ id: "dup-id", callsign: "A1" }),
    flightRecord({ id: "dup-id", callsign: "B2" }),
  ]));
  assert.equal(result.records.length, 2, "the normalizer must not silently collapse duplicate ids");
  assert.deepEqual(result.records.map((record) => record.callsign), ["A1", "B2"]);
  assert.equal(result.evidence.acceptedRecords, 2);
});

test("empty and exactly-one-record upstream responses normalize cleanly", () => {
  const empty = normalizeDisplayAll("[]");
  assert.equal(empty.records.length, 0);
  assert.equal(empty.evidence.records, 0);
  assert.equal(empty.evidence.rejectedRecords, 0);

  const single = normalizeDisplayAll(JSON.stringify([flightRecord({})]));
  assert.equal(single.records.length, 1);
  assert.equal(single.evidence.acceptedRecords, 1);
});

// ---------------------------------------------------------------------------
// 2. Route-element count boundaries at MAX_ROUTE_ELEMENTS.
// ---------------------------------------------------------------------------

test("a route at exactly MAX_ROUTE_ELEMENTS survives; one element over rejects the record", () => {
  const maxElements = 254; // MAX_ROUTE_ELEMENTS = MAX_ROUTE_POINTS - 2
  const atLimit = normalizeDisplayAll(JSON.stringify([flightRecord({ routeElements: Array.from({ length: maxElements }, (_unused, index) => `W${index}`) })]));
  assert.equal(atLimit.records.length, 1, "exactly the element bound must be accepted");
  assert.equal(atLimit.records[0]?.routeElements?.length, maxElements);

  const over = normalizeDisplayAll(JSON.stringify([flightRecord({ routeElements: Array.from({ length: maxElements + 1 }, (_unused, index) => `W${index}`) })]));
  assert.equal(over.records.length, 0, "one element over the bound rejects the record");
  assert.equal(over.evidence.rejectedRecords, 1, "the over-bound record is evidenced");
});

test("a filedRoute whose routeElement is not an array rejects the record", () => {
  for (const routeElement of ["A B C", { nested: true }, 7, null]) {
    const result = normalizeDisplayAll(JSON.stringify([flightRecord({ filedRoute: { routeElement } })]));
    assert.equal(result.records.length, 0, `routeElement=${JSON.stringify(routeElement)} must reject`);
    assert.equal(result.evidence.rejectedRecords, 1);
  }
});

test("a route element carrying neither identifier nor coordinate rejects the record", () => {
  const result = normalizeDisplayAll(JSON.stringify([flightRecord({ routeElements: [{ unrelated: 1 }] })]));
  assert.equal(result.records.length, 0);
  assert.equal(result.evidence.rejectedRecords, 1);
});

// ---------------------------------------------------------------------------
// 3. Coordinate extremes through the real parse path.
// ---------------------------------------------------------------------------

test("coordinates at exactly ±90/±180 parse; one epsilon beyond fails closed", () => {
  for (const candidate of [{ lat: 90, lon: 180 }, { lat: -90, lon: -180 }, { lat: 90, lon: -180 }, { lat: -90, lon: 180 }]) {
    const parsed = safeParseCoordinate(candidate);
    assert.equal(parsed.success, true, `boundary coordinate ${JSON.stringify(candidate)} must parse`);
  }
  for (const candidate of [
    { lat: 90.0000001, lon: 0 },
    { lat: -90.0000001, lon: 0 },
    { lat: 0, lon: 180.0000001 },
    { lat: 0, lon: -180.0000001 },
    { lat: 91, lon: 0 },
    { lat: 0, lon: -181 },
  ]) {
    const parsed = safeParseCoordinate(candidate);
    assert.equal(parsed.success, false, `out-of-range coordinate ${JSON.stringify(candidate)} must reject`);
  }
});

test("string coordinates at the extremes parse; NaN/Infinity/hex spellings reject", () => {
  assert.deepEqual(safeParseCoordinate({ lat: "90", lon: "-180" }).data, { lat: 90, lon: -180 });
  // GeoJSON [lon, lat] array form at the boundary.
  assert.deepEqual(safeParseCoordinate(["180", "90"]).data, { lat: 90, lon: 180 });
  for (const candidate of [
    { lat: "NaN", lon: "0" },
    { lat: "Infinity", lon: "0" },
    { lat: "-Infinity", lon: "0" },
    { lat: "0x5A", lon: "0" },
    { lat: "1e1", lon: "0" },
    { lat: "", lon: "0" },
  ]) {
    assert.equal(safeParseCoordinate(candidate).success, false, `JSON-string smuggled value ${JSON.stringify(candidate)} must reject`);
  }
});

test("NaN/Infinity/Date/undefined/null never throw — they surface structured rejections", () => {
  for (const candidate of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, undefined, null, new Date(), 42n, Symbol("lat"), { lat: Number.NaN, lon: 0 }, { lat: 0, lon: Number.POSITIVE_INFINITY }]) {
    const parsed = safeParseCoordinate(candidate);
    assert.equal(parsed.success, false, `value of type ${typeof candidate} must reject structurally`);
    if (!parsed.success) assert.ok(Array.isArray(parsed.error.issues) && parsed.error.issues.length > 0, "the rejection must carry structured issues");
  }
});

test("reference-point strings hit the real coordinate bounds: (90,180) parses, just-beyond rejects", () => {
  assert.ok(parseReferencePoint("POLE (90,180)", "fixes"), "the extreme corner must parse");
  assert.ok(parseReferencePoint("ANTIPODE (-90,-180)", "fixes"));
  for (const line of ["TOOFAR (90.5,0)", "TOOFAR (0,-180.5)", "TOOFAR (91,180)", "TOOFAR (-90.0001,0)"]) {
    assert.equal(parseReferencePoint(line, "fixes"), null, `${line} must reject`);
  }
  // Rejections are counted in evidence, never silently dropped.
  const result = normalizeReferenceList(JSON.stringify(["GOOD (90,180)", "TOOFAR (90.5,0)"]), "fixes");
  assert.equal(result.points.length, 1);
  assert.equal(result.evidence.rejectedRecords, 1);
});

// ---------------------------------------------------------------------------
// 4. Type confusion / prototype-pollution shapes at the contracts schema.
// ---------------------------------------------------------------------------

test("prototype-pollution-shaped inputs reject structurally and never mutate Object.prototype", () => {
  const pollutedProbe = () => (Object.prototype as Record<string, unknown>)["pwned"];
  assert.equal(pollutedProbe(), undefined);
  const hostileCoordinate = JSON.parse('{"__proto__":{"pwned":true},"lat":1,"lon":1}');
  const parsedHostile = safeParseCoordinate(hostileCoordinate);
  assert.equal(parsedHostile.success, true, "the preprocess rebuilds {lat,lon}, dropping the hostile key");
  assert.deepEqual(parsedHostile.data, { lat: 1, lon: 1 }, "only canonical lat/lon may survive the parse");
  assert.equal("pwned" in (parsedHostile.data ?? {}), false, "the pollution payload must never reach parsed output");
  const hostileDraft = JSON.parse('{"__proto__":{"pwned":true}}');
  const draftParsed = RouteDraftSchema.safeParse(hostileDraft);
  // zod strips __proto__ from its key walk by design; whatever the verdict,
  // the hostile payload must never reach the output or the global prototype.
  if (draftParsed.success) {
    assert.ok(!JSON.stringify(draftParsed.data).includes("pwned"), "the pollution payload must never reach parsed output");
    assert.deepEqual(Object.keys(draftParsed.data).sort(), ["destination", "origin", "selections", "via"], "only canonical draft keys may survive");
  }
  // Genuine strictness: an ordinary unknown key still rejects.
  assert.equal(RouteDraftSchema.safeParse({ unknownField: true }).success, false, "the schema stays strict for non-__proto__ unknown keys");
  assert.equal(pollutedProbe(), undefined, "Object.prototype must never be polluted by schema parsing");
});

test("RouteDraftSchema rejects oversized/wrong-typed drafts structurally without throwing", () => {
  const oversizedVia = Array.from({ length: 300 }, (_unused, index) => `V${index}`);
  for (const draft of [
    { via: oversizedVia },
    { origin: 42, destination: "KDS1" },
    { via: "not-an-array" },
    { selections: [{ sequence: -1, locationId: "tok" }] },
    { selections: [{ sequence: 0, locationId: "" }] },
    { unknownField: true },
  ]) {
    const parsed = RouteDraftSchema.safeParse(draft);
    assert.equal(parsed.success, false, `draft ${JSON.stringify(draft).slice(0, 80)} must reject`);
  }
});

// ---------------------------------------------------------------------------
// 5. Failure surfacing: stable codes, bounded messages, no payload leakage.
// ---------------------------------------------------------------------------

test("a plain Error thrown by the transport is wrapped with a bounded message that never leaks its text", async () => {
  process.env.apikey = "offline-fixture-key";
  const transport: CaasTransport = { async get() { throw new Error("upstream internal detail SECRET-CALLSIGN-XYZ at https://internal.host/trace"); } };
  await assert.rejects(
    () => createCaasAdapter({ transport }).displayAll(),
    (error: unknown) => {
      assert.ok(error instanceof CaasAdapterError);
      assert.equal(error.code, "UPSTREAM_STATUS");
      assert.ok(!error.message.includes("SECRET-CALLSIGN-XYZ"), "the transport error text must never leak into the surfaced message");
      assert.ok(!error.message.includes("internal.host"));
      return true;
    },
  );
});

test("adapter-level failures carry stable codes and bounded messages with no hostile body content", async () => {
  process.env.apikey = "offline-fixture-key";
  const hostileCallsign = "LEAKME-999";
  const oversized = Array.from({ length: FAMILY_POLICIES.displayAll.maxRecords + 1 }, (_unused, index) => ({ callsign: `${hostileCallsign}${index}` }));

  const recordLimit = createCaasAdapter({ transport: transportServing(JSON.stringify(oversized)) });
  await assert.rejects(() => recordLimit.displayAll(), (error: unknown) => {
    assert.ok(error instanceof CaasAdapterError);
    assert.equal(error.code, "RECORD_LIMIT");
    assert.equal(error.family, "displayAll");
    assert.ok(!error.message.includes(hostileCallsign), "record-limit message must not leak upstream identifiers");
    return true;
  });

  const wrongMedia = createCaasAdapter({ transport: transportServing(JSON.stringify([{ callsign: hostileCallsign }]), "text/html") });
  await assert.rejects(() => wrongMedia.displayAll(), (error: unknown) => {
    assert.ok(error instanceof CaasAdapterError);
    assert.equal(error.code, "MEDIA_TYPE");
    assert.ok(!error.message.includes(hostileCallsign));
    return true;
  });

  const badJson = createCaasAdapter({ transport: transportServing(`{"broken": "${hostileCallsign}"`) });
  await assert.rejects(() => badJson.displayAll(), (error: unknown) => {
    assert.ok(error instanceof CaasAdapterError);
    assert.equal(error.code, "INVALID_JSON");
    assert.ok(!error.message.includes(hostileCallsign));
    return true;
  });
});

test("a non-string 200 body fails closed as POLICY_REJECTED", async () => {
  process.env.apikey = "offline-fixture-key";
  const transport = { async get() { return { status: 200, headers: { "content-type": "application/json" }, body: 12345 as unknown as string }; } };
  await assert.rejects(() => createCaasAdapter({ transport }).displayAll(), { code: "POLICY_REJECTED" });
});

// ---------------------------------------------------------------------------
// 6. Boundary counts at the full displayAll record bound.
// ---------------------------------------------------------------------------

test("exactly maxRecords displayAll records are accepted; the limit is inclusive", () => {
  const max = FAMILY_POLICIES.displayAll.maxRecords; // 10_000
  const records = Array.from({ length: max }, (_unused, index) => ({ callsign: `C${index}`, departure: "KOR1", destination: "KDS1" }));
  const result = normalizeDisplayAll(JSON.stringify(records));
  assert.equal(result.records.length, max, "a page exactly at the bound must fully normalize");
  assert.equal(result.evidence.acceptedRecords, max);
  assert.equal(result.evidence.rejectedRecords, 0);
});

// ---------------------------------------------------------------------------
// 7. Offline fixture integrity: counts stable, engine bounds honored.
// ---------------------------------------------------------------------------

test("offline fixtures are stable and every fixture route satisfies engine bounds", () => {
  // Generation counts are fixed: a drifting fixture would corrupt synthesis assumptions.
  assert.equal(sanitizedFlights.length, 2, "sanitized fixture flight count must be stable");
  assert.equal(synthesisFlights.length, 7, "synthesis fixture flight count must be stable");

  for (const flights of [sanitizedFlights, synthesisFlights]) {
    const ids = flights.map((flight) => flight.id);
    assert.equal(new Set(ids).size, ids.length, "fixture flight ids must be unique");
    const callsigns = flights.map((flight) => flight.callsign);
    assert.equal(new Set(callsigns).size, callsigns.length, "fixture callsigns must be unique");
    for (const flight of flights) {
      const elements = flight.routeElements ?? [];
      assert.ok(elements.length <= MAX_ROUTE_POINTS, `fixture route ${flight.id} must satisfy MAX_ROUTE_POINTS`);
      elements.forEach((element, index) => {
        assert.equal(element.sequence, index, `fixture ${flight.id} sequences must be contiguous from 0`);
        if (element.coordinate) {
          assert.equal(CoordinateSchema.safeParse(element.coordinate).success, true, `fixture ${flight.id} coordinate must be canonical`);
        }
      });
    }
  }

  // Every fixture reference coordinate is a valid canonical coordinate.
  for (const [identifier, lat, lon] of [...sanitizedLocations.fixes, ...sanitizedLocations.airports, ...sanitizedLocations.navaids]) {
    assert.equal(CoordinateSchema.safeParse({ lat, lon }).success, true, `fixture reference ${identifier} coordinate must be valid`);
  }
});

test("offline fixture adapters are deterministic across repeated calls", async () => {
  for (const make of [() => sanitizedAdapter(), () => synthesisAdapter()]) {
    const adapter = make();
    const first = await adapter.displayAll();
    const second = await adapter.displayAll();
    assert.equal(first.records.length, second.records.length, "fixture generation counts must not drift between calls");
    assert.deepEqual(first.records.map((record) => record.id), second.records.map((record) => record.id));
    const fixesA = await adapter.fixes();
    const fixesB = await adapter.fixes();
    assert.equal(fixesA.points.length, fixesB.points.length);
  }
});
