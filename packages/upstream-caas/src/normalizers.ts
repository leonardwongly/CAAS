import { CoordinateInputSchema, MAX_REFERENCE_LENGTH, MAX_TEXT_LENGTH, type Coordinate } from "@flight-route-explorer/contracts";
import { FAMILY_POLICIES, MAX_ROUTE_ELEMENTS } from "./config.ts";
import { CaasAdapterError } from "./errors.ts";
import type {
  AirwayEvidence,
  DatasetEvidence,
  DisplayAllResult,
  FlightPlanRecord,
  FlightRouteElement,
  ReferenceDataset,
  ReferenceDatasetResult,
  ReferencePoint,
} from "./types.ts";

const IDENTIFIER_PATTERN = /^([A-Za-z0-9][A-Za-z0-9._/\- ]{0,31})\s*\(\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+))\s*,\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+))\s*\)$/;
const CONTROL_OR_BIDI = /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/;

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonRecord : null;
}

function jsonValue(body: string, family: "displayAll" | "airways" | "fixes" | "airports" | "navaids"): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new CaasAdapterError("INVALID_JSON", "The upstream response was not valid JSON.", { family });
  }
}

function boundedText(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text || text.length > maxLength || CONTROL_OR_BIDI.test(text)) return null;
  return text;
}

function firstValue(record: JsonRecord, keys: readonly string[]): unknown {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(record, key) && record[key] !== undefined) return record[key];
  }
  return undefined;
}

function firstBoundedText(record: JsonRecord, keys: readonly string[], maxLength: number): string | null {
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
    const value = boundedText(record[key], maxLength);
    if (value) return value;
  }
  return null;
}

function firstReferenceValue(record: JsonRecord, keys: readonly string[]): string | null {
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
    const value = referenceValue(record[key]);
    if (value) return value;
  }
  return null;
}

function referenceValue(value: unknown): string | null {
  if (typeof value === "string") return boundedText(value, MAX_REFERENCE_LENGTH)?.toUpperCase() ?? null;
  const record = asRecord(value);
  if (!record) return null;
  return firstBoundedText(record, ["icao", "code", "identifier", "id", "name"], MAX_REFERENCE_LENGTH)?.toUpperCase() ?? null;
}

function coordinateValue(value: unknown): Coordinate | undefined {
  const record = asRecord(value);
  const candidate = record
    ? { lat: record.lat ?? record.latitude, lon: record.lon ?? record.lng ?? record.longitude }
    : value;
  const parsed = CoordinateInputSchema.safeParse(candidate);
  return parsed.success ? Object.freeze(parsed.data) : undefined;
}

function firstCoordinateValue(record: JsonRecord, keys: readonly string[]): Coordinate | undefined {
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
    const coordinate = coordinateValue(record[key]);
    if (coordinate) return coordinate;
  }
  return undefined;
}

function liveAerodromeValue(value: unknown): string | null {
  if (typeof value === "string") return boundedText(value, MAX_REFERENCE_LENGTH)?.toUpperCase() ?? null;
  const record = asRecord(value);
  if (!record) return null;
  return firstBoundedText(record, ["locationId", "icao", "code", "identifier", "id", "name"], MAX_REFERENCE_LENGTH)?.toUpperCase() ?? null;
}

function endpointValue(record: JsonRecord, parentKey: "departure" | "arrival", childKey: "departureAerodrome" | "destinationAerodrome", legacyKeys: readonly string[]): string | null {
  if (Object.prototype.hasOwnProperty.call(record, parentKey)) {
    const parent = asRecord(record[parentKey]);
    if (parent && Object.prototype.hasOwnProperty.call(parent, childKey)) return liveAerodromeValue(parent[childKey]);
  }
  return firstReferenceValue(record, legacyKeys);
}

function routeElementsValue(record: JsonRecord): unknown[] | null | undefined {
  if (Object.prototype.hasOwnProperty.call(record, "filedRoute")) {
    const filedRoute = asRecord(record.filedRoute);
    if (!filedRoute || !Object.prototype.hasOwnProperty.call(filedRoute, "routeElement")) return null;
    return Array.isArray(filedRoute.routeElement) ? filedRoute.routeElement : null;
  }
  let present = false;
  for (const key of ["routeElements", "route", "waypoints", "points", "flightPlan", "flightplan", "elements"]) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
    present = true;
    if (Array.isArray(record[key])) return record[key];
  }
  return present ? null : undefined;
}

