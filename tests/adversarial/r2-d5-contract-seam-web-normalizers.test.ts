// R2-D5 — cross-package contract seam (round-2 adversarial sweep 2026-08-23).
//
// Attacks the consumption side of the seam: every payload the API projection
// layer emits must be accepted by the apps/web/src/api.ts normalizers WITHOUT
// silent field loss, and schema-valid edge payloads (boundary values, optional
// absences, empty arrays, unicode) must survive normalization intact. The web
// normalizers are pure fetch-driven transforms (no DOM imports), so they are
// exercised here under Node by stubbing globalThis.fetch.
//
// Non-duplication (reference-only suites):
// - tests/adversarial/sweep-d6-webdata-normalizers.test.tsx drives HOSTILE
//   payloads through the normalizers; this lane drives REAL API emissions and
//   schema-valid boundary payloads, asserting losslessness (not rejection).
// - tests/api-contract.test.ts pins one happy-path server DTO; this lane pins
//   the API-emission -> web-normalizer round trip for every adversarial shape
//   and every DTO field, plus the emission/consumption key-drift map.
// - tests/upstream-adapter-contract.test.ts pins upstream -> adapter only.

import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_TEXT_LENGTH,
  PERSISTENT_SAFETY_COPY,
} from "../../packages/contracts/src/index.ts";
import {
  PUBLIC_PROVENANCE,
  acquireSnapshot,
  generationSummary,
  type Snapshot,
} from "../../apps/api/src/snapshot.ts";
import { overviewRouteDto } from "../../apps/api/src/projection.ts";
import {
  fetchRouteData,
  fetchRouteOptions,
  fetchRouteOverview,
  type RouteOption,
} from "../../apps/web/src/api.ts";
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

// Same adversarial shape matrix as the emission lane: complete, gapped,
// ambiguous, boundary-coordinate, endpoint-gap, zero-distance, and splice
// routes all cross the web normalizer seam.
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

/**
 * DOM-free fetch stub: apps/web/src/api.ts only consumes response.ok /
 * response.status / response.json(), so a canned JSON Response is enough.
 */
function stubFetch(payloadFor: (url: string, body: unknown) => unknown): { calls: Array<{ url: string; body?: unknown }>; restore: () => void } {
  const original = globalThis.fetch;
  const calls: Array<{ url: string; body?: unknown }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, ...(body !== undefined ? { body } : {}) });
    return new Response(JSON.stringify(payloadFor(url, body)), { status: 200 });
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

function geometryToCoordinates(geometry: Array<{ lat: number; lon: number }>): Array<[number, number]> {
  return geometry.map((point) => [point.lon, point.lat]);
}

