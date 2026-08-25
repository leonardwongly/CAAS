// R2-D5 — cross-package contract seam (round-2 adversarial sweep 2026-08-23).
//
// Attacks the emission side of the seam: every payload shape that
// apps/api/src/projection.ts and apps/api/src/snapshot.ts can emit must parse
// cleanly under the packages/contracts schemas, and every scoped token emitted
// through a projection must stay generation- and flight-bound (never widen).
//
// Non-duplication (reference-only suites):
// - tests/api-contract.test.ts pins one happy-path options DTO end-to-end
//   (provenance/safety verbatim, no raw upstream fields, security headers).
//   This lane instead fuzzes the projection/DTO builders directly across every
//   adversarial-but-valid flight shape (missing/empty routes, unresolved and
//   ambiguous references, coordinate-only boundary points, null endpoints,
//   co-located endpoints, endpoint splice cases) and validates each emitted
//   sub-shape against the contracts schemas.
// - tests/upstream-adapter-contract.test.ts pins upstream -> adapter
//   normalization; here the adapter output is the trusted seam input.
// - tests/adversarial/sweep-d5-pipeline-contracts.test.ts fuzzes the schemas
//   themselves; this lane fuzzes the EMITTERS against the schemas.
// - tests/adversarial/adv-tokens-proofs.test.ts pins forgery/tamper/expiry on
//   tokens; this lane pins the scope KEY SETS and flight-binding of tokens as
//   emitted by projection (no scope widening at the seam).

import assert from "node:assert/strict";
import test from "node:test";
import {
  GeoJsonPositionSchema,
  PERSISTENT_SAFETY_COPY,
  RouteGapReasonSchema,
} from "../../packages/contracts/src/index.ts";
import {
  PUBLIC_PROVENANCE,
  acquireSnapshot,
  generationSummary,
  readScoped,
  type Snapshot,
} from "../../apps/api/src/snapshot.ts";
import {
  overviewProjection,
  overviewRouteDto,
} from "../../apps/api/src/projection.ts";
import { fetchRouteOptions } from "../../apps/web/src/api.ts";
import type {
  CaasAdapter,
  DatasetEvidence,
  FlightPlanRecord,
  ReferenceDatasetResult,
  ReferencePoint,
} from "../../packages/upstream-caas/src/index.ts";

const BASE_NOW = 1_750_000_000_000;

function evidence(family: DatasetEvidence["family"], records: number): DatasetEvidence {
  return { family, bytes: 128, records, acceptedRecords: records, rejectedRecords: 0, retried: false, durationMs: 0 };
}

function references(dataset: "fixes" | "airports" | "navaids", values: readonly (readonly [string, number, number])[]): ReferenceDatasetResult {
  const points: ReferencePoint[] = values.map(([identifier, lat, lon]) => ({ dataset, identifier, coordinate: { lat, lon } }));
  const index = new Map<string, readonly ReferencePoint[]>();
  for (const point of points) index.set(point.identifier, [...(index.get(point.identifier) ?? []), point]);
  return { dataset, points, index, evidence: evidence(dataset, points.length) };
}

/**
 * Adversarial-but-valid flight shapes covering every emission branch in
 * projection.ts: complete direct routes, absent vs empty routeElements,
 * unresolved/ambiguous references, coordinate-only elements at the schema
 * bounds, out-of-order sequences, null/unresolvable endpoints, co-located
 * endpoints (zero-distance and splice paths).
 */
const SEAM_FLIGHTS: readonly FlightPlanRecord[] = Object.freeze([
  { id: "seam-direct", callsign: "SEAM0", departure: "A", destination: "B", routeElements: [] },
  { id: "seam-noroute", callsign: "SEAM1", departure: "A", destination: "B" },
  { id: "seam-gap", callsign: "SEAM2", departure: "A", destination: "B", routeElements: [{ sequence: 0, identifier: "NOPE" }] },
  { id: "seam-ambig", callsign: "SEAM3", departure: "A", destination: "B", routeElements: [{ sequence: 0, identifier: "DUPA" }] },
  {
    id: "seam-coords",
    callsign: "SEAM4",
    departure: "A",
    destination: "B",
    routeElements: [
      { sequence: 2, coordinate: { lat: 90, lon: 180 } },
      { sequence: 0, coordinate: { lat: -90, lon: -180 } },
      { sequence: 1, identifier: "X", coordinate: { lat: 20, lon: 30 } },
      { sequence: 3, identifier: "ALSO_MISSING" },
    ],
  },
  { id: "seam-badendpoints", callsign: "SEAM5", departure: "NOPE2", destination: "NOPE3" },
  { id: "seam-colocated", callsign: "SEAM6", departure: "A", destination: "A", routeElements: [] },
  { id: "seam-splice", callsign: "SEAM7", departure: "A", destination: "B", routeElements: [{ sequence: 0, identifier: "A" }, { sequence: 1, identifier: "B" }] },
]);

