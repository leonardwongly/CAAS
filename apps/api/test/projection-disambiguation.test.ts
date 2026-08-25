// ADR-0004: route-context disambiguation of duplicate fix references.
//
// A reference that matches several distinct coordinates is resolved only when
// the route supplies two resolved neighbours and exactly one candidate is
// clearly closest to the great-circle arc between them (within the cap and
// beyond the margin). Ties, weak separations, far-field candidates, and
// missing neighbour context all keep the fail-closed "ambiguous" gap.
import assert from "node:assert/strict";
import test from "node:test";
import {
  acquireSnapshot,
  type Snapshot,
} from "../src/snapshot.ts";
import {
  overviewRouteDto,
  resolveAmbiguousByProximity,
} from "../src/projection.ts";
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

const onRoute = { id: "fix-0", code: "DUPA", name: "DUPA", kind: "place" as const, coordinate: { lat: 10, lon: -5 }, aliases: [] };
const farField = { ...onRoute, id: "fix-1", coordinate: { lat: 50, lon: 10 } };
const arcFrom = { lat: 10, lon: 0 };
const arcTo = { lat: 10, lon: -10 };

test("proximity disambiguation picks the candidate on the route arc", () => {
  assert.deepEqual(resolveAmbiguousByProximity([onRoute, farField], arcFrom, arcTo), onRoute);
  assert.deepEqual(resolveAmbiguousByProximity([farField, onRoute], arcFrom, arcTo), onRoute);
});

test("equidistant ties stay ambiguous", () => {
  const tieA = { ...onRoute, id: "fix-tie-a", coordinate: { lat: 10, lon: -3 } };
  const tieB = { ...onRoute, id: "fix-tie-b", coordinate: { lat: 10, lon: -7 } };
  assert.equal(resolveAmbiguousByProximity([tieA, tieB], arcFrom, arcTo), undefined);
});

test("weak separation below the margin and far-field candidates stay ambiguous", () => {
  const nearA = { ...onRoute, id: "fix-near-a", coordinate: { lat: 10, lon: -5 } };
  const nearB = { ...onRoute, id: "fix-near-b", coordinate: { lat: 10, lon: -5.005 } };
  assert.equal(resolveAmbiguousByProximity([nearA, nearB], arcFrom, arcTo), undefined);
  const farA = { ...onRoute, id: "fix-far-a", coordinate: { lat: 1, lon: 1 } };
  const farB = { ...onRoute, id: "fix-far-b", coordinate: { lat: 2, lon: 2 } };
  assert.equal(resolveAmbiguousByProximity([farA, farB], arcFrom, arcTo), undefined);
});

function flight(id: string, callsign: string, via: readonly string[]): FlightPlanRecord {
  return { id, callsign, departure: "A", destination: "B", routeElements: via.map((identifier, index) => ({ sequence: index, identifier })) };
}

function disambiguationAdapter(): CaasAdapter {
  return {
    displayAll: async () => ({
      records: [
        flight("f-resolve", "RES1", ["DUPA"]),
        flight("f-tie", "TIE1", ["DUPT"]),
        flight("f-far", "FAR1", ["DUPF"]),
        { id: "f-single", callsign: "SIN1", departure: "A", destination: "NOPE", routeElements: [{ sequence: 0, identifier: "DUPX" }] },
      ],
      evidence: evidence("displayAll", 4),
    }),
    airways: async () => ({ family: "airways", bytes: 64, records: 0, acceptedRecords: 0, rejectedRecords: 0, uniqueRecords: 0, retried: false, durationMs: 0 }),
    fixes: async () => references("fixes", [
      ["DUPA", 10, -5], ["DUPA", 50, 10],
      ["DUPT", 10, -3], ["DUPT", 10, -7],
      ["DUPF", 1, 1], ["DUPF", 2, 2],
      ["DUPX", 10, -5], ["DUPX", 50, 10],
    ]),
    airports: async () => references("airports", [["A", 10, 0], ["B", 10, -10]]),
    navaids: async () => references("navaids", []),
  };
}

async function snapshot(): Promise<Snapshot> {
  return acquireSnapshot(disambiguationAdapter(), () => BASE_NOW);
}

test("a route with one candidate on the arc resolves the ambiguous waypoint", async () => {
  const snap = await snapshot();
  const dto = overviewRouteDto(snap, snap.flights[0]!);
  assert.equal(dto.callsign, "RES1");
  assert.deepEqual(dto.gaps, []);
  assert.equal(dto.complete, true);
  assert.ok((dto.distanceNm as number) > 0);
  const labels = (dto.legs as Array<Record<string, unknown>>).map((leg) => `${leg.from}->${leg.to}`);
  assert.ok(labels.some((label) => label.endsWith("->DUPA")) && labels.some((label) => label.includes("DUPA->")), `expected DUPA legs, got ${JSON.stringify(labels)}`);
});

test("ties, far-field candidates, and missing neighbour context keep the ambiguous gap", async () => {
  const snap = await snapshot();
  const byCallsign = new Map(snap.flights.map((flight) => [flight.record.callsign, flight]));
  const gapsOf = (callsign: string) => overviewRouteDto(snap, byCallsign.get(callsign)!).gaps as Array<{ reason: string }>;
  assert.deepEqual(gapsOf("TIE1").map((gap) => gap.reason), ["ambiguous"]);
  assert.deepEqual(gapsOf("FAR1").map((gap) => gap.reason), ["ambiguous"]);
  // Destination is unresolved, so only one neighbour exists: fail closed.
  const single = overviewRouteDto(snap, byCallsign.get("SIN1")!);
  assert.deepEqual((single.gaps as Array<{ reason: string }>).map((gap) => gap.reason), ["ambiguous", "not-found"]);
});
