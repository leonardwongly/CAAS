// Owner: R2-D6 — fixture integrity (round-2 adversarial sweep 2026-08-23).
//
// The upstream CAAS fixtures (tests/fixtures/caas-fixtures.ts and
// tests/fixtures/sanitized-caas.ts) feed ~20 offline suites but were never
// checked against reality. This lane pins:
//   1. Fixture payloads survive REAL packages/contracts parsing: every record
//      identifier honors the reference grammar/bounds, every coordinate
//      parses through CoordinateSchema, routes respect MAX_ROUTE_ELEMENTS.
//   2. The fixture adapters conform BEHAVIORALLY to the real CaasAdapter
//      built by createCaasAdapter (method set, return-shape key sets against
//      real normalizer output, evidence arithmetic, index grouping, and the
//      deep-freeze immutability the real normalizers guarantee).
//   3. The deliberate semantic difference is pinned explicitly: fixture
//      adapters ignore AbortSignal (the race lanes depend on a
//      signal-ignoring upstream), whereas the live adapter rejects an
//      aborted signal with CANCELLED.
import assert from "node:assert/strict";
import test from "node:test";
import { CoordinateSchema, parseReference } from "../../packages/contracts/src/index.ts";
import { createCaasAdapter, FAMILY_POLICIES, MAX_ROUTE_ELEMENTS } from "../../packages/upstream-caas/src/index.ts";
import type { CaasAdapter, CaasTransport, FlightPlanRecord } from "../../packages/upstream-caas/src/index.ts";
import { caasFixtureAdapter, caasFixtureFlights } from "../fixtures/caas-fixtures.ts";
import { sanitizedAdapter, sanitizedFlights } from "../fixtures/sanitized-caas.ts";

function sortedKeys(value: object): string[] {
  return Object.keys(value).sort();
}

/** A deterministic transport that answers every family with a valid live-shaped payload. */
function fakeTransport(): CaasTransport {
  const bodies: Record<string, string> = {
    displayAll: JSON.stringify([{ id: "probe-flight-1", callsign: "PROBE01", departure: "PPAA", destination: "PPBB", routeElements: [{ seqNum: 0, identifier: "PROBEFIXA" }, { seqNum: 1, identifier: "PROBEFIXB" }] }]),
    airways: JSON.stringify(["PROBEAWY1", "PROBEAWY2"]),
    fixes: JSON.stringify(["PROBEFIXA (10,20)", "PROBEFIXB (11,21)"]),
    airports: JSON.stringify(["PPAA (1,2)", "PPBB (3,4)"]),
    navaids: JSON.stringify(["PROBENAV (5,6)"]),
  };
  return {
    async get(request) {
      const policy = FAMILY_POLICIES[request.family];
      return { status: 200, headers: { "content-type": `${policy.expectedMediaType}; charset=utf-8` }, body: bodies[request.family] ?? "[]" };
    },
  };
}

/** Builds the real adapter with a fake transport; credential is restored afterwards. */
function realAdapter(t: { after: (fn: () => void) => void }): CaasAdapter {
  const previous = process.env.apikey;
  process.env.apikey = "fixture-integrity-probe";
  t.after(() => {
    if (previous === undefined) delete process.env.apikey;
    else process.env.apikey = previous;
  });
  return createCaasAdapter({ transport: fakeTransport() });
}

test("fixture adapters expose exactly the real CaasAdapter method set", async (t) => {
  const real = realAdapter(t);
  for (const adapter of [caasFixtureAdapter(), sanitizedAdapter()]) {
    assert.deepEqual(sortedKeys(adapter), sortedKeys(real), "fixture adapter method set must equal the live adapter method set");
    for (const method of sortedKeys(real)) {
      assert.equal(typeof (adapter as unknown as Record<string, unknown>)[method], "function", `${method} must be a function`);
    }
  }
});

