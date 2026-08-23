// R2-D5 — cross-package contract seam (round-2 adversarial sweep 2026-08-23).
//
// Deterministic fuzz lane: 120 generated adversarial-but-valid flight shapes
// (random resolution mixes, coordinate-only elements, missing/empty routes,
// co-located endpoints, unicode identifiers, duplicate sequences, out-of-order
// sequences) are projected through apps/api/src/projection.ts, then every
// emitted DTO is round-tripped through the apps/web/src/api.ts normalizers
// with a strict losslessness invariant: any DTO field the web view drops must
// be derivably equal (counts, identities, distances, geometry) — never
// silently different.
//
// Non-duplication: tests/api-contract.test.ts and
// tests/upstream-adapter-contract.test.ts pin single-shape endpoint and
// adapter contracts; tests/adversarial/sweep-d5-pipeline-contracts.test.ts
// fuzzes schemas alone; this lane fuzzes the emitter->normalizer seam itself.

import assert from "node:assert/strict";
import test from "node:test";
import {
  CoordinateSchema,
  RouteGapReasonSchema,
} from "../../packages/contracts/src/index.ts";
import {
  acquireSnapshot,
  generationSummary,
  type Snapshot,
} from "../../apps/api/src/snapshot.ts";
import { overviewRouteDto } from "../../apps/api/src/projection.ts";
import { fetchRouteOptions } from "../../apps/web/src/api.ts";
import type {
  CaasAdapter,
  DatasetEvidence,
  FlightPlanRecord,
  ReferenceDatasetResult,
  ReferencePoint,
} from "../../packages/upstream-caas/src/index.ts";

const BASE_NOW = 1_750_000_000_000;

/** Deterministic LCG so the fuzz corpus is reproducible across runs. */
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 2 ** 32;
  };
}

function evidence(family: DatasetEvidence["family"], records: number): DatasetEvidence {
  return { family, bytes: 128, records, acceptedRecords: records, rejectedRecords: 0, retried: false, durationMs: 0 };
}

function references(dataset: "fixes" | "airports" | "navaids", values: readonly (readonly [string, number, number])[]): ReferenceDatasetResult {
  const points: ReferencePoint[] = values.map(([identifier, lat, lon]) => ({ dataset, identifier, coordinate: { lat, lon } }));
  const index = new Map<string, readonly ReferencePoint[]>();
  for (const point of points) index.set(point.identifier, [...(index.get(point.identifier) ?? []), point]);
  return { dataset, points, index, evidence: evidence(dataset, points.length) };
}

// Known-resolvable references (FIX1..FIX3, AP1..AP4), a deliberately ambiguous
// pair (DUP shared by two distinct coordinates), and unicode identifiers that
// exercise toUpperCase()-stable token lookups.
const FIXES = [["FIX1", 5, 5], ["FIX2", 15, 25], ["FIX3", -35, 145], ["DUP", 1, 1], ["DUP", 2, 2]] as const;
const AIRPORTS = [["AP1", 10, 0], ["AP2", 10, -10], ["AP3", -10, 20], ["AP4", 89.9, 179.9]] as const;
const RESOLVABLE = ["FIX1", "FIX2", "FIX3", "AP1", "AP2", "AP3", "AP4"] as const;
const UNRESOLVABLE = ["MISSING1", "NOFIX", "ÄLSO-NOT"] as const;

function generatedFlights(count: number): FlightPlanRecord[] {
  const random = rng(0xC0FFEE);
  const pick = <T>(values: readonly T[]): T => values[Math.floor(random() * values.length)]!;
  const flights: FlightPlanRecord[] = [];
  for (let index = 0; index < count; index += 1) {
    const departureRoll = random();
    const destinationRoll = random();
    const departure = departureRoll < 0.1 ? null : departureRoll < 0.25 ? pick(UNRESOLVABLE) : pick(AIRPORTS.map(([code]) => code));
    const destination = destinationRoll < 0.1 ? null : destinationRoll < 0.25 ? pick(UNRESOLVABLE) : pick(AIRPORTS.map(([code]) => code));
    const routeRoll = random();
    let routeElements: FlightPlanRecord["routeElements"];
    if (routeRoll < 0.15) {
      routeElements = undefined; // upstream route field absent
    } else {
      const length = Math.floor(random() * 7); // 0..6 elements incl. empty route
      routeElements = Array.from({ length }, (_, position) => {
        const shape = random();
        // Adversarial-but-valid sequence shapes: out-of-order, duplicated,
        // sparse — the projection sorts and must stay coherent.
        const sequence = shape < 0.2 ? Math.floor(random() * length) : shape < 0.3 ? position + 4 : position;
        const elementRoll = random();
        if (elementRoll < 0.35) {
          // Coordinate-only element at schema-valid bounds.
          const lat = Math.round((random() * 180 - 90) * 1e6) / 1e6;
          const lon = Math.round((random() * 360 - 180) * 1e6) / 1e6;
          CoordinateSchema.parse({ lat, lon });
          return { sequence, coordinate: { lat, lon } };
        }
        const identifier = elementRoll < 0.75 ? pick(RESOLVABLE) : elementRoll < 0.9 ? pick(UNRESOLVABLE) : "DUP";
        return { sequence, identifier };
      });
    }
    flights.push({
      id: `fuzz-${index}`,
      callsign: `FUZ${index}`,
      departure,
      destination,
      ...(routeElements === undefined ? {} : { routeElements }),
    });
  }
  return flights;
}

