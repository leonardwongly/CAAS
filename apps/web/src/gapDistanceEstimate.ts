import {
  createGapDistanceFeatures,
  pathDistanceNm,
  predictGapDistance,
  type GapDistanceModelFile,
  type GapDistancePrediction,
} from "@flight-route-explorer/route-engine/gap-distance";
import type { Coordinate, RouteLeg, RouteOption } from "./api";
import type { PotentialEndpoints } from "./potentialRoute";

export type GapCorridorDistanceAnalysis = {
  gapSequences: number[];
  anchorFrom: Coordinate;
  anchorTo: Coordinate;
  endpointCorridor: boolean;
  minimumNm: number;
  prediction: GapDistancePrediction;
};

export type IncompleteRouteDistanceAnalysis = {
  status: "estimated" | "lower-bound-only" | "unavailable";
  recordedGeometrySubtotalNm: number;
  sourceResolvedLegSubtotalNm?: number | undefined;
  gapMinimumSubtotalNm?: number | undefined;
  continuousRouteMinimumNm?: number | undefined;
  corridors: GapCorridorDistanceAnalysis[];
  aggregateEstimate?: {
    label: "sum-of-corridor-medians";
    centralNm: number;
    interval: { confidenceLevel: number; lowerNm: number; upperNm: number };
    modelVersion: string;
  } | undefined;
  reason?: string | undefined;
  message?: string | undefined;
};

type CandidateSpan = {
  anchorFrom: Coordinate;
  anchorTo: Coordinate;
  previousCoordinate?: Coordinate | undefined;
  nextCoordinate?: Coordinate | undefined;
  endpointCorridor: boolean;
};

const NO_MODEL: GapDistanceModelFile = {
  schemaVersion: 1,
  status: "unavailable",
  reason: "NO_CALIBRATED_MODEL",
  message: "No calibrated historical distance model is available. Lower bounds remain available.",
};

function isGapLeg(leg: RouteLeg): boolean {
  return leg.status === "gap" || leg.kind === "gap" || !leg.from || !leg.to;
}

function sameCoordinate(left: Coordinate, right: Coordinate): boolean {
  return left.lat === right.lat && left.lon === right.lon;
}

function gapLegRuns(legs: readonly RouteLeg[]): RouteLeg[][] {
  const runs: RouteLeg[][] = [];
  let current: RouteLeg[] = [];
  for (const leg of legs) {
    if (isGapLeg(leg)) {
      current.push(leg);
    } else if (current.length) {
      runs.push(current);
      current = [];
    }
  }
  if (current.length) runs.push(current);
  return runs;
}

function candidateSpans(segments: readonly Coordinate[][], endpoints: PotentialEndpoints): CandidateSpan[] {
  const spans: CandidateSpan[] = [];
  const firstSegment = segments[0];
  const lastSegment = segments.at(-1);
  const first = firstSegment?.[0];
  const last = lastSegment?.at(-1);
  if (endpoints.origin && first && !sameCoordinate(endpoints.origin, first)) {
    spans.push({
      anchorFrom: endpoints.origin,
      anchorTo: first,
      nextCoordinate: firstSegment?.[1],
      endpointCorridor: true,
    });
  }
  for (let index = 0; index < segments.length - 1; index += 1) {
    const before = segments[index]!;
    const after = segments[index + 1]!;
    spans.push({
      anchorFrom: before.at(-1)!,
      anchorTo: after[0]!,
      previousCoordinate: before.at(-2),
      nextCoordinate: after[1],
      endpointCorridor: false,
    });
  }
  if (last && endpoints.destination && !sameCoordinate(last, endpoints.destination)) {
    spans.push({
      anchorFrom: last,
      anchorTo: endpoints.destination,
      previousCoordinate: lastSegment?.at(-2),
      endpointCorridor: true,
    });
  }
  return spans;
}

function mapGapSequences(route: RouteOption, spanCount: number): number[][] | undefined {
  const runs = gapLegRuns(route.legs);
  if (!runs.length) {
    if (spanCount === 1) return [route.gaps.map((gap) => gap.sequence)];
    if (spanCount === route.gaps.length) return route.gaps.map((gap) => [gap.sequence]);
    return undefined;
  }
  if (runs.length !== spanCount) return undefined;
  const remaining = [...route.gaps];
  const mapped: number[][] = [];
  for (const run of runs) {
    const runSequences = new Set(run.flatMap((leg) => leg.sequence === undefined ? [] : [leg.sequence]));
    let matches = remaining.filter((gap) => runSequences.has(gap.sequence));
    if (!matches.length && remaining[0]) matches = [remaining[0]];
    if (!matches.length) return undefined;
    mapped.push(matches.map((gap) => gap.sequence));
    for (const match of matches) {
      const index = remaining.indexOf(match);
      if (index >= 0) remaining.splice(index, 1);
    }
  }
  return remaining.length ? undefined : mapped;
}

