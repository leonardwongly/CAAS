import { airportNameForIcao } from "./airport-names.ts";
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  LocationSchema,
  type Location,
} from "@flight-route-explorer/contracts";
import {
  LIVE_FRESH_MS,
  LIVE_UNUSABLE_MS,
  REFERENCE_FRESH_MS,
  REFERENCE_UNUSABLE_MS,
  liveFreshnessState,
  referenceFreshnessState,
  worseGenerationState,
  type AirwayEvidence,
  type CaasAdapter,
  type DatasetEvidence,
  type DisplayAllResult,
  type FlightPlanRecord,
  type GenerationState,
  type ReferenceDatasetResult,
  type ReferencePoint,
} from "@flight-route-explorer/upstream-caas";
import { GenerationAcquisitionError } from "./server.ts";

const PUBLIC_PROVENANCE = "CAAS normalized live generation";
export { PUBLIC_PROVENANCE };

/** Display placeholder assigned to airports without a bundled ICAO name.
 * It is a label, never an identity: it must not be indexed as a location
 * token, or every unnamed airport would resolve to every other unnamed
 * airport (phantom ambiguity and phantom duplicate groups). */
export const UNAVAILABLE_AIRPORT_NAME = "Name unavailable";

type RouteGapReason = "invalid-reference" | "not-found" | "ambiguous" | "missing";
export type { RouteGapReason };

/**
 * Plan §6.2 tiered freshness surfaced on every generation payload. The live tier
 * covers the flight-plan family (fresh <= 5 minutes, unusable after 30 minutes);
 * the reference tier covers airways/fixes/airports/navaids (fresh <= 24 hours,
 * unusable after 7 days). `overall` is the more severe tier state.
 */
export interface GenerationTier {
  readonly state: GenerationState;
  readonly retrievedAt: string;
  readonly freshUntil: string;
  readonly staleUntil: string;
}

export interface GenerationSummary {
  readonly id: string;
  readonly retrievedAt: string;
  readonly live: GenerationTier;
  readonly reference: GenerationTier;
  readonly overall: GenerationState;
}

export interface SafeFlight {
  readonly record: FlightPlanRecord;
  readonly index: number;
}

export interface Snapshot {
  readonly id: string;
  readonly retrievedAtMs: number;
  readonly unusableAtMs: number;
  readonly tokenSecret: Buffer;
  readonly flights: readonly SafeFlight[];
  readonly locations: readonly Location[];
  readonly airportLocations: readonly Location[];
  readonly locationTokens: ReadonlyMap<string, readonly number[]>;
  readonly flightByIndex: ReadonlyMap<number, SafeFlight>;
  readonly evidence: readonly PublicEvidence[];
  readonly airwayEvidence: PublicEvidence;
}

export interface PublicEvidence {
  readonly family: string;
  readonly records: number;
  readonly acceptedRecords: number;
  readonly rejectedRecords: number;
  /** Present only for the airways family, which deduplicates accepted values. */
  readonly uniqueRecords?: number;
  readonly retried: boolean;
  readonly durationMs: number;
}

export interface ScopedToken {
  readonly g?: unknown;
  readonly t?: unknown;
  readonly i?: unknown;
  readonly e?: unknown;
  readonly q?: unknown;
  readonly l?: unknown;
  readonly o?: unknown;
  readonly n?: unknown;
  readonly k?: unknown;
  /** Inclusive lower ordinal bound (donor-proof range tokens). */
  readonly f?: unknown;
  /** Inclusive upper ordinal bound (donor-proof range tokens). */
  readonly u?: unknown;
}

