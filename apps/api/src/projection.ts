import { airportDisplayLabel } from "./airport-names.ts";
import {
  PERSISTENT_SAFETY_COPY,
  type Coordinate,
  type Location,
} from "@flight-route-explorer/contracts";
import {
  distanceToGreatCircleArcNm,
  haversineDistanceNm,
  toGeoJsonLineString,
  type ResolutionResult,
} from "@flight-route-explorer/route-engine";
import {
  PUBLIC_PROVENANCE,
  UNAVAILABLE_AIRPORT_NAME,
  scopedToken,
  token,
  type RouteGapReason,
  type SafeFlight,
  type Snapshot,
} from "./snapshot.ts";
import { flightId } from "./server.ts";

export interface PublicGap {
  readonly status: "gap";
  readonly sequence: number;
  readonly reason: RouteGapReason;
}

export interface PublicLeg {
  readonly id: string;
  readonly sequence: number;
  readonly kind: "segment" | "gap";
  readonly status: "resolved" | "gap";
  readonly from?: string;
  readonly to?: string;
  readonly distanceNm?: number;
  readonly reason?: RouteGapReason;
  /** Outbound airway recorded on the from-occurrence (labels a resolved leg). */
  readonly airway?: string;
  readonly airwayType?: string;
}

export interface PublicWaypoint {
  readonly sequence: number;
  readonly status: "resolved" | "gap";
  readonly label?: string;
  readonly reason?: RouteGapReason;
}

export interface ProjectionEndpointGap {
  readonly status: "gap";
  readonly label: string;
  readonly gap: PublicGap;
}

export type ProjectionEndpoint = Location | ProjectionEndpointGap;

export interface RouteProjection<TEndpoint extends ProjectionEndpoint = Location> {
  readonly id: string;
  readonly flight: SafeFlight;
  readonly origin: TEndpoint;
  readonly destination: TEndpoint;
  readonly legs: readonly PublicLeg[];
  readonly waypoints: readonly PublicWaypoint[];
  readonly segments: readonly (readonly Coordinate[])[];
  readonly gaps: readonly PublicGap[];
  readonly distanceNm: number | undefined;
  readonly complete: boolean;
  readonly pointCount: number;
  readonly signature: string;
}

type ProjectionOccurrence =
  | { point: { label: string; coordinate: Coordinate; sequence: number; ordinal: number; referenceId?: string; airway?: string; airwayType?: string } }
  | { gap: PublicGap & { ordinal: number } };

export function isProjectionEndpointGap(endpoint: ProjectionEndpoint): endpoint is ProjectionEndpointGap {
  return "gap" in endpoint;
}

/**
 * Route-context disambiguation for duplicate fix references (ADR-0004).
 *
 * A reference that matches several distinct coordinates is a fail-closed
 * "ambiguous" gap today. When the route itself supplies two resolved
 * neighbours, the recorded coordinate consistent with the route is the
 * candidate closest to the great-circle arc between those neighbours. The
 * rule only auto-resolves when the best candidate is both within a bounded
 * cross-track distance and clearly closer than every runner-up; any tie or
 * weak separation keeps the honest ambiguous gap. This never invents a
 * coordinate: the chosen point is a real recorded location from the
 * reference dataset.
 */
export const AMBIGUOUS_PROXIMITY_CAP_NM = 200;
export const AMBIGUOUS_PROXIMITY_MARGIN_NM = 1;

export function resolveAmbiguousByProximity(
  matches: readonly Location[],
  before: Coordinate,
  after: Coordinate,
): Location | undefined {
  let best: Location | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  let secondDistance = Number.POSITIVE_INFINITY;
  for (const match of matches) {
    const distance = distanceToGreatCircleArcNm(match.coordinate, before, after);
    if (distance < bestDistance) {
      secondDistance = bestDistance;
      bestDistance = distance;
      best = match;
    } else if (distance < secondDistance) {
      secondDistance = distance;
    }
  }
  if (best === undefined || bestDistance > AMBIGUOUS_PROXIMITY_CAP_NM) return undefined;
  if (secondDistance - bestDistance < AMBIGUOUS_PROXIMITY_MARGIN_NM) return undefined;
  return best;
}

