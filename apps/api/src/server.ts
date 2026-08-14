import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import {
  LocationSchema,
  PERSISTENT_SAFETY_COPY,
  RANK_ONE_LABEL,
  RouteDraftSchema,
  type Coordinate,
  type Location,
  type RouteDraft,
  type RouteDraftSelection,
} from "@flight-route-explorer/contracts";
import {
  compareDistanceOperands,
  haversineDistanceNm,
  rankDistanceNm,
  resolveExactReference,
  toGeoJsonLineString,
  type ResolutionResult,
} from "@flight-route-explorer/route-engine";
import {
  createCaasAdapter,
  LIVE_FRESH_MS,
  LIVE_UNUSABLE_MS,
  REFERENCE_FRESH_MS,
  REFERENCE_UNUSABLE_MS,
  liveFreshnessState,
  referenceFreshnessState,
  worseGenerationState,
  type AirwayEvidence,
  type CaasAdapter,
  type CaasTransport,
  type DatasetEvidence,
  type DisplayAllResult,
  type FlightPlanRecord,
  type GenerationState,
  type ReferenceDatasetResult,
  type ReferencePoint,
} from "@flight-route-explorer/upstream-caas";

const DEFAULT_PORT = 8080;
const DEFAULT_HOST = "0.0.0.0";
const DEFAULT_WARM_DEADLINE_MS = 5 * 1000;
const MAX_LIMIT = 100;
const MAX_SAME_ENDPOINT_CANDIDATES = 500;
// Plan §6.1: ambiguity page 50 results; hard total 500 — above it the API
// fails closed and requires a narrower term instead of dumping matches.
const AMBIGUITY_PAGE = 50;
const AMBIGUITY_HARD_TOTAL = 500;
// Plan §6.1: browser response hard limit 2 MiB — a larger payload fails
// closed with a bounded error instead of emitting an over-limit body.
const MAX_BROWSER_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_DRAFT_ENTRIES = 512;
const MAX_SEARCH_LENGTH = 64;
const MAX_ERROR_MESSAGE = 160;
const PUBLIC_PROVENANCE = "CAAS normalized live generation";
const OPERATIONAL_PROXY_SUMMARY = "Shortest complete normalized observed route among same-endpoint candidates returned by this fresh generation.";

type RouteGapReason = "invalid-reference" | "not-found" | "ambiguous" | "missing";

export interface ApiServerOptions {
  readonly adapter?: CaasAdapter;
  readonly transport?: CaasTransport;
  readonly now?: () => number;
  readonly warmRequestDeadlineMs?: number;
  readonly initialize?: boolean;
  readonly assetDirectory?: string;
  readonly refreshSecret?: string;
  readonly logger?: boolean;
}

export interface StartServerOptions extends ApiServerOptions {
  readonly port?: number;
  readonly host?: string;
}

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

interface SafeFlight {
  readonly record: FlightPlanRecord;
  readonly index: number;
}

interface Snapshot {
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

interface PublicEvidence {
  readonly family: string;
  readonly records: number;
  readonly acceptedRecords: number;
  readonly rejectedRecords: number;
  readonly retried: boolean;
  readonly durationMs: number;
}

interface PublicGap {
  readonly status: "gap";
  readonly sequence: number;
  readonly reason: RouteGapReason;
}

interface PublicLeg {
  readonly id: string;
  readonly sequence: number;
  readonly kind: "segment" | "gap";
  readonly status: "resolved" | "gap";
  readonly from?: string;
  readonly to?: string;
  readonly distanceNm?: number;
  readonly reason?: RouteGapReason;
}

interface PublicWaypoint {
  readonly sequence: number;
  readonly status: "resolved" | "gap";
  readonly label?: string;
  readonly reason?: RouteGapReason;
}

interface RouteProjection {
  readonly id: string;
  readonly flight: SafeFlight;
  readonly origin: Location;
  readonly destination: Location;
  readonly legs: readonly PublicLeg[];
  readonly waypoints: readonly PublicWaypoint[];
  readonly segments: readonly (readonly Coordinate[])[];
  readonly gaps: readonly PublicGap[];
  readonly distanceNm: number | undefined;
  readonly rankDistanceNm: number | undefined;
  readonly complete: boolean;
  readonly pointCount: number;
  readonly signature: string;
}

interface RouteCandidate {
  readonly projection: RouteProjection;
  /** Opaque API flight tokens retained for internal source/provenance tracking. */
  readonly sourceFlightIds: readonly string[];
  readonly selected: boolean;
}

interface DraftEntry {
  readonly snapshotId: string;
  readonly draft: RouteDraft;
}

interface ScopedToken {
  readonly g?: unknown;
  readonly t?: unknown;
  readonly i?: unknown;
  readonly e?: unknown;
  readonly q?: unknown;
  readonly l?: unknown;
  readonly o?: unknown;
  readonly n?: unknown;
}

export class ApiHttpError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly retryable: boolean;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(statusCode: number, code: string, message: string, retryable = false, details?: Readonly<Record<string, unknown>>) {
    super(message);
    this.name = "ApiHttpError";
    this.statusCode = statusCode;
    this.code = code;
    this.retryable = retryable;
    this.details = details;
  }
}

export class GenerationAcquisitionError extends Error {
  readonly causeCode: string;