test("every real API route DTO crosses the web normalizer seam without silent field loss", async () => {
  const snapshot = await seamSnapshot();
  const dtos = snapshot.flights.map((flight) => overviewRouteDto(snapshot, flight));
  const envelope = { data: dtos, generation: generationSummary(snapshot, BASE_NOW) };

  const { calls, restore } = stubFetch((url) => {
    if (url === "/api/v1/routes/options") return envelope;
    throw new Error(`unexpected url ${url}`);
  });
  try {
    const { options } = await fetchRouteOptions("unused");
    assert.equal(calls.length, 1);
    // No route may be silently dropped at the seam.
    assert.equal(options.length, dtos.length, "every emitted DTO must normalize into an option");

    for (let index = 0; index < dtos.length; index += 1) {
      const dto = dtos[index]!;
      const option = options[index]!;
      const where = `flight ${SEAM_FLIGHTS[index]!.id}`;
      assert.equal(option.id, dto.id, where);
      assert.equal(option.flightId, dto.flightId, where);
      assert.equal(option.callsign, dto.callsign, where);
      assert.equal(option.status, dto.status, where);
      assert.equal(option.complete, dto.complete, where);
      assert.equal(option.label, dto.label, where);
      assert.equal(option.origin, dto.origin, where);
      assert.equal(option.destination, dto.destination, where);
      assert.equal(option.pointCount, dto.pointCount, where);
      assert.equal(option.provenance, dto.provenance, where);
      assert.equal(option.freshness, dto.freshness, where);
      assert.equal(option.safety, dto.safety, where);

      // Legs survive 1:1, including gap legs (no from/to).
      assert.equal(option.legs.length, (dto.legs as unknown[]).length, `leg count ${where}`);
      for (let legIndex = 0; legIndex < option.legs.length; legIndex += 1) {
        const emitted = (dto.legs as Array<Record<string, unknown>>)[legIndex]!;
        const normalized = option.legs[legIndex]!;
        assert.equal(normalized.id, emitted.id, `leg id ${where}#${legIndex}`);
        assert.equal(normalized.kind, emitted.kind, `leg kind ${where}#${legIndex}`);
        assert.equal(normalized.status, emitted.status, `leg status ${where}#${legIndex}`);
        if (emitted.kind === "segment") {
          assert.equal(normalized.from, emitted.from, `leg from ${where}#${legIndex}`);
          assert.equal(normalized.to, emitted.to, `leg to ${where}#${legIndex}`);
          assert.equal(normalized.distanceNm, emitted.distanceNm, `leg distance ${where}#${legIndex}`);
        } else {
          assert.equal(normalized.reason, emitted.reason, `gap leg reason ${where}#${legIndex}`);
        }
      }

      // Geometry/segments round-trip GeoJSON [lon,lat] back to {lat,lon}
      // exactly — never reordered, clamped, or dropped.
      if (dto.geometry !== undefined) {
        assert.deepEqual(geometryToCoordinates(option.geometry!), (dto.geometry as { coordinates: Array<[number, number]> }).coordinates, `geometry ${where}`);
      } else {
        assert.equal(option.geometry, undefined, `absent geometry stays absent ${where}`);
      }
      if ("segments" in dto) {
        const emittedSegments = dto.segments as Array<{ coordinates: Array<[number, number]> }>;
        assert.equal(option.segments!.length, emittedSegments.length, `segment count ${where}`);
        for (let segmentIndex = 0; segmentIndex < emittedSegments.length; segmentIndex += 1) {
          assert.deepEqual(geometryToCoordinates(option.segments![segmentIndex]!), emittedSegments[segmentIndex]!.coordinates, `segment ${where}#${segmentIndex}`);
        }
      } else {
        assert.equal(option.segments, undefined, `absent segments stay absent ${where}`);
      }

      // distanceNm is lossless, including a real zero-distance route.
      assert.equal(option.distanceNm, dto.distanceNm, `distanceNm ${where}`);
    }
    // The zero-distance co-located route pins that 0 is a value, never a
    // falsy drop: the normalized option carries distanceNm === 0.
    const colocated = options.find((option) => option.callsign === "SEAM6")!;
    assert.equal(colocated.distanceNm, 0);
    assert.equal(colocated.complete, true);
  } finally {
    restore();
  }
});

test("web gap view never loses a distinguishable API gap (sequence+reason identity)", async () => {
  const snapshot = await seamSnapshot();
  const dtos = snapshot.flights.map((flight) => overviewRouteDto(snapshot, flight));
  const envelope = { data: dtos, generation: generationSummary(snapshot, BASE_NOW) };
  const { restore } = stubFetch(() => envelope);
  try {
    const { options } = await fetchRouteOptions("unused");
    for (let index = 0; index < dtos.length; index += 1) {
      const dto = dtos[index]!;
      const emitted = dto.gaps as Array<{ sequence: number; reason: string }>;
      // The DTO already merges gap-array and gap-leg views by (sequence,
      // reason) identity; the web view must keep exactly that set.
      const expectedKeys = new Set(emitted.map((gap) => `${gap.sequence}:${gap.reason}`));
      const option = options[index]!;
      const actualKeys = new Set(option.gaps.map((gap) => `${gap.sequence}:${gap.reason}`));
      assert.deepEqual([...actualKeys].sort(), [...expectedKeys].sort(), `gap set drift for ${SEAM_FLIGHTS[index]!.id}`);
      for (const gap of option.gaps) assert.equal(gap.status, "gap");
    }
  } finally {
    restore();
  }
});