function sourceResolvedLegSubtotal(route: RouteOption): number | undefined {
  const resolved = route.legs.filter((leg) => !isGapLeg(leg));
  if (!resolved.length || !resolved.every((leg) => leg.distanceNm !== undefined && Number.isFinite(leg.distanceNm) && leg.distanceNm >= 0)) return undefined;
  return resolved.reduce((sum, leg) => sum + leg.distanceNm!, 0);
}

export function analyzeIncompleteRouteDistance(
  route: RouteOption,
  endpoints: PotentialEndpoints = {},
  modelFile: GapDistanceModelFile = NO_MODEL,
  routeConfidenceLevel = 0.9,
): IncompleteRouteDistanceAnalysis {
  const segments = (route.segments ?? (route.geometry ? [route.geometry] : []))
    .filter((segment) => segment.length >= 2)
    .map((segment) => [...segment]);
  const recordedGeometrySubtotalNm = segments.reduce((sum, segment) => sum + pathDistanceNm(segment), 0);
  const sourceResolvedLegSubtotalNm = sourceResolvedLegSubtotal(route);
  const base = {
    recordedGeometrySubtotalNm,
    ...(sourceResolvedLegSubtotalNm === undefined ? {} : { sourceResolvedLegSubtotalNm }),
  };
  if (route.complete || route.gaps.length === 0) {
    return { ...base, status: "unavailable", corridors: [], reason: "ROUTE_NOT_INCOMPLETE", message: "Estimated-distance analysis applies only to source routes with explicit gaps." };
  }
  if (!segments.length) {
    return { ...base, status: "unavailable", corridors: [], reason: "NO_RECORDED_GEOMETRY", message: "No recorded route component exists to anchor a distance analysis." };
  }
  const spans = candidateSpans(segments, endpoints);
  const gapSequences = mapGapSequences(route, spans.length);
  if (!gapSequences || gapSequences.length !== spans.length || !spans.length) {
    return { ...base, status: "unavailable", corridors: [], reason: "UNBOUNDED_OR_UNMAPPED_GAPS", message: "Every explicit gap could not be mapped to one pair of exact recorded anchors." };
  }
  const perCorridorConfidence = 1 - ((1 - routeConfidenceLevel) / spans.length);
  const corridors = spans.map((span, index): GapCorridorDistanceAnalysis => {
    const features = createGapDistanceFeatures({
      ...span,
      coveredGapCount: gapSequences[index]!.length,
    });
    return {
      gapSequences: [...gapSequences[index]!],
      anchorFrom: span.anchorFrom,
      anchorTo: span.anchorTo,
      endpointCorridor: span.endpointCorridor,
      minimumNm: features.anchorDistanceNm,
      prediction: predictGapDistance(features, modelFile, perCorridorConfidence),
    };
  });
  const gapMinimumSubtotalNm = corridors.reduce((sum, corridor) => sum + corridor.minimumNm, 0);
  const continuousRouteMinimumNm = recordedGeometrySubtotalNm + gapMinimumSubtotalNm;
  const predictions = corridors.map((corridor) => corridor.prediction);
  if (predictions.every((prediction) => prediction.status === "estimated")) {
    const estimated = predictions.filter((prediction): prediction is Extract<GapDistancePrediction, { status: "estimated" }> => prediction.status === "estimated");
    return {
      ...base,
      status: "estimated",
      corridors,
      gapMinimumSubtotalNm,
      continuousRouteMinimumNm,
      aggregateEstimate: {
        label: "sum-of-corridor-medians",
        centralNm: recordedGeometrySubtotalNm + estimated.reduce((sum, prediction) => sum + prediction.medianNm, 0),
        interval: {
          confidenceLevel: routeConfidenceLevel,
          lowerNm: recordedGeometrySubtotalNm + estimated.reduce((sum, prediction) => sum + prediction.interval.lowerNm, 0),
          upperNm: recordedGeometrySubtotalNm + estimated.reduce((sum, prediction) => sum + prediction.interval.upperNm, 0),
        },
        modelVersion: estimated[0]!.modelVersion,
      },
    };
  }
  const unavailablePrediction = predictions.find((prediction) => prediction.status === "unavailable");
  return {
    ...base,
    status: "lower-bound-only",
    corridors,
    gapMinimumSubtotalNm,
    continuousRouteMinimumNm,
    reason: unavailablePrediction?.reason ?? "MODEL_UNAVAILABLE",
    message: unavailablePrediction?.message ?? "A calibrated statistical estimate is unavailable. The exact-anchor lower bound remains available.",
  };
}
