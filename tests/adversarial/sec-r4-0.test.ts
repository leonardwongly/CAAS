import assert from "node:assert/strict";
import test from "node:test";
import { createApiServer } from "../../apps/api/src/index.ts";
import type { CaasAdapter, FlightPlanRecord, ReferenceDatasetResult } from "../../packages/upstream-caas/src/index.ts";
import { sanitizedAdapter } from "../fixtures/sanitized-caas.ts";

// Security sweep round-4 regressions (server-side):
// - POST /api/v1/drafts validates referential integrity at store time: a 201
//   draft must never be a draft every consumer rejects.
// - Ambiguity pagination cursors bind the kind filter: a cursor minted under
//   one kind must not offset into a differently-filtered result set.
// - Draft tokens carry a bounded TTL and expired drafts are reclaimed: slot
//   exhaustion can never block draft creation for a full generation lifetime.
// - A superseded (earlier-started) refresh whose acquisition completes after
//   the newer attempt aborted/failed installs its snapshot when the store
//   would otherwise stay cold/failed.
// - Unauthenticated refresh floods are bounded by a minimum interval.
// - Opaque ("null") Origin requests fail the cross-origin defense closed.

test("POST /api/v1/drafts rejects selections no consumer could ever use", async () => {
  const server = await createApiServer({ adapter: sanitizedAdapter() });
  try {
    const base = { origin: "KOR1", destination: "KDS1" };
    const outOfRange = await server.app.inject({ method: "POST", url: "/api/v1/drafts", payload: { ...base, via: ["MIDPT"], selections: [{ sequence: 5, locationId: "AAAA" }] } });
    assert.equal(outOfRange.statusCode, 400, "a selection beyond the via list must be rejected at store time");
    assert.equal((outOfRange.json() as { error: { code: string } }).error.code, "INVALID_DRAFT");

    const duplicate = await server.app.inject({ method: "POST", url: "/api/v1/drafts", payload: { ...base, via: ["MIDPT"], selections: [{ sequence: 0, locationId: "AAAA" }, { sequence: 0, locationId: "BBBB" }] } });
    assert.equal(duplicate.statusCode, 400, "two selections for one waypoint must be rejected at store time");

    const junk = await server.app.inject({ method: "POST", url: "/api/v1/drafts", payload: { ...base, via: ["MIDPT"], selections: [{ sequence: 0, locationId: "AAAA" }] } });
    assert.equal(junk.statusCode, 400, "a forged selection token must be rejected at store time");
    assert.equal((junk.json() as { error: { code: string } }).error.code, "TOKEN_INVALID");

    // Endpoint resolvability is part of the same invariant: a 201 draft with
    // unresolvable endpoints would be rejected by every consumer.
    const unknownAirport = await server.app.inject({ method: "POST", url: "/api/v1/drafts", payload: { origin: "KOR1", destination: "XXXNOPE", via: [] } });
    assert.equal(unknownAirport.statusCode, 404, "an unresolvable destination must be rejected at store time");
    assert.equal((unknownAirport.json() as { error: { code: string } }).error.code, "AIRPORT_NOT_FOUND");
  } finally {
    await server.app.close();
  }
});

test("POST /api/v1/drafts stores only drafts the compare routes can consume", async () => {
  const server = await createApiServer({ adapter: sanitizedAdapter() });
  try {
    // A service-issued selection token for the unique fix MIDPT.
    const lookup = await server.app.inject({ method: "GET", url: "/api/v1/points/MIDPT" });
    assert.equal(lookup.statusCode, 200);
    const match = (lookup.json() as { data: { id: string } }).data;
    const stored = await server.app.inject({
      method: "POST",
      url: "/api/v1/drafts",
      payload: { origin: "KOR1", destination: "KDS1", via: ["MIDPT"], selections: [{ sequence: 0, locationId: match.id }] },
    });
    assert.equal(stored.statusCode, 201, "a referentially valid draft must store");
    const draftId = (stored.json() as { id: string }).id;
    const compared = await server.app.inject({ method: "POST", url: "/api/v1/drafts/compare", payload: { draftId } });
    assert.equal(compared.statusCode, 200, "every stored draft must be consumable by the compare route");
  } finally {
    await server.app.close();
  }
});

