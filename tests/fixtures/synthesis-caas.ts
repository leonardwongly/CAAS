import type { CaasAdapter, DatasetEvidence, FlightPlanRecord, ReferenceDatasetResult, ReferencePoint } from "../../packages/upstream-caas/src/index.ts";

export const SYNTHESIS_COORDS = Object.freeze({
  A: [10, 0] as const, C: [10, 10] as const, D: [10, 20] as const,
  X: [20, 30] as const, E: [10, 40] as const, Y: [30, 30] as const, B: [10, -10] as const,
});
// lat, lon order for reference data:
const fixes = [["X", 20, 30], ["Y", 30, 30]] as const;
const airports = [["A", 10, 0], ["B", 10, -10], ["C", 10, 10], ["D", 10, 20], ["E", 10, 40]] as const;

function flight(id: string, callsign: string, departure: string, destination: string, via: readonly string[]): FlightPlanRecord {
  return Object.freeze({ id, callsign, departure, destination, routeElements: Object.freeze(via.map((identifier, index) => Object.freeze({ sequence: index, identifier }))) });
}

export const synthesisFlights: readonly FlightPlanRecord[] = Object.freeze([
  flight("synth-r1", "SYNTH1", "A", "D", ["C"]),            // R1: A -> C -> D
  flight("synth-r2", "SYNTH2", "B", "E", ["D", "X"]),       // R2: B -> D -> X -> E (donor)
  flight("synth-r3", "SYNTH3", "C", "E", ["D", "NOSUCHFIX"]), // R3: target C -> D -> [gap] -> E
  flight("synth-r4", "SYNTH4", "E", "D", ["X"]),            // R4: reverse-only negative
  flight("synth-r5", "SYNTH5", "B", "E", ["D", "ALSO_MISSING"]), // R5: discontinuous negative
  flight("synth-r6", "SYNTH6", "B", "E", ["D", "Y"]),       // R6: distinct alternative
  flight("synth-r7", "SYNTH7", "B", "E", ["D", "X"]),       // R7: duplicate geometry/provenance
]);

function evidence(family: DatasetEvidence["family"], records: number): DatasetEvidence {
  return { family, bytes: 128, records, acceptedRecords: records, rejectedRecords: 0, retried: false, durationMs: 0 };
}

function references(dataset: "fixes" | "airports" | "navaids", values: readonly (readonly [string, number, number])[]): ReferenceDatasetResult {
  const points: ReferencePoint[] = values.map(([identifier, lat, lon]) => ({ dataset, identifier, coordinate: { lat, lon } }));
  const index = new Map<string, readonly ReferencePoint[]>();
  for (const point of points) index.set(point.identifier, [...(index.get(point.identifier) ?? []), point]);
  return { dataset, points, index, evidence: evidence(dataset, points.length) };
}

export function synthesisAdapter(): CaasAdapter {
  return {
    displayAll: async () => ({ records: [...synthesisFlights], evidence: evidence("displayAll", synthesisFlights.length) }),
    airways: async () => ({ family: "airways", bytes: 64, records: 0, acceptedRecords: 0, rejectedRecords: 0, uniqueRecords: 0, retried: false, durationMs: 0 }),
    fixes: async () => references("fixes", fixes),
    airports: async () => references("airports", airports),
    navaids: async () => references("navaids", []),
  };
}
