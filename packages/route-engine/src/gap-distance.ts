import type { Coordinate } from "@flight-route-explorer/contracts";

export const GAP_DISTANCE_MODEL_SCHEMA_VERSION = 1 as const;
export const GAP_DISTANCE_EARTH_RADIUS_NM = 3440.065;

const DEFAULT_SPAN_EDGES_NM = [0, 100, 300, 600, 1200, 2400, 5000] as const;
const DEFAULT_MAX_EXAMPLES_PER_ROUTE = 128;

type HeadingContext = "unbounded" | "aligned" | "moderate" | "sharp";
type ModelCellLevel = "span-latitude-heading" | "span-latitude" | "span" | "global";
export type GapDistanceSplit = "train" | "calibration" | "test";

export type GapDistanceFeatures = {
  anchorDistanceNm: number;
  logAnchorDistanceNm: number;
  midpointAbsoluteLatitude: number;
  chordBearingDegrees?: number | undefined;
  inboundDeviationDegrees?: number | undefined;
  outboundDeviationDegrees?: number | undefined;
  headingContext: HeadingContext;
  endpointCorridor: boolean;
  coveredGapCount: number;
};

export type GapDistanceTrainingRoute = {
  /** Stable grouping key used only while training; never copied into a model artifact. */
  routeGroup: string;
  /** Complete, ordered source-route coordinates including both endpoints. */
  coordinates: readonly Coordinate[];
  retrievedAt?: string | undefined;
};

export type MaskedGapDistanceExample = {
  routeGroup: string;
  mask: { fromIndex: number; toIndex: number; hiddenPointCount: number };
  features: GapDistanceFeatures;
  observedPathNm: number;
  logCircuity: number;
};

export type GapDistanceModelCell = {
  level: ModelCellLevel;
  spanBin?: number | undefined;
  latitudeBand?: number | undefined;
  headingContext?: HeadingContext | undefined;
  endpointCorridor?: boolean | undefined;
  medianLogCircuity: number;
  exampleCount: number;
  independentRouteGroups: number;
};

export type UnavailableGapDistanceModel = {
  schemaVersion: typeof GAP_DISTANCE_MODEL_SCHEMA_VERSION;
  status: "unavailable";
  reason: string;
  message: string;
};

export type TrainedGapDistanceModel = {
  schemaVersion: typeof GAP_DISTANCE_MODEL_SCHEMA_VERSION;
  status: "trained";
  modelVersion: string;
  createdAt: string;
  trainedThrough?: string | undefined;
  distanceConvention: {
    method: "haversine";
    earthRadiusNm: typeof GAP_DISTANCE_EARTH_RADIUS_NM;
  };
  target: "log-circuity-ratio";
  spanEdgesNm: number[];
  support: { minimumAnchorDistanceNm: number; maximumAnchorDistanceNm: number };
  minimumIndependentRouteGroupsPerCell: number;
  training: {
    digestSha256: string;
    routeGroups: number;
    examples: number;
    calibrationRouteGroups: number;
    testRouteGroups: number;
  };
  cells: GapDistanceModelCell[];
  /** One maximum absolute residual per independent calibration route group. */
  calibrationResidualsLog: number[];
  validation: {
    confidenceLevel: number;
    heldOutCoverage: number;
    heldOutMedianAbsoluteErrorNm: number;
    testExamples: number;
  };
};

export type GapDistanceModelFile = UnavailableGapDistanceModel | TrainedGapDistanceModel;

export type GapDistancePrediction =
  | {
      status: "estimated";
      modelVersion: string;
      minimumNm: number;
      medianNm: number;
      interval: { confidenceLevel: number; lowerNm: number; upperNm: number };
      independentRouteGroups: number;
      modelCellLevel: ModelCellLevel;
    }
  | {
      status: "unavailable";
      minimumNm: number;
      reason: string;
      message: string;
    };

export type TrainGapDistanceOptions = {
  modelVersion: string;
  createdAt: string;
  trainingDigestSha256: string;
  spanEdgesNm?: readonly number[] | undefined;
  confidenceLevel?: number | undefined;
  minimumIndependentRouteGroups?: number | undefined;
  minimumIndependentRouteGroupsPerCell?: number | undefined;
  minimumCalibrationRouteGroups?: number | undefined;
  minimumTestRouteGroups?: number | undefined;
  minimumHeldOutCoverage?: number | undefined;
  maxExamplesPerRoute?: number | undefined;
  splitSalt?: string | undefined;
};