export function routeProjection(
  snapshot: Snapshot,
  flight: SafeFlight,
  origin: Location,
  destination: Location,
  routeId?: string,
): RouteProjection;
export function routeProjection(
  snapshot: Snapshot,
  flight: SafeFlight,
  origin: ProjectionEndpoint,
  destination: ProjectionEndpoint,
  routeId?: string,
): RouteProjection<ProjectionEndpoint>;
export function routeProjection(
  snapshot: Snapshot,
  flight: SafeFlight,
  origin: ProjectionEndpoint,
  destination: ProjectionEndpoint,
  routeId = flightId(snapshot, flight.index),
): RouteProjection<ProjectionEndpoint> {
  const record = flight.record;
  const routeIdValue = routeId;
  const elements = record.routeElements;
  const occurrences: ProjectionOccurrence[] = [];
  const gaps: PublicGap[] = [];
  // Endpoint-inclusive occurrence ordinals: origin is 0, route elements take
  // 1..n in sorted element order, the destination takes n+1. Ordinals are
  // assigned in push order and never renumbered (the adjacent-endpoint splice
  // removes an occurrence but the survivors keep their assigned values).
  let nextOrdinal = 0;
  // Ordered entries are resolved in two passes so ambiguous references can be
  // disambiguated against their resolved neighbours before any geometry is
  // built. The endpoints participate as resolved context coordinates, never
  // as candidates themselves.
  type OrderedEntry =
    | { kind: "point"; label: string; coordinate: Coordinate; sequence: number; referenceId?: string; airway?: string; airwayType?: string }
    | { kind: "candidate"; sequence: number; matches: Location[]; airway?: string; airwayType?: string }
    | { kind: "gap"; sequence: number; reason: RouteGapReason };
  const endpointEntry = (endpoint: ProjectionEndpoint, sequence: number): OrderedEntry =>
    isProjectionEndpointGap(endpoint)
      ? { kind: "gap", sequence: endpoint.gap.sequence, reason: endpoint.gap.reason }
      : { kind: "point", label: displayReference(endpoint), coordinate: endpoint.coordinate, sequence, referenceId: endpoint.id };
  const elementEntry = (element: NonNullable<typeof elements>[number]): OrderedEntry => {
    if (element.coordinate) {
      let label = `Point ${element.sequence + 1}`;
      if (element.identifier) {
        const named = indexedReferenceResolution(snapshot, element.identifier);
        if (named.status === "resolved") label = displayReference(named.match);
      }
      return { kind: "point", label, coordinate: element.coordinate, sequence: element.sequence, ...(element.airway ? { airway: element.airway } : {}), ...(element.airwayType ? { airwayType: element.airwayType } : {}) };
    }
    const result = element.identifier ? indexedReferenceResolution(snapshot, element.identifier) : { status: "gap" as const } as ResolutionResult;
    if (result.status === "resolved") {
      return { kind: "point", label: displayReference(result.match), coordinate: result.match.coordinate, sequence: element.sequence, referenceId: result.match.id, ...(element.airway ? { airway: element.airway } : {}), ...(element.airwayType ? { airwayType: element.airwayType } : {}) };
    }
    if (result.status === "ambiguous") {
      return { kind: "candidate", sequence: element.sequence, matches: result.matches, ...(element.airway ? { airway: element.airway } : {}), ...(element.airwayType ? { airwayType: element.airwayType } : {}) };
    }
    return { kind: "gap", sequence: element.sequence, reason: element.identifier ? "not-found" : "missing" };
  };

  const ordered: OrderedEntry[] = [endpointEntry(origin, -1)];
  if (elements === undefined) {
    ordered.push({ kind: "gap", sequence: 0, reason: "missing" });
  } else {
    ordered.push(...[...elements].sort((left, right) => left.sequence - right.sequence).map(elementEntry));
  }
  ordered.push(endpointEntry(destination, Number.MAX_SAFE_INTEGER));

  // Second pass: resolve ambiguous references against their resolved
  // neighbours. Only a confident proximity pick resolves; anything else keeps
  // the fail-closed ambiguous gap.
  for (let index = 0; index < ordered.length; index += 1) {
    const entry = ordered[index];
    if (!entry || entry.kind !== "candidate") continue;
    let before: OrderedEntry | undefined;
    let after: OrderedEntry | undefined;
    for (let scan = index - 1; scan >= 0; scan -= 1) {
      if (ordered[scan]?.kind === "point") { before = ordered[scan]; break; }
    }
    for (let scan = index + 1; scan < ordered.length; scan += 1) {
      if (ordered[scan]?.kind === "point") { after = ordered[scan]; break; }
    }
    if (!before || !after || before.kind !== "point" || after.kind !== "point") continue;
    const chosen = resolveAmbiguousByProximity(entry.matches, before.coordinate, after.coordinate);
    if (!chosen) continue;
    ordered[index] = { kind: "point", label: displayReference(chosen), coordinate: chosen.coordinate, sequence: entry.sequence, referenceId: chosen.id, ...(entry.airway ? { airway: entry.airway } : {}), ...(entry.airwayType ? { airwayType: entry.airwayType } : {}) };
  }

  const pushEntry = (entry: OrderedEntry) => {
    if (entry.kind === "point") {
      occurrences.push({ point: { label: entry.label, coordinate: entry.coordinate, sequence: entry.sequence, ordinal: nextOrdinal, ...(entry.referenceId ? { referenceId: entry.referenceId } : {}), ...(entry.airway ? { airway: entry.airway } : {}), ...(entry.airwayType ? { airwayType: entry.airwayType } : {}) } });
    } else {
      const gap = { status: "gap" as const, sequence: entry.sequence, reason: entry.kind === "gap" ? entry.reason : "ambiguous" as const };
      occurrences.push({ gap: { ...gap, ordinal: nextOrdinal } });
      gaps.push(gap);
    }
    nextOrdinal += 1;
  };
  for (const entry of ordered) pushEntry(entry);

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
  let chain: Array<{ label: string; coordinate: Coordinate; sequence: number; airway?: string; airwayType?: string }> = [];
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
          ...(from.airway ? { airway: from.airway } : {}),
          ...(from.airwayType ? { airwayType: from.airwayType } : {}),
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
  const complete = !isProjectionEndpointGap(origin) && !isProjectionEndpointGap(destination) && elements !== undefined && gaps.length === 0 && segments.length === 1;
  const distanceNm = complete ? legs.reduce((sum, leg) => sum + (leg.distanceNm ?? 0), 0) : undefined;
  const pointCount = occurrences.filter((occurrence): occurrence is { point: { label: string; coordinate: Coordinate; sequence: number; ordinal: number; referenceId?: string } } => "point" in occurrence).length;
  const signature = occurrences.map((occurrence) => "gap" in occurrence ? `g:${occurrence.gap.sequence}:${occurrence.gap.reason}` : `p:${occurrence.point.sequence}:${coordinateKey(occurrence.point.coordinate)}`).join("|");
  // The web gap view deduplicates by (sequence, reason) identity, so emitting
  // structurally identical duplicate gaps (e.g. two unresolved elements that
  // share a duplicated upstream sequence number) would silently lose one of
  // them at the seam. The DTO emits the deduplicated gap set: nothing
  // distinguishable is ever collapsed.
  const deduplicatedGaps = gaps.filter((gap, index) => gaps.findIndex((other) => other.sequence === gap.sequence && other.reason === gap.reason) === index);
  return Object.freeze({
    id: routeIdValue,
    flight,
    origin,
    destination,
    legs: Object.freeze(legs),
    waypoints: Object.freeze(waypoints),
    segments: Object.freeze(segments.map((segment) => Object.freeze(segment))),
    gaps: Object.freeze(deduplicatedGaps),
    distanceNm,
    complete,
    pointCount,
    signature,
  });
}

