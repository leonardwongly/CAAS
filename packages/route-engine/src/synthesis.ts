import { MAX_ROUTE_POINTS, MAX_SYNTHESIS_CANDIDATES, type Coordinate } from "@flight-route-explorer/contracts";

export const SYNTHESIS_ALGORITHM_VERSION = "donor-subpath-v1";
export const DISTANCE_RECONCILIATION_TOLERANCE_NM = 1e-6;

/** Input occurrence produced by the API layer from a source projection. */
export type ObservedOccurrenceInput =
  | { readonly ordinal: number; readonly referenceId?: string; readonly coordinate: Coordinate; readonly label: string }
  | { readonly ordinal: number; readonly gapReason: string };

export interface ObservedRoute {
  readonly flightKey: string;
  readonly occurrences: readonly ObservedOccurrenceInput[];
}

export type SynthesisJoinKey =
  | { readonly kind: "reference"; readonly id: string }
  | { readonly kind: "coordinate"; readonly lat: number; readonly lon: number }
  | { readonly kind: "unjoinable" };

export function joinKeyToString(key: SynthesisJoinKey): string {
  if (key.kind === "reference") return `ref:${key.id}`;
  if (key.kind === "coordinate") return `coord:${key.lat},${key.lon}`;
  return "unjoinable";
}

interface IndexedPoint {
  readonly ordinal: number;
  readonly coordinate: Coordinate;
  readonly label: string;
  readonly key: SynthesisJoinKey;
}

interface Component {
  readonly routeIndex: number;
  readonly points: readonly IndexedPoint[];
}

export interface SynthesisIndex {
  readonly routes: readonly ObservedRoute[];
  readonly components: readonly Component[];
  readonly pointsByKey: ReadonlyMap<string, readonly { readonly component: number; readonly position: number }[]>;
  readonly conflictedReferenceIds: ReadonlySet<string>;
}

/**
 * Build is O(total points): one pass for conflict detection, one pass for
 * components, one pass for the key map. No all-pairs subpath enumeration.
 */
export function buildSynthesisIndex(routes: readonly ObservedRoute[]): SynthesisIndex {
  const coordinatesByReference = new Map<string, Set<string>>();
  for (const observed of routes) {
    for (const occurrence of observed.occurrences) {
      if ("gapReason" in occurrence || occurrence.referenceId === undefined) continue;
      const set = coordinatesByReference.get(occurrence.referenceId) ?? new Set<string>();
      set.add(`${occurrence.coordinate.lat},${occurrence.coordinate.lon}`);
      coordinatesByReference.set(occurrence.referenceId, set);
    }
  }
  const conflictedReferenceIds = new Set<string>();
  for (const [referenceId, coordinates] of coordinatesByReference) {
    if (coordinates.size > 1) conflictedReferenceIds.add(referenceId);
  }

  const components: Component[] = [];
  const pointsByKey = new Map<string, { component: number; position: number }[]>();
  for (const [routeIndex, observed] of routes.entries()) {
    let chain: IndexedPoint[] = [];
    const flush = () => {
      if (chain.length >= 2) {
        const componentIndex = components.length;
        components.push({ routeIndex, points: chain });
        chain.forEach((point, position) => {
          const key = joinKeyToString(point.key);
          if (point.key.kind === "unjoinable") return;
          // Push is safe: these arrays are owned locally and only exposed
          // readonly through the returned index.
          const entries = pointsByKey.get(key);
          if (entries) entries.push({ component: componentIndex, position });
          else pointsByKey.set(key, [{ component: componentIndex, position }]);
        });
      }
      chain = [];
    };
    for (const occurrence of observed.occurrences) {
      if ("gapReason" in occurrence) { flush(); continue; }
      // Join-key rules: unique identity joins by reference; coordinate-only
      // points join by exact coordinate; conflicted identities are unjoinable
      // and never fall back to coordinate joining.
      const key: SynthesisJoinKey = occurrence.referenceId !== undefined
        ? conflictedReferenceIds.has(occurrence.referenceId)
          ? { kind: "unjoinable" }
          : { kind: "reference", id: occurrence.referenceId }
        : { kind: "coordinate", lat: occurrence.coordinate.lat, lon: occurrence.coordinate.lon };
      chain.push({ ordinal: occurrence.ordinal, coordinate: occurrence.coordinate, label: occurrence.label, key });
    }
    flush();
  }
  return { routes, components, pointsByKey, conflictedReferenceIds };
}

export interface TargetCorridor {
  readonly fromOrdinal: number;
  readonly toOrdinal: number;
  readonly gapOrdinals: readonly number[];
}

/** Corridors between the nearest exact anchors around runs of gaps. An
 * unbounded edge (unresolved origin/destination) yields no corridor for that
 * edge; callers report coverage failure explicitly. */
export function targetCorridors(occurrences: readonly ObservedOccurrenceInput[]): TargetCorridor[] {
  const corridors: TargetCorridor[] = [];
  let lastAnchorOrdinal: number | undefined;
  let gapRun: number[] = [];
  for (const occurrence of occurrences) {
    if ("gapReason" in occurrence) { gapRun.push(occurrence.ordinal); continue; }
    if (gapRun.length > 0) {
      if (lastAnchorOrdinal !== undefined) corridors.push({ fromOrdinal: lastAnchorOrdinal, toOrdinal: occurrence.ordinal, gapOrdinals: gapRun });
      gapRun = [];
    }
    lastAnchorOrdinal = occurrence.ordinal;
  }
  return corridors;
}

export interface DonorSlice {
  readonly donorFlightKey: string;
  readonly componentIndex: number;
  readonly fromPosition: number;
  readonly toPosition: number; // inclusive
  readonly pointCount: number; // endpoint-inclusive
}

/** Forward-only, gap-free, exact directed lookup. Never reverses a path. */
export function findDonorSlices(
  index: SynthesisIndex,
  from: ObservedOccurrenceInput,
  to: ObservedOccurrenceInput,
  excludeFlightKey: string,
): DonorSlice[] {
  if ("gapReason" in from || "gapReason" in to) return [];
  const fromKey = keyOf(index, from);
  const toKey = keyOf(index, to);
  if (fromKey.kind === "unjoinable" || toKey.kind === "unjoinable") return [];
  const toKeyString = joinKeyToString(toKey);
  const slices: DonorSlice[] = [];
  for (const start of index.pointsByKey.get(joinKeyToString(fromKey)) ?? []) {
    const component = index.components[start.component]!;
    const donorFlightKey = index.routes[component.routeIndex]!.flightKey;
    if (donorFlightKey === excludeFlightKey) continue;
    const maxPosition = Math.min(component.points.length - 1, start.position + MAX_ROUTE_POINTS - 1);
    for (let position = start.position + 1; position <= maxPosition; position += 1) {
      if (joinKeyToString(component.points[position]!.key) === toKeyString) {
        slices.push({ donorFlightKey, componentIndex: start.component, fromPosition: start.position, toPosition: position, pointCount: position - start.position + 1 });
        if (slices.length > MAX_SYNTHESIS_CANDIDATES) return slices; // over-limit sentinel
      }
    }
  }
  return slices;
}

function keyOf(index: SynthesisIndex, occurrence: Exclude<ObservedOccurrenceInput, { gapReason: string }>): SynthesisJoinKey {
  if (occurrence.referenceId !== undefined) {
    return index.conflictedReferenceIds.has(occurrence.referenceId)
      ? { kind: "unjoinable" }
      : { kind: "reference", id: occurrence.referenceId };
  }
  return { kind: "coordinate", lat: occurrence.coordinate.lat, lon: occurrence.coordinate.lon };
}