test("an ambiguity cursor minted under one kind cannot offset a differently-filtered page", async () => {
  // 30 airports + 30 navaids share the token AB: page 1 (kind=unknown) pages
  // 50 of 60; page 2 must be kind=unknown, never a re-filtered kind=airport.
  const airportPoints = Array.from({ length: 30 }, (_, i) => ({ dataset: "airports" as const, identifier: "AB", coordinate: { lat: 10 + i * 0.01, lon: 100 + i * 0.01 } }));
  const navaidPoints = Array.from({ length: 30 }, (_, i) => ({ dataset: "navaids" as const, identifier: "AB", coordinate: { lat: 20 + i * 0.01, lon: 110 + i * 0.01 } }));
  const index = <T extends { identifier: string }>(points: readonly T[]): Map<string, T[]> => {
    const map = new Map<string, T[]>();
    for (const point of points) map.set(point.identifier, [...(map.get(point.identifier) ?? []), point]);
    return map;
  };
  const evidence = { family: "airports" as const, bytes: 128, records: 30, acceptedRecords: 30, rejectedRecords: 0, retried: false, durationMs: 0 };
  const adapter: CaasAdapter = {
    ...sanitizedAdapter(),
    airports: async (): Promise<ReferenceDatasetResult> => ({ dataset: "airports", points: airportPoints, index: index(airportPoints), evidence }),
    navaids: async (): Promise<ReferenceDatasetResult> => ({ dataset: "navaids", points: navaidPoints, index: index(navaidPoints), evidence: { ...evidence, family: "navaids" } }),
  };
  const server = await createApiServer({ adapter });
  try {
    const page1 = await server.app.inject({ method: "POST", url: "/api/v1/points/lookup", payload: { reference: "AB" } });
    assert.equal(page1.statusCode, 200);
    const first = page1.json() as { status: string; matches: unknown[]; nextCursor: string };
    assert.equal(first.matches.length, 50, "page 1 returns a full ambiguity page");
    assert.ok(first.nextCursor, "page 1 mints a next cursor");

    const wrongKind = await server.app.inject({ method: "POST", url: "/api/v1/points/lookup", payload: { reference: "AB", kind: "airport", cursor: first.nextCursor } });
    assert.equal(wrongKind.statusCode, 409, "a cursor minted under kind=unknown must never offset a kind=airport page");
    assert.equal((wrongKind.json() as { error: { code: string } }).error.code, "CURSOR_EXPIRED");

    const sameKind = await server.app.inject({ method: "POST", url: "/api/v1/points/lookup", payload: { reference: "AB", cursor: first.nextCursor } });
    assert.equal(sameKind.statusCode, 200, "the cursor still works for its own kind");
    const second = sameKind.json() as { matches: unknown[] };
    assert.equal(second.matches.length, 10, "page 2 returns the remaining 10 matches");
  } finally {
    await server.app.close();
  }
});

test("expired draft tokens are reclaimed: capacity cannot be exhausted for a generation lifetime", async () => {
  const clock = { t: 1_000_000 };
  const server = await createApiServer({ adapter: sanitizedAdapter(), now: () => clock.t });
  try {
    const stored = await server.app.inject({ method: "POST", url: "/api/v1/drafts", payload: { origin: "KOR1", destination: "KDS1", via: [] } });
    assert.equal(stored.statusCode, 201);
    const draftId = (stored.json() as { id: string }).id;

    // Past the 15-minute draft TTL but well inside the 30-minute live
    // freshness window: the slot must be reclaimed and the old id dead.
    clock.t += 16 * 60 * 1000;
    const expired = await server.app.inject({ method: "POST", url: "/api/v1/drafts/compare", payload: { draftId } });
    assert.equal(expired.statusCode, 410, "the expired draft must no longer resolve");
    const after = await server.app.inject({ method: "POST", url: "/api/v1/drafts", payload: { origin: "KOR1", destination: "KDS1", via: [] } });
    assert.equal(after.statusCode, 201, "a new draft must succeed after the expired one is reclaimed");
  } finally {
    await server.app.close();
  }
});