function immutableMap<K, V>(entries: Iterable<readonly [K, V]>): ReadonlyMap<K, V> {
  const map = new Map(entries);
  const result = {
    get size() { return map.size; },
    get: (key: K) => map.get(key),
    has: (key: K) => map.has(key),
    keys: () => map.keys(),
    values: () => map.values(),
    entries: () => map.entries(),
    forEach: (callback: (value: V, key: K, map: ReadonlyMap<K, V>) => void) => map.forEach((value, key) => callback(value, key, result)),
    [Symbol.iterator]: () => map[Symbol.iterator](),
  };
  return Object.freeze(result) as ReadonlyMap<K, V>;
}

export function token(value: string): string {
  return value.trim().toUpperCase();
}

function base64(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

export function scopedToken(snapshot: Snapshot, type: string, values: Record<string, unknown> = {}, expiresAt?: number): string {
  const body = base64(JSON.stringify({
    g: snapshot.id,
    t: type,
    e: expiresAt ?? snapshot.unusableAtMs,
    n: randomToken(),
    ...values,
  }));
  const signature = createHmac("sha256", snapshot.tokenSecret).update(body).digest("base64url");
  return `${body}.${signature}`;
}

export function readScoped(value: unknown, snapshot: Snapshot): ScopedToken | undefined {
  if (typeof value !== "string") return undefined;
  const parts = value.split(".");
  if (parts.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(parts[0]!) || !/^[A-Za-z0-9_-]+$/.test(parts[1]!)) return undefined;
  const expected = createHmac("sha256", snapshot.tokenSecret).update(parts[0]!).digest("base64url");
  const actual = Buffer.from(parts[1]!);
  const expectedBuffer = Buffer.from(expected);
  if (actual.length !== expectedBuffer.length || !timingSafeEqual(actual, expectedBuffer)) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(parts[0]!, "base64url").toString("utf8")) as unknown;
    return parsed && typeof parsed === "object" ? parsed as ScopedToken : undefined;
  } catch {
    return undefined;
  }
}

export function randomToken(): string {
  return randomBytes(24).toString("base64url");
}

function publicEvidence(evidence: DatasetEvidence | AirwayEvidence): PublicEvidence {
  return Object.freeze({
    family: evidence.family,
    records: evidence.records,
    acceptedRecords: evidence.acceptedRecords,
    rejectedRecords: evidence.rejectedRecords,
    ...("uniqueRecords" in evidence ? { uniqueRecords: evidence.uniqueRecords } : {}),
    retried: evidence.retried,
    durationMs: evidence.durationMs,
  });
}

function freezeLocation(value: unknown): Location {
  const parsed = LocationSchema.parse(value);
  return Object.freeze({
    ...parsed,
    coordinate: Object.freeze({ ...parsed.coordinate }),
    aliases: Object.freeze([...parsed.aliases]),
  }) as Location;
}

function freezeFlightRecord(record: FlightPlanRecord): FlightPlanRecord {
  return Object.freeze({
    ...record,
    ...(record.routeElements === undefined ? {} : {
      routeElements: Object.freeze(record.routeElements.map((element) => Object.freeze({
        ...element,
        ...(element.coordinate ? { coordinate: Object.freeze({ ...element.coordinate }) } : {}),
      }))),
    }),
  }) as FlightPlanRecord;
}

export function locationTokens(location: Location): string[] {
  return [
    location.id,
    location.code ?? "",
    // The placeholder is not a searchable identity (R2-G1-BUG-1): an airport
    // without a bundled name stays reachable through its id and ICAO code.
    location.name === UNAVAILABLE_AIRPORT_NAME ? "" : location.name,
    ...location.aliases,
  ].map(token).filter(Boolean);
}

function locationKind(dataset: ReferencePoint["dataset"]): Location["kind"] {
  if (dataset === "airports") return "airport";
  if (dataset === "navaids") return "station";
  return "place";
}

export function publicName(location: Location): string {
  return location.name || location.code || location.id;
}

