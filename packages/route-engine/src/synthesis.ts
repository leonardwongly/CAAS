import { MAX_DONOR_PROVENANCE, MAX_ROUTE_POINTS, MAX_SYNTHESIS_CANDIDATES, type Coordinate } from "@flight-route-explorer/contracts";
import { haversineDistanceNm } from "./index.ts";

export const SYNTHESIS_ALGORITHM_VERSION = "donor-subpath-v1";
export const DISTANCE_RECONCILIATION_TOLERANCE_NM = 1e-6;

/** Input occurrence produced by the API layer from a source projection. */
export type ObservedOccurrenceInput =
  | { readonly ordinal: number; readonly referenceId?: string | undefined; readonly coordinate: Coordinate; readonly label: string }
  | { readonly ordinal: number; readonly gapReason: string };

export type ObservedPointOccurrence = Exclude<ObservedOccurrenceInput, { gapReason: string }>;

function isObservedPoint(occurrence: ObservedOccurrenceInput): occurrence is ObservedPointOccurrence {
  return !("gapReason" in occurrence);
}

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
  /** Exact anchor occurrences bounding the gap run. Donor lookups must use
   * these structural anchors, never an ordinal re-resolution: ordinals are
   * recorded metadata and need not be unique, so a map keyed by ordinal could
   * resolve to a different occurrence than the one bounding this corridor. */
  readonly from: ObservedPointOccurrence;
  readonly to: ObservedPointOccurrence;
}

/** Corridors between the nearest exact anchors around runs of gaps. An
 * unbounded edge (unresolved origin/destination) yields no corridor for that
 * edge; callers report coverage failure explicitly. */
