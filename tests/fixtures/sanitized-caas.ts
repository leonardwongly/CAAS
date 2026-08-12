import type { CaasAdapter, DatasetEvidence, FlightPlanRecord, ReferenceDatasetResult } from "../../packages/upstream-caas/src/index.ts";

export const sanitizedLocations = Object.freeze({
  fixes: [["MIDPT", 35, -90]] as const,
  airports: [["KOR1", 40, -73], ["KDS1", 33, -118]] as const,
  navaids: [["DUPX", 35, -90], ["DUPX", 36, -91]] as const,
});

export const sanitizedFlights: readonly FlightPlanRecord[] = Object.freeze([
  Object.freeze({
    id: "fixture-flight-1",
    callsign: "FIXTURE1",
    departure: "KOR1",
    destination: "KDS1",
    routeElements: Object.freeze([{ sequence: 0, identifier: "MIDPT" }]),
  }),
  Object.freeze({
    id: "fixture-flight-2",
    callsign: "FIXTURE2",
    departure: "KOR1",
    destination: "KDS1",
    routeElements: Object.freeze([{ sequence: 0, identifier: "MIDPT" }]),
  }),
]);

function evidence(family: DatasetEvidence["family"], records: number): DatasetEvidence {
  return { family, bytes: 128, records, acceptedRecords: records, rejectedRecords: 0, retried: false, durationMs: 0 };
}

function references(dataset: "fixes" | "airports" | "navaids", values: readonly (readonly [string, number, number])[]): ReferenceDatasetResult {
  const points = values.map(([identifier, lat, lon]) => ({ dataset, identifier, coordinate: { lat, lon } }));
  const index = new Map<string, readonly typeof points[number][]>();
  for (const point of points) index.set(point.identifier, [...(index.get(point.identifier) ?? []), point]);
  return { dataset, points, index, evidence: evidence(dataset, points.length) };
}

export function sanitizedAdapter(records: readonly FlightPlanRecord[] = sanitizedFlights): CaasAdapter {
  return {
    displayAll: async () => ({ records, evidence: evidence("displayAll", records.length) }),
    airways: async () => ({ family: "airways", bytes: 64, records: 2, acceptedRecords: 2, rejectedRecords: 0, uniqueRecords: 1, retried: false, durationMs: 0 }),
    fixes: async () => references("fixes", sanitizedLocations.fixes),
    airports: async () => references("airports", sanitizedLocations.airports),
    navaids: async () => references("navaids", sanitizedLocations.navaids),
  };
}