test("the overview and detail envelopes normalize with generation and identity intact", async () => {
  const snapshot = await seamSnapshot();
  const dtos = snapshot.flights.map((flight) => overviewRouteDto(snapshot, flight));
  const generation = generationSummary(snapshot, BASE_NOW);
  const { restore } = stubFetch((url, body) => {
    if (url === "/api/v1/routes/overview") return { data: dtos, generation, loaded: dtos.length, total: dtos.length };
    if (url === "/api/v1/routes/detail") {
      assert.deepEqual(body, { routeId: "requested-token" });
      return { data: dtos[0], generation };
    }
    throw new Error(`unexpected url ${url}`);
  });
  try {
    const overview = await fetchRouteOverview();
    assert.equal(overview.routes.length, dtos.length);
    assert.equal(overview.generation.id, generation.id);
    assert.equal(overview.generation.overall, generation.overall);
    assert.equal(overview.generation.live.state, generation.live.state);
    assert.equal(overview.generation.reference.state, generation.reference.state);
    assert.equal(overview.routes[0]!.id, dtos[0]!.id);

    const detail = await fetchRouteData("requested-token");
    assert.equal(detail.id, dtos[0]!.id);
    assert.equal(detail.callsign, dtos[0]!.callsign);
    assert.equal(detail.safety, PERSISTENT_SAFETY_COPY);
    assert.equal(detail.provenance, PUBLIC_PROVENANCE);
  } finally {
    restore();
  }
});

test("schema-valid boundary payloads normalize losslessly (bounds, unicode, absences, empty arrays)", async () => {
  const snapshot = await seamSnapshot();
  const generation = generationSummary(snapshot, BASE_NOW);
  const unicodeCallsign = "ÄTHÉR-Ø1";
  const maxCallsign = "Z".repeat(MAX_TEXT_LENGTH);
  const boundary: Record<string, unknown> = {
    id: "boundary-route",
    flightId: "boundary-route",
    callsign: unicodeCallsign,
    status: "complete",
    complete: true,
    label: `${unicodeCallsign} route`,
    origin: "Tōkyō (RJTT)",
    destination: "São Paulo (SBGR)",
    pointCount: 3,
    legs: [
      { id: "leg-a", sequence: 0, kind: "segment", status: "resolved", from: "Tōkyō (RJTT)", to: "Anchorage (PANC)", distanceNm: 2987.5 },
      { id: "leg-b", sequence: 1, kind: "segment", status: "resolved", from: "Anchorage (PANC)", to: "São Paulo (SBGR)", distanceNm: 7031.25 },
    ],
    // Exact CoordinateSchema bounds: +/-90 latitude, +/-180 longitude.
    geometry: { type: "LineString", coordinates: [[180, 90], [0, 0], [-180, -90]] },
    segments: [{ type: "LineString", coordinates: [[180, 90], [-180, -90]] }],
    distanceNm: 0,
    provenance: PUBLIC_PROVENANCE,
    freshness: new Date(BASE_NOW).toISOString(),
    safety: PERSISTENT_SAFETY_COPY,
    gaps: [{ status: "gap", sequence: 0, reason: "missing" }],
  };
  const minimal: Record<string, unknown> = {
    id: "minimal-route",
    flightId: "minimal-route",
    callsign: maxCallsign,
    status: "incomplete",
    complete: false,
    pointCount: 0,
    legs: [],
    gaps: [],
  };
  const { restore } = stubFetch(() => ({ data: [boundary, minimal], generation }));
  try {
    const { options } = await fetchRouteOptions("unused");
    assert.equal(options.length, 2, "both boundary and minimal payloads must normalize");

    const rich = options[0]!;
    assert.equal(rich.callsign, unicodeCallsign, "unicode callsign must survive verbatim");
    assert.equal(rich.origin, "Tōkyō (RJTT)", "unicode origin label must survive verbatim");
    assert.equal(rich.destination, "São Paulo (SBGR)");
    assert.deepEqual(rich.geometry, [{ lat: 90, lon: 180 }, { lat: 0, lon: 0 }, { lat: -90, lon: -180 }], "boundary coordinates must survive at the exact schema bounds");
    assert.deepEqual(rich.segments, [[{ lat: 90, lon: 180 }, { lat: -90, lon: -180 }]]);
    assert.equal(rich.distanceNm, 0, "zero distance is a value, never dropped");
    assert.equal(rich.legs.length, 2);
    assert.equal(rich.legs[0]!.from, "Tōkyō (RJTT)");
    assert.equal(rich.legs[0]!.distanceNm, 2987.5);
    assert.deepEqual(rich.gaps, [{ sequence: 0, status: "gap", reason: "missing" }], "sequence 0 must not fall back to an index-derived sequence");
    assert.equal(rich.provenance, PUBLIC_PROVENANCE);
    assert.equal(rich.safety, PERSISTENT_SAFETY_COPY);

    const sparse = options[1]! as RouteOption;
    assert.equal(sparse.callsign, maxCallsign, `a ${MAX_TEXT_LENGTH}-char callsign must survive verbatim`);
    assert.deepEqual(sparse.legs, []);
    assert.deepEqual(sparse.gaps, []);
    assert.equal(sparse.distanceNm, undefined, "absent distance stays absent");
    assert.equal(sparse.geometry, undefined, "absent geometry stays absent");
    assert.equal(sparse.segments, undefined, "absent segments stay absent");
    assert.equal(sparse.provenance, undefined);
    assert.equal(sparse.freshness, undefined);
    assert.equal(sparse.safety, undefined);
  } finally {
    restore();
  }
});