export function projectionEndpointLabel(endpoint: ProjectionEndpoint): string {
  return isProjectionEndpointGap(endpoint) ? endpoint.label : displayReference(endpoint);
}

export function routeDto(snapshot: Snapshot, projection: RouteProjection<ProjectionEndpoint>): Record<string, unknown> {
  const geometry = projection.complete && projection.segments[0] && projection.segments[0].length >= 2 ? toGeoJsonLineString(projection.segments[0]) : undefined;
  return {
    id: projection.id,
    flightId: projection.id,
    callsign: projection.flight.record.callsign,
    status: projection.complete ? "complete" : "incomplete",
    label: `${projection.flight.record.callsign} route`,
    origin: projectionEndpointLabel(projection.origin),
    destination: projectionEndpointLabel(projection.destination),
    pointCount: projection.pointCount,
    complete: projection.complete,
    legs: projection.legs,
    ...(projection.distanceNm === undefined ? {} : { distanceNm: projection.distanceNm }),
    ...(geometry ? { geometry } : {}),
    ...(projection.segments.length > 0 ? { segments: projection.segments.map((points) => toGeoJsonLineString(points)) } : {}),
    provenance: PUBLIC_PROVENANCE,
    freshness: new Date(snapshot.retrievedAtMs).toISOString(),
    safety: PERSISTENT_SAFETY_COPY,
    gaps: projection.gaps,
  };
}