function unavailable(reason: string, message: string): UnavailableGapDistanceModel {
  return { schemaVersion: GAP_DISTANCE_MODEL_SCHEMA_VERSION, status: "unavailable", reason, message };
}

function finiteCoordinate(value: Coordinate | undefined): value is Coordinate {
  return value !== undefined && Number.isFinite(value.lat) && Number.isFinite(value.lon) && value.lat >= -90 && value.lat <= 90 && value.lon >= -180 && value.lon <= 180;
}

/** Browser-safe mirror of the route engine's R=3440.065-NM Haversine convention. */
function gapHaversineDistanceNm(from: Coordinate, to: Coordinate): number {
  const latitudeFrom = (from.lat * Math.PI) / 180;
  const latitudeTo = (to.lat * Math.PI) / 180;
  const latitudeDelta = latitudeTo - latitudeFrom;
  const rawLongitudeDelta = ((to.lon - from.lon) * Math.PI) / 180;
  const longitudeDelta = ((rawLongitudeDelta + Math.PI) % (2 * Math.PI) + (2 * Math.PI)) % (2 * Math.PI) - Math.PI;
  const unboundedATerm = Math.sin(latitudeDelta / 2) ** 2 + Math.cos(latitudeFrom) * Math.cos(latitudeTo) * Math.sin(longitudeDelta / 2) ** 2;
  const aTerm = Math.min(1, Math.max(0, unboundedATerm));
  return GAP_DISTANCE_EARTH_RADIUS_NM * 2 * Math.atan2(Math.sqrt(aTerm), Math.sqrt(1 - aTerm));
}

function sameCoordinate(left: Coordinate, right: Coordinate): boolean {
  return left.lat === right.lat && left.lon === right.lon;
}

function normalizedAngleDegrees(value: number): number {
  return ((value % 360) + 360) % 360;
}

function angularDifferenceDegrees(left: number, right: number): number {
  const delta = Math.abs(normalizedAngleDegrees(left) - normalizedAngleDegrees(right));
  return Math.min(delta, 360 - delta);
}

export function initialBearingDegrees(from: Coordinate, to: Coordinate): number | undefined {
  if (sameCoordinate(from, to)) return undefined;
  const latitudeFrom = (from.lat * Math.PI) / 180;
  const latitudeTo = (to.lat * Math.PI) / 180;
  const longitudeDelta = (((to.lon - from.lon + 540) % 360) - 180) * Math.PI / 180;
  const y = Math.sin(longitudeDelta) * Math.cos(latitudeTo);
  const x = Math.cos(latitudeFrom) * Math.sin(latitudeTo) - Math.sin(latitudeFrom) * Math.cos(latitudeTo) * Math.cos(longitudeDelta);
  return normalizedAngleDegrees((Math.atan2(y, x) * 180) / Math.PI);
}

export function pathDistanceNm(coordinates: readonly Coordinate[]): number {
  let total = 0;
  for (let index = 1; index < coordinates.length; index += 1) {
    total += gapHaversineDistanceNm(coordinates[index - 1]!, coordinates[index]!);
  }
  return total;
}

export function createGapDistanceFeatures(input: {
  anchorFrom: Coordinate;
  anchorTo: Coordinate;
  previousCoordinate?: Coordinate | undefined;
  nextCoordinate?: Coordinate | undefined;
  endpointCorridor?: boolean | undefined;
  coveredGapCount?: number | undefined;
}): GapDistanceFeatures {
  const anchorDistanceNm = gapHaversineDistanceNm(input.anchorFrom, input.anchorTo);
  const chordBearingDegrees = initialBearingDegrees(input.anchorFrom, input.anchorTo);
  const inboundBearing = input.previousCoordinate ? initialBearingDegrees(input.previousCoordinate, input.anchorFrom) : undefined;
  const outboundBearing = input.nextCoordinate ? initialBearingDegrees(input.anchorTo, input.nextCoordinate) : undefined;
  const inboundDeviationDegrees = chordBearingDegrees === undefined || inboundBearing === undefined ? undefined : angularDifferenceDegrees(inboundBearing, chordBearingDegrees);
  const outboundDeviationDegrees = chordBearingDegrees === undefined || outboundBearing === undefined ? undefined : angularDifferenceDegrees(chordBearingDegrees, outboundBearing);
  const deviations = [inboundDeviationDegrees, outboundDeviationDegrees].filter((value): value is number => value !== undefined);
  const maximumDeviation = deviations.length ? Math.max(...deviations) : undefined;
  const headingContext: HeadingContext = maximumDeviation === undefined
    ? "unbounded"
    : maximumDeviation <= 15
      ? "aligned"
      : maximumDeviation <= 45
        ? "moderate"
        : "sharp";
  return {
    anchorDistanceNm,
    logAnchorDistanceNm: anchorDistanceNm > 0 ? Math.log(anchorDistanceNm) : Number.NEGATIVE_INFINITY,
    midpointAbsoluteLatitude: Math.abs((input.anchorFrom.lat + input.anchorTo.lat) / 2),
    ...(chordBearingDegrees === undefined ? {} : { chordBearingDegrees }),
    ...(inboundDeviationDegrees === undefined ? {} : { inboundDeviationDegrees }),
    ...(outboundDeviationDegrees === undefined ? {} : { outboundDeviationDegrees }),
    headingContext,
    endpointCorridor: input.endpointCorridor === true,
    coveredGapCount: Math.max(0, Math.trunc(input.coveredGapCount ?? 0)),
  };
}

