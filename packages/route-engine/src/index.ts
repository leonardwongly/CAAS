import {
  CoordinateInputSchema,
  CoordinateSchema,
  GeoJsonPositionSchema,
  LocationReferenceSchema,
  LocationSchema,
  MAX_ROUTE_POINTS,
  RouteCandidateSchema,
  RouteDraftSchema,
  RouteQuerySchema,
  type Coordinate,
  type GeoJsonPosition,
  type LeafletCoordinate,
  type Location,
  type LocationReference,
  type RouteCandidate,
  type RouteDraft,
  type RouteQuery,
} from "@flight-route-explorer/contracts";
export type { RouteGap, RouteOccurrence, RoutePath, RoutePoint, RouteSegment } from "@flight-route-explorer/contracts";
export { RouteGapReasonSchema, RouteGapSchema, RouteOccurrenceSchema, RoutePathSchema, RoutePointSchema, RouteSegmentSchema } from "@flight-route-explorer/contracts";

export interface DraftIssue {
  code: string;
  path: Array<string | number>;
  message: string;
}

export type ResolutionGapReason = "invalid-reference" | "not-found";
export type ResolutionResult =
  | { status: "resolved"; reference: LocationReference; match: Location }
  | { status: "ambiguous"; reference: LocationReference; matches: Location[] }
  | { status: "gap"; reference: LocationReference | null; reason: ResolutionGapReason };

export interface ResolvedRouteQuery {
  status: "resolved" | "gap" | "ambiguous";
  origin: ResolutionResult;
  destination: ResolutionResult;
  query?: RouteQuery;
}

export interface GeoJsonLineString {
  type: "LineString";
  coordinates: GeoJsonPosition[];
}

export interface LeafletRoute {
  type: "polyline";
  positions: LeafletCoordinate[];
}

export interface Ranked<T> {
  item: T;
  distanceNm: number;
  rankDistanceNm: number;
  rank: number;
}

export interface DraftResult<T> {
  ok: boolean;
  value?: T;
  issues?: DraftIssue[];
}

function draftIssues(issues: readonly { code: string; path: (string | number)[]; message: string }[]): DraftIssue[] {
  return issues.map((issue) => ({ code: issue.code, path: [...issue.path], message: issue.message }));
}

const EARTH_RADIUS_NM = 3440.065;
const RANK_SCALE = 1_000_000;

function normalizedToken(value: string): string {
  return value.trim().toUpperCase();
}

function toCoordinate(value: unknown): Coordinate {
  return CoordinateInputSchema.parse(value);
}

function toReference(value: unknown): LocationReference | null {
  const result = typeof value === "string"
    ? LocationReferenceSchema.safeParse({ value })
    : LocationReferenceSchema.safeParse(value);
  return result.success ? result.data : null;
}

function candidateTokens(location: Location): string[] {
  return [location.id, location.code ?? "", location.name, ...location.aliases]
    .map(normalizedToken)
    .filter(Boolean);
}

export function resolveExactReference(
  referenceInput: unknown,
  locationsInput: readonly unknown[],
): ResolutionResult {
  const reference = toReference(referenceInput);
  if (!reference) {
    return { status: "gap", reference: null, reason: "invalid-reference" };
  }

  const locations = locationsInput.flatMap((value) => {
    const parsed = LocationSchema.safeParse(value);
    return parsed.success ? [parsed.data] : [];
  });
  const token = normalizedToken(reference.value);
  const matches = locations.filter((location) =>
    (reference.kind === "unknown" || reference.kind === location.kind) &&
    candidateTokens(location).includes(token),
  );
  // Dedupe only exact duplicates (same id, kind, and coordinate). Distinct
  // locations sharing one id are a real duplicate-identifier group and must
  // surface as ambiguity — never resolved last-wins, which flips with input
  // order.
  const seen = new Map<string, Location>();
  for (const location of matches) {
    const key = `${location.id}|${location.kind}|${location.coordinate.lat}|${location.coordinate.lon}`;
    if (!seen.has(key)) seen.set(key, location);
  }
  const uniqueMatches = [...seen.values()];

  if (uniqueMatches.length === 0) {
    return { status: "gap", reference, reason: "not-found" };
  }
  if (uniqueMatches.length > 1) {
    return { status: "ambiguous", reference, matches: uniqueMatches };
  }
  return { status: "resolved", reference, match: uniqueMatches[0]! };
}