function fuzzAdapter(records: readonly FlightPlanRecord[]): CaasAdapter {
  return {
    displayAll: async () => ({ records: [...records], evidence: evidence("displayAll", records.length) }),
    airways: async () => ({ family: "airways", bytes: 64, records: 0, acceptedRecords: 0, rejectedRecords: 0, uniqueRecords: 0, retried: false, durationMs: 0 }),
    fixes: async () => references("fixes", FIXES),
    airports: async () => references("airports", AIRPORTS),
    navaids: async () => references("navaids", []),
  };
}

function stubFetch(payload: unknown): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify(payload), { status: 200 })) as typeof fetch;
  return () => { globalThis.fetch = original; };
}

test("fuzzed projection emissions stay contracts-clean and cross the web seam losslessly", async () => {
  const records = generatedFlights(120);
  const snapshot: Snapshot = await acquireSnapshot(fuzzAdapter(records), () => BASE_NOW);
  assert.equal(snapshot.flights.length, records.length);

  const dtos = snapshot.flights.map((flight) => overviewRouteDto(snapshot, flight));

  // Lane 1: every emission parses under the contracts schemas that govern its
  // sub-shapes, and the DTO grammar stays JSON-safe.
  for (let index = 0; index < dtos.length; index += 1) {
    const dto = dtos[index]!;
    const where = `fuzz flight ${index}`;
    assert.deepEqual(JSON.parse(JSON.stringify(dto)), dto, where);
    for (const gap of dto.gaps as Array<Record<string, unknown>>) {
      RouteGapReasonSchema.parse(gap.reason);
      assert.ok(Number.isSafeInteger(gap.sequence) && (gap.sequence as number) >= 0, where);
    }
    for (const leg of dto.legs as Array<Record<string, unknown>>) {
      // Safe non-negative integer grammar. Note: destination-terminating legs
      // legally carry Number.MAX_SAFE_INTEGER (documented drift pinned by
      // r2-d5-contract-seam-emission.test.ts and the golden fixture).
      assert.ok(Number.isSafeInteger(leg.sequence) && (leg.sequence as number) >= 0, `safe leg sequence (${where})`);
      if (typeof leg.distanceNm === "number") assert.ok(Number.isFinite(leg.distanceNm) && leg.distanceNm >= 0, where);
    }
    if (dto.complete === true) {
      assert.ok(typeof dto.distanceNm === "number" && Number.isFinite(dto.distanceNm) && (dto.distanceNm as number) >= 0, where);
    } else {
      assert.equal("distanceNm" in dto, false, where);
    }
  }

  // Lane 2: every emission is accepted by the web normalizers with no silent
  // field loss — identity, counts, distances, gap sets, and geometry all match.
  const envelope = { data: dtos, generation: generationSummary(snapshot, BASE_NOW) };
  const restore = stubFetch(envelope);
  try {
    const { options } = await fetchRouteOptions("unused");
    assert.equal(options.length, dtos.length, "no fuzzed route may be dropped at the seam");
    for (let index = 0; index < dtos.length; index += 1) {
      const dto = dtos[index]!;
      const option = options[index]!;
      const where = `fuzz flight ${index}`;
      assert.equal(option.id, dto.id, where);
      assert.equal(option.callsign, dto.callsign, where);
      assert.equal(option.complete, dto.complete, where);
      assert.equal(option.pointCount, dto.pointCount, where);
      assert.equal(option.distanceNm, dto.distanceNm, where);
      assert.equal(option.legs.length, (dto.legs as unknown[]).length, where);
      // Gap view: exactly the DTO's (sequence, reason) identity set.
      const emittedGaps = (dto.gaps as Array<{ sequence: number; reason: string }>).map((gap) => `${gap.sequence}:${gap.reason}`).sort();
      const normalizedGaps = option.gaps.map((gap) => `${gap.sequence}:${gap.reason}`).sort();
      assert.deepEqual(normalizedGaps, emittedGaps, where);
      // Geometry: exact [lon,lat] round trip when emitted, absent otherwise.
      if (dto.geometry !== undefined) {
        const expected = (dto.geometry as { coordinates: Array<[number, number]> }).coordinates;
        assert.deepEqual(option.geometry!.map((point) => [point.lon, point.lat] as [number, number]), expected, where);
      } else {
        assert.equal(option.geometry, undefined, where);
      }
      if ("segments" in dto) {
        const emittedSegments = dto.segments as Array<{ coordinates: Array<[number, number]> }>;
        assert.equal(option.segments!.length, emittedSegments.length, where);
      } else {
        assert.equal(option.segments, undefined, where);
      }
    }

    // Sanity spread: the corpus actually exercises every seam branch.
    const statuses = new Set(dtos.map((dto) => dto.status));
    assert.deepEqual([...statuses].sort(), ["complete", "incomplete"]);
    const reasons = new Set(dtos.flatMap((dto) => (dto.gaps as Array<{ reason: string }>).map((gap) => gap.reason)));
    assert.ok(reasons.has("missing") && reasons.has("not-found") && reasons.has("ambiguous"), "corpus must cover all reachable gap reasons");
    assert.ok(dtos.some((dto) => dto.distanceNm === 0), "corpus must include a zero-distance route");
  } finally {
    restore();
  }
});
