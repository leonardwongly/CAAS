import { z } from "zod";

export const MAX_TEXT_LENGTH = 160;
export const MAX_REFERENCE_LENGTH = 32;
export const MAX_ALIASES = 16;
/** Maximum number of endpoint-inclusive points in a route. */
export const MAX_ROUTE_POINTS = 256;
export const MAX_ROUTE_LEGS = MAX_ROUTE_POINTS - 1;

/** Maximum donor candidate slices/combinations returned for one target flight. */
export const MAX_SYNTHESIS_CANDIDATES = 20;
/** Maximum donor provenance entries aggregated onto one deduplicated geometry. */
export const MAX_DONOR_PROVENANCE = 8;
/** Fixed synthesis candidate page size (cursor-bound). */
export const SYNTHESIS_PAGE = 5;

const finiteNumber = z.number().finite();
const normalizedText = z.string().trim().min(1).max(MAX_TEXT_LENGTH);
const normalizedReferenceValue = z.string().trim().min(1).max(MAX_REFERENCE_LENGTH);

export const CoordinateSchema = z.object({
  lat: finiteNumber.min(-90).max(90),
  lon: finiteNumber.min(-180).max(180),
}).strict();
export type Coordinate = z.infer<typeof CoordinateSchema>;

export const GeoJsonPositionSchema = z.tuple([
  finiteNumber.min(-180).max(180),
  finiteNumber.min(-90).max(90),
]);
export type GeoJsonPosition = z.infer<typeof GeoJsonPositionSchema>;

export const LeafletCoordinateSchema = z.object({
  lat: finiteNumber.min(-90).max(90),
  lng: finiteNumber.min(-180).max(180),
}).strict();
export type LeafletCoordinate = z.infer<typeof LeafletCoordinateSchema>;

export const ReferenceKindSchema = z.enum(["airport", "city", "station", "place", "unknown"]);
export type ReferenceKind = z.infer<typeof ReferenceKindSchema>;

export const LocationReferenceSchema = z.object({
  value: normalizedReferenceValue,
  kind: ReferenceKindSchema.default("unknown"),
}).strict().transform(({ value, kind }) => ({
  value: value.toUpperCase(),
  kind,
}));
export type LocationReference = z.output<typeof LocationReferenceSchema>;

export const LocationSchema = z.object({
  id: normalizedReferenceValue,
  name: normalizedText,
  code: normalizedReferenceValue.optional(),
  kind: ReferenceKindSchema.default("place"),
  coordinate: CoordinateSchema,
  aliases: z.array(normalizedText).max(MAX_ALIASES).default([]),
}).strict().transform((location) => ({
  ...location,
  id: location.id.toUpperCase(),
  code: location.code?.toUpperCase(),
  aliases: [...new Set(location.aliases.map((alias) => alias.toUpperCase()))],
}));
export type Location = z.output<typeof LocationSchema>;

export const RouteLegSchema = z.object({
  from: LocationReferenceSchema,
  to: LocationReferenceSchema,
  distanceNm: finiteNumber.nonnegative().optional(),
}).strict();
export type RouteLeg = z.output<typeof RouteLegSchema>;

const routeSequence = z.number().int().min(0).max(MAX_ROUTE_POINTS - 1);
export const RouteGapReasonSchema = z.enum(["invalid-reference", "not-found", "ambiguous", "invalid-coordinate", "missing"]);
export type RouteGapReason = z.infer<typeof RouteGapReasonSchema>;

/** An unresolved occurrence retained in its original ordered position. */
export const RouteGapSchema = z.object({
  status: z.literal("gap"),
  sequence: routeSequence,
  reference: LocationReferenceSchema.nullable(),
  reason: RouteGapReasonSchema,
}).strict();
export type RouteGap = z.output<typeof RouteGapSchema>;

/** A coordinate-bearing occurrence, including coordinate-only upstream points. */
export const RoutePointSchema = z.object({
  status: z.literal("point"),
  sequence: routeSequence,
  designatedIdentifier: normalizedReferenceValue.transform((value) => value.toUpperCase()).nullable(),
  coordinate: CoordinateSchema,
}).strict();
export type RoutePoint = z.output<typeof RoutePointSchema>;

export const RouteOccurrenceSchema = z.discriminatedUnion("status", [RoutePointSchema, RouteGapSchema]);
export type RouteOccurrence = z.output<typeof RouteOccurrenceSchema>;

/** A continuous renderable part of a route. Gaps must never be bridged by a segment. */
export const RouteSegmentSchema = z.object({
  points: z.array(RoutePointSchema).min(2).max(MAX_ROUTE_POINTS),
}).strict();
export type RouteSegment = z.output<typeof RouteSegmentSchema>;

export const RoutePathSchema = z.object({
  occurrences: z.array(RouteOccurrenceSchema).max(MAX_ROUTE_POINTS),
  segments: z.array(RouteSegmentSchema).max(MAX_ROUTE_POINTS),
  gaps: z.array(RouteGapSchema).max(MAX_ROUTE_POINTS),
}).strict();
export type RoutePath = z.output<typeof RoutePathSchema>;

export const RouteCandidateSchema = z.object({
  id: normalizedReferenceValue,
  origin: LocationReferenceSchema,
  destination: LocationReferenceSchema,
  legs: z.array(RouteLegSchema).min(1).max(MAX_ROUTE_LEGS),
  distanceNm: finiteNumber.nonnegative(),
}).strict();
export type RouteCandidate = z.output<typeof RouteCandidateSchema>;