export const resolveReference = resolveExactReference;

export function resolveRouteQuery(
  queryInput: unknown,
  locationsInput: readonly unknown[],
): ResolvedRouteQuery {
  const query = RouteQuerySchema.safeParse(queryInput);
  if (!query.success) {
    const invalid = { status: "gap" as const, reference: null, reason: "invalid-reference" as const };
    return { status: "gap", origin: invalid, destination: invalid };
  }
  const origin = resolveExactReference(query.data.origin, locationsInput);
  const destination = resolveExactReference(query.data.destination, locationsInput);
  const status = origin.status === "resolved" && destination.status === "resolved"
    ? "resolved"
    : origin.status === "ambiguous" || destination.status === "ambiguous"
      ? "ambiguous"
      : "gap";
  return { status, origin, destination, ...(status === "resolved" ? { query: query.data } : {}) };
}

export function haversineDistanceNm(aInput: unknown, bInput: unknown): number {
  const a = toCoordinate(aInput);
  const b = toCoordinate(bInput);
  const latitudeDelta = degreesToRadians(b.lat - a.lat);
  const rawLongitudeDelta = degreesToRadians(b.lon - a.lon);
  // Use the shortest longitudinal arc, including routes crossing the antimeridian.
  const longitudeDelta = ((rawLongitudeDelta + Math.PI) % (2 * Math.PI) + (2 * Math.PI)) % (2 * Math.PI) - Math.PI;
  const unboundedATerm = Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(degreesToRadians(a.lat)) * Math.cos(degreesToRadians(b.lat)) *
    Math.sin(longitudeDelta / 2) ** 2;
  // Floating-point noise can move a near-antipodal value fractionally outside [0, 1].
  const aTerm = Math.min(1, Math.max(0, unboundedATerm));
  const centralAngle = 2 * Math.atan2(Math.sqrt(aTerm), Math.sqrt(1 - aTerm));
  return EARTH_RADIUS_NM * centralAngle;
}

export function degreesToRadians(degrees: number): number {
  return degrees * (Math.PI / 180);
}

export function rankDistanceNm(distanceNm: number): number {
  if (!Number.isFinite(distanceNm) || distanceNm < 0) {
    throw new RangeError("distanceNm must be a finite, non-negative number");
  }
  return Math.round((distanceNm + Number.EPSILON) * RANK_SCALE) / RANK_SCALE;
}

export const haversineNm = haversineDistanceNm;
export const roundRankDistanceNm = rankDistanceNm;

/** Distance display rounding: 0.1 NM. Used for UI copy only, never for competition equality. */
export function displayDistanceNm(distanceNm: number): number {
  if (!Number.isFinite(distanceNm) || distanceNm < 0) {
    throw new RangeError("distanceNm must be a finite, non-negative number");
  }
  return Math.round((distanceNm + Number.EPSILON) * 10) / 10;
}

export type DistanceComparisonStatus = "complete" | "incomplete";
export type DistanceComparisonUnavailable = "INCOMPLETE_OPERAND" | "ZERO_BASELINE";

export interface DistanceComparison {
  status: DistanceComparisonStatus;
  /** Exactly one of distanceDeltaNm / percentageDistanceDelta is present per status. */
  distanceDeltaNm?: number;
  percentageDistanceDelta?: number;
  unavailable: DistanceComparisonUnavailable[];
}

/**
 * Directed difference of two modeled route distances at full precision.
 * `target` is always the second operand: distanceDeltaNm = target - baseline.
 * Either operand missing (incomplete geometry) makes both metrics unavailable
 * with code INCOMPLETE_OPERAND; a zero-distance baseline makes the percentage
 * unavailable with code ZERO_BASELINE. Rounding (rankDistanceNm at 0.000001 NM,
 * displayDistanceNm at 0.1 NM) is a display concern and never applied here.
 */