  constructor(causeCode = "UPSTREAM_UNAVAILABLE") {
    super("The live data generation could not be acquired.");
    this.name = "GenerationAcquisitionError";
    this.causeCode = causeCode;
  }
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

function token(value: string): string {
  return value.trim().toUpperCase();
}

function base64(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

function scopedToken(snapshot: Snapshot, type: string, values: Record<string, unknown> = {}): string {
  const body = base64(JSON.stringify({
    g: snapshot.id,
    t: type,
    e: snapshot.unusableAtMs,
    n: randomToken(),
    ...values,
  }));
  const signature = createHmac("sha256", snapshot.tokenSecret).update(body).digest("base64url");
  return `${body}.${signature}`;
}

function readScoped(value: unknown, snapshot: Snapshot): ScopedToken | undefined {
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

function randomToken(): string {
  return randomBytes(24).toString("base64url");
}

function publicEvidence(evidence: DatasetEvidence | AirwayEvidence): PublicEvidence {
  return Object.freeze({
    family: evidence.family,
    records: evidence.records,
    acceptedRecords: evidence.acceptedRecords,
    rejectedRecords: evidence.rejectedRecords,
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

function locationTokens(location: Location): string[] {
  return [location.id, location.code ?? "", location.name, ...location.aliases].map(token).filter(Boolean);
}

function locationKind(dataset: ReferencePoint["dataset"]): Location["kind"] {
  if (dataset === "airports") return "airport";
  if (dataset === "navaids") return "station";
  return "place";
}

function publicName(location: Location): string {
  return location.name || location.code || location.id;
}

function flightMatchesAirport(snapshot: Snapshot, reference: string | null, airport: Location): boolean {
  if (reference === null || !reference.trim()) return false;
  const result = resolveExactReference({ value: reference }, snapshot.airportLocations);
  return result.status === "resolved" && result.match.id === airport.id;
}

function deduplicateRouteCandidates(
  projections: readonly RouteProjection[],
  selectedFlightIndex: number,
): RouteCandidate[] {
  const candidates = new Map<string, RouteCandidate>();
  for (const projection of projections) {
    const sourceFlightId = projection.id;
    const selected = projection.flight.index === selectedFlightIndex;
    const existing = candidates.get(projection.signature);
    if (!existing) {
      candidates.set(projection.signature, { projection, sourceFlightIds: [sourceFlightId], selected });
      continue;
    }
    const representative = selected && !existing.selected ? projection : existing.projection;
    candidates.set(projection.signature, {
      projection: representative,
      sourceFlightIds: Object.freeze([...existing.sourceFlightIds, sourceFlightId]),
      selected: existing.selected || selected,
    });
  }
  return [...candidates.values()];
}

function familyLocations(results: readonly ReferenceDatasetResult[]): Location[] {
  const locations: Location[] = [];
  for (const result of results) {
    result.points.forEach((point, index) => {
      locations.push(freezeLocation({
        id: `${result.dataset.slice(0, 3)}-${index}`,
        name: point.identifier,
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

async function acquireSnapshot(adapter: CaasAdapter, now: () => number, signal?: AbortSignal): Promise<Snapshot> {
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

function generationSummary(snapshot: Snapshot, now: number): GenerationSummary {
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

export class GenerationStore {
  private activeSnapshot: Snapshot | undefined;
  private previousSnapshot: Snapshot | undefined;
  private state: "cold" | "loading" | "ready" | "failed" = "cold";
  private failureCode: string | undefined;
  private readonly drafts = new Map<string, DraftEntry>();
  private readonly adapter: CaasAdapter;
  private readonly now: () => number;

  constructor(adapter: CaasAdapter, now: () => number = Date.now) {
    this.adapter = adapter;
    this.now = now;
  }

  get status(): "cold" | "loading" | "ready" | "failed" { return this.state; }
  get failure(): string | undefined { return this.failureCode; }
  get active(): Snapshot | undefined { return this.activeSnapshot; }
  /** The immediately previous generation, retained only within plan §6.2 freshness limits. */
  get previous(): Snapshot | undefined { return this.previousSnapshot; }

  async initialize(): Promise<Snapshot> {
    if (this.activeSnapshot && this.state === "ready") return this.activeSnapshot;
    this.state = "loading";
    try {
      const snapshot = await acquireSnapshot(this.adapter, this.now);
      this.activeSnapshot = snapshot;
      this.state = "ready";
      this.failureCode = undefined;
      return snapshot;
    } catch {
      this.state = "failed";
      this.failureCode = "UPSTREAM_UNAVAILABLE";
      throw new GenerationAcquisitionError();
    }
  }

  /**
   * Plan §6.2 stale-generation state machine. A successful refresh atomically
   * swaps in the newly validated generation and retains the previous active
   * generation only while it is still servable (at most 30 minutes). A failed
   * refresh keeps the prior generation only within those freshness limits.
   * Nothing persists across restart: the store is per-process and tokens from
   * another server fail HMAC.
   */
  async refresh(signal?: AbortSignal): Promise<Snapshot> {
    this.state = "loading";
    try {
      const snapshot = await acquireSnapshot(this.adapter, this.now, signal);
      const current = this.activeSnapshot;
      this.previousSnapshot = current !== undefined && this.isServable(current) ? current : undefined;
      this.activeSnapshot = snapshot;
      this.state = "ready";
      this.failureCode = undefined;
      for (const [draftId, entry] of this.drafts) if (entry.snapshotId !== snapshot.id) this.drafts.delete(draftId);
      return snapshot;
    } catch {
      this.state = this.activeSnapshot ? "ready" : "failed";
      this.failureCode = "UPSTREAM_UNAVAILABLE";
      this.prunePrevious();
      throw new GenerationAcquisitionError();
    }
  }

  /** The retained (still active) generation after a failed refresh, if any. */
  retainedGeneration(): GenerationSummary | undefined {
    return this.activeSnapshot ? generationSummary(this.activeSnapshot, this.now()) : undefined;
  }

  readiness(): { ready: boolean; code?: string; snapshot?: Snapshot } {
    this.prunePrevious();
    if (!this.activeSnapshot) return { ready: false, code: this.failureCode ?? "NOT_INITIALIZED" };
    if (!this.isServable(this.activeSnapshot)) return { ready: false, code: "GENERATION_STALE", snapshot: this.activeSnapshot };
    return { ready: true, snapshot: this.activeSnapshot };
  }

  private isServable(snapshot: Snapshot): boolean {
    const elapsedMs = Math.max(0, this.now() - snapshot.retrievedAtMs);
    return worseGenerationState(liveFreshnessState(elapsedMs), referenceFreshnessState(elapsedMs)) !== "unusable";
  }

  private prunePrevious(): void {
    const previous = this.previousSnapshot;
    if (previous === undefined) return;
    const elapsedMs = Math.max(0, this.now() - previous.retrievedAtMs);
    if (worseGenerationState(liveFreshnessState(elapsedMs), referenceFreshnessState(elapsedMs)) === "unusable") {
      this.previousSnapshot = undefined;
    }
  }

  requireSnapshot(): Snapshot {
    const result = this.readiness();
    if (!result.ready || !result.snapshot) throw new ApiHttpError(503, result.code ?? "NOT_READY", "The route data is not ready.", true);
    return result.snapshot;
  }

  rememberDraft(draft: RouteDraft, snapshot: Snapshot): string {
    if (this.drafts.size >= MAX_DRAFT_ENTRIES) {
      throw new ApiHttpError(429, "DRAFT_CAPACITY_REACHED", "The active data generation has reached its draft capacity. Refresh or retry after the generation changes.", true);
    }
    const id = scopedToken(snapshot, "draft");
    this.drafts.set(id, Object.freeze({ snapshotId: snapshot.id, draft: Object.freeze({ ...draft }) }));
    return id;
  }

  getDraft(id: string, snapshot: Snapshot): RouteDraft {
    const decoded = readScoped(id, snapshot);
    // Inclusive boundary, like decodeScoped/cursorOffset: at exactly the
    // unusable instant the generation is still servable ("stale").
    if (!decoded || decoded.g !== snapshot.id || decoded.t !== "draft" || typeof decoded.e !== "number" || decoded.e < this.now() || typeof decoded.n !== "string") {
      throw new ApiHttpError(410, "DRAFT_EXPIRED", "The draft is no longer available.");
    }
    const entry = this.drafts.get(id);
    if (!entry || entry.snapshotId !== snapshot.id) throw new ApiHttpError(410, "DRAFT_EXPIRED", "The draft is no longer available.");
    return entry.draft;
  }
}

function idsForLocation(snapshot: Snapshot, location: Location): number[] {
  const values = new Set<number>();
  for (const value of locationTokens(location)) for (const index of snapshot.locationTokens.get(value) ?? []) values.add(index);
  return [...values];
}

function resolveAirportEndpoint(snapshot: Snapshot, value: unknown, field: string): Location {
  if (typeof value !== "string" || !value.trim() || value.length > MAX_SEARCH_LENGTH) throw new ApiHttpError(400, "INVALID_ENDPOINTS", `${field} is required.`);
  const result = resolveExactReference({ value }, snapshot.airportLocations);
  if (result.status === "ambiguous") throw new ApiHttpError(409, "AMBIGUOUS_ENDPOINT", `${field} matches multiple airports.`);
  if (result.status !== "resolved") throw new ApiHttpError(404, "AIRPORT_NOT_FOUND", `${field} was not found in the airport reference data.`);
  return result.match;
}

function decodeScoped(value: unknown, snapshot: Snapshot, type: string, now = Date.now): number {
  const decoded = readScoped(value, snapshot);
  if (!decoded || decoded.g !== snapshot.id || decoded.t !== type || typeof decoded.e !== "number" || decoded.e < now() || typeof decoded.n !== "string" || typeof decoded.i !== "number" || !Number.isInteger(decoded.i) || decoded.i < 0) {
    throw new ApiHttpError(410, "GENERATION_EXPIRED", "The requested item belongs to an older data generation.");
  }
  return decoded.i;
}

function publicLocation(snapshot: Snapshot, index: number, duplicateIndexes: readonly number[]): Record<string, unknown> {
  const location = snapshot.locations[index];
  if (!location) throw new ApiHttpError(404, "POINT_NOT_FOUND", "The requested point was not found.");
  const group = duplicateIndexes.length > 1 ? scopedToken(snapshot, "duplicate", { i: duplicateIndexes[0] }) : undefined;
  return {
    id: scopedToken(snapshot, "location", { i: index }),
    callsign: location.code ?? location.name,
    name: publicName(location),
    kind: location.kind,
    coordinate: location.coordinate,
    ...(group ? { duplicateGroup: group } : {}),
  };
}

function selectionMap(draft: RouteDraft): ReadonlyMap<number, RouteDraftSelection> {
  const bySequence = new Map<number, RouteDraftSelection>();
  for (const selection of draft.selections) {
    if (bySequence.has(selection.sequence)) throw new ApiHttpError(400, "INVALID_DRAFT", "A draft waypoint may have only one explicit coordinate selection.");
    if (selection.sequence >= draft.via.length) throw new ApiHttpError(400, "INVALID_DRAFT", "An explicit coordinate selection must reference an existing draft waypoint.");
    bySequence.set(selection.sequence, selection);
  }
  return bySequence;
}

function decodeSelectionToken(value: unknown): ScopedToken | undefined {
  if (typeof value !== "string") return undefined;
  const parts = value.split(".");
  if (parts.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(parts[0]!) || !/^[A-Za-z0-9_-]+$/.test(parts[1]!)) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(parts[0]!, "base64url").toString("utf8")) as unknown;
    return parsed && typeof parsed === "object" ? parsed as ScopedToken : undefined;
  } catch {
    return undefined;
  }
}

function verifySelectionSignature(value: string, snapshot: Snapshot): boolean {
  const parts = value.split(".");
  const expected = createHmac("sha256", snapshot.tokenSecret).update(parts[0]!).digest("base64url");
  const actual = Buffer.from(parts[1]!);
  const expectedBuffer = Buffer.from(expected);
  return actual.length === expectedBuffer.length && timingSafeEqual(actual, expectedBuffer);
}

function selectedLocation(snapshot: Snapshot, selection: RouteDraftSelection, reference: string, now: () => number): Location {
  // Decode the body first so a genuine selection from an older generation can be
  // told apart from a forged one: the token secret rotates with every snapshot,
  // so an old-generation token no longer verifies. Both paths fail closed.
  const decoded = decodeSelectionToken(selection.locationId);
  if (!decoded) throw new ApiHttpError(400, "TOKEN_INVALID", "The explicit coordinate selection is not a valid service-issued selection.");
  if (decoded.g !== snapshot.id || typeof decoded.e !== "number" || decoded.e < now() || typeof decoded.n !== "string") {
    throw new ApiHttpError(410, "GENERATION_EXPIRED", "The explicit coordinate selection belongs to an older data generation.");
  }
  if (decoded.t !== "location" || typeof decoded.i !== "number" || !Number.isInteger(decoded.i) || decoded.i < 0) {
    throw new ApiHttpError(400, "TOKEN_INVALID", "The explicit coordinate selection is not a service-issued location selection.");
  }
  if (!verifySelectionSignature(selection.locationId, snapshot)) {
    throw new ApiHttpError(400, "TOKEN_INVALID", "The explicit coordinate selection signature is invalid.");
  }
  const location = snapshot.locations[decoded.i];
  if (!location) throw new ApiHttpError(404, "POINT_NOT_FOUND", "The selected point was not found.");
  // Pair the selection with its waypoint reference: a selection is only usable at the
  // exact waypoint it was issued for. It is never interpreted as a nearby or inferred choice.
  const resolved = resolveExactReference({ value: reference }, [location]);
  if (resolved.status !== "resolved") throw new ApiHttpError(409, "SELECTION_MISMATCH", "The explicit coordinate selection does not match the referenced draft waypoint.");
  return location;
}

function displayReference(location: Location): string {
  return location.code ?? location.name;
}

function flightId(snapshot: Snapshot, flightIndex: number): string {
  return scopedToken(snapshot, "flight", { i: flightIndex });
}

function coordinateKey(coordinate: Coordinate): string {
  return `${String(coordinate.lat)},${String(coordinate.lon)}`;
}

function isSameCoordinate(left: Coordinate, right: Coordinate): boolean {
  return left.lat === right.lat && left.lon === right.lon;
}

function routeProjection(
  snapshot: Snapshot,
  flight: SafeFlight,
  origin: Location,
  destination: Location,
  routeId = flightId(snapshot, flight.index),
): RouteProjection {
  const record = flight.record;
  const routeIdValue = routeId;
  const elements = record.routeElements;
  const occurrences: Array<{ point: { label: string; coordinate: Coordinate; sequence: number } } | { gap: PublicGap }> = [
    { point: { label: displayReference(origin), coordinate: origin.coordinate, sequence: -1 } },
  ];
  const gaps: PublicGap[] = [];
  if (elements === undefined) {
    const gap = { status: "gap" as const, sequence: 0, reason: "missing" as const };
    occurrences.push({ gap });
    gaps.push(gap);
  } else {
    for (const element of [...elements].sort((left, right) => left.sequence - right.sequence)) {
      if (element.coordinate) {
        let label = `Point ${element.sequence + 1}`;
        if (element.identifier) {
          const named = resolveExactReference({ value: element.identifier }, snapshot.locations);
          if (named.status === "resolved") label = displayReference(named.match);
        }
        occurrences.push({ point: { label, coordinate: element.coordinate, sequence: element.sequence } });
        continue;
      }
      const result = element.identifier ? resolveExactReference({ value: element.identifier }, snapshot.locations) : { status: "gap" as const } as ResolutionResult;
      const reason: RouteGapReason = result.status === "ambiguous" ? "ambiguous" : result.status === "resolved" ? "not-found" : element.identifier ? "not-found" : "missing";
      if (result.status === "resolved") {
        occurrences.push({ point: { label: displayReference(result.match), coordinate: result.match.coordinate, sequence: element.sequence } });
      } else {
        const gap = { status: "gap" as const, sequence: element.sequence, reason };
        occurrences.push({ gap });
        gaps.push(gap);
      }
    }
  }
  occurrences.push({ point: { label: displayReference(destination), coordinate: destination.coordinate, sequence: Number.MAX_SAFE_INTEGER } });

  // Remove only route points directly adjacent to the corresponding endpoint.
  // Guard: with zero route elements the only occurrences are the two endpoints
  // themselves; a co-located origin/destination is a real zero-distance leg and
  // must never be spliced away (it is not a duplicate route point).
  if (occurrences.length > 2) {
    const firstRouteOccurrence = occurrences[1];
    const firstEndpoint = occurrences[0];
    if (firstRouteOccurrence && firstEndpoint && "point" in firstRouteOccurrence && "point" in firstEndpoint && isSameCoordinate(firstEndpoint.point.coordinate, firstRouteOccurrence.point.coordinate)) occurrences.splice(1, 1);
    const last = occurrences.length - 2;
    const lastRouteOccurrence = occurrences[last];
    const lastEndpoint = occurrences[occurrences.length - 1];
    if (last > 0 && lastRouteOccurrence && lastEndpoint && "point" in lastRouteOccurrence && "point" in lastEndpoint && isSameCoordinate(lastRouteOccurrence.point.coordinate, lastEndpoint.point.coordinate)) occurrences.splice(last, 1);
  }

  const waypoints = Object.freeze(occurrences.map((occurrence) => "gap" in occurrence
    ? Object.freeze({ sequence: occurrence.gap.sequence, status: "gap" as const, reason: occurrence.gap.reason })
    : Object.freeze({ sequence: occurrence.point.sequence, status: "resolved" as const, label: occurrence.point.label })));
  const legs: PublicLeg[] = [];
  const segments: Coordinate[][] = [];
  let chain: Array<{ label: string; coordinate: Coordinate; sequence: number }> = [];
  const flush = () => {
    if (chain.length >= 2) {
      segments.push(chain.map((point) => point.coordinate));
      for (let index = 1; index < chain.length; index += 1) {
        const from = chain[index - 1]!;
        const to = chain[index]!;
        legs.push({
          id: scopedToken(snapshot, "leg", { i: flight.index, o: legs.length }),
          sequence: to.sequence,
          kind: "segment",
          status: "resolved",
          from: from.label,
          to: to.label,
          distanceNm: haversineDistanceNm(from.coordinate, to.coordinate),
        });
      }
    }
    chain = [];
  };
  for (const occurrence of occurrences) {
    if ("gap" in occurrence) {
      flush();
      legs.push({ id: scopedToken(snapshot, "gap-leg", { i: flight.index, o: legs.length }), sequence: occurrence.gap.sequence, kind: "gap", status: "gap", reason: occurrence.gap.reason });
    } else {
      chain.push(occurrence.point);
    }
  }
  flush();
  const complete = elements !== undefined && gaps.length === 0 && segments.length === 1;
  const distanceNm = complete ? legs.reduce((sum, leg) => sum + (leg.distanceNm ?? 0), 0) : undefined;
  const pointCount = occurrences.filter((occurrence): occurrence is { point: { label: string; coordinate: Coordinate; sequence: number } } => "point" in occurrence).length;
  const signature = occurrences.map((occurrence) => "gap" in occurrence ? `g:${occurrence.gap.sequence}:${occurrence.gap.reason}` : `p:${occurrence.point.sequence}:${coordinateKey(occurrence.point.coordinate)}`).join("|");
  return Object.freeze({
    id: routeIdValue,
    flight,
    origin,
    destination,
    legs: Object.freeze(legs),
    waypoints: Object.freeze(waypoints),
    segments: Object.freeze(segments.map((segment) => Object.freeze(segment))),
    gaps: Object.freeze(gaps),
    distanceNm,
    rankDistanceNm: distanceNm === undefined ? undefined : rankDistanceNm(distanceNm),
    complete,
    pointCount,
    signature,
  });
}

function operationalProxy(projection: RouteProjection, rank?: number): Record<string, unknown> {
  // A complete candidate with modeled distances is eligible whether or not a
  // competition rank was computed for this surface (the route-detail view has
  // no population to rank against); only genuinely incomplete geometry is
  // ineligible.
  const eligible = projection.complete && projection.distanceNm !== undefined && projection.rankDistanceNm !== undefined;
  return Object.freeze({
    mode: "operational-proxy",
    eligible,
    criterion: "minimum-modeled-distance-nm",
    summary: OPERATIONAL_PROXY_SUMMARY,
    ...(eligible ? { ...(rank !== undefined ? { rank } : {}) } : { exclusion: "Route geometry is incomplete or unresolved." }),
  });
}

function routeDto(snapshot: Snapshot, projection: RouteProjection, rank?: number, includeOperationalProxy = true): Record<string, unknown> {
  const geometry = projection.complete && projection.segments[0] && projection.segments[0].length >= 2 ? toGeoJsonLineString(projection.segments[0]) : undefined;
  return {
    id: projection.id,
    flightId: projection.id,
    callsign: projection.flight.record.callsign,
    status: projection.complete ? "complete" : "incomplete",
    label: `${projection.flight.record.callsign} route`,
    origin: displayReference(projection.origin),
    destination: displayReference(projection.destination),
    pointCount: projection.pointCount,
    complete: projection.complete,
    legs: projection.legs,
    ...(projection.distanceNm === undefined ? {} : { distanceNm: projection.distanceNm, rankDistanceNm: projection.rankDistanceNm, ...(rank === undefined ? {} : { rank }) }),
    ...(includeOperationalProxy ? { operationalProxy: operationalProxy(projection, rank) } : {}),
    ...(geometry ? { geometry } : {}),
    ...(projection.segments.length > 0 ? { segments: projection.segments.map((points) => toGeoJsonLineString(points)) } : {}),
    provenance: PUBLIC_PROVENANCE,
    freshness: new Date(snapshot.retrievedAtMs).toISOString(),
    safety: PERSISTENT_SAFETY_COPY,
    gaps: projection.gaps,
  };
}

function waypointKey(waypoint: PublicWaypoint): string {
  return waypoint.status === "resolved"
    ? `resolved:${waypoint.label ?? ""}`
    : `gap:${waypoint.reason ?? "missing"}`;
}

function waypointDifference(baseline: readonly PublicWaypoint[], target: readonly PublicWaypoint[]): Record<string, unknown>[] {
  const lengths = Array.from({ length: baseline.length + 1 }, () => Array<number>(target.length + 1).fill(0));
  for (let baselineIndex = baseline.length - 1; baselineIndex >= 0; baselineIndex -= 1) {
    for (let targetIndex = target.length - 1; targetIndex >= 0; targetIndex -= 1) {
      lengths[baselineIndex]![targetIndex] = waypointKey(baseline[baselineIndex]!) === waypointKey(target[targetIndex]!)
        ? 1 + lengths[baselineIndex + 1]![targetIndex + 1]!
        : Math.max(lengths[baselineIndex + 1]![targetIndex]!, lengths[baselineIndex]![targetIndex + 1]!);
    }
  }
  const differences: Record<string, unknown>[] = [];
  let baselineIndex = 0;
  let targetIndex = 0;
  while (baselineIndex < baseline.length || targetIndex < target.length) {
    const baselineWaypoint = baseline[baselineIndex];
    const targetWaypoint = target[targetIndex];
    if (baselineWaypoint && targetWaypoint && waypointKey(baselineWaypoint) === waypointKey(targetWaypoint)) {
      baselineIndex += 1;
      targetIndex += 1;
    } else if (!targetWaypoint || (baselineWaypoint && lengths[baselineIndex + 1]![targetIndex]! >= lengths[baselineIndex]![targetIndex + 1]!)) {
      differences.push({ kind: "removed", sequence: baselineWaypoint!.sequence, status: baselineWaypoint!.status, ...(baselineWaypoint!.label ? { label: baselineWaypoint!.label } : {}), ...(baselineWaypoint!.reason ? { reason: baselineWaypoint!.reason } : {}) });
      baselineIndex += 1;
    } else {
      differences.push({ kind: "added", sequence: targetWaypoint.sequence, status: targetWaypoint.status, ...(targetWaypoint.label ? { label: targetWaypoint.label } : {}), ...(targetWaypoint.reason ? { reason: targetWaypoint.reason } : {}) });
      targetIndex += 1;
    }
  }
  return differences;
}

interface DraftProjection {
  readonly origin: Location;
  readonly destination: Location;
  readonly legs: readonly PublicLeg[];
  readonly waypoints: readonly PublicWaypoint[];
  readonly segments: readonly (readonly Coordinate[])[];
  readonly gaps: readonly PublicGap[];
  readonly complete: boolean;
  readonly distanceNm: number | undefined;
  readonly rankDistanceNm: number | undefined;
  readonly pointCount: number;
}

/**
 * Resolves a local draft against the active generation. Ambiguous waypoints fail
 * closed (gap reason "ambiguous") unless an explicit selection token was supplied
 * and binds to one of the waypoint's exact matches. Selections are never treated
 * as nearby or inferred choices.
 */
function resolveDraftProjection(snapshot: Snapshot, draft: RouteDraft, now: () => number): DraftProjection {
  const origin = resolveAirportEndpoint(snapshot, draft.origin, "origin");
  const destination = resolveAirportEndpoint(snapshot, draft.destination, "destination");
  const selections = selectionMap(draft);
  const references = [displayReference(origin), ...draft.via, displayReference(destination)];
  const points: Array<{ label: string; location?: Location }> = [];
  const gaps: PublicGap[] = [];
  const waypoints: PublicWaypoint[] = [];
  for (const [sequence, reference] of references.entries()) {
    const endpoint = sequence === 0 ? origin : sequence === references.length - 1 ? destination : undefined;
    let resolution: ResolutionResult;
    if (endpoint) {
      resolution = { status: "resolved", reference: { value: endpoint.id, kind: endpoint.kind }, match: endpoint };
    } else {
      const selection = selections.get(sequence - 1);
      resolution = selection
        ? { status: "resolved", reference: { value: reference, kind: "unknown" }, match: selectedLocation(snapshot, selection, reference, now) }
        : resolveExactReference({ value: reference }, snapshot.locations);
    }
    if (resolution.status === "resolved") {
      points.push({ label: displayReference(resolution.match), location: resolution.match });
      waypoints.push(Object.freeze({ sequence, status: "resolved" as const, label: displayReference(resolution.match) }));
    } else {
      points.push({ label: `Point ${sequence + 1}` });
      gaps.push({ status: "gap", sequence, reason: resolution.status === "ambiguous" ? "ambiguous" : "not-found" });
      waypoints.push(Object.freeze({ sequence, status: "gap" as const, reason: resolution.status === "ambiguous" ? "ambiguous" as const : "not-found" as const }));
    }
  }
  const legs: PublicLeg[] = [];
  const segments: Coordinate[][] = [];
  let chain: Array<{ label: string; coordinate: Coordinate }> = [];
  const flush = () => {
    if (chain.length >= 2) {
      segments.push(chain.map((point) => point.coordinate));
      for (let index = 1; index < chain.length; index += 1) {
        const from = chain[index - 1]!;
        const to = chain[index]!;
        legs.push({ id: scopedToken(snapshot, "draft-leg", { o: legs.length }), sequence: legs.length, kind: "segment", status: "resolved", from: from.label, to: to.label, distanceNm: haversineDistanceNm(from.coordinate, to.coordinate) });
      }
    }
    chain = [];
  };
  points.forEach((point, index) => { if (point.location) chain.push({ label: point.label, coordinate: point.location.coordinate }); else { flush(); legs.push({ id: scopedToken(snapshot, "draft-gap-leg", { o: legs.length }), sequence: index, kind: "gap", status: "gap", reason: gaps.find((gap) => gap.sequence === index)?.reason ?? "not-found" }); } });
  flush();
  const complete = gaps.length === 0 && legs.length === references.length - 1;
  const distanceNm = complete ? legs.reduce((sum, leg) => sum + (leg.distanceNm ?? 0), 0) : undefined;
  const pointCount = points.length;
  return Object.freeze({
    origin,
    destination,
    legs: Object.freeze(legs),
    waypoints: Object.freeze(waypoints),
    segments: Object.freeze(segments.map((segment) => Object.freeze(segment))),
    gaps: Object.freeze(gaps),
    complete,
    distanceNm,
    rankDistanceNm: distanceNm === undefined ? undefined : rankDistanceNm(distanceNm),
    pointCount,
  });
}

function draftRouteDto(snapshot: Snapshot, projection: DraftProjection, id: string): Record<string, unknown> {
  const routeLegs: PublicLeg[] = projection.complete
    ? [...projection.legs]
    : projection.legs.map((leg) => {
      const { distanceNm: _distanceNm, ...withoutDistance } = leg;
      return withoutDistance;
    });
  return {
    id,
    origin: displayReference(projection.origin),
    destination: displayReference(projection.destination),
    legs: routeLegs,
    gaps: projection.gaps,
    ...(projection.distanceNm === undefined ? {} : { distanceNm: projection.distanceNm, rankDistanceNm: projection.rankDistanceNm }),
    ...(projection.complete && projection.segments.length === 1 ? { geometry: toGeoJsonLineString(projection.segments[0]!) } : {}),
    provenance: PUBLIC_PROVENANCE,
    freshness: new Date(snapshot.retrievedAtMs).toISOString(),
    safety: PERSISTENT_SAFETY_COPY,
  };
}

function compareProjections(
  snapshot: Snapshot,
  baseline: RouteProjection,
  target: DraftProjection,
  now: () => number,
  targetId = "local-draft",
): Record<string, unknown> {
  if (baseline.origin.id !== target.origin.id || baseline.destination.id !== target.destination.id) {
    throw new ApiHttpError(409, "ENDPOINT_MISMATCH", "Both routes must resolve to the same airport endpoints in the active generation.");
  }
  const waypointDifferences = waypointDifference(baseline.waypoints, target.waypoints);
  const removedWaypointCount = waypointDifferences.filter((difference) => difference.kind === "removed").length;
  const addedWaypointCount = waypointDifferences.length - removedWaypointCount;
  const distance = compareDistanceOperands(baseline.distanceNm, target.distanceNm);
  return {
    baseline: routeDto(snapshot, baseline, undefined, false),
    target: draftRouteDto(snapshot, target, targetId),
    comparison: {
      status: distance.status,
      message: distance.status === "complete"
        ? "Directional modeled-distance difference from baseline to target. This is not an operational recommendation."
        : "Modeled-distance difference is unavailable because one or both normalized route geometries are incomplete or unresolved.",
      ...(distance.distanceDeltaNm !== undefined ? { distanceDeltaNm: distance.distanceDeltaNm } : {}),
      ...(distance.percentageDistanceDelta !== undefined ? { percentageDistanceDelta: distance.percentageDistanceDelta } : {}),
      ...(distance.unavailable.length > 0 ? { unavailable: [...distance.unavailable] } : {}),
      addedWaypointCount,
      removedWaypointCount,
      waypointDifferences,
    },
    generation: generationSummary(snapshot, now()),
  };
}

function parseLimit(value: unknown): number {
  if (value === undefined) return 50;
  const parsed = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_LIMIT) throw new ApiHttpError(400, "INVALID_LIMIT", "The limit must be an integer from 1 to 100.");
  return parsed;
}

function queryObject(request: FastifyRequest, allowed: readonly string[]): Record<string, unknown> {
  if (!request.query || typeof request.query !== "object" || Array.isArray(request.query)) throw new ApiHttpError(400, "INVALID_QUERY", "The query must be an object.");
  const query = request.query as Record<string, unknown>;
  if (Object.keys(query).some((key) => !allowed.includes(key))) throw new ApiHttpError(400, "INVALID_QUERY", "The request contains an unsupported query parameter.");
  if (Object.values(query).some((value) => Array.isArray(value))) throw new ApiHttpError(400, "INVALID_QUERY", "Query parameters must have one value.");
  return query;
}

function bodyObject(request: FastifyRequest, allowed: readonly string[]): Record<string, unknown> {
  if (!request.body || typeof request.body !== "object" || Array.isArray(request.body)) throw new ApiHttpError(400, "INVALID_BODY", "The request body must be an object.");
  const body = request.body as Record<string, unknown>;
  if (Object.keys(body).some((key) => !allowed.includes(key))) throw new ApiHttpError(400, "INVALID_BODY", "The request contains an unsupported field.");
  return body;
}

function assertEmptyBody(request: FastifyRequest): void {
  if (request.body !== undefined) bodyObject(request, []);
}

function requiredString(value: unknown, code: string, message: string, max = MAX_SEARCH_LENGTH): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new ApiHttpError(400, code, message);
  return value.trim();
}

function cursorOffset(value: unknown, snapshot: Snapshot, query: string, limit: number, type: string, now = Date.now): number {
  const decoded = readScoped(value, snapshot);
  if (!decoded || decoded.g !== snapshot.id || decoded.t !== type || decoded.q !== query || decoded.l !== limit || typeof decoded.e !== "number" || decoded.e < now() || typeof decoded.n !== "string" || typeof decoded.o !== "number" || !Number.isInteger(decoded.o) || decoded.o < 0) {
    throw new ApiHttpError(409, "CURSOR_EXPIRED", "The cursor is invalid, expired, or belongs to another query, limit, or data generation.");
  }
  return decoded.o;
}

function readinessPayload(store: GenerationStore, now: () => number): Record<string, unknown> {
  const readiness = store.readiness();
  return readiness.ready && readiness.snapshot
    ? { status: "ready", generation: generationSummary(readiness.snapshot, now()), families: readiness.snapshot.evidence.map((item) => ({ family: item.family, status: "available" })), airway: { status: "available" } }
    : { status: "unavailable", code: readiness.code ?? "NOT_READY", retryable: true };
}

function runtimeRefreshSecret(options: ApiServerOptions): string | undefined {
  return options.refreshSecret ?? process.env.REFRESH_SECRET ?? process.env.REFRESH_TOKEN;
}

function ensureRefreshAuthorization(request: FastifyRequest, secret: string | undefined): void {
  // Single-user access model (design §0.1/§0.5, plan §2 decision 4): with no
  // refresh secret configured, refresh is authorized by the access boundary —
  // loopback single-user locally, Entra authConfigs at the Azure edge. A
  // configured REFRESH_SECRET is optional defense-in-depth and must then be
  // presented on every refresh.
  if (!secret) return;
  const supplied = request.headers["x-refresh-token"];
  if (typeof supplied !== "string") throw new ApiHttpError(401, "UNAUTHORIZED", "Refresh authorization is required.");
  const suppliedBuffer = Buffer.from(supplied);
  const secretBuffer = Buffer.from(secret);
  if (suppliedBuffer.length !== secretBuffer.length || !timingSafeEqual(suppliedBuffer, secretBuffer)) throw new ApiHttpError(401, "UNAUTHORIZED", "Refresh authorization is required.");
}

function registerStaticAssets(app: FastifyInstance, directory: string | undefined): void {
  if (!directory) return;
  const root = resolve(directory);
  app.get("/*", async (request, reply) => {
    const requestedPath = String((request.params as { "*"?: string })["*"] ?? "");
    if (requestedPath === "api" || requestedPath.startsWith("api/")) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "The requested resource was not found." } });
    const candidate = resolve(join(root, requestedPath || "index.html"));
    if (candidate !== root && !candidate.startsWith(`${root}/`)) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "The requested resource was not found." } });
    let file = candidate;
    try { await readFile(file); } catch {
      if (!extname(requestedPath)) file = join(root, "index.html");
      else return reply.code(404).send({ error: { code: "NOT_FOUND", message: "The requested resource was not found." } });
    }
    try {
      const content = await readFile(file);
      const types: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".ico": "image/x-icon" };
      return reply.type(types[extname(file).toLowerCase()] ?? "application/octet-stream").send(content);
    } catch { return reply.code(404).send({ error: { code: "NOT_FOUND", message: "The requested resource was not found." } }); }
  });
}

function deadlineMessage(deadlineMs: number): string {
  const seconds = deadlineMs / 1000;
  return `The request exceeded the ${Number.isInteger(seconds) ? `${seconds}-second` : `${deadlineMs}ms`} service deadline.`;
}

/**
 * Plan §6.2 hard server deadline on warm API requests (5 seconds by default).
 * The handler races a bounded timeout and fails closed with a 503
 * REQUEST_DEADLINE_EXCEEDED if the deadline passes before a response is sent.
 * The timeout aborts the handler's upstream work via an AbortSignal so hung
 * upstream fetches stop promptly instead of lingering. Late handler completion
 * is consumed by the race and never produces a second response.
 */
function withWarmDeadline(
  handler: (request: FastifyRequest, reply: FastifyReply, signal?: AbortSignal) => Promise<unknown>,
  deadlineMs: number,
): (request: FastifyRequest, reply: FastifyReply) => Promise<unknown> {
  return async (request, reply) => {
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        if (!reply.sent) reject(new ApiHttpError(503, "REQUEST_DEADLINE_EXCEEDED", deadlineMessage(deadlineMs), true));
      }, deadlineMs);
    });
    try {
      return await Promise.race([handler(request, reply, controller.signal), deadline]);
    } finally {
      if (timer) clearTimeout(timer);
      controller.abort();
    }
  };
}