function seamAdapter(records: readonly FlightPlanRecord[]): CaasAdapter {
  return {
    displayAll: async () => ({ records: [...records], evidence: evidence("displayAll", records.length) }),
    airways: async () => ({ family: "airways", bytes: 64, records: 0, acceptedRecords: 0, rejectedRecords: 0, uniqueRecords: 0, retried: false, durationMs: 0 }),
    fixes: async () => references("fixes", [["X", 20, 30]]),
    airports: async () => references("airports", [["A", 10, 0], ["B", 10, -10], ["DUPA", 1, 1], ["DUPA", 2, 2]]),
    navaids: async () => references("navaids", []),
  };
}

async function seamSnapshot(): Promise<Snapshot> {
  return acquireSnapshot(seamAdapter(SEAM_FLIGHTS), () => BASE_NOW);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

test("every projection DTO emitted for an adversarial flight shape is JSON-safe and contracts-clean", async () => {
  const snapshot = await seamSnapshot();
  assert.equal(snapshot.flights.length, SEAM_FLIGHTS.length);
  for (const flight of snapshot.flights) {
    const dto = overviewRouteDto(snapshot, flight);
    // JSON round-trip must be lossless: no functions, no undefined leakage,
    // no non-serializable internals crossing the seam.
    const round = JSON.parse(JSON.stringify(dto)) as Record<string, unknown>;
    assert.deepEqual(round, dto, `flight ${flight.record.id} DTO must survive JSON round-trip`);

    // Internal projection surfaces must never leak into the DTO.
    for (const internal of ["occurrences", "flight", "record", "routeElements", "signature", "segments"]) {
      if (internal === "segments") continue; // serialized as GeoJSON LineStrings, checked below
      assert.equal(internal in dto, false, `internal field ${internal} must not cross the seam (${flight.record.id})`);
    }

    assert.equal(dto.provenance, PUBLIC_PROVENANCE);
    assert.equal(dto.safety, PERSISTENT_SAFETY_COPY);
    assert.equal(dto.freshness, new Date(BASE_NOW).toISOString(), "freshness must be the snapshot retrieval instant");
    assert.equal(typeof dto.id, "string");
    assert.equal(dto.id, dto.flightId, "id and flightId must stay one identity at the seam");
    assert.equal(dto.status, dto.complete === true ? "complete" : "incomplete", `status/complete drift (${flight.record.id})`);
    assert.equal(typeof dto.pointCount, "number");
    assert.ok(Number.isInteger(dto.pointCount as number) && (dto.pointCount as number) >= 0, `pointCount must be a non-negative integer (${flight.record.id})`);

    // Gap emissions: reason values must live in the contracts enum and every
    // sequence must be a non-negative integer (routeSequence grammar).
    assert.ok(Array.isArray(dto.gaps));
    for (const gap of dto.gaps as Array<Record<string, unknown>>) {
      RouteGapReasonSchema.parse(gap.reason);
      assert.equal(gap.status, "gap");
      assert.ok(Number.isInteger(gap.sequence) && (gap.sequence as number) >= 0, `gap sequence must be a non-negative integer (${flight.record.id})`);
    }

    // Leg emissions: distances are finite, non-negative numbers; gap legs
    // carry a contracts-enum reason and never a from/to pair. Every leg
    // sequence is a safe non-negative integer.
    assert.ok(Array.isArray(dto.legs));
    for (const leg of dto.legs as Array<Record<string, unknown>>) {
      assert.ok(Number.isSafeInteger(leg.sequence) && (leg.sequence as number) >= 0, `leg sequence must be a safe non-negative integer (${flight.record.id})`);
      if (leg.kind === "segment") {
        assert.equal(leg.status, "resolved");
        assert.equal(typeof leg.from, "string");
        assert.equal(typeof leg.to, "string");
        assert.ok(typeof leg.distanceNm === "number" && Number.isFinite(leg.distanceNm) && (leg.distanceNm as number) >= 0, `leg distance must be finite and non-negative (${flight.record.id})`);
      } else if (leg.kind === "gap") {
        assert.equal(leg.status, "gap");
        RouteGapReasonSchema.parse(leg.reason);
        assert.equal("from" in leg, false);
        assert.equal("to" in leg, false);
      } else {
        assert.fail(`unknown leg kind ${String(leg.kind)} (${flight.record.id})`);
      }
    }

    // GeoJSON emissions: every position parses GeoJsonPositionSchema, which
    // pins [lon, lat] axis order and the +/-180/+/-90 bounds at the seam.
    const lineStrings: Array<Record<string, unknown>> = [];
    if (dto.geometry !== undefined) lineStrings.push(dto.geometry as Record<string, unknown>);
    for (const segment of (dto.segments ?? []) as Array<Record<string, unknown>>) lineStrings.push(segment);
    for (const lineString of lineStrings) {
      assert.equal(lineString.type, "LineString");
      const coordinates = lineString.coordinates as unknown[];
      assert.ok(coordinates.length >= 2, `a LineString crossing the seam needs >= 2 positions (${flight.record.id})`);
      for (const position of coordinates) GeoJsonPositionSchema.parse(position);
    }

    // distanceNm is emitted iff the route is complete, and then it must equal
    // the sum of the emitted leg distances (never a stale or partial total).
    if (dto.complete === true) {
      const expected = (dto.legs as Array<Record<string, unknown>>).reduce((sum, leg) => sum + (typeof leg.distanceNm === "number" ? leg.distanceNm : 0), 0);
      assert.ok(Math.abs((dto.distanceNm as number) - expected) < 1e-9, `route distance must equal the leg distance sum (${flight.record.id})`);
    } else {
      assert.equal("distanceNm" in dto, false, `incomplete routes must omit distanceNm (${flight.record.id})`);
    }
  }
});

test("adversarial shapes pin the completeness and gap semantics at the seam", async () => {
  const snapshot = await seamSnapshot();
  const byId = new Map(snapshot.flights.map((flight) => [flight.record.id, flight]));
  const dtoFor = (id: string) => overviewRouteDto(snapshot, byId.get(id)!);

  // Empty explicit route: complete direct leg with a real distance.
  const direct = dtoFor("seam-direct");
  assert.equal(direct.complete, true);
  assert.equal((direct.gaps as unknown[]).length, 0);
  assert.ok((direct.distanceNm as number) > 0);

  // Absent routeElements: exactly one "missing" gap, never complete.
  const noRoute = dtoFor("seam-noroute");
  assert.equal(noRoute.complete, false);
  assert.deepEqual((noRoute.gaps as Array<Record<string, unknown>>).map((gap) => gap.reason), ["missing"]);

  // Unresolved and ambiguous references emit distinct contracts reasons.
  assert.deepEqual((dtoFor("seam-gap").gaps as Array<Record<string, unknown>>).map((gap) => gap.reason), ["not-found"]);
  assert.deepEqual((dtoFor("seam-ambig").gaps as Array<Record<string, unknown>>).map((gap) => gap.reason), ["ambiguous"]);

  // Coordinate-only boundary elements resolve; only the bare identifier gaps.
  const coords = dtoFor("seam-coords");
  assert.deepEqual((coords.gaps as Array<Record<string, unknown>>).map((gap) => gap.reason), ["not-found"]);
  assert.equal(coords.complete, false);

  // Both endpoints unresolvable plus absent route: three gaps, every leg a
  // gap leg, and still a valid (if empty) DTO.
  const badEndpoints = dtoFor("seam-badendpoints");
  assert.equal((badEndpoints.gaps as unknown[]).length, 3);
  assert.ok((badEndpoints.legs as Array<Record<string, unknown>>).every((leg) => leg.kind === "gap"));
  assert.equal("segments" in badEndpoints, false);
  assert.equal("geometry" in badEndpoints, false);

  // Co-located endpoints with an empty route are a real zero-distance leg:
  // complete, distance 0, and the endpoints are never spliced away.
  const colocated = dtoFor("seam-colocated");
  assert.equal(colocated.complete, true);
  assert.equal(colocated.distanceNm, 0);
  assert.equal(colocated.pointCount, 2);

  // Route points co-located with the endpoints are spliced without losing
  // completeness or the endpoint pair.
  const spliced = dtoFor("seam-splice");
  assert.equal(spliced.complete, true);
  assert.equal(spliced.pointCount, 2);
  assert.equal((spliced.gaps as unknown[]).length, 0);
});

test("drift pin: destination-terminating legs emit the endpoint placeholder sequence", async () => {
  // DOCUMENTED SEAM DRIFT (r2-d5 finding, escalated): a segment leg that
  // terminates at the destination endpoint carries the endpoint placeholder
  // sequence Number.MAX_SAFE_INTEGER instead of a bounded route position.
  // The golden byte-stability fixture tests/projection-regression
  // .test.ts pins exactly this value, so it is contract-frozen; the web
  // normalizer accepts it as an opaque finite number and the UI renders
  // index+1 instead. This test pins the current shape so any future change is
  // a deliberate, golden-fixture-coordinated decision.
  const snapshot = await seamSnapshot();
  const byId = new Map(snapshot.flights.map((flight) => [flight.record.id, flight]));
  const legsFor = (id: string) => overviewRouteDto(snapshot, byId.get(id)!).legs as Array<Record<string, unknown>>;

  // Direct route: the single leg terminates at the destination endpoint.
  assert.deepEqual(legsFor("seam-direct").map((leg) => leg.sequence), [Number.MAX_SAFE_INTEGER]);
  // Multi-point route: element legs keep their element sequence; only the
  // destination-terminating leg carries the placeholder.
  assert.deepEqual(legsFor("seam-splice").map((leg) => leg.sequence), [Number.MAX_SAFE_INTEGER]);
  // Coordinate route: element legs keep their sorted element sequences, the
  // gap leg keeps its element sequence, and no segment follows the last
  // resolved element before the gap.
  assert.deepEqual(legsFor("seam-coords").map((leg) => [leg.kind, leg.sequence]), [
    ["segment", 0],
    ["segment", 1],
    ["segment", 2],
    ["gap", 3],
  ]);
});

test("duplicated-sequence gaps are emitted once; distinguishable gaps are never collapsed", async () => {
  // Two unresolved elements sharing one upstream sequence number produce two
  // structurally identical gaps; the DTO emits the deduplicated set because
  // the web gap view keys gaps by (sequence, reason) and would silently drop
  // the duplicate (r2-d5 fix in projection.ts). Gaps that differ by sequence
  // OR reason must all survive.
  const records: readonly FlightPlanRecord[] = [
    { id: "dupseq", callsign: "DUPSEQ", departure: "A", destination: "B", routeElements: [{ sequence: 5, identifier: "NOPE" }, { sequence: 5, identifier: "ALSO_MISSING" }, { sequence: 6, identifier: "NOPE" }] },
  ];
  const snapshot = await acquireSnapshot(seamAdapter(records), () => BASE_NOW);
  const dto = overviewRouteDto(snapshot, snapshot.flights[0]!);
  const gaps = dto.gaps as Array<{ sequence: number; reason: string }>;
  assert.deepEqual(gaps.map((gap) => `${gap.sequence}:${gap.reason}`).sort(), ["5:not-found", "6:not-found"], "identical duplicate gaps collapse once; distinct sequences survive");
  // Gap legs stay one per unresolved occurrence — only the gap list dedupes.
  const gapLegs = (dto.legs as Array<Record<string, unknown>>).filter((leg) => leg.kind === "gap");
  assert.equal(gapLegs.length, 3);

  // And the web seam view matches the DTO gap set exactly after the fix.
  const envelope = { data: [dto], generation: generationSummary(snapshot, BASE_NOW) };
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify(envelope), { status: 200 })) as typeof fetch;
  try {
    const { options } = await fetchRouteOptions("unused");
    assert.deepEqual(options[0]!.gaps.map((gap) => `${gap.sequence}:${gap.reason}`).sort(), ["5:not-found", "6:not-found"]);
  } finally {
    globalThis.fetch = original;
  }
});