test("rememberDraft prunes expired slots even when no consumer ever touches them", async () => {
  // Fill all 512 slots (never calling compare, so getDraft can never
  // reclaim), age past the TTL, then create one more: it must succeed only
  // because rememberDraft itself prunes expired entries. Without the prune
  // loop this returns 429 for the generation's lifetime.
  const clock = { t: 1_000_000 };
  const server = await createApiServer({ adapter: sanitizedAdapter(), now: () => clock.t });
  try {
    const payload = { origin: "KOR1", destination: "KDS1", via: [] };
    for (let i = 0; i < 512; i += 1) {
      const response = await server.app.inject({ method: "POST", url: "/api/v1/drafts", payload });
      assert.equal(response.statusCode, 201, `draft ${i + 1} must store`);
    }
    const full = await server.app.inject({ method: "POST", url: "/api/v1/drafts", payload });
    assert.equal(full.statusCode, 429, "the 513th draft hits capacity");
    clock.t += 16 * 60 * 1000;
    const reclaimed = await server.app.inject({ method: "POST", url: "/api/v1/drafts", payload });
    assert.equal(reclaimed.statusCode, 201, "expired drafts must be reclaimed by rememberDraft itself");
  } finally {
    await server.app.close();
  }
});

test("a superseded refresh installs its complete acquisition when the newer attempt leaves the store empty", async () => {
  let releaseFirst: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let acquisitions = 0;
  const base = sanitizedAdapter();
  const adapter: CaasAdapter = {
    ...base,
    displayAll: async () => {
      acquisitions += 1;
      const mine = acquisitions;
      if (mine === 1) { await gate; return base.displayAll(); } // earlier-started refresh parks
      if (mine === 2) throw new Error("upstream failed"); // newer refresh fails fast
      return base.displayAll();
    },
  };
  const server = await createApiServer({ adapter, initialize: false });
  try {
    const earlier = server.store.refresh();
    let newerFailed = false;
    try { await server.store.refresh(); } catch { newerFailed = true; }
    assert.ok(newerFailed, "the later-started refresh must fail");
    assert.equal(server.store.readiness().ready, false, "the failed newer attempt leaves the store unready");
    releaseFirst?.();
    await earlier;
    assert.equal(server.store.readiness().ready, true, "the earlier complete acquisition must not be stranded by the newer failure");
  } finally {
    releaseFirst?.();
    await server.app.close();
  }
});

test("unauthenticated refresh floods are rate-limited; the bound is configurable", async () => {
  const limited = await createApiServer({ adapter: sanitizedAdapter() });
  try {
    const first = await limited.app.inject({ method: "POST", url: "/api/v1/refresh" });
    assert.equal(first.statusCode, 200);
    const second = await limited.app.inject({ method: "POST", url: "/api/v1/refresh" });
    assert.equal(second.statusCode, 429, "a second refresh inside the minimum interval must be rate-limited");
    assert.equal((second.json() as { error: { code: string } }).error.code, "REFRESH_RATE_LIMITED");
  } finally {
    await limited.app.close();
  }
  const unbounded = await createApiServer({ adapter: sanitizedAdapter(), refreshMinIntervalMs: 0 });
  try {
    const first = await unbounded.app.inject({ method: "POST", url: "/api/v1/refresh" });
    const second = await unbounded.app.inject({ method: "POST", url: "/api/v1/refresh" });
    assert.equal(first.statusCode, 200);
    assert.equal(second.statusCode, 200, "refreshMinIntervalMs: 0 keeps back-to-back refreshes allowed (lanes, fixtures)");
  } finally {
    await unbounded.app.close();
  }
});

