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

export interface DraftResult<T> {
  ok: boolean;
  value?: T;
  issues?: DraftIssue[];
}

function draftIssues(issues: readonly { code: string; path: (string | number)[]; message: string }[]): DraftIssue[] {
  return issues.map((issue) => ({ code: issue.code, path: [...issue.path], message: issue.message }));
}

const EARTH_RADIUS_NM = 3440.065;

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

/**
 * Perpendicular (cross-track) great-circle distance from a point to the arc
 * between two positions, clamped to the nearer endpoint when the projection
 * falls beyond the arc. This is the route-context metric used to disambiguate
 * duplicate fix references: the recorded coordinate consistent with the
 * neighbouring resolved waypoints is the one closest to the arc between them.
 *
 * Degenerate arcs (identical endpoints) and coincident points return 0 via the
 * endpoint-distance branch, never NaN.
 */
export function distanceToGreatCircleArcNm(pointInput: unknown, fromInput: unknown, toInput: unknown): number {
  const point = toCoordinate(pointInput);
  const from = toCoordinate(fromInput);
  const to = toCoordinate(toInput);
  const totalNm = haversineDistanceNm(from, to);
  const fromPointNm = haversineDistanceNm(from, point);
  // A degenerate arc has no cross-track direction; fall back to the endpoint distance.
  if (totalNm < 1e-9) return fromPointNm;
  const initialBearing = (latA: number, lonA: number, latB: number, lonB: number): number => {
    // Normalize the longitude delta to the shortest arc so antimeridian
    // crossings produce the bearing of the same great circle haversine uses.
    let dLon = lonB - lonA;
    dLon = ((dLon + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
    const y = Math.sin(dLon) * Math.cos(latB);
    const x = Math.cos(latA) * Math.sin(latB) - Math.sin(latA) * Math.cos(latB) * Math.cos(dLon);
    return Math.atan2(y, x);
  };
  const lat1 = degreesToRadians(from.lat);
  const lon1 = degreesToRadians(from.lon);
  const lat2 = degreesToRadians(to.lat);
  const lon2 = degreesToRadians(to.lon);
  const latP = degreesToRadians(point.lat);
  const lonP = degreesToRadians(point.lon);
  const theta12 = initialBearing(lat1, lon1, lat2, lon2);
  const theta13 = initialBearing(lat1, lon1, latP, lonP);
  const angularFromPoint = fromPointNm / EARTH_RADIUS_NM;
  const crossTrackAngular = Math.asin(Math.min(1, Math.max(-1, Math.sin(angularFromPoint) * Math.sin(theta13 - theta12))));
  // A point near a pole of the arc has an undefined along-track projection;
  // report the endpoint distance instead of dividing by a ~0 cosine.
  if (Math.abs(crossTrackAngular) >= Math.PI / 2 - 1e-9) return fromPointNm;
  const alongTrackAngular = Math.acos(Math.min(1, Math.max(-1, Math.cos(angularFromPoint) / Math.cos(crossTrackAngular))));
  const alongTrackNm = alongTrackAngular * EARTH_RADIUS_NM;
  if (alongTrackNm < 0 || alongTrackNm > totalNm) {
    return Math.min(fromPointNm, haversineDistanceNm(to, point));
  }
  return Math.abs(crossTrackAngular) * EARTH_RADIUS_NM;
}

export function degreesToRadians(degrees: number): number {
  return degrees * (Math.PI / 180);
}

export const haversineNm = haversineDistanceNm;

/** Distance display rounding: 0.1 NM. Used for UI copy only. */
export function displayDistanceNm(distanceNm: number): number {
  if (!Number.isFinite(distanceNm) || distanceNm < 0) {
    throw new RangeError("distanceNm must be a finite, non-negative number");
  }
  const rounded = Math.round((distanceNm + Number.EPSILON) * 10) / 10;
  // Finite inputs near Number.MAX_VALUE overflow the *10 step to Infinity;
  // a display helper must never emit a non-finite value, so fail closed.
  if (!Number.isFinite(rounded)) {
    throw new RangeError("distanceNm is too large to round at 0.1 NM without overflow");
  }
  return rounded;
}

export { compareDistanceOperands, type DistanceComparison, type DistanceComparisonStatus, type DistanceComparisonUnavailable } from "./compare.ts";

export function sumDistanceNm(distances: readonly number[]): number {
  return distances.reduce((sum, distance) => {
    if (!Number.isFinite(distance) || distance < 0) throw new RangeError("distances must be finite and non-negative");
    const next = sum + distance;
    // Finite operands can still overflow the accumulated sum to Infinity;
    // a modeled total must never leave this helper non-finite.
    if (!Number.isFinite(next)) throw new RangeError("distance sum overflowed to a non-finite value");
    return next;
  }, 0);
}

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
  // Per-position schema failures surface as the same TypeError contract as the
  // outer shape check, never as a raw ZodError escaping to callers.
  return line.coordinates.map((position) => {
    try {
      return fromGeoJsonPosition(position);
    } catch (error) {
      throw error instanceof TypeError ? error : new TypeError("invalid GeoJSON line string");
    }
  });
}

export function toLeafletRoute(points: readonly unknown[]): LeafletRoute {
  if (points.length < 2 || points.length > MAX_ROUTE_POINTS) throw new RangeError(`a route must contain 2-${MAX_ROUTE_POINTS} points`);
  return { type: "polyline", positions: points.map(toLeafletCoordinate) };
}

export function fromLeafletRoute(value: unknown): Coordinate[] {
  if (typeof value !== "object" || value === null) throw new TypeError("invalid Leaflet route");
  const route = value as { positions?: unknown };
  if (!Array.isArray(route.positions) || route.positions.length < 2 || route.positions.length > MAX_ROUTE_POINTS) throw new TypeError("invalid Leaflet route");
  // Same TypeError contract as the outer shape check for malformed positions.
  return route.positions.map((position) => {
    try {
      return fromLeafletCoordinate(position);
    } catch (error) {
      throw error instanceof TypeError ? error : new TypeError("invalid Leaflet route");
    }
  });
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
  });
}

export * from "./alternate.ts";