test("projection-issued scoped tokens never widen: exact scope key sets, flight-binding, generation-binding", async () => {
  const snapshot = await seamSnapshot();
  const foreign = await seamSnapshot();
  assert.notEqual(foreign.id, snapshot.id);

  for (const flight of snapshot.flights) {
    const dto = overviewRouteDto(snapshot, flight);

    // Flight identity token: exactly { g, t, e, n, i } — no scope widening.
    const identity = readScoped(dto.id, snapshot);
    assert.ok(identity, `flight token must decode under its own generation (${flight.record.id})`);
    assert.deepEqual(Object.keys(identity!).sort(), ["e", "g", "i", "n", "t"]);
    assert.equal(identity!.g, snapshot.id, "token must be generation-bound");
    assert.equal(identity!.t, "flight");
    assert.equal(identity!.i, flight.index, "token must be bound to exactly this flight");
    assert.equal(identity!.e, snapshot.unusableAtMs, "token expiry must never extend past the generation boundary");

    // Leg tokens: exactly { g, t, e, n, i, o }, flight-bound, with the ordinal
    // matching the leg's position (one distinct scope per emitted leg).
    const ordinals = new Set<unknown>();
    for (const leg of dto.legs as Array<Record<string, unknown>>) {
      const decoded = readScoped(leg.id, snapshot);
      assert.ok(decoded, `leg token must decode under its own generation (${flight.record.id})`);
      assert.deepEqual(Object.keys(decoded!).sort(), ["e", "g", "i", "n", "o", "t"]);
      assert.equal(decoded!.g, snapshot.id);
      assert.ok(decoded!.t === "leg" || decoded!.t === "gap-leg");
      assert.equal(decoded!.i, flight.index, "leg tokens must never reference another flight");
      assert.equal(decoded!.e, snapshot.unusableAtMs);
      assert.ok(Number.isInteger(decoded!.o) && (decoded!.o as number) >= 0);
      assert.equal(ordinals.has(decoded!.o), false, "leg ordinals must be distinct within one projection");
      ordinals.add(decoded!.o);
      // A projection token must never validate under a different generation.
      assert.equal(readScoped(leg.id, foreign), undefined, "leg tokens must not widen across generations");
    }
    assert.equal(readScoped(dto.id, foreign), undefined, "flight tokens must not widen across generations");

    // Re-minting a projection identity never widens its scope: the fresh
    // token differs only by nonce, never by generation/type/flight/expiry.
    const projection = overviewProjection(snapshot, flight);
    const reminted = readScoped(projection.id, snapshot);
    assert.ok(reminted);
    assert.deepEqual([reminted!.g, reminted!.t, reminted!.i, reminted!.e], [identity!.g, identity!.t, identity!.i, identity!.e], "re-minted projection identity must keep the identical scope");
    assert.notEqual(projection.id, dto.id, "each mint carries a fresh nonce (replay separation)");
  }
});