export function compareDistanceOperands(
  baselineDistanceNm: number | undefined,
  targetDistanceNm: number | undefined,
): DistanceComparison {
  const baselineAvailable = baselineDistanceNm !== undefined && Number.isFinite(baselineDistanceNm) && baselineDistanceNm >= 0;
  const targetAvailable = targetDistanceNm !== undefined && Number.isFinite(targetDistanceNm) && targetDistanceNm >= 0;
  if (!baselineAvailable || !targetAvailable) {
    return { status: "incomplete", unavailable: ["INCOMPLETE_OPERAND"] };
  }
  const distanceDeltaNm = targetDistanceNm! - baselineDistanceNm!;
  const percentageDistanceDelta = baselineDistanceNm === 0
    ? undefined
    : (100 * distanceDeltaNm) / baselineDistanceNm;
  return {
    status: "complete",
    distanceDeltaNm,
    ...(percentageDistanceDelta === undefined ? {} : { percentageDistanceDelta }),
    unavailable: baselineDistanceNm === 0 ? ["ZERO_BASELINE"] : [],
  };
}

export function competitionRank(values: readonly number[]): number[] {
  const normalizedValues = values.map(rankDistanceNm);
  const sorted = [...normalizedValues].sort((left, right) => left - right);
  const rankByValue = new Map<number, number>();
  sorted.forEach((value, index) => {
    if (!rankByValue.has(value)) rankByValue.set(value, index + 1);
  });
  return normalizedValues.map((value) => rankByValue.get(value)!);
}

export function sumDistanceNm(distances: readonly number[]): number {
  return distances.reduce((sum, distance) => {
    if (!Number.isFinite(distance) || distance < 0) throw new RangeError("distances must be finite and non-negative");
    return sum + distance;
  }, 0);
}

export function rankRouteCandidates<T extends { distanceNm: number }>(
  items: readonly T[],
): Array<Ranked<T>> {
  const sorted = items
    .map((item, index) => ({ item, index, distanceNm: item.distanceNm, rankDistanceNm: rankDistanceNm(item.distanceNm) }))
    .sort((left, right) => left.rankDistanceNm - right.rankDistanceNm || left.index - right.index);
  const ranks = competitionRank(sorted.map((entry) => entry.rankDistanceNm));
  return sorted.map((entry, index) => ({
    item: entry.item,
    distanceNm: entry.distanceNm,
    rankDistanceNm: entry.rankDistanceNm,
    rank: ranks[index]!,
  }));
}

export const rankCandidates = rankRouteCandidates;

export function compareRouteCandidates(left: RouteCandidate, right: RouteCandidate): number {
  return left.rankDistanceNm - right.rankDistanceNm ||
    left.legs.length - right.legs.length ||
    left.id.localeCompare(right.id);
}

export const compareCandidates = compareRouteCandidates;

export function toGeoJsonPosition(value: unknown): GeoJsonPosition {
  const coordinate = toCoordinate(value);
  return GeoJsonPositionSchema.parse([coordinate.lon, coordinate.lat]);
}

export function fromGeoJsonPosition(value: unknown): Coordinate {
  const position = GeoJsonPositionSchema.parse(value);
  return CoordinateSchema.parse({ lon: position[0], lat: position[1] });
}

export function toLeafletCoordinate(value: unknown): LeafletCoordinate {
  const coordinate = toCoordinate(value);
  return { lat: coordinate.lat, lng: coordinate.lon };
}

export function fromLeafletCoordinate(value: unknown): Coordinate {
  const parsed = toCoordinate(value);
  const record = value as Record<string, unknown>;
  return CoordinateSchema.parse({ lat: parsed.lat, lon: record.lng });
}

export const coordinateToGeoJson = toGeoJsonPosition;
export const geoJsonToCoordinate = fromGeoJsonPosition;
export const coordinateToLeaflet = toLeafletCoordinate;
export const leafletToCoordinate = fromLeafletCoordinate;

export function toGeoJsonLineString(points: readonly unknown[]): GeoJsonLineString {
  if (points.length < 2 || points.length > MAX_ROUTE_POINTS) throw new RangeError(`a route must contain 2-${MAX_ROUTE_POINTS} points`);
  return { type: "LineString", coordinates: points.map(toGeoJsonPosition) };
}