export async function createApiServer(options: ApiServerOptions = {}): Promise<{ app: FastifyInstance; store: GenerationStore }> {
  // Monotonic clock: an NTP step-back must never revive expired tokens or an
  // unusable generation (fail-closed invalidation is irreversible within a
  // process lifetime).
  const rawNow = options.now ?? Date.now;
  let latestNow = Number.NEGATIVE_INFINITY;
  const now = () => {
    const current = rawNow();
    latestNow = Math.max(latestNow, current);
    return latestNow;
  };
  const adapter = options.adapter ?? createCaasAdapter(options.transport ? { transport: options.transport } : {});
  const deadlineMs = options.warmRequestDeadlineMs ?? DEFAULT_WARM_DEADLINE_MS;
  const warm = (handler: (request: FastifyRequest, reply: FastifyReply, signal?: AbortSignal) => Promise<unknown>) => withWarmDeadline(handler, deadlineMs);
  const store = new GenerationStore(adapter, now);
  const app = Fastify({ logger: options.logger ?? false, maxParamLength: 2048, bodyLimit: 64 * 1024 });
  app.addHook("onSend", async (_request, reply, payload) => {
    // Plan §6.1: browser responses are hard-limited to 2 MiB. Crossing the
    // limit fails closed with a bounded error; a larger payload is never
    // emitted as a 200 body.
    const size = typeof payload === "string" ? Buffer.byteLength(payload, "utf8") : Buffer.isBuffer(payload) ? payload.length : 0;
    if (size > MAX_BROWSER_RESPONSE_BYTES) {
      reply.code(500);
      return JSON.stringify({ error: { code: "RESPONSE_TOO_LARGE", message: "The response exceeded the 2 MiB browser limit; request a narrower or paginated view." } });
    }
    return payload;
  });
  app.addHook("onSend", async (_request, reply, payload) => {
    reply
      .header("content-security-policy", "default-src 'self'; base-uri 'self'; connect-src 'self'; font-src 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; object-src 'none'; style-src 'self'")
      .header("referrer-policy", "strict-origin-when-cross-origin")
      .header("strict-transport-security", "max-age=31536000; includeSubDomains")
      .header("x-content-type-options", "nosniff")
      .header("x-frame-options", "DENY")
      .header("permissions-policy", "geolocation=(), microphone=(), camera=()");
    return payload;
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ApiHttpError) return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message.slice(0, MAX_ERROR_MESSAGE), retryable: error.retryable }, ...(error.details ? { ...error.details } : {}) });
    if (error instanceof SyntaxError) return reply.code(400).send({ error: { code: "INVALID_JSON", message: "The request body is not valid JSON." } });
    // Client-shaped Fastify errors (body parsing, content-type mismatch, entity
    // too large) carry a 4xx statusCode; report them as 4xx, never as a 500
    // server fault.
    const statusCode = typeof (error as { statusCode?: unknown }).statusCode === "number" ? (error as { statusCode: number }).statusCode : undefined;
    if (statusCode !== undefined && statusCode >= 400 && statusCode < 500) {
      return reply.code(statusCode).send({ error: { code: statusCode === 413 ? "REQUEST_TOO_LARGE" : "INVALID_REQUEST", message: error.message.slice(0, MAX_ERROR_MESSAGE) } });
    }
    return reply.code(500).send({ error: { code: "INTERNAL_ERROR", message: "The route service encountered an internal error." } });
  });

  const health = async (_request: FastifyRequest, reply: FastifyReply) => reply.send({ status: "ok", service: "flight-route-api" });
  const readiness = async (_request: FastifyRequest, reply: FastifyReply) => {
    const payload = readinessPayload(store, now);
    return reply.code(payload.status === "ready" ? 200 : 503).send(payload);
  };
  const startup = async (_request: FastifyRequest, reply: FastifyReply) => {
    const ready = store.status === "ready" && !!store.active;
    return reply.code(ready ? 200 : 503).send(ready ? { status: "started", service: "flight-route-api" } : { status: "starting", code: store.failure ?? "NOT_INITIALIZED", retryable: true });
  };
  app.get("/health", health);
  app.get("/healthz", health);
  app.get("/live", health);
  app.get("/livez", health);
  app.get("/health/live", health);
  app.get("/api/v1/health", health);
  app.get("/api/v1/healthz", health);
  app.get("/api/v1/live", health);
  app.get("/api/v1/livez", health);
  app.get("/api/v1/liveness", health);
  app.get("/api/v1/health/live", health);
  app.get("/ready", warm(readiness));
  app.get("/readyz", warm(readiness));
  app.get("/health/ready", warm(readiness));
  app.get("/api/v1/readiness", warm(readiness));
  app.get("/api/v1/ready", warm(readiness));
  app.get("/api/v1/readyz", warm(readiness));
  app.get("/api/v1/health/ready", warm(readiness));
  app.get("/startup", warm(startup));
  app.get("/startupz", warm(startup));
  app.get("/health/startup", warm(startup));
  app.get("/api/v1/startup", warm(startup));
  app.get("/api/v1/startupz", warm(startup));
  app.get("/api/v1/health/startup", warm(startup));

  // Plan §2.4 callsign search is POST-only: the query travels in the request body,
  // never in the URL, so no live flight identifiers, callsigns, coordinates, tokens,
  // or query state can leak through URLs or server logs.
  const searchCallsigns = async (request: FastifyRequest, reply: FastifyReply) => {
    const snapshot = store.requireSnapshot();
    if (request.query && typeof request.query === "object" && !Array.isArray(request.query) && Object.keys(request.query as Record<string, unknown>).length > 0) {
      throw new ApiHttpError(400, "INVALID_QUERY", "Callsign search accepts its query in the request body only.");
    }
    const body = bodyObject(request, ["query", "limit", "cursor"]);
    const value = requiredString(body.query, "INVALID_QUERY", "Search query must contain 1 to 64 characters.");
    const normalizedQuery = token(value);
    const limit = parseLimit(body.limit);
    const offset = body.cursor === undefined ? 0 : cursorOffset(body.cursor, snapshot, normalizedQuery, limit, "flight-cursor", now);
    const matches = snapshot.flights.filter((flight) => token(flight.record.callsign).includes(normalizedQuery));
    const data = matches.slice(offset, offset + limit).map((flight) => {
      const id = flightId(snapshot, flight.index);
      return {
        id,
        flightId: id,
        callsign: flight.record.callsign,
        departure: flight.record.departure,
        destination: flight.record.destination,
        routePointCount: flight.record.routeElements?.length ?? 0,
      };
    });
    const nextOffset = offset + data.length;
    return reply.send({ data, generation: generationSummary(snapshot, now()), ...(nextOffset < matches.length ? { nextCursor: scopedToken(snapshot, "flight-cursor", { o: nextOffset, q: normalizedQuery, l: limit }) } : {}) });
  };
  const searchMethodNotAllowed = async (_request: FastifyRequest, reply: FastifyReply) =>
    reply.header("allow", "POST").code(405).send({ error: { code: "METHOD_NOT_ALLOWED", message: "Callsign search is available over POST only." } });
  app.post("/api/v1/callsigns/search", warm(searchCallsigns));
  app.post("/api/v1/search", warm(searchCallsigns));
  app.post("/api/v1/flights/search", warm(searchCallsigns));
  app.get("/api/v1/callsigns/search", searchMethodNotAllowed);
  app.get("/api/v1/search", searchMethodNotAllowed);
  app.get("/api/v1/flights/search", searchMethodNotAllowed);

  const browse = async (request: FastifyRequest, reply: FastifyReply) => {
    const snapshot = store.requireSnapshot();
    const query = queryObject(request, ["limit", "cursor"]);
    const limit = parseLimit(query.limit);
    const context = "";
    const offset = query.cursor === undefined ? 0 : cursorOffset(query.cursor, snapshot, context, limit, "browse-cursor", now);
    const items = snapshot.flights.slice(offset, offset + limit).map((flight) => {
      const id = flightId(snapshot, flight.index);
      return {
        id,
        flightId: id,
        callsign: flight.record.callsign,
        origin: flight.record.departure,
        destination: flight.record.destination,
        routePointCount: flight.record.routeElements?.length ?? 0,
      };
    });
    const nextOffset = offset + items.length;
    return reply.send({ data: items, generation: generationSummary(snapshot, now()), ...(nextOffset < snapshot.flights.length ? { nextCursor: scopedToken(snapshot, "browse-cursor", { o: nextOffset, q: context, l: limit }) } : {}) });
  };
  app.get("/api/v1/routes", warm(browse));
  app.get("/api/v1/routes/browse", warm(browse));
  app.get("/api/v1/browse", warm(browse));
  app.get("/api/v1/flights", warm(browse));

  const routeOptions = async (request: FastifyRequest, reply: FastifyReply) => {
    const snapshot = store.requireSnapshot();
    const body = bodyObject(request, ["flightId", "originId", "destinationId"]);
    let candidates: RouteCandidate[];
    if (body.flightId !== undefined) {
      const selectedFlightIndex = decodeScoped(body.flightId, snapshot, "flight", now);
      const selectedFlight = snapshot.flightByIndex.get(selectedFlightIndex);
      if (!selectedFlight) throw new ApiHttpError(404, "FLIGHT_NOT_FOUND", "The selected flight was not found.");
      if (!selectedFlight.record.departure || !selectedFlight.record.destination) throw new ApiHttpError(409, "ROUTE_GAP", "The selected flight has no usable airport endpoints.");
      const origin = resolveAirportEndpoint(snapshot, selectedFlight.record.departure, "origin");
      const destination = resolveAirportEndpoint(snapshot, selectedFlight.record.destination, "destination");
      const matchedFlights = snapshot.flights.filter((flight) => flight.index === selectedFlight.index || (
        flightMatchesAirport(snapshot, flight.record.departure, origin) &&
        flightMatchesAirport(snapshot, flight.record.destination, destination)
      ));
      if (matchedFlights.length > MAX_SAME_ENDPOINT_CANDIDATES) {
        throw new ApiHttpError(409, "TOO_MANY_CANDIDATES", "The selected endpoints have more than 500 recorded route candidates.");
      }
      const projections = matchedFlights
        .map((flight) => routeProjection(
          snapshot,
          flight,
          origin,
          destination,
          flight.index === selectedFlight.index ? body.flightId as string : undefined,
        ));
      candidates = deduplicateRouteCandidates(projections, selectedFlight.index);
    } else {
      if (typeof body.originId !== "string" || typeof body.destinationId !== "string") throw new ApiHttpError(400, "INVALID_FLIGHT_ID", "A selected flight ID is required.");
      const originIndex = decodeScoped(body.originId, snapshot, "location", now);
      const destinationIndex = decodeScoped(body.destinationId, snapshot, "location", now);
      const origin = snapshot.locations[originIndex];
      const destination = snapshot.locations[destinationIndex];
      if (!origin || !destination || origin.kind !== "airport" || destination.kind !== "airport") throw new ApiHttpError(400, "INVALID_ENDPOINTS", "Endpoints must be uniquely selected from Airports.");
      const matchedFlights = snapshot.flights
        .filter((flight) => flightMatchesAirport(snapshot, flight.record.departure, origin) && flightMatchesAirport(snapshot, flight.record.destination, destination));
      if (matchedFlights.length > MAX_SAME_ENDPOINT_CANDIDATES) {
        throw new ApiHttpError(409, "TOO_MANY_CANDIDATES", "The selected endpoints have more than 500 recorded route candidates.");
      }
      const projections = matchedFlights
        .map((flight) => routeProjection(snapshot, flight, origin, destination));
      candidates = deduplicateRouteCandidates(projections, -1);
    }

    const completeByDistance = candidates
      .filter((candidate) => candidate.projection.complete && candidate.projection.distanceNm !== undefined && candidate.projection.rankDistanceNm !== undefined)
      .sort((left, right) => {
        const leftProjection = left.projection;
        const rightProjection = right.projection;
        return leftProjection.distanceNm! - rightProjection.distanceNm! ||
          leftProjection.rankDistanceNm! - rightProjection.rankDistanceNm! ||
          leftProjection.pointCount - rightProjection.pointCount ||
          leftProjection.signature.localeCompare(rightProjection.signature) ||
          leftProjection.id.localeCompare(rightProjection.id);
      });
    const ranks = new Map<number, number>();
    completeByDistance.forEach((candidate, index) => {
      const rankDistance = candidate.projection.rankDistanceNm!;
      if (!ranks.has(rankDistance)) ranks.set(rankDistance, index + 1);
    });
    const rankOf = (candidate: RouteCandidate): number => candidate.projection.complete && candidate.projection.rankDistanceNm !== undefined
      ? ranks.get(candidate.projection.rankDistanceNm) ?? Number.POSITIVE_INFINITY
      : Number.POSITIVE_INFINITY;
    const ordered = candidates.sort((left, right) => {
      return rankOf(left) - rankOf(right) ||
        left.projection.pointCount - right.projection.pointCount ||
        left.projection.signature.localeCompare(right.projection.signature) ||
        left.projection.id.localeCompare(right.projection.id);
    });
    const hasRankOne = ordered.some((candidate) => rankOf(candidate) === 1);
    return reply.send({
      data: ordered.map((candidate) => routeDto(snapshot, candidate.projection, candidate.projection.complete ? rankOf(candidate) : undefined)),
      ...(hasRankOne ? { rankLabel: RANK_ONE_LABEL } : {}),
      generation: generationSummary(snapshot, now()),
    });
  };
  app.post("/api/v1/routes/options", warm(routeOptions));
  app.post("/api/v1/route-options", warm(routeOptions));

  const routeDetail = async (request: FastifyRequest, reply: FastifyReply) => {
    queryObject(request, []);
    const snapshot = store.requireSnapshot();
    const route = (request.params as { routeId?: unknown }).routeId;
    const selectedId = requiredString(route, "INVALID_ROUTE_ID", "A flight ID is required.", 2048);
    const flightIndex = decodeScoped(selectedId, snapshot, "flight", now);
    const flight = snapshot.flightByIndex.get(flightIndex);
    if (!flight || !flight.record.departure || !flight.record.destination) throw new ApiHttpError(404, "ROUTE_NOT_FOUND", "The requested flight was not found.");
    const origin = resolveAirportEndpoint(snapshot, flight.record.departure, "origin");
    const destination = resolveAirportEndpoint(snapshot, flight.record.destination, "destination");
    return reply.send({ data: routeDto(snapshot, routeProjection(snapshot, flight, origin, destination)), generation: generationSummary(snapshot, now()) });
  };
  app.get("/api/v1/routes/:routeId", warm(routeDetail));
  app.get("/api/v1/detail/:routeId", warm(routeDetail));
  app.get("/api/v1/flight/:routeId", warm(routeDetail));
  app.get("/api/v1/flights/:routeId", warm(routeDetail));
  app.get("/api/v1/flights/:routeId/routes", warm(routeDetail));

  const exactLookup = async (request: FastifyRequest, reply: FastifyReply) => {
    const snapshot = store.requireSnapshot();
    const query = queryObject(request, ["reference", "kind", "cursor"]);
    const body = request.method === "POST" ? bodyObject(request, ["reference", "kind", "cursor"]) : {};
    const raw = (request.params as { reference?: unknown }).reference ?? query.reference ?? body.reference;
    const reference = requiredString(raw, "INVALID_REFERENCE", "A bounded point reference is required.");
    const kind = query.kind ?? body.kind ?? "unknown";
    if (typeof kind !== "string" || !["airport", "city", "station", "place", "unknown"].includes(kind)) throw new ApiHttpError(400, "INVALID_KIND", "The point kind is invalid.");
    const result: ResolutionResult = resolveExactReference({ value: reference, kind }, snapshot.locations);
    if (result.status === "resolved") {
      const index = snapshot.locations.findIndex((location) => location.id === result.match.id);
      return reply.send({ status: "resolved", data: publicLocation(snapshot, index, idsForLocation(snapshot, result.match)), generation: generationSummary(snapshot, now()) });
    }
    if (result.status === "ambiguous") {
      const total = result.matches.length;
      if (total > AMBIGUITY_HARD_TOTAL) throw new ApiHttpError(400, "TOO_MANY_MATCHES", `The reference matches more than ${AMBIGUITY_HARD_TOTAL} locations. Use a narrower term.`);
      const context = token(reference);
      const cursor = query.cursor ?? body.cursor;
      const offset = cursor === undefined ? 0 : cursorOffset(cursor, snapshot, context, AMBIGUITY_PAGE, "ambiguity-cursor", now);
      const page = result.matches.slice(offset, offset + AMBIGUITY_PAGE);
      const nextOffset = offset + page.length;
      return reply.send({
        status: "ambiguous",
        matches: page.map((match) => { const index = snapshot.locations.findIndex((location) => location.id === match.id); return publicLocation(snapshot, index, idsForLocation(snapshot, match)); }),
        ...(nextOffset < total ? { nextCursor: scopedToken(snapshot, "ambiguity-cursor", { o: nextOffset, q: context, l: AMBIGUITY_PAGE }) } : {}),
        generation: generationSummary(snapshot, now()),
      });
    }
    return reply.code(404).send({ status: "gap", error: { code: "POINT_NOT_FOUND", message: "The point reference was not found." }, generation: generationSummary(snapshot, now()) });
  };
  app.get("/api/v1/points/:reference", warm(exactLookup));
  app.get("/api/v1/points/lookup", warm(exactLookup));
  app.post("/api/v1/points/lookup", warm(exactLookup));
  app.post("/api/v1/points", warm(exactLookup));

  const refresh = async (request: FastifyRequest, reply: FastifyReply, signal?: AbortSignal) => {
    queryObject(request, []);
    assertEmptyBody(request);
    ensureRefreshAuthorization(request, runtimeRefreshSecret(options));
    try {
      const snapshot = await store.refresh(signal);
      return reply.send({ status: "refreshed", generation: generationSummary(snapshot, now()) });
    } catch {
      // Plan §6.2: a failed refresh keeps serving the prior generation when it is
      // still within freshness limits, and the 503 names it with its retrieval time.
      const retained = store.retainedGeneration();
      throw new ApiHttpError(503, "REFRESH_FAILED", "A new live data generation could not be acquired.", true, retained ? { retained: { generation: retained } } : undefined);
    }
  };
  app.post("/api/v1/refresh", warm(refresh));
  app.post("/api/v1/admin/refresh", warm(refresh));

  app.post("/api/v1/drafts", warm(async (request, reply) => {
    const snapshot = store.requireSnapshot();
    const parsed = RouteDraftSchema.safeParse(bodyObject(request, ["origin", "destination", "via", "selections"]));
    if (!parsed.success || !parsed.data.origin || !parsed.data.destination) throw new ApiHttpError(400, "INVALID_DRAFT", "A route draft requires non-empty origin and destination endpoints.");
    const draftId = store.rememberDraft(parsed.data, snapshot);
    return reply.code(201).send({ id: draftId, generation: generationSummary(snapshot, now()), draft: parsed.data });
  }));

  const draftCompare = async (request: FastifyRequest, reply: FastifyReply) => {
    const snapshot = store.requireSnapshot();
    const body = bodyObject(request, ["draftId", "draft"]);
    const draftId = body.draftId === undefined ? undefined : requiredString(body.draftId, "INVALID_DRAFT", "A valid draft ID is required.", 512);
    if (draftId && body.draft !== undefined) throw new ApiHttpError(400, "INVALID_DRAFT", "Provide either draftId or draft, not both.");
    let draft: RouteDraft | undefined;
    if (draftId) {
      draft = store.getDraft(draftId, snapshot);
    } else if (body.draft !== undefined) {
      const parsedDraft = RouteDraftSchema.safeParse(body.draft);
      if (!parsedDraft.success || !parsedDraft.data.origin || !parsedDraft.data.destination) throw new ApiHttpError(400, "INVALID_DRAFT", "A route draft requires non-empty origin and destination endpoints.");
      draft = parsedDraft.data;
    }
    if (!draft) throw new ApiHttpError(400, "INVALID_DRAFT", "A draft ID or valid draft is required.");
    const projection = resolveDraftProjection(snapshot, draft, now);
    const route = draftRouteDto(snapshot, projection, draftId ?? randomToken());
    return reply.send({ draft, route, comparison: { status: projection.complete ? "complete" : "gap", message: projection.complete ? "Draft distances are derived from resolved reference points." : "No distance or geometry is inferred across unresolved draft points." }, generation: generationSummary(snapshot, now()) });
  };
  app.post("/api/v1/drafts/compare", warm(draftCompare));
  app.post("/api/v1/compare", warm(draftCompare));

  const compareRoutes = async (request: FastifyRequest, reply: FastifyReply) => {
    const snapshot = store.requireSnapshot();
    const body = bodyObject(request, ["baselineId", "targetDraftId", "targetDraft"]);
    const baselineId = requiredString(body.baselineId, "INVALID_BASELINE", "A selected recorded route ID is required.", 2048);
    const targetDraftId = body.targetDraftId === undefined ? undefined : requiredString(body.targetDraftId, "INVALID_DRAFT", "A valid draft ID is required.", 512);
    if (targetDraftId !== undefined && body.targetDraft !== undefined) throw new ApiHttpError(400, "INVALID_COMPARE", "Provide either targetDraftId or targetDraft, not both.");
    if (targetDraftId === undefined && body.targetDraft === undefined) throw new ApiHttpError(400, "INVALID_COMPARE", "A target draft ID or draft is required.");
    const flightIndex = decodeScoped(baselineId, snapshot, "flight", now);
    const flight = snapshot.flightByIndex.get(flightIndex);
    if (!flight || !flight.record.departure || !flight.record.destination) throw new ApiHttpError(404, "ROUTE_NOT_FOUND", "The baseline recorded route was not found.");
    const origin = resolveAirportEndpoint(snapshot, flight.record.departure, "origin");
    const destination = resolveAirportEndpoint(snapshot, flight.record.destination, "destination");
    const baseline = routeProjection(snapshot, flight, origin, destination, baselineId);
    let draft: RouteDraft;
    let draftId: string;
    if (targetDraftId !== undefined) {
      draft = store.getDraft(targetDraftId, snapshot);
      draftId = targetDraftId;
    } else {
      const parsed = RouteDraftSchema.safeParse(body.targetDraft);
      if (!parsed.success || !parsed.data.origin || !parsed.data.destination) throw new ApiHttpError(400, "INVALID_DRAFT", "A route draft requires non-empty origin and destination endpoints.");
      draft = parsed.data;
      draftId = randomToken();
    }
    const target = resolveDraftProjection(snapshot, draft, now);
    return reply.send(compareProjections(snapshot, baseline, target, now, draftId));
  };
  app.post("/api/v1/routes/compare", warm(compareRoutes));

  if (options.assetDirectory || (process.env.NODE_ENV === "production" && process.env.WEB_ASSET_DIR)) registerStaticAssets(app, options.assetDirectory ?? process.env.WEB_ASSET_DIR);
  if (options.initialize !== false) await store.initialize();
  return { app, store };
}

export async function startServer(options: StartServerOptions = {}): Promise<{ app: FastifyInstance; store: GenerationStore }> {
  const { port = Number(process.env.PORT ?? DEFAULT_PORT), host = process.env.HOST ?? DEFAULT_HOST, ...apiOptions } = options;
  const server = await createApiServer(apiOptions);
  await server.app.listen({ port, host });
  return server;
}

export type { CaasAdapter, CaasTransport };
