import type { CaasAdapter, DatasetEvidence, FlightPlanRecord, ReferenceDatasetResult, ReferencePoint } from "../../packages/upstream-caas/src/index.ts";

// lat, lon order for reference data:
const fixes = [["X", 20, 30], ["Y", 30, 30]] as const;
const airports = [["A", 10, 0], ["B", 10, -10], ["C", 10, 10], ["D", 10, 20], ["E", 10, 40]] as const;

function flight(id: string, callsign: string, departure: string, destination: string, via: readonly string[]): FlightPlanRecord {
  return Object.freeze({ id, callsign, departure, destination, routeElements: Object.freeze(via.map((identifier, index) => Object.freeze({ sequence: index, identifier }))) });
}

export const caasFixtureFlights: readonly FlightPlanRecord[] = Object.freeze([
  flight("fixture-r1", "FX1", "A", "D", ["C"]),
  flight("fixture-r2", "FX2", "B", "E", ["D", "X"]),
  flight("fixture-r3", "FX3", "C", "E", ["D", "NOSUCHFIX"]),
  flight("fixture-r4", "FX4", "E", "D", ["X"]),
  flight("fixture-r5", "FX5", "B", "E", ["D", "ALSO_MISSING"]),
  flight("fixture-r6", "FX6", "B", "E", ["D", "Y"]),
  flight("fixture-r7", "FX7", "B", "E", ["D", "X"]),
]);

function evidence(family: DatasetEvidence["family"], records: number): DatasetEvidence {
  // The real normalizer deep-freezes every result (normalizers.ts); the
  // fixture must present the same immutability so consumers cannot depend on
  // mutating fixture data that would be frozen against the live adapter.
  return Object.freeze({ family, bytes: 128, records, acceptedRecords: records, rejectedRecords: 0, retried: false, durationMs: 0 });
}

function references(dataset: "fixes" | "airports" | "navaids", values: readonly (readonly [string, number, number])[]): ReferenceDatasetResult {
  const points: ReferencePoint[] = values.map(([identifier, lat, lon]) => Object.freeze({ dataset, identifier, coordinate: Object.freeze({ lat, lon }) }));
  const index = new Map<string, readonly ReferencePoint[]>();
  for (const point of points) index.set(point.identifier, [...(index.get(point.identifier) ?? []), point]);
  for (const [key, matches] of index) index.set(key, Object.freeze(matches));
  return Object.freeze({ dataset, points: Object.freeze(points), index, evidence: evidence(dataset, points.length) });
}

export function caasFixtureAdapter(): CaasAdapter {
  return Object.freeze({
    displayAll: async () => Object.freeze({ records: Object.freeze([...caasFixtureFlights]), evidence: evidence("displayAll", caasFixtureFlights.length) }),
    airways: async () => Object.freeze({ family: "airways", bytes: 64, records: 0, acceptedRecords: 0, rejectedRecords: 0, uniqueRecords: 0, retried: false, durationMs: 0 }),
    fixes: async () => references("fixes", fixes),
    airports: async () => references("airports", airports),
    navaids: async () => references("navaids", []),
  });
}