export function overviewProjection(snapshot: Snapshot, flight: SafeFlight): RouteProjection<ProjectionEndpoint> {
  const originReference = flight.record.departure;
  const destinationReference = flight.record.destination;
  const origin = typeof originReference === "string" ? indexedReferenceResolution(snapshot, originReference, "airport") : undefined;
  const destination = typeof destinationReference === "string" ? indexedReferenceResolution(snapshot, destinationReference, "airport") : undefined;
  const endpoint = (
    result: ResolutionResult | undefined,
    reference: unknown,
    sequence: number,
  ): ProjectionEndpoint => result?.status === "resolved"
    ? result.match
    : {
      status: "gap",
      label: airportLabelForReference(snapshot, reference),
      gap: {
        status: "gap",
        sequence,
        reason: result?.status === "ambiguous" ? "ambiguous" : reference ? "not-found" : "missing",
      },
    };
  return routeProjection(
    snapshot,
    flight,
    endpoint(origin, originReference, 0),
    endpoint(destination, destinationReference, Math.max(1, (flight.record.routeElements?.length ?? 0) + 1)),
    flightId(snapshot, flight.index),
  );
}

export function overviewRouteDto(snapshot: Snapshot, flight: SafeFlight): Record<string, unknown> {
  return routeDto(snapshot, overviewProjection(snapshot, flight));
}

export function coordinateKey(coordinate: Coordinate): string {
  return `${String(coordinate.lat)},${String(coordinate.lon)}`;
}

export function isSameCoordinate(left: Coordinate, right: Coordinate): boolean {
  return left.lat === right.lat && left.lon === right.lon;
}

export function displayReference(location: Location): string {
  if (location.kind === "airport" && location.code) return airportDisplayLabel(location.code, location.name === UNAVAILABLE_AIRPORT_NAME ? undefined : location.name);
  return location.code ?? location.name;
}

export function airportLabelForReference(snapshot: Snapshot, value: unknown): string {
  const raw = typeof value === "string" && value.trim() ? value.trim().toUpperCase() : "UNKNOWN";
  const result = indexedReferenceResolution(snapshot, raw, "airport");
  return result.status === "resolved" ? displayReference(result.match) : airportDisplayLabel(raw);
}

/**
 * Index-backed exact reference resolution for the draft hot path: the
 * prebuilt snapshot.locationTokens index resolves a reference in O(matches)
 * instead of rescanning and schema-parsing every location per waypoint (a
 * full scan of ~270k locations per via entry blocks the event loop and evades
 * the warm deadline). Semantics match resolveExactReference for kind
 * "unknown": exact-token match, distinct locations sharing the token stay
 * ambiguous.
 */
export function indexedReferenceResolution(snapshot: Snapshot, value: string, kind: "airport" | "city" | "station" | "place" | "unknown" = "unknown"): ResolutionResult {
  const reference = { value, kind: "unknown" as const };
  const indexes = snapshot.locationTokens.get(token(value)) ?? [];
  if (indexes.length === 0) return { status: "gap", reference, reason: "not-found" };
  const distinct = new Map<string, Location>();
  for (const index of indexes) {
    const location = snapshot.locations[index];
    if (!location) continue;
    if (kind !== "unknown" && location.kind !== kind) continue;
    const key = `${location.id}|${location.kind}|${location.coordinate.lat}|${location.coordinate.lon}`;
    if (!distinct.has(key)) distinct.set(key, location);
  }
  const matches = [...distinct.values()];
  if (matches.length === 0) return { status: "gap", reference, reason: "not-found" };
  if (matches.length === 1) return { status: "resolved", reference, match: matches[0]! };
  return { status: "ambiguous", reference, matches };
}