test("fixture return shapes mirror the real normalizer outputs key-for-key", async (t) => {
  const real = realAdapter(t);
  for (const adapter of [caasFixtureAdapter(), sanitizedAdapter()]) {
    const [realDisplay, fixtureDisplay] = [await real.displayAll(), await adapter.displayAll()];
    assert.deepEqual(sortedKeys(fixtureDisplay), sortedKeys(realDisplay), "displayAll result keys");
    assert.deepEqual(sortedKeys(fixtureDisplay.evidence), sortedKeys(realDisplay.evidence), "displayAll evidence keys");
    const [realRecord] = realDisplay.records;
    const [fixtureRecord] = fixtureDisplay.records;
    assert.ok(realRecord && fixtureRecord, "both adapters return at least one record");
    assert.deepEqual(sortedKeys(fixtureRecord!), sortedKeys(realRecord!), "flight record keys");
    const [realElement] = realRecord!.routeElements ?? [];
    const [fixtureElement] = fixtureRecord!.routeElements ?? [];
    assert.ok(realElement && fixtureElement, "both records carry route elements");
    // Fixture elements may omit coordinate-only variants the live data has,
    // but may never invent keys the live shape lacks.
    const realElementKeys = new Set(sortedKeys(realElement!));
    for (const key of sortedKeys(fixtureElement!)) assert.ok(realElementKeys.has(key), `route element key ${key} exists in the live shape`);

    const [realAirways, fixtureAirways] = [await real.airways(), await adapter.airways()];
    assert.deepEqual(sortedKeys(fixtureAirways), sortedKeys(realAirways), "airways evidence keys");

    for (const dataset of ["fixes", "airports", "navaids"] as const) {
      const [realReferences, fixtureReferences] = [await real[dataset](), await adapter[dataset]()];
      assert.deepEqual(sortedKeys(fixtureReferences), sortedKeys(realReferences), `${dataset} result keys`);
      assert.deepEqual(sortedKeys(fixtureReferences.evidence), sortedKeys(realReferences.evidence), `${dataset} evidence keys`);
      const realPoint = realReferences.points[0];
      const fixturePoint = fixtureReferences.points[0];
      if (realPoint && fixturePoint) assert.deepEqual(sortedKeys(fixturePoint), sortedKeys(realPoint), `${dataset} point keys`);
    }
  }
});

test("fixture flight records survive real contract parsing", () => {
  const flights: readonly FlightPlanRecord[] = [...caasFixtureFlights, ...sanitizedFlights];
  assert.ok(flights.length > 0, "fixtures carry flight records");
  for (const record of flights) {
    assert.ok(record.id.trim().length > 0, "every record has an id");
    assert.equal(record.callsign, record.callsign.toUpperCase(), `${record.id}: callsigns are uppercased like normalized live records`);
    for (const endpoint of [record.departure, record.destination]) {
      if (endpoint === null) continue;
      assert.doesNotThrow(() => parseReference(endpoint), `${record.id}: endpoint ${endpoint} honors the reference grammar`);
    }
    const elements = record.routeElements ?? [];
    assert.ok(elements.length <= MAX_ROUTE_ELEMENTS, `${record.id}: route fits the live element bound`);
    elements.forEach((element, index) => {
      assert.equal(element.sequence, index, `${record.id}: sequences are the contiguous 0-based array order the real normalizer renumbers to`);
      if (element.identifier !== undefined) {
        assert.doesNotThrow(() => parseReference(element.identifier), `${record.id}: element ${element.identifier} honors the reference grammar`);
      }
      if (element.coordinate !== undefined) {
        assert.doesNotThrow(() => CoordinateSchema.parse(element.coordinate), `${record.id}: element coordinate is bounded`);
      }
    });
  }
  const ids = flights.map((record) => record.id);
  assert.equal(new Set(ids).size, ids.length, "fixture flight ids are unique per fixture set");
});

test("fixture reference datasets survive real contract parsing with a faithful index", async () => {
  for (const adapter of [caasFixtureAdapter(), sanitizedAdapter()]) {
    for (const dataset of ["fixes", "airports", "navaids"] as const) {
      const result = await adapter[dataset]();
      assert.equal(result.dataset, dataset, "dataset label round-trips");
      assert.equal(result.evidence.family, dataset, "evidence family matches the dataset");
      assert.equal(result.evidence.records, result.evidence.acceptedRecords + result.evidence.rejectedRecords, "records = accepted + rejected");
      assert.equal(result.evidence.acceptedRecords, result.points.length, "accepted count equals the point count");
      assert.ok(result.evidence.bytes > 0, "evidence carries a positive byte count");
      assert.ok(result.points.length <= FAMILY_POLICIES[dataset].maxRecords, `${dataset} stays inside the live record bound`);
      for (const point of result.points) {
        assert.equal(point.dataset, dataset, "every point carries its dataset label");
        assert.doesNotThrow(() => parseReference(point.identifier), `${dataset}: identifier ${point.identifier} honors the reference grammar`);
        assert.doesNotThrow(() => CoordinateSchema.parse(point.coordinate), `${dataset}: coordinate for ${point.identifier} is bounded`);
      }
      // The index must group exactly the points sharing an identifier, in order.
      const rebuilt = new Map<string, number>();
      for (const point of result.points) rebuilt.set(point.identifier, (rebuilt.get(point.identifier) ?? 0) + 1);
      assert.deepEqual([...result.index.keys()].sort(), [...rebuilt.keys()].sort(), "index covers exactly the point identifiers");
      for (const [identifier, count] of rebuilt) {
        assert.equal(result.index.get(identifier)?.length, count, `${identifier}: index grouping matches the points`);
      }
      const flattened = [...result.index.values()].flat();
      assert.deepEqual(flattened, [...result.points], "index values preserve point order");
    }
  }
  // The duplicate-navaid scenario the sanitized fixture exists for.
  const duplicates = await sanitizedAdapter().navaids();
  assert.equal(duplicates.index.get("DUPX")?.length, 2, "duplicate identifiers stay grouped, not deduplicated");
});