function liveDesignatedPoint(value: unknown): { identifier?: string; coordinate?: Coordinate } {
  if (typeof value === "string") {
    const identifier = boundedText(value, MAX_REFERENCE_LENGTH)?.toUpperCase();
    return identifier ? { identifier } : {};
  }
  const record = asRecord(value);
  if (!record) return {};
  const identifier = firstReferenceValue(record, ["designator", "identifier", "code", "id", "name"]);
  const coordinate = firstCoordinateValue(record, ["coordinate", "coordinates"]) ?? coordinateValue(record);
  return { ...(identifier ? { identifier } : {}), ...(coordinate ? { coordinate } : {}) };
}

function normalizeRouteElement(value: unknown, index: number): FlightRouteElement | null {
  if (typeof value === "string") {
    const identifier = boundedText(value, MAX_REFERENCE_LENGTH)?.toUpperCase();
    return identifier ? { sequence: index, identifier } : null;
  }
  const record = asRecord(value);
  if (!record) return null;
  const position = asRecord(record.position);
  const designatedPoint = position && Object.prototype.hasOwnProperty.call(position, "designatedPoint")
    ? liveDesignatedPoint(position.designatedPoint)
    : {};
  const identifier = designatedPoint.identifier ?? firstReferenceValue(record, ["identifier", "ident", "designator", "waypoint", "waypointName", "fix", "fixName", "point", "code", "name"]);
  const coordinate = designatedPoint.coordinate
    ?? (position ? firstCoordinateValue(position, ["coordinate", "coordinates"]) ?? coordinateValue(position) : undefined)
    ?? (firstCoordinateValue(record, ["coordinate", "coord", "coordinates"]) ?? coordinateValue(record));
  if (!identifier && !coordinate) return null;
  const sequenceValue = firstValue(record, ["seqNum", "sequence", "seq", "order", "index"]);
  const sequence = sequenceValue === undefined ? index : Number(sequenceValue);
  if (!Number.isInteger(sequence) || sequence < 0 || sequence > MAX_ROUTE_ELEMENTS) return null;
  return { sequence, ...(identifier ? { identifier } : {}), ...(coordinate ? { coordinate } : {}) };
}

function normalizeFlightRecord(value: unknown, index: number): FlightPlanRecord | null {
  const record = asRecord(value);
  if (!record) return null;
  const callsign = firstBoundedText(record, ["aircraftIdentification", "callsign", "callSign", "flightCallsign", "flightCallSign"], MAX_REFERENCE_LENGTH);
  if (!callsign) return null;
  const departure = endpointValue(record, "departure", "departureAerodrome", ["departure", "departureAirport", "origin", "originAirport", "from", "departureCode", "dep"]);
  const destination = endpointValue(record, "arrival", "destinationAerodrome", ["destination", "destinationAirport", "arrival", "arrivalAirport", "to", "destinationCode", "dest"]);
  const routeValues = routeElementsValue(record);
  if (routeValues === null || (routeValues && routeValues.length > MAX_ROUTE_ELEMENTS)) return null;
  const elements = routeValues?.map(normalizeRouteElement);
  if (elements?.some((element) => element === null)) return null;
  const routeElements = elements as FlightRouteElement[] | undefined;
  if (routeElements) {
    const sequences = routeElements.map((element) => element.sequence);
    if (new Set(sequences).size !== sequences.length || sequences.some((sequence, routeIndex) => routeIndex > 0 && sequence <= sequences[routeIndex - 1]!)) return null;
  }
  const suppliedId = firstBoundedText(record, ["id", "flightId", "uuid", "recordId"], MAX_REFERENCE_LENGTH);
  return Object.freeze({
    id: suppliedId ?? `flight-${index + 1}`,
    callsign: callsign.toUpperCase(),
    departure,
    destination,
    ...(routeElements ? { routeElements: Object.freeze(routeElements) } : {}),
  });
}

function bytesOf(body: string): number {
  return new TextEncoder().encode(body).byteLength;
}

function evidence(family: DatasetEvidence["family"], body: string, records: number, acceptedRecords: number, rejectedRecords: number, retried: boolean, durationMs: number): DatasetEvidence {
  return Object.freeze({ family, bytes: bytesOf(body), records, acceptedRecords, rejectedRecords, retried, durationMs });
}

function collectionValue(value: unknown, family: "displayAll" | "airways" | "fixes" | "airports" | "navaids"): unknown[] {
  if (Array.isArray(value)) return value;
  let record = asRecord(value);
  for (let depth = 0; depth < 2 && record; depth += 1) {
    const nested = firstValue(record, ["data", "records", "items", "results", "flights", "flightPlans"]);
    if (Array.isArray(nested)) return nested;
    record = asRecord(nested);
  }
  throw new CaasAdapterError("INVALID_RECORD", "The upstream response did not contain the expected collection.", { family });
}