function familyLocations(results: readonly ReferenceDatasetResult[]): Location[] {
  const locations: Location[] = [];
  for (const result of results) {
    result.points.forEach((point, index) => {
      const airportName = point.dataset === "airports" ? airportNameForIcao(point.identifier) : undefined;
      locations.push(freezeLocation({
        id: `${result.dataset.slice(0, 3)}-${index}`,
        name: airportName ?? (point.dataset === "airports" ? UNAVAILABLE_AIRPORT_NAME : point.identifier),
        code: point.identifier,
        kind: locationKind(point.dataset),
        coordinate: point.coordinate,
        aliases: [],
      }));
    });
  }
  return locations;
}

function buildSnapshot(
  display: DisplayAllResult,
  airway: AirwayEvidence,
  references: readonly ReferenceDatasetResult[],
  now: number,
): Snapshot {
  const id = randomUUID();
  const locations = familyLocations(references);
  const tokenEntries = new Map<string, number[]>();
  locations.forEach((location, index) => {
    for (const value of locationTokens(location)) tokenEntries.set(value, [...(tokenEntries.get(value) ?? []), index]);
  });
  const frozenTokenEntries = [...tokenEntries.entries()].map(([key, value]) => [key, Object.freeze([...value])] as const);
  const flights = Object.freeze(display.records.map((record, index) => Object.freeze({ record: freezeFlightRecord(record), index })));
  // Generation-bound tokens expire at the earliest unusable boundary (the live tier).
  const retrievedAtMs = now;
  const unusableAtMs = now + LIVE_UNUSABLE_MS;
  const evidence = Object.freeze([publicEvidence(display.evidence), ...references.map((result) => publicEvidence(result.evidence))]);
  return Object.freeze({
    id,
    retrievedAtMs,
    unusableAtMs,
    tokenSecret: randomBytes(32),
    flights,
    locations: Object.freeze(locations),
    airportLocations: Object.freeze(locations.filter((location) => location.kind === "airport")),
    locationTokens: immutableMap(frozenTokenEntries),
    flightByIndex: immutableMap(flights.map((flight) => [flight.index, flight] as const)),
    evidence,
    airwayEvidence: publicEvidence(airway),
  });
}

export async function acquireSnapshot(adapter: CaasAdapter, now: () => number, signal?: AbortSignal): Promise<Snapshot> {
  // Keep the five-family acquisition bounded and upstream-friendly. The generation
  // is still published atomically because buildSnapshot runs only after every
  // family has completed and validated.
  const display = await adapter.displayAll(signal);
  const airway = await adapter.airways(signal);
  const fixes = await adapter.fixes(signal);
  const airports = await adapter.airports(signal);
  const navaids = await adapter.navaids(signal);
  const references = [fixes, airports, navaids] as const;
  const totalReferenceRecords = references.reduce((total, dataset) => total + dataset.points.length, 0);
  if (totalReferenceRecords > 700_000) {
    throw new GenerationAcquisitionError("REFERENCE_RECORD_LIMIT");
  }
  return buildSnapshot(display, airway, references, now());
}

export function generationSummary(snapshot: Snapshot, now: number): GenerationSummary {
  const retrievedAt = new Date(snapshot.retrievedAtMs).toISOString();
  const elapsedMs = Math.max(0, now - snapshot.retrievedAtMs);
  const live = liveFreshnessState(elapsedMs);
  const reference = referenceFreshnessState(elapsedMs);
  const overall = worseGenerationState(live, reference);
  const tier = (state: GenerationState, freshMs: number, unusableMs: number): GenerationTier => Object.freeze({
    state,
    retrievedAt,
    freshUntil: new Date(snapshot.retrievedAtMs + freshMs).toISOString(),
    staleUntil: new Date(snapshot.retrievedAtMs + unusableMs).toISOString(),
  });
  return Object.freeze({
    id: snapshot.id,
    retrievedAt,
    live: tier(live, LIVE_FRESH_MS, LIVE_UNUSABLE_MS),
    reference: tier(reference, REFERENCE_FRESH_MS, REFERENCE_UNUSABLE_MS),
    overall,
  });
}