test("fixture airways evidence honors the live evidence invariants", async () => {
  for (const adapter of [caasFixtureAdapter(), sanitizedAdapter()]) {
    const airways = await adapter.airways();
    assert.equal(airways.family, "airways");
    assert.equal(airways.records, airways.acceptedRecords + airways.rejectedRecords, "records = accepted + rejected");
    assert.ok(airways.uniqueRecords <= airways.acceptedRecords, "unique records never exceed accepted records");
    assert.ok(airways.bytes > 0, "evidence carries a positive byte count");
    assert.equal(typeof airways.retried, "boolean");
    assert.ok(airways.durationMs >= 0);
  }
});

test("fixture results are immutable exactly like the real normalizer output", async (t) => {
  const real = realAdapter(t);
  const realDisplay = await real.displayAll();
  assert.ok(Object.isFrozen(realDisplay) && Object.isFrozen(realDisplay.records) && Object.isFrozen(realDisplay.evidence), "baseline: live results are deep-frozen");
  for (const adapter of [caasFixtureAdapter(), sanitizedAdapter()]) {
    assert.ok(Object.isFrozen(adapter), "the adapter object itself is frozen like createCaasAdapter's return");
    const display = await adapter.displayAll();
    assert.ok(Object.isFrozen(display), "displayAll result frozen");
    assert.ok(Object.isFrozen(display.records), "records array frozen");
    assert.ok(Object.isFrozen(display.evidence), "evidence frozen");
    for (const record of display.records) {
      assert.ok(Object.isFrozen(record), "record frozen");
      if (record.routeElements) {
        assert.ok(Object.isFrozen(record.routeElements), "routeElements frozen");
        for (const element of record.routeElements) assert.ok(Object.isFrozen(element), "route element frozen");
      }
    }
    const airways = await adapter.airways();
    assert.ok(Object.isFrozen(airways), "airways evidence frozen");
    for (const dataset of ["fixes", "airports", "navaids"] as const) {
      const references = await adapter[dataset]();
      assert.ok(Object.isFrozen(references), `${dataset} result frozen`);
      assert.ok(Object.isFrozen(references.points), `${dataset} points frozen`);
      assert.ok(Object.isFrozen(references.evidence), `${dataset} evidence frozen`);
      for (const point of references.points) {
        assert.ok(Object.isFrozen(point), `${dataset} point frozen`);
        assert.ok(Object.isFrozen(point.coordinate), `${dataset} coordinate frozen`);
      }
      for (const matches of references.index.values()) assert.ok(Object.isFrozen(matches), `${dataset} index match list frozen`);
    }
  }
});

test("fixture adapters tolerate an AbortSignal argument without rejecting", async () => {
  // Deliberate, pinned divergence: the live adapter rejects a pre-aborted
  // signal with CaasAdapterError CANCELLED; the offline fixtures are
  // intentionally signal-ignoring sources (tests/adversarial/sec-r2-6.test.ts
  // builds its deadline races on exactly that behavior). They must accept the
  // same (signal?) arity and still resolve.
  const aborted = AbortSignal.abort();
  for (const adapter of [caasFixtureAdapter(), sanitizedAdapter()]) {
    await adapter.displayAll(aborted);
    await adapter.airways(aborted);
    await adapter.fixes(aborted);
    await adapter.airports(aborted);
    await adapter.navaids(aborted);
  }
});