test("route options fails fast with 409 RESPONSE_TOO_LARGE over the 2 MiB cap and serves just-under payloads", async () => {
  // Synthetic adapter: N flights KOR1 -> KDS1, each with 254 unique fixes, so
  // each candidate DTO is ~50-60 KB. ~50 candidates cross the 2 MiB policy
  // cap; ~20 stay safely under it.
  const fixes: Array<readonly [string, number, number]> = Array.from({ length: 300 }, (_, i) => [`FIX${String(i).padStart(3, "0")}`, 10 + (i % 50) * 0.01, 100 + Math.floor(i / 50) * 0.01]);
  const airports: Array<readonly [string, number, number]> = [["KOR1", 40, -73], ["KDS1", 33, -118]];
  const evidence = { family: "displayAll" as const, bytes: 128, records: 0, acceptedRecords: 0, rejectedRecords: 0, retried: false, durationMs: 0 };
  const makeAdapter = (flightCount: number): CaasAdapter => {
    const records: FlightPlanRecord[] = Array.from({ length: flightCount }, (_, f) => Object.freeze({
      id: `big-${f}`,
      callsign: `BIG${f}`,
      departure: "KOR1",
      destination: "KDS1",
      routeElements: Object.freeze(Array.from({ length: 254 }, (_, i) => ({ sequence: i, identifier: fixes[(f * 7 + i * 3) % 300]![0] }))),
    }));
    const refIndex = <T extends { identifier: string }>(points: readonly T[]): Map<string, T[]> => {
      const map = new Map<string, T[]>();
      for (const point of points) map.set(point.identifier, [...(map.get(point.identifier) ?? []), point]);
      return map;
    };
    const fixPoints = fixes.map(([identifier, lat, lon]) => ({ dataset: "fixes" as const, identifier, coordinate: { lat, lon } }));
    const airportPoints = airports.map(([identifier, lat, lon]) => ({ dataset: "airports" as const, identifier, coordinate: { lat, lon } }));
    return {
      displayAll: async () => ({ records, evidence: { ...evidence, records: flightCount, acceptedRecords: flightCount } }),
      airways: async () => ({ family: "airways", bytes: 64, records: 2, acceptedRecords: 2, rejectedRecords: 0, uniqueRecords: 1, retried: false, durationMs: 0 }),
      fixes: async () => ({ dataset: "fixes", points: fixPoints, index: refIndex(fixPoints), evidence: { ...evidence, family: "fixes" } }),
      airports: async () => ({ dataset: "airports", points: airportPoints, index: refIndex(airportPoints), evidence: { ...evidence, family: "airports" } }),
      navaids: async () => ({ dataset: "navaids", points: [], index: new Map(), evidence: { ...evidence, family: "navaids" } }),
    };
  };
  const flightIdOf = async (server: { app: { inject: (options: { method: string; url: string }) => Promise<{ json: () => { data: { id: string }[] } }> } }): Promise<string> => {
    const browse = await server.app.inject({ method: "GET", url: "/api/v1/routes?limit=1" });
    return browse.json().data[0]!.id;
  };

  const over = await createApiServer({ adapter: makeAdapter(50) });
  try {
    const response = await over.app.inject({ method: "POST", url: "/api/v1/routes/options", payload: { flightId: await flightIdOf(over) } });
    assert.equal(response.statusCode, 409, "an over-cap candidate set must fail fast with 409");
    assert.equal((response.json() as { error: { code: string } }).error.code, "RESPONSE_TOO_LARGE");
  } finally {
    await over.app.close();
  }
  const under = await createApiServer({ adapter: makeAdapter(20) });
  try {
    const response = await under.app.inject({ method: "POST", url: "/api/v1/routes/options", payload: { flightId: await flightIdOf(under) } });
    assert.equal(response.statusCode, 200, "a just-under candidate set must serialize to a 200");
  } finally {
    await under.app.close();
  }
});

test("opaque Origin: null requests fail the cross-origin defense closed", async () => {
  const server = await createApiServer({ adapter: sanitizedAdapter(), refreshMinIntervalMs: 0 });
  try {
    const opaque = await server.app.inject({ method: "POST", url: "/api/v1/refresh", headers: { origin: "null" } });
    assert.equal(opaque.statusCode, 403, "Origin: null must never skip the origin defense");
    assert.equal((opaque.json() as { error: { code: string } }).error.code, "CROSS_ORIGIN_DENIED");
  } finally {
    await server.app.close();
  }
});

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