export function fromGeoJsonLineString(value: unknown): Coordinate[] {
  if (typeof value !== "object" || value === null) throw new TypeError("invalid GeoJSON line string");
  const line = value as { type?: unknown; coordinates?: unknown };
  if (line.type !== "LineString" || !Array.isArray(line.coordinates) || line.coordinates.length < 2 || line.coordinates.length > MAX_ROUTE_POINTS) {
    throw new TypeError("invalid GeoJSON line string");
  }
  return line.coordinates.map(fromGeoJsonPosition);
}

export function toLeafletRoute(points: readonly unknown[]): LeafletRoute {
  if (points.length < 2 || points.length > MAX_ROUTE_POINTS) throw new RangeError(`a route must contain 2-${MAX_ROUTE_POINTS} points`);
  return { type: "polyline", positions: points.map(toLeafletCoordinate) };
}

export function fromLeafletRoute(value: unknown): Coordinate[] {
  if (typeof value !== "object" || value === null) throw new TypeError("invalid Leaflet route");
  const route = value as { positions?: unknown };
  if (!Array.isArray(route.positions) || route.positions.length < 2 || route.positions.length > MAX_ROUTE_POINTS) throw new TypeError("invalid Leaflet route");
  return route.positions.map(fromLeafletCoordinate);
}

export function safeParseRouteCandidate(value: unknown): DraftResult<RouteCandidate> {
  const result = RouteCandidateSchema.safeParse(value);
  return result.success ? { ok: true, value: result.data } : { ok: false, issues: draftIssues(result.error.issues as Array<{ code: string; path: (string | number)[]; message: string }>) };
}

export function safeParseRouteQuery(value: unknown): DraftResult<RouteQuery> {
  const result = RouteQuerySchema.safeParse(value);
  return result.success ? { ok: true, value: result.data } : { ok: false, issues: draftIssues(result.error.issues as Array<{ code: string; path: (string | number)[]; message: string }>) };
}

export function createEmptyRouteDraft(): RouteDraft {
  return RouteDraftSchema.parse({});
}

export function normalizeRouteDraft(value: unknown): DraftResult<RouteDraft> {
  const result = RouteDraftSchema.safeParse(value);
  return result.success ? { ok: true, value: result.data } : { ok: false, issues: draftIssues(result.error.issues as Array<{ code: string; path: (string | number)[]; message: string }>) };
}

export function updateRouteDraft(
  draft: unknown,
  patch: Partial<RouteDraft>,
): DraftResult<RouteDraft> {
  const current = RouteDraftSchema.safeParse(draft);
  if (!current.success) return { ok: false, issues: draftIssues(current.error.issues as Array<{ code: string; path: (string | number)[]; message: string }>) };
  return normalizeRouteDraft({ ...current.data, ...patch });
}

export function buildRouteQueryFromDraft(draft: unknown): DraftResult<RouteQuery> {
  const normalized = RouteDraftSchema.safeParse(draft);
  if (!normalized.success) return { ok: false, issues: draftIssues(normalized.error.issues as Array<{ code: string; path: (string | number)[]; message: string }>) };
  if (!normalized.data.origin || !normalized.data.destination) {
    return { ok: false, issues: [{ code: "custom", path: [!normalized.data.origin ? "origin" : "destination"], message: "origin and destination are required" }] };
  }
  return safeParseRouteQuery({
    origin: { value: normalized.data.origin },
    destination: { value: normalized.data.destination },
    maxLegs: Math.max(1, normalized.data.via.length + 1),
  });
}

export function createRouteCandidate(
  id: string,
  origin: Location,
  destination: Location,
  legs: RouteCandidate["legs"],
): RouteCandidate {
  // Never infer: a leg without a computed distance must fail closed, not be
  // replaced by a direct origin-to-destination great-circle estimate that
  // ignores every recorded waypoint (design §0.3 "never infer by proximity").
  if (!legs.every((leg) => leg.distanceNm !== undefined)) {
    throw new RangeError("createRouteCandidate requires every leg to carry a computed distanceNm; a direct great-circle substitution is prohibited.");
  }
  const distanceNm = sumDistanceNm(legs.map((leg) => leg.distanceNm!));
  return RouteCandidateSchema.parse({
    id,
    origin: { value: origin.id, kind: origin.kind },
    destination: { value: destination.id, kind: destination.kind },
    legs,
    distanceNm,
    rankDistanceNm: rankDistanceNm(distanceNm),
  });
}