export function normalizeDisplayAll(body: string, maxRecords = FAMILY_POLICIES.displayAll.maxRecords, retried = false, durationMs = 0): DisplayAllResult {
  const values = collectionValue(jsonValue(body, "displayAll"), "displayAll");
  if (values.length > maxRecords) throw new CaasAdapterError("RECORD_LIMIT", "The upstream response exceeded its record limit.", { family: "displayAll" });
  const records = values.flatMap((value, index) => {
    const normalized = normalizeFlightRecord(value, index);
    return normalized ? [normalized] : [];
  });
  return Object.freeze({ records: Object.freeze(records), evidence: evidence("displayAll", body, values.length, records.length, values.length - records.length, retried, durationMs) });
}

export function normalizeAirways(body: string, maxRecords = FAMILY_POLICIES.airways.maxRecords, retried = false, durationMs = 0): AirwayEvidence {
  const values = jsonValue(body, "airways");
  if (!Array.isArray(values)) throw new CaasAdapterError("INVALID_RECORD", "The upstream response did not contain an airway array.", { family: "airways" });
  if (values.length > maxRecords) throw new CaasAdapterError("RECORD_LIMIT", "The upstream response exceeded its record limit.", { family: "airways" });
  const accepted = values.flatMap((value) => boundedText(value, MAX_TEXT_LENGTH) ? [boundedText(value, MAX_TEXT_LENGTH)!.toUpperCase()] : []);
  return Object.freeze({ family: "airways", bytes: bytesOf(body), records: values.length, acceptedRecords: accepted.length, rejectedRecords: values.length - accepted.length, uniqueRecords: new Set(accepted).size, retried, durationMs });
}

export function parseReferencePoint(value: unknown, dataset: ReferenceDataset): ReferencePoint | null {
  if (typeof value !== "string" || value.length > MAX_TEXT_LENGTH + MAX_REFERENCE_LENGTH + 64 || CONTROL_OR_BIDI.test(value)) return null;
  const match = IDENTIFIER_PATTERN.exec(value.trim());
  if (!match) return null;
  const identifier = boundedText(match[1], MAX_REFERENCE_LENGTH)?.toUpperCase();
  if (!identifier) return null;
  const lat = Number(match[2]);
  const lon = Number(match[3]);
  const coordinate = coordinateValue({ lat, lon });
  return coordinate ? Object.freeze({ dataset, identifier, coordinate: Object.freeze(coordinate) }) : null;
}

export function normalizeReferenceList(body: string, dataset: ReferenceDataset, maxRecords = FAMILY_POLICIES[dataset].maxRecords, retried = false, durationMs = 0): ReferenceDatasetResult {
  const values = jsonValue(body, dataset);
  if (!Array.isArray(values)) throw new CaasAdapterError("INVALID_RECORD", "The upstream response did not contain a reference array.", { family: dataset });
  if (values.length > maxRecords) throw new CaasAdapterError("RECORD_LIMIT", "The upstream response exceeded its record limit.", { family: dataset });
  const points = values.flatMap((value) => {
    const point = parseReferencePoint(value, dataset);
    return point ? [point] : [];
  });
  const index = new Map<string, readonly ReferencePoint[]>();
  for (const point of points) index.set(point.identifier, [...(index.get(point.identifier) ?? []), point]);
  for (const [key, matches] of index) index.set(key, Object.freeze(matches));
  const frozenIndex = index as ReadonlyMap<string, readonly ReferencePoint[]>;
  return Object.freeze({ dataset, points: Object.freeze(points), index: frozenIndex, evidence: evidence(dataset, body, values.length, points.length, values.length - points.length, retried, durationMs) });
}


export function normalizeFixes(body: string, retried = false, durationMs = 0): ReferenceDatasetResult {
  return normalizeReferenceList(body, "fixes", FAMILY_POLICIES.fixes.maxRecords, retried, durationMs);
}

export function normalizeAirports(body: string, retried = false, durationMs = 0): ReferenceDatasetResult {
  return normalizeReferenceList(body, "airports", FAMILY_POLICIES.airports.maxRecords, retried, durationMs);
}

export function normalizeNavaids(body: string, retried = false, durationMs = 0): ReferenceDatasetResult {
  return normalizeReferenceList(body, "navaids", FAMILY_POLICIES.navaids.maxRecords, retried, durationMs);
}