export const RouteQuerySchema = z.object({
  origin: LocationReferenceSchema,
  destination: LocationReferenceSchema,
  maxLegs: z.number().int().min(1).max(MAX_ROUTE_LEGS).default(MAX_ROUTE_LEGS),
}).strict();
export type RouteQuery = z.output<typeof RouteQuerySchema>;

/**
 * A generation-bound explicit coordinate selection for one ambiguous draft waypoint.
 * `sequence` is the zero-based position within `RouteDraft.via`; `locationId` is a
 * server-issued scoped location token (never a client-supplied coordinate). The
 * server pairs the selection with the waypoint reference and rejects selections
 * that do not identify one of the waypoint's exact matches.
 */
export const RouteDraftSelectionSchema = z.object({
  // via is capped at MAX_ROUTE_LEGS - 1 entries (valid indices 0..MAX_ROUTE_LEGS - 2);
  // a selection must reference an existing waypoint, so the sequence bound matches
  // the last valid via index (the server rejects sequence >= via.length).
  sequence: z.number().int().min(0).max(MAX_ROUTE_LEGS - 2),
  locationId: z.string().trim().min(1).max(512),
}).strict();
export type RouteDraftSelection = z.output<typeof RouteDraftSelectionSchema>;

export const RouteDraftSchema = z.object({
  origin: z.string().trim().max(MAX_REFERENCE_LENGTH).default(""),
  destination: z.string().trim().max(MAX_REFERENCE_LENGTH).default(""),
  via: z.array(z.string().trim().min(1).max(MAX_REFERENCE_LENGTH)).max(MAX_ROUTE_LEGS - 1).default([]),
  selections: z.array(RouteDraftSelectionSchema).max(MAX_ROUTE_LEGS - 1).default([]),
}).strict();
export type RouteDraft = z.output<typeof RouteDraftSchema>;

export const SynthesisRequestSchema = z.object({
  flightId: z.string().trim().min(1).max(2048),
  cursor: z.string().trim().min(1).max(2048).optional(),
}).strict();
export type SynthesisRequest = z.output<typeof SynthesisRequestSchema>;

export const SourceOccurrencesRequestSchema = z.object({
  proofId: z.string().trim().min(1).max(2048),
}).strict();
export type SourceOccurrencesRequest = z.output<typeof SourceOccurrencesRequestSchema>;

/**
 * Persistent safety copy carried on every recorded route, draft route, and
 * comparison operand response. It must appear verbatim in API responses and UI.
 */
export const PERSISTENT_SAFETY_COPY =
  "Demonstration only. Operational weather, NOTAM, ATC, fuel, aircraft suitability, and regulatory constraints are not evaluated.";

/** Safety copy on route drafts that are computationally complete but not operationally assessed. */
export const DRAFT_SAFETY_COPY = "Computationally complete; operational constraints not assessed.";

export const CoordinateInputSchema = z.preprocess((value) => {
  if (Array.isArray(value)) {
    return { lat: value[1], lon: value[0] };
  }
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return {
      lat: record.lat ?? record.latitude,
      lon: record.lon ?? record.lng ?? record.longitude,
    };
  }
  return value;
}, z.object({
  // Canonical decimal strings only: Number() would coerce "0x1A", "0o11",
  // "0b101", and "1e1" into in-range coordinates, violating the
  // IDENTIFIER (latitude,longitude) decimal grammar.
  lat: z.union([finiteNumber, z.string().trim().min(1).refine((value) => /^-?\d+(?:\.\d+)?$/.test(value), "Coordinate strings must be canonical decimal numbers.")]).transform((value) => Number(value)),
  lon: z.union([finiteNumber, z.string().trim().min(1).refine((value) => /^-?\d+(?:\.\d+)?$/.test(value), "Coordinate strings must be canonical decimal numbers.")]).transform((value) => Number(value)),
}).pipe(CoordinateSchema));

export type CoordinateInput = z.input<typeof CoordinateInputSchema>;

export function parseCoordinate(value: unknown): Coordinate {
  return CoordinateInputSchema.parse(value);
}

export function safeParseCoordinate(value: unknown): z.ZodSafeParseResult<Coordinate> {
  return CoordinateInputSchema.safeParse(value);
}

export function parseReference(value: unknown): LocationReference {
  if (typeof value === "string") {
    return LocationReferenceSchema.parse({ value });
  }
  return LocationReferenceSchema.parse(value);
}

export function safeParseReference(value: unknown): z.ZodSafeParseResult<LocationReference> {
  if (typeof value === "string") {
    return LocationReferenceSchema.safeParse({ value });
  }
  return LocationReferenceSchema.safeParse(value);
}

export function normalizeReference(value: string): string {
  return parseReference(value).value;
}

export function parseLocation(value: unknown): Location {
  return LocationSchema.parse(value);
}

export function safeParseLocation(value: unknown): z.ZodSafeParseResult<Location> {
  return LocationSchema.safeParse(value);
}

export function parseRouteDraft(value: unknown): RouteDraft {
  return RouteDraftSchema.parse(value);
}

export function safeParseRouteDraft(value: unknown): z.ZodSafeParseResult<RouteDraft> {
  return RouteDraftSchema.safeParse(value);
}
