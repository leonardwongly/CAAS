import type { Coordinate } from "@flight-route-explorer/contracts";

export type CaasFamily = "displayAll" | "airways" | "fixes" | "airports" | "navaids";
export type ReferenceDataset = "fixes" | "airports" | "navaids";

export interface FlightRouteElement {
  readonly sequence: number;
  readonly identifier?: string;
  readonly coordinate?: Coordinate;
}

export interface FlightPlanRecord {
  readonly id: string;
  readonly callsign: string;
  readonly departure: string | null;
  readonly destination: string | null;
  /** Absent when the upstream route field was missing; [] is an explicit empty route. */
  readonly routeElements?: readonly FlightRouteElement[];
}

export interface DatasetEvidence {
  readonly family: CaasFamily;
  readonly bytes: number;
  readonly records: number;
  readonly acceptedRecords: number;
  readonly rejectedRecords: number;
  readonly retried: boolean;
  readonly durationMs: number;
}

export interface DisplayAllResult {
  readonly records: readonly FlightPlanRecord[];
  readonly evidence: DatasetEvidence;
}

export interface ReferencePoint {
  readonly dataset: ReferenceDataset;
  readonly identifier: string;
  readonly coordinate: Coordinate;
}

export type ReferenceIndex = ReadonlyMap<string, readonly ReferencePoint[]>;

export interface ReferenceDatasetResult {
  readonly dataset: ReferenceDataset;
  readonly points: readonly ReferencePoint[];
  readonly index: ReferenceIndex;
  readonly evidence: DatasetEvidence;
}

export interface AirwayEvidence {
  readonly family: "airways";
  readonly bytes: number;
  readonly records: number;
  readonly acceptedRecords: number;
  readonly rejectedRecords: number;
  readonly uniqueRecords: number;
  readonly retried: boolean;
  readonly durationMs: number;
}

export interface CaasAdapter {
  readonly displayAll: (signal?: AbortSignal) => Promise<DisplayAllResult>;
  readonly airways: (signal?: AbortSignal) => Promise<AirwayEvidence>;
  readonly fixes: (signal?: AbortSignal) => Promise<ReferenceDatasetResult>;
  readonly airports: (signal?: AbortSignal) => Promise<ReferenceDatasetResult>;
  readonly navaids: (signal?: AbortSignal) => Promise<ReferenceDatasetResult>;
}