function evenlyLimited<T>(values: readonly T[], limit: number): T[] {
  if (values.length <= limit) return [...values];
  if (limit <= 1) return values[0] === undefined ? [] : [values[0]];
  const selected: T[] = [];
  const used = new Set<number>();
  for (let index = 0; index < limit; index += 1) {
    const sourceIndex = Math.round((index * (values.length - 1)) / (limit - 1));
    if (!used.has(sourceIndex) && values[sourceIndex] !== undefined) {
      used.add(sourceIndex);
      selected.push(values[sourceIndex]!);
    }
  }
  return selected;
}

export function createMaskedGapDistanceExamples(route: GapDistanceTrainingRoute, maxExamples = DEFAULT_MAX_EXAMPLES_PER_ROUTE): MaskedGapDistanceExample[] {
  const routeGroup = route.routeGroup.trim();
  const coordinates = route.coordinates;
  if (!routeGroup || coordinates.length < 3 || !coordinates.every((coordinate) => finiteCoordinate(coordinate))) return [];
  const examples: MaskedGapDistanceExample[] = [];
  for (let fromIndex = 0; fromIndex < coordinates.length - 2; fromIndex += 1) {
    for (let toIndex = fromIndex + 2; toIndex < coordinates.length; toIndex += 1) {
      const anchorFrom = coordinates[fromIndex]!;
      const anchorTo = coordinates[toIndex]!;
      const features = createGapDistanceFeatures({
        anchorFrom,
        anchorTo,
        previousCoordinate: coordinates[fromIndex - 1],
        nextCoordinate: coordinates[toIndex + 1],
        endpointCorridor: fromIndex === 0 || toIndex === coordinates.length - 1,
        coveredGapCount: toIndex - fromIndex - 1,
      });
      if (!(features.anchorDistanceNm > 0)) continue;
      const observedPathNm = pathDistanceNm(coordinates.slice(fromIndex, toIndex + 1));
      if (!Number.isFinite(observedPathNm) || observedPathNm <= 0) continue;
      const circuityRatio = Math.max(1, observedPathNm / features.anchorDistanceNm);
      examples.push({
        routeGroup,
        mask: { fromIndex, toIndex, hiddenPointCount: toIndex - fromIndex - 1 },
        features,
        observedPathNm,
        logCircuity: Math.log(circuityRatio),
      });
    }
  }
  return evenlyLimited(examples, Math.max(1, Math.trunc(maxExamples)));
}