test("tampered or foreign-generation projections never widen an emitted token scope", async () => {
  const snapshot = await seamSnapshot();
  const foreign = await seamSnapshot();
  const flight = snapshot.flights[0]!;
  const dto = overviewRouteDto(snapshot, flight);
  const [body] = String(dto.id).split(".");

  // Re-signing scope widening (i -> another flight) under the real secret is
  // possible only WITH the secret; the public seam must reject everything
  // else. Flip one payload bit: the HMAC check fails closed.
  const flipped = `${body!.slice(0, -1)}${body!.endsWith("A") ? "B" : "A"}.${String(dto.id).split(".")[1]}`;
  assert.equal(readScoped(flipped, snapshot), undefined, "tampered tokens must fail closed");

  // A token minted by another generation for the same flight index is not
  // interchangeable: it never decodes under this snapshot's secret.
  const foreignDto = overviewRouteDto(foreign, foreign.flights[0]!);
  assert.equal(readScoped(foreignDto.id, snapshot), undefined);
});

test("projection surfaces are frozen at the seam: DTO and projection outputs are immutable", async () => {
  const snapshot = await seamSnapshot();
  for (const flight of snapshot.flights) {
    const projection = overviewProjection(snapshot, flight);
    assert.ok(Object.isFrozen(projection));
    assert.ok(Object.isFrozen(projection.legs));
    assert.ok(Object.isFrozen(projection.waypoints));
    assert.ok(Object.isFrozen(projection.gaps));
    const dto = overviewRouteDto(snapshot, flight);
    assert.ok(Object.isFrozen(dto.legs));
    assert.ok(Object.isFrozen(dto.gaps));
  }
});