test("drift pin: the routeDto emission key set exactly matches the web consumption map", async () => {
  const snapshot = await seamSnapshot();
  // The complete route emits every optional field; the gapped one emits the
  // minimal key set. Together they pin the full emission grammar.
  const completeDto = overviewRouteDto(snapshot, snapshot.flights[0]!);
  const gappedDto = overviewRouteDto(snapshot, snapshot.flights[2]!);
  const FULL_KEYS = ["callsign", "complete", "destination", "distanceNm", "flightId", "freshness", "gaps", "geometry", "id", "label", "legs", "origin", "pointCount", "provenance", "safety", "segments", "status"];
  const CONDITIONAL_KEYS = ["distanceNm", "geometry", "segments"];
  assert.deepEqual(Object.keys(completeDto).sort(), FULL_KEYS, "a complete route DTO must emit exactly the pinned key set (drift alarm)");
  assert.deepEqual(
    Object.keys(gappedDto).sort(),
    FULL_KEYS.filter((key) => !CONDITIONAL_KEYS.includes(key)).sort(),
    "an incomplete gapped route DTO must omit exactly the conditional keys (drift alarm)",
  );

  // Every emitted key has a consuming normalizer path in apps/web/src/api.ts
  // (verified by round trip below); a new API field with no web consumer, or a
  // renamed field, fails one of these mappings.
  const envelope = { data: [completeDto], generation: generationSummary(snapshot, BASE_NOW) };
  const { restore } = stubFetch(() => envelope);
  try {
    const { options } = await fetchRouteOptions("unused");
    const option = options[0]!;
    const consumption: Record<string, unknown> = {
      id: option.id,
      flightId: option.flightId,
      callsign: option.callsign,
      status: option.status,
      label: option.label,
      origin: option.origin,
      destination: option.destination,
      pointCount: option.pointCount,
      legs: option.legs.length,
      distanceNm: option.distanceNm,
      geometry: option.geometry ? "present" : undefined,
      segments: option.segments ? "present" : undefined,
      provenance: option.provenance,
      freshness: option.freshness,
      safety: option.safety,
      gaps: option.gaps.length,
    };
    assert.equal(consumption.id, completeDto.id);
    assert.equal(consumption.flightId, completeDto.flightId);
    assert.equal(consumption.callsign, completeDto.callsign);
    assert.equal(consumption.status, completeDto.status);
    assert.equal(consumption.label, completeDto.label);
    assert.equal(consumption.origin, completeDto.origin);
    assert.equal(consumption.destination, completeDto.destination);
    assert.equal(consumption.pointCount, completeDto.pointCount);
    assert.equal(consumption.legs, (completeDto.legs as unknown[]).length);
    assert.equal(consumption.distanceNm, completeDto.distanceNm);
    assert.equal(consumption.geometry, "present");
    assert.equal(consumption.segments, "present");
    assert.equal(consumption.provenance, completeDto.provenance);
    assert.equal(consumption.freshness, completeDto.freshness);
    assert.equal(consumption.safety, completeDto.safety);
    assert.equal(consumption.gaps, (completeDto.gaps as unknown[]).length);
  } finally {
    restore();
  }
});