function stableHash(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function assignGapDistanceSplits(routeGroups: readonly string[], salt = "gap-distance-v1"): Map<string, GapDistanceSplit> {
  const groups = [...new Set(routeGroups.map((group) => group.trim()).filter(Boolean))]
    .sort((left, right) => stableHash(`${salt}:${left}`) - stableHash(`${salt}:${right}`) || left.localeCompare(right));
  const result = new Map<string, GapDistanceSplit>();
  if (groups.length < 3) {
    groups.forEach((group) => result.set(group, "train"));
    return result;
  }
  const calibrationCount = Math.max(1, Math.floor(groups.length * 0.2));
  const testCount = Math.max(1, Math.floor(groups.length * 0.2));
  const trainCount = groups.length - calibrationCount - testCount;
  groups.forEach((group, index) => result.set(group, index < trainCount ? "train" : index < trainCount + calibrationCount ? "calibration" : "test"));
  return result;
}

function quantile(values: readonly number[], probability: number): number {
  if (!values.length) throw new RangeError("quantile requires at least one value");
  const ordered = [...values].sort((left, right) => left - right);
  const position = (ordered.length - 1) * Math.min(1, Math.max(0, probability));
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  const lower = ordered[lowerIndex]!;
  const upper = ordered[upperIndex]!;
  return lower + (upper - lower) * (position - lowerIndex);
}

function spanBinFor(distanceNm: number, edges: readonly number[]): number {
  for (let index = 1; index < edges.length; index += 1) {
    if (distanceNm < edges[index]!) return index - 1;
  }
  return edges.length - 1;
}

function latitudeBandFor(latitude: number): number {
  return Math.min(90, Math.floor(Math.abs(latitude) / 15) * 15);
}

type CellDescriptor = Pick<GapDistanceModelCell, "level" | "spanBin" | "latitudeBand" | "headingContext" | "endpointCorridor">;

function descriptorsFor(features: GapDistanceFeatures, edges: readonly number[]): CellDescriptor[] {
  const spanBin = spanBinFor(features.anchorDistanceNm, edges);
  const latitudeBand = latitudeBandFor(features.midpointAbsoluteLatitude);
  return [
    { level: "span-latitude-heading", spanBin, latitudeBand, headingContext: features.headingContext, endpointCorridor: features.endpointCorridor },
    { level: "span-latitude", spanBin, latitudeBand },
    { level: "span", spanBin },
    { level: "global" },
  ];
}

function descriptorKey(descriptor: CellDescriptor): string {
  return [descriptor.level, descriptor.spanBin ?? "*", descriptor.latitudeBand ?? "*", descriptor.headingContext ?? "*", descriptor.endpointCorridor === undefined ? "*" : descriptor.endpointCorridor ? "endpoint" : "internal"].join("|");
}

function sameDescriptor(cell: GapDistanceModelCell, descriptor: CellDescriptor): boolean {
  return descriptorKey(cell) === descriptorKey(descriptor);
}

function selectCell(features: GapDistanceFeatures, model: Pick<TrainedGapDistanceModel, "spanEdgesNm" | "cells">): GapDistanceModelCell | undefined {
  for (const descriptor of descriptorsFor(features, model.spanEdgesNm)) {
    const cell = model.cells.find((candidate) => sameDescriptor(candidate, descriptor));
    if (cell) return cell;
  }
  return undefined;
}

function buildCells(examples: readonly MaskedGapDistanceExample[], edges: readonly number[], minimumGroups: number): GapDistanceModelCell[] {
  const buckets = new Map<string, { descriptor: CellDescriptor; examples: MaskedGapDistanceExample[] }>();
  for (const example of examples) {
    for (const descriptor of descriptorsFor(example.features, edges)) {
      const key = descriptorKey(descriptor);
      const bucket = buckets.get(key) ?? { descriptor, examples: [] };
      bucket.examples.push(example);
      buckets.set(key, bucket);
    }
  }
  const cells: GapDistanceModelCell[] = [];
  for (const { descriptor, examples: bucketExamples } of buckets.values()) {
    const groups = new Map<string, number[]>();
    for (const example of bucketExamples) groups.set(example.routeGroup, [...(groups.get(example.routeGroup) ?? []), example.logCircuity]);
    if (groups.size < minimumGroups) continue;
    const routeGroupMedians = [...groups.values()].map((values) => quantile(values, 0.5));
    cells.push({
      ...descriptor,
      medianLogCircuity: Math.max(0, quantile(routeGroupMedians, 0.5)),
      exampleCount: bucketExamples.length,
      independentRouteGroups: groups.size,
    });
  }
  const specificity: Record<ModelCellLevel, number> = { "span-latitude-heading": 4, "span-latitude": 3, span: 2, global: 1 };
  return cells.sort((left, right) => specificity[right.level] - specificity[left.level] || descriptorKey(left).localeCompare(descriptorKey(right)));
}

function conformalRadius(residuals: readonly number[], confidenceLevel: number): number | undefined {
  if (!(confidenceLevel > 0 && confidenceLevel < 1) || residuals.length === 0) return undefined;
  const rank = Math.ceil((residuals.length + 1) * confidenceLevel);
  if (rank > residuals.length) return undefined;
  return [...residuals].sort((left, right) => left - right)[rank - 1];
}

function predictionFromTrainedModel(features: GapDistanceFeatures, model: TrainedGapDistanceModel, confidenceLevel: number): GapDistancePrediction {
  const minimumNm = features.anchorDistanceNm;
  if (!(minimumNm > 0)) return { status: "unavailable", minimumNm, reason: "ZERO_LENGTH_ANCHORS", message: "The exact bounding anchors are identical, so no calibrated corridor estimate is available." };
  if (minimumNm < model.support.minimumAnchorDistanceNm || minimumNm > model.support.maximumAnchorDistanceNm) {
    return { status: "unavailable", minimumNm, reason: "OUTSIDE_TRAINING_SUPPORT", message: "The visual span remains available, but its distance lies outside the calibrated historical model support." };
  }
  const cell = selectCell(features, model);
  if (!cell || cell.independentRouteGroups < model.minimumIndependentRouteGroupsPerCell) {
    return { status: "unavailable", minimumNm, reason: "INSUFFICIENT_MATCHED_ROUTES", message: "Too few independent complete historical routes match this corridor." };
  }
  const radius = conformalRadius(model.calibrationResidualsLog, confidenceLevel);
  if (radius === undefined) {
    return { status: "unavailable", minimumNm, reason: "INSUFFICIENT_CALIBRATION_FOR_CONFIDENCE", message: "The historical calibration set cannot support the requested interval confidence." };
  }
  const medianRatio = Math.max(1, Math.exp(cell.medianLogCircuity));
  const lowerRatio = Math.max(1, Math.exp(cell.medianLogCircuity - radius));
  const upperRatio = Math.max(medianRatio, Math.exp(cell.medianLogCircuity + radius));
  return {
    status: "estimated",
    modelVersion: model.modelVersion,
    minimumNm,
    medianNm: minimumNm * medianRatio,
    interval: { confidenceLevel, lowerNm: minimumNm * lowerRatio, upperNm: minimumNm * upperRatio },
    independentRouteGroups: cell.independentRouteGroups,
    modelCellLevel: cell.level,
  };
}

export function predictGapDistance(features: GapDistanceFeatures, modelFile: GapDistanceModelFile, confidenceLevel = 0.9): GapDistancePrediction {
  const validated = validateGapDistanceModelFile(modelFile);
  if (validated.status === "unavailable") {
    return { status: "unavailable", minimumNm: features.anchorDistanceNm, reason: validated.reason, message: validated.message };
  }
  return predictionFromTrainedModel(features, validated, confidenceLevel);
}

function validSpanEdges(value: unknown): value is number[] {
  return Array.isArray(value) && value.length >= 2 && value[0] === 0 && value.every((item, index) => typeof item === "number" && Number.isFinite(item) && item >= 0 && (index === 0 || item > value[index - 1]!));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validCell(value: unknown): value is GapDistanceModelCell {
  if (!isRecord(value)) return false;
  const levels: ModelCellLevel[] = ["span-latitude-heading", "span-latitude", "span", "global"];
  return levels.includes(value.level as ModelCellLevel)
    && typeof value.medianLogCircuity === "number" && Number.isFinite(value.medianLogCircuity) && value.medianLogCircuity >= 0
    && Number.isInteger(value.exampleCount) && Number(value.exampleCount) > 0
    && Number.isInteger(value.independentRouteGroups) && Number(value.independentRouteGroups) > 0;
}

export function validateGapDistanceModelFile(value: unknown): GapDistanceModelFile {
  if (!isRecord(value) || value.schemaVersion !== GAP_DISTANCE_MODEL_SCHEMA_VERSION) return unavailable("INVALID_MODEL_ARTIFACT", "The bundled historical distance model failed schema validation.");
  if (value.status === "unavailable") {
    return typeof value.reason === "string" && value.reason && typeof value.message === "string" && value.message
      ? value as UnavailableGapDistanceModel
      : unavailable("INVALID_MODEL_ARTIFACT", "The bundled model-unavailable record failed schema validation.");
  }
  if (value.status !== "trained" || typeof value.modelVersion !== "string" || !value.modelVersion || typeof value.createdAt !== "string" || Number.isNaN(Date.parse(value.createdAt))) {
    return unavailable("INVALID_MODEL_ARTIFACT", "The bundled historical distance model failed schema validation.");
  }
  const support = value.support;
  const training = value.training;
  const validation = value.validation;
  const distanceConvention = value.distanceConvention;
  if (!validSpanEdges(value.spanEdgesNm)
    || !isRecord(support) || typeof support.minimumAnchorDistanceNm !== "number" || typeof support.maximumAnchorDistanceNm !== "number" || !Number.isFinite(support.minimumAnchorDistanceNm) || !Number.isFinite(support.maximumAnchorDistanceNm) || support.minimumAnchorDistanceNm < 0 || support.maximumAnchorDistanceNm < support.minimumAnchorDistanceNm
    || !isRecord(distanceConvention) || distanceConvention.method !== "haversine" || distanceConvention.earthRadiusNm !== GAP_DISTANCE_EARTH_RADIUS_NM
    || value.target !== "log-circuity-ratio"
    || !Number.isInteger(value.minimumIndependentRouteGroupsPerCell) || Number(value.minimumIndependentRouteGroupsPerCell) < 1
    || !Array.isArray(value.cells) || !value.cells.length || !value.cells.every(validCell)
    || !Array.isArray(value.calibrationResidualsLog) || !value.calibrationResidualsLog.length || !value.calibrationResidualsLog.every((item, index, values) => typeof item === "number" && Number.isFinite(item) && item >= 0 && (index === 0 || item >= values[index - 1]!))
    || !isRecord(training) || typeof training.digestSha256 !== "string" || !/^[a-f0-9]{64}$/.test(training.digestSha256)
    || !isRecord(validation) || typeof validation.confidenceLevel !== "number" || !(validation.confidenceLevel > 0 && validation.confidenceLevel < 1) || typeof validation.heldOutCoverage !== "number" || validation.heldOutCoverage < 0 || validation.heldOutCoverage > 1 || typeof validation.heldOutMedianAbsoluteErrorNm !== "number" || !Number.isFinite(validation.heldOutMedianAbsoluteErrorNm) || validation.heldOutMedianAbsoluteErrorNm < 0) {
    return unavailable("INVALID_MODEL_ARTIFACT", "The bundled historical distance model failed invariant validation.");
  }
  return value as TrainedGapDistanceModel;
}

export function trainGapDistanceModel(routes: readonly GapDistanceTrainingRoute[], options: TrainGapDistanceOptions): GapDistanceModelFile {
  const minimumIndependentRouteGroups = options.minimumIndependentRouteGroups ?? 50;
  const minimumGroupsPerCell = options.minimumIndependentRouteGroupsPerCell ?? 10;
  const minimumCalibrationGroups = options.minimumCalibrationRouteGroups ?? 10;
  const minimumTestGroups = options.minimumTestRouteGroups ?? 10;
  const confidenceLevel = options.confidenceLevel ?? 0.9;
  const minimumHeldOutCoverage = options.minimumHeldOutCoverage ?? Math.max(0, confidenceLevel - 0.1);
  const spanEdgesNm = [...(options.spanEdgesNm ?? DEFAULT_SPAN_EDGES_NM)];
  if (!validSpanEdges(spanEdgesNm) || !/^[a-f0-9]{64}$/.test(options.trainingDigestSha256) || !options.modelVersion.trim() || Number.isNaN(Date.parse(options.createdAt))) {
    return unavailable("INVALID_TRAINING_CONFIGURATION", "The historical model training configuration is invalid.");
  }
  const examples = routes.flatMap((route) => createMaskedGapDistanceExamples(route, options.maxExamplesPerRoute ?? DEFAULT_MAX_EXAMPLES_PER_ROUTE));
  const routeGroups = [...new Set(examples.map((example) => example.routeGroup))];
  if (routeGroups.length < minimumIndependentRouteGroups) {
    return unavailable("INSUFFICIENT_INDEPENDENT_COMPLETE_ROUTES", `At least ${minimumIndependentRouteGroups} independent complete historical route groups are required; ${routeGroups.length} were usable.`);
  }
  const assignments = assignGapDistanceSplits(routeGroups, options.splitSalt);
  const train = examples.filter((example) => assignments.get(example.routeGroup) === "train");
  const calibration = examples.filter((example) => assignments.get(example.routeGroup) === "calibration");
  const test = examples.filter((example) => assignments.get(example.routeGroup) === "test");
  const cells = buildCells(train, spanEdgesNm, minimumGroupsPerCell);
  if (!cells.length) return unavailable("INSUFFICIENT_MATCHED_ROUTES", "No model cell met the independent-route support threshold.");
  const modelForSelection = { spanEdgesNm, cells };
  const calibrationByGroup = new Map<string, number[]>();
  for (const example of calibration) {
    const cell = selectCell(example.features, modelForSelection);
    if (!cell) continue;
    const residual = Math.abs(example.logCircuity - cell.medianLogCircuity);
    calibrationByGroup.set(example.routeGroup, [...(calibrationByGroup.get(example.routeGroup) ?? []), residual]);
  }
  if (calibrationByGroup.size < minimumCalibrationGroups) {
    return unavailable("INSUFFICIENT_CALIBRATION_ROUTES", `At least ${minimumCalibrationGroups} independent calibration route groups are required; ${calibrationByGroup.size} matched.`);
  }
  const calibrationResidualsLog = [...calibrationByGroup.values()].map((residuals) => Math.max(...residuals)).sort((left, right) => left - right);
  const supportDistances = train.map((example) => example.features.anchorDistanceNm);
  const provisional: TrainedGapDistanceModel = {
    schemaVersion: GAP_DISTANCE_MODEL_SCHEMA_VERSION,
    status: "trained",
    modelVersion: options.modelVersion.trim(),
    createdAt: new Date(options.createdAt).toISOString(),
    ...(routes.map((route) => route.retrievedAt).filter((value): value is string => value !== undefined && !Number.isNaN(Date.parse(value))).sort().at(-1) ? { trainedThrough: routes.map((route) => route.retrievedAt).filter((value): value is string => value !== undefined && !Number.isNaN(Date.parse(value))).sort().at(-1)! } : {}),
    distanceConvention: { method: "haversine", earthRadiusNm: GAP_DISTANCE_EARTH_RADIUS_NM },
    target: "log-circuity-ratio",
    spanEdgesNm,
    support: { minimumAnchorDistanceNm: Math.min(...supportDistances), maximumAnchorDistanceNm: Math.max(...supportDistances) },
    minimumIndependentRouteGroupsPerCell: minimumGroupsPerCell,
    training: {
      digestSha256: options.trainingDigestSha256,
      routeGroups: routeGroups.length,
      examples: examples.length,
      calibrationRouteGroups: calibrationByGroup.size,
      testRouteGroups: 0,
    },
    cells,
    calibrationResidualsLog,
    validation: { confidenceLevel, heldOutCoverage: 0, heldOutMedianAbsoluteErrorNm: 0, testExamples: 0 },
  };
  const testByGroup = new Map<string, { covered: number; errors: number[]; count: number }>();
  for (const example of test) {
    const prediction = predictionFromTrainedModel(example.features, provisional, confidenceLevel);
    if (prediction.status !== "estimated") continue;
    const current = testByGroup.get(example.routeGroup) ?? { covered: 0, errors: [], count: 0 };
    current.count += 1;
    if (example.observedPathNm >= prediction.interval.lowerNm && example.observedPathNm <= prediction.interval.upperNm) current.covered += 1;
    current.errors.push(Math.abs(example.observedPathNm - prediction.medianNm));
    testByGroup.set(example.routeGroup, current);
  }
  if (testByGroup.size < minimumTestGroups) {
    return unavailable("INSUFFICIENT_TEST_ROUTES", `At least ${minimumTestGroups} independent held-out route groups are required; ${testByGroup.size} matched.`);
  }
  const routeCoverages = [...testByGroup.values()].map((result) => result.covered / result.count);
  const routeMedianErrors = [...testByGroup.values()].map((result) => quantile(result.errors, 0.5));
  const heldOutCoverage = routeCoverages.reduce((sum, value) => sum + value, 0) / routeCoverages.length;
  if (heldOutCoverage < minimumHeldOutCoverage) {
    return unavailable("HOLDOUT_COVERAGE_FAILED", `Held-out interval coverage ${(heldOutCoverage * 100).toFixed(1)}% did not meet the ${(minimumHeldOutCoverage * 100).toFixed(1)}% release gate.`);
  }
  provisional.training.testRouteGroups = testByGroup.size;
  provisional.validation = {
    confidenceLevel,
    heldOutCoverage,
    heldOutMedianAbsoluteErrorNm: quantile(routeMedianErrors, 0.5),
    testExamples: [...testByGroup.values()].reduce((sum, result) => sum + result.count, 0),
  };
  return provisional;
}