export function targetCorridors(occurrences: readonly ObservedOccurrenceInput[]): TargetCorridor[] {
  const corridors: TargetCorridor[] = [];
  let lastAnchor: ObservedPointOccurrence | undefined;
  let gapRun: number[] = [];
  for (const occurrence of occurrences) {
    if ("gapReason" in occurrence) { gapRun.push(occurrence.ordinal); continue; }
    if (gapRun.length > 0) {
      if (lastAnchor !== undefined) corridors.push({ fromOrdinal: lastAnchor.ordinal, toOrdinal: occurrence.ordinal, gapOrdinals: gapRun, from: lastAnchor, to: occurrence });
      gapRun = [];
    }
    lastAnchor = occurrence;
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

export type SynthesisStatus = "not-needed" | "full" | "ambiguous" | "partial" | "unavailable" | "over-limit" | "candidate-limit-exceeded";

export interface BorrowedSegment {
  readonly coordinates: readonly Coordinate[];
  readonly donorFlightKeys: readonly string[];
  readonly donorCount: number;
  readonly donorTruncated: boolean;
  readonly donorOrdinals: readonly { readonly flightKey: string; readonly fromOrdinal: number; readonly toOrdinal: number }[];
  readonly matchMethod: "reference" | "exact-coordinate";
  readonly distanceNm: number;
}

export interface AssembledCandidate {
  readonly geometrySignature: string;
  readonly borrowedSegments: readonly BorrowedSegment[];
  readonly donorFlightKeys: readonly string[];
  readonly donorCount: number;
  readonly donorTruncated: boolean;
  readonly sourceResolvedDistanceNm: number;
  readonly borrowedDistanceNm: number;
  readonly estimatedTotalDistanceNm: number | undefined;
  readonly corridorsCovered: number;
}

export interface SynthesisOutcome {
  readonly status: SynthesisStatus;
  readonly corridorCount: number;
  readonly corridorsCovered: number;
  readonly candidates: readonly AssembledCandidate[];
  readonly algorithmVersion: string;
}

function coordinateSignature(coordinate: Coordinate): string {
  return `${coordinate.lat},${coordinate.lon}`;
}

/**
 * Assemble bounded synthesis candidates for one target route. v1 is
 * single-corridor-first: multi-corridor targets combine per-corridor deduplicated
 * geometries as a Cartesian product with a hard cap; exceeding it fails closed.
 */
export function assembleSynthesisCandidates(
  index: SynthesisIndex,
  target: ObservedRoute,
  options: { readonly complete?: boolean } = {},
): SynthesisOutcome {
  if (options.complete) {
    return { status: "not-needed", corridorCount: 0, corridorsCovered: 0, candidates: [], algorithmVersion: SYNTHESIS_ALGORITHM_VERSION };
  }
  const corridors = targetCorridors(target.occurrences);
  const gapOrdinals = new Set(target.occurrences.filter((occurrence) => "gapReason" in occurrence).map((occurrence) => occurrence.ordinal));

  // Source distance: haversine over recorded target geometry, legs between
  // adjacent recorded points (never across gaps).
  let sourceResolvedDistanceNm = 0;
  let previous: ObservedOccurrenceInput | undefined;
  for (const occurrence of target.occurrences) {
    if ("gapReason" in occurrence) { previous = undefined; continue; }
    if (previous && !("gapReason" in previous)) sourceResolvedDistanceNm += haversineDistanceNm(previous.coordinate, occurrence.coordinate);
    previous = occurrence;
  }

  const hasLeadingGap = target.occurrences.length > 0 && "gapReason" in target.occurrences[0]!;
  const hasTrailingGap = target.occurrences.length > 0 && "gapReason" in target.occurrences[target.occurrences.length - 1]!;
  const coveredGapOrdinals = new Set<number>();

  // Per-corridor deduplicated slices (geometry-keyed, provenance aggregated).
  // donorKeys carries the UNCAPPED donor union per geometry so candidate-level
  // aggregates stay truthful even when segment provenance is capped.
  type CorridorChoice = { signature: string; donorKeys: readonly string[]; segments: BorrowedSegment[]; distanceNm: number };
  const choicesPerCorridor: CorridorChoice[][] = [];
  for (const corridor of corridors) {
    // Structural anchors from the corridor itself: never re-resolve by
    // ordinal, which is not guaranteed unique (regression D1-BUG-1).
    const from = corridor.from;
    const to = corridor.to;
    const slices = findDonorSlices(index, from, to, target.flightKey);
    if (slices.length > MAX_SYNTHESIS_CANDIDATES) return limitExceeded(corridors.length);
    const byGeometry = new Map<string, DonorSlice[]>();
    for (const slice of slices) {
      const component = index.components[slice.componentIndex]!;
      const signature = component.points.slice(slice.fromPosition, slice.toPosition + 1).map((point) => coordinateSignature(point.coordinate)).join("|");
      byGeometry.set(signature, [...(byGeometry.get(signature) ?? []), slice]);
    }
    const choices: CorridorChoice[] = [];
    for (const [signature, groupSlices] of byGeometry) {
      const first = groupSlices[0]!;
      const coordinates = index.components[first.componentIndex]!.points.slice(first.fromPosition, first.toPosition + 1).map((point) => point.coordinate);
      let distanceNm = 0;
      for (let position = 1; position < coordinates.length; position += 1) distanceNm += haversineDistanceNm(coordinates[position - 1]!, coordinates[position]!);
      const donorFlightKeys = [...new Set(groupSlices.map((slice) => slice.donorFlightKey))]
        .sort((left, right) => index.routes.findIndex((route) => route.flightKey === left) - index.routes.findIndex((route) => route.flightKey === right));
      const seamByCoordinate = keyOf(index, from).kind === "coordinate" || keyOf(index, to).kind === "coordinate";
      choices.push({
        signature,
        donorKeys: donorFlightKeys,
        distanceNm,
        segments: [{
          coordinates,
          donorFlightKeys: donorFlightKeys.slice(0, MAX_DONOR_PROVENANCE),
          donorCount: donorFlightKeys.length,
          donorTruncated: donorFlightKeys.length > MAX_DONOR_PROVENANCE,
          donorOrdinals: groupSlices.slice(0, MAX_DONOR_PROVENANCE).map((slice) => ({
            flightKey: slice.donorFlightKey,
            fromOrdinal: index.components[slice.componentIndex]!.points[slice.fromPosition]!.ordinal,
            toOrdinal: index.components[slice.componentIndex]!.points[slice.toPosition]!.ordinal,
          })),
          matchMethod: seamByCoordinate ? "exact-coordinate" : "reference",
          distanceNm,
        }],
      });
    }
    // Neutral ordering: generation order of the first donor, then signature.
    choices.sort((left, right) => {
      const leftFirst = index.routes.findIndex((route) => route.flightKey === left.segments[0]!.donorFlightKeys[0]);
      const rightFirst = index.routes.findIndex((route) => route.flightKey === right.segments[0]!.donorFlightKeys[0]);
      return leftFirst - rightFirst || (left.signature < right.signature ? -1 : left.signature > right.signature ? 1 : 0);
    });
    if (choices.length > 0) corridor.gapOrdinals.forEach((ordinal) => coveredGapOrdinals.add(ordinal));
    choicesPerCorridor.push(choices);
  }

  const corridorsCovered = choicesPerCorridor.filter((choices) => choices.length > 0).length;
  const coveredEdge = !hasLeadingGap && !hasTrailingGap;
  if (corridors.length === 0 || corridorsCovered === 0) {
    return { status: "unavailable", corridorCount: corridors.length, corridorsCovered: 0, candidates: [], algorithmVersion: SYNTHESIS_ALGORITHM_VERSION };
  }

  // Bounded Cartesian product across corridors (v1: single-corridor fixtures
  // produce one factor; multi-corridor products fail closed past the cap).
  // The visited-leaf budget also bounds the traversal itself, not just the
  // output: combinations rejected by the point cap still count against it,
  // so adversarial inputs cannot drive exponential enumeration.
  const PRODUCT_VISIT_BUDGET = MAX_SYNTHESIS_CANDIDATES * MAX_SYNTHESIS_CANDIDATES;
  const candidates: AssembledCandidate[] = [];
  let visitedLeaves = 0;
  let traversalExceeded = false;
  const combine = (corridorIndex: number, picked: CorridorChoice[], signatureParts: string[]) => {
    if (traversalExceeded || candidates.length > MAX_SYNTHESIS_CANDIDATES) return;
    if (corridorIndex === choicesPerCorridor.length) {
      visitedLeaves += 1;
      if (visitedLeaves > PRODUCT_VISIT_BUDGET) { traversalExceeded = true; return; }
      const borrowedSegments = picked.flatMap((choice) => choice.segments);
      const borrowedDistanceNm = picked.reduce((sum, choice) => sum + choice.distanceNm, 0);
      const totalPoints = target.occurrences.filter(isObservedPoint).length
        + borrowedSegments.reduce((sum, segment) => sum + Math.max(0, segment.coordinates.length - 2), 0);
      if (totalPoints > MAX_ROUTE_POINTS) return; // over-limit candidate: reject, never truncate
      // Candidate-level aggregates come from the uncapped per-corridor donor
      // unions, so donorCount reports the true aggregate even when segment
      // provenance lists are capped at MAX_DONOR_PROVENANCE. The key list is
      // engine-internal (the API DTO serializes segment provenance only) and
      // stays consistent with donorCount.
      const donorFlightKeys = [...new Set(picked.flatMap((choice) => choice.donorKeys))]
        .sort((left, right) => index.routes.findIndex((route) => route.flightKey === left) - index.routes.findIndex((route) => route.flightKey === right));
      const donorCount = donorFlightKeys.length;
      const donorTruncated = borrowedSegments.some((segment) => segment.donorTruncated);
      const fullyCovered = corridorsCovered === corridors.length && coveredEdge && coveredGapOrdinals.size === gapOrdinals.size;
      candidates.push({
        geometrySignature: signatureParts.join("#"),
        borrowedSegments,
        donorFlightKeys,
        donorCount,
        donorTruncated,
        sourceResolvedDistanceNm,
        borrowedDistanceNm,
        estimatedTotalDistanceNm: fullyCovered ? sourceResolvedDistanceNm + borrowedDistanceNm : undefined,
        corridorsCovered,
      });
      return;
    }
    for (const choice of choicesPerCorridor[corridorIndex]!) {
      combine(corridorIndex + 1, [...picked, choice], [...signatureParts, choice.signature]);
    }
  };
  if (choicesPerCorridor.some((choices) => choices.length === 0)) {
    return { status: "partial", corridorCount: corridors.length, corridorsCovered, candidates: [], algorithmVersion: SYNTHESIS_ALGORITHM_VERSION };
  }
  combine(0, [], []);
  if (traversalExceeded || candidates.length > MAX_SYNTHESIS_CANDIDATES) return limitExceeded(corridors.length, corridorsCovered);
  if (candidates.length === 0) {
    return { status: "over-limit", corridorCount: corridors.length, corridorsCovered, candidates: [], algorithmVersion: SYNTHESIS_ALGORITHM_VERSION };
  }
  // A route with an unbounded edge (unresolved origin/destination) or any
  // uncovered gap is never "full", even when every bounded corridor found a
  // donor: coverage must be complete before the status may claim it.
  if (!coveredEdge || coveredGapOrdinals.size !== gapOrdinals.size) {
    return { status: "partial", corridorCount: corridors.length, corridorsCovered, candidates, algorithmVersion: SYNTHESIS_ALGORITHM_VERSION };
  }
  const allCorridorsSingleGeometry = choicesPerCorridor.every((choices) => new Set(choices.map((choice) => choice.signature)).size === 1);
  return {
    status: allCorridorsSingleGeometry ? "full" : "ambiguous",
    corridorCount: corridors.length,
    corridorsCovered,
    candidates,
    algorithmVersion: SYNTHESIS_ALGORITHM_VERSION,
  };
}

function limitExceeded(corridorCount: number, corridorsCovered = 0): SynthesisOutcome {
  return { status: "candidate-limit-exceeded", corridorCount, corridorsCovered, candidates: [], algorithmVersion: SYNTHESIS_ALGORITHM_VERSION };
}
