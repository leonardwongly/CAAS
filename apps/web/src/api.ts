export type Coordinate = { lat: number; lon: number };
export type OpaqueId = string;

export type CallsignMatch = {
  id: OpaqueId;
  flightId: OpaqueId;
  callsign: string;
  departure: string;
  destination: string;
  routePointCount: number;
};

export type RouteLeg = {
  id: OpaqueId;
  sequence?: number | undefined;
  kind?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  reason?: string | undefined;
  distanceNm?: number | undefined;
  durationMinutes?: number | undefined;
  status?: string | undefined;
};

export type RouteGap = {
  sequence: number;
  status: "gap" | string;
  reason: string;
  code?: string | undefined;
};

export type RouteOption = {
  id: OpaqueId;
  flightId: OpaqueId;
  callsign: string;
  status: "complete" | "incomplete" | string;
  complete: boolean;
  label?: string | undefined;
  origin?: string | undefined;
  destination?: string | undefined;
  pointCount: number;
  legs: RouteLeg[];
  segments?: Coordinate[][] | undefined;
  distanceNm?: number | undefined;
  geometry?: Coordinate[] | undefined;
  provenance?: string | undefined;
  freshness?: string | undefined;
  safety?: string | undefined;
  gaps: RouteGap[];
};

export class ApiError extends Error {
  // Plain field declarations (no TS parameter properties) so the module stays
  // importable under Node's strip-only TypeScript mode for offline tests.
  readonly status: number;
  readonly code?: string | undefined;
  readonly body?: Record<string, unknown> | undefined;
  constructor(status: number, message: string, code?: string | undefined, body?: Record<string, unknown> | undefined) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringValue(record: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

/** Canonical decimal grammar only: never Number()-coerce "0x1A", "1e2", "", null, or booleans. */
function decimalNumber(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : NaN;
  if (typeof value !== "string") return NaN;
  const trimmed = value.trim();
  if (!/^-?\d+(?:\.\d+)?$/.test(trimmed)) return NaN;
  return Number(trimmed);
}

function finiteNumber(record: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const number = decimalNumber(record[key]);
    if (Number.isFinite(number)) return number;
  }
  return undefined;
}

function unwrap(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (!isRecord(value)) return [];
  for (const key of ["results", "items", "matches", "options", "routes", "data"]) {
    if (Array.isArray(value[key])) return value[key];
  }
  return [];
}

function geoJsonCoordinate(value: unknown): Coordinate | undefined {
  if (!Array.isArray(value) || value.length < 2) return undefined;
  const lon = decimalNumber(value[0]);
  const lat = decimalNumber(value[1]);
  return Number.isFinite(lat) && Number.isFinite(lon) && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180 ? { lat, lon } : undefined;
}

function normalizeGeometry(value: unknown): Coordinate[] | undefined {
  if (isRecord(value) && value.type === "LineString" && Array.isArray(value.coordinates)) {
    const points = value.coordinates.flatMap((point) => {
      const parsed = geoJsonCoordinate(point);
      return parsed ? [parsed] : [];
    });
    return points.length >= 2 ? points : undefined;
  }
  if (!Array.isArray(value)) return undefined;
  const points = value.flatMap((point) => {
    if (isRecord(point)) {
      // Same strict grammar and range bounds as the array branch: a coerced
      // (0,0) or unbounded coordinate must never render.
      const lat = decimalNumber(point.lat ?? point.latitude);
      const lon = decimalNumber(point.lon ?? point.longitude ?? point.lng);
      return Number.isFinite(lat) && Number.isFinite(lon) && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180 ? [{ lat, lon }] : [];
    }
    const parsed = geoJsonCoordinate(point);
    return parsed ? [parsed] : [];
  });
  return points.length >= 2 ? points : undefined;
}

function normalizeSegments(value: unknown): Coordinate[][] | undefined {
  if (!Array.isArray(value)) return undefined;
  const segments = value.flatMap((segment) => {
    const normalized = normalizeGeometry(segment);
    return normalized ? [normalized] : [];
  });
  return segments.length > 0 ? segments : undefined;
}

function normalizeMatch(value: unknown): CallsignMatch | undefined {
  if (!isRecord(value)) return undefined;
  const id = stringValue(value, "flightId", "id", "opaqueId");
  const callsign = stringValue(value, "callsign", "code", "icao");
  const departure = stringValue(value, "departure", "origin") ?? "Unknown departure";
  const destination = stringValue(value, "destination") ?? "Unknown destination";
  if (!id || !callsign) return undefined;
  return {
    id,
    flightId: id,
    callsign,
    departure,
    destination,
    routePointCount: finiteNumber(value, "routePointCount", "pointCount") ?? 0,
  };
}

function normalizeGap(value: unknown, index: number): RouteGap | undefined {
  if (typeof value === "string" && value.trim()) return { sequence: index + 1, status: "gap", reason: value.trim() };
  if (!isRecord(value)) return undefined;
  const reason = stringValue(value, "reason", "message", "code") ?? "Unresolved route segment";
  return {
    sequence: finiteNumber(value, "sequence") ?? index + 1,
    status: stringValue(value, "status") ?? "gap",
    reason,
    ...(stringValue(value, "code") ? { code: stringValue(value, "code") } : {}),
  };
}

function normalizeLeg(value: unknown, index: number): RouteLeg | undefined {
  if (!isRecord(value)) return undefined;
  const status = stringValue(value, "status", "kind");
  const from = stringValue(value, "from", "origin", "start", "fromCallsign");
  const to = stringValue(value, "to", "destination", "end", "toCallsign");
  const reason = stringValue(value, "reason", "message");
  if (!from || !to) {
    if (status !== "gap" && !reason) return undefined;
    return {
      id: stringValue(value, "id", "legId") ?? `leg-${index + 1}`,
      sequence: finiteNumber(value, "sequence") ?? index + 1,
      kind: "gap",
      ...(reason ? { reason } : {}),
      ...(status ? { status } : { status: "gap" }),
    };
  }
  return {
    id: stringValue(value, "id", "legId") ?? `leg-${index + 1}`,
    sequence: finiteNumber(value, "sequence") ?? index + 1,
    ...(stringValue(value, "kind") ? { kind: stringValue(value, "kind") } : {}),
    from,
    to,
    ...(finiteNumber(value, "distanceNm", "distance", "nauticalMiles") !== undefined ? { distanceNm: finiteNumber(value, "distanceNm", "distance", "nauticalMiles") } : {}),
    ...(finiteNumber(value, "durationMinutes", "duration") !== undefined ? { durationMinutes: finiteNumber(value, "durationMinutes", "duration") } : {}),
    ...(status ? { status } : {}),
  };
}

function normalizeRoute(value: unknown, index: number): RouteOption | undefined {
  if (!isRecord(value)) return undefined;
  const id = stringValue(value, "id", "flightId", "routeId", "opaqueId");
  if (!id) return undefined;
  const status = stringValue(value, "status") ?? (value.complete === true ? "complete" : "incomplete");
  const complete = value.complete === true || status === "complete";
  const rawLegs = Array.isArray(value.legs) ? value.legs : [];
  const legs = rawLegs.flatMap((leg, legIndex) => {
    const normalized = normalizeLeg(leg, legIndex);
    return normalized ? [normalized] : [];
  });
  const gaps = [...[
    ...unwrap(value.gaps ?? value.visibleGaps).flatMap((gap, gapIndex) => {
      const normalized = normalizeGap(gap, gapIndex);
      return normalized ? [normalized] : [];
    }),
    ...legs.flatMap((leg) => leg.status === "gap" || leg.kind === "gap" ? [{ sequence: leg.sequence ?? legs.indexOf(leg) + 1, status: "gap", reason: leg.reason ?? "Unresolved route segment" }] : []),
  ].sort((left, right) => left.sequence - right.sequence).reduce<RouteGap[]>((unique, gap) => unique.some((item) => item.sequence === gap.sequence && item.reason === gap.reason) ? unique : [...unique, gap], [])];
  const geometry = normalizeGeometry(value.geometry);
  const segments = normalizeSegments(value.segments);
  return {
    id,
    flightId: stringValue(value, "flightId", "id") ?? id,
    callsign: stringValue(value, "callsign") ?? "Unknown callsign",
    status,
    complete,
    ...(stringValue(value, "label", "name", "title") ? { label: stringValue(value, "label", "name", "title") } : { label: `Route option ${index + 1}` }),
    ...(stringValue(value, "origin", "originCallsign") ? { origin: stringValue(value, "origin", "originCallsign") } : {}),
    ...(stringValue(value, "destination", "destinationCallsign") ? { destination: stringValue(value, "destination", "destinationCallsign") } : {}),
    pointCount: finiteNumber(value, "pointCount") ?? 0,
    legs,
    ...(segments ? { segments } : {}),
    ...(geometry ? { geometry } : {}),
    ...(finiteNumber(value, "distanceNm", "distance", "totalDistanceNm") !== undefined ? { distanceNm: finiteNumber(value, "distanceNm", "distance", "totalDistanceNm") } : {}),
    ...(stringValue(value, "provenance", "source", "sourceLabel") ? { provenance: stringValue(value, "provenance", "source", "sourceLabel") } : {}),
    ...(stringValue(value, "freshness", "updatedAt", "asOf") ? { freshness: stringValue(value, "freshness", "updatedAt", "asOf") } : {}),
    ...(stringValue(value, "safety", "safetyNote") ? { safety: stringValue(value, "safety", "safetyNote") } : {}),
    gaps,
  };
}

async function request(path: string, options: RequestInit = {}): Promise<unknown> {
  const response = await fetch(path, {
    ...options,
    headers: { Accept: "application/json", ...(options.body ? { "Content-Type": "application/json" } : {}), ...options.headers },
  });
  if (!response.ok) {
    let detail = `Request failed (${response.status})`;
    let code: string | undefined;
    let body: Record<string, unknown> | undefined;
    try {
      body = await response.json() as Record<string, unknown>;
      if (isRecord(body) && isRecord(body.error)) {
        detail = typeof body.error.message === "string" ? body.error.message : detail;
        code = typeof body.error.code === "string" ? body.error.code : undefined;
      }
    } catch { /* Keep the status-only message. */ }
    throw new ApiError(response.status, detail, code, body);
  }
  return response.json();
}

export async function searchCallsigns(query: string, signal?: AbortSignal): Promise<CallsignMatch[]> {
  // Plan §2.4: the query travels in the POST body only; no callsign or flight
  // identifier ever appears in the request URL.
  // Plan §6: search must never silently truncate — the server pages matches
  // (default 50 per page) with a nextCursor; page to the terminal cursor so
  // the returned list is the complete match set.
  const matches: CallsignMatch[] = [];
  let cursor: string | undefined;
  for (;;) {
    const payload = await request("/api/v1/callsigns/search", {
      method: "POST",
      ...(signal ? { signal } : {}),
      body: JSON.stringify({ query, ...(cursor === undefined ? {} : { cursor }) }),
    });
    const record = isRecord(payload) ? payload : undefined;
    const page = (Array.isArray(record?.data) ? record.data : []).flatMap((item) => {
      const match = normalizeMatch(item);
      return match ? [match] : [];
    });
    matches.push(...page);
    const nextCursor = record?.nextCursor;
    if (typeof nextCursor !== "string" || page.length === 0) break;
    cursor = nextCursor;
  }
  return matches;
}

export type GenerationTier = {
  state: string;
  retrievedAt: string;
  freshUntil: string;
  staleUntil: string;
};

export type GenerationSummary = {
  id: string;
  retrievedAt: string;
  live: GenerationTier;
  reference: GenerationTier;
  overall: string;
};

function normalizeGeneration(value: unknown): GenerationSummary | undefined {
  if (!isRecord(value)) return undefined;
  const tier = (tierValue: unknown): GenerationTier | undefined => {
    if (!isRecord(tierValue)) return undefined;
    const state = stringValue(tierValue, "state");
    const retrievedAt = stringValue(tierValue, "retrievedAt");
    const freshUntil = stringValue(tierValue, "freshUntil");
    const staleUntil = stringValue(tierValue, "staleUntil");
    if (!state || !retrievedAt || !freshUntil || !staleUntil) return undefined;
    return { state, retrievedAt, freshUntil, staleUntil };
  };
  const live = tier(value.live);
  const reference = tier(value.reference);
  const retrievedAt = stringValue(value, "retrievedAt");
  const overall = stringValue(value, "overall");
  const id = stringValue(value, "id");
  if (!live || !reference || !retrievedAt || !overall || !id) return undefined;
  return { id, retrievedAt, live, reference, overall };
}

export type RouteOptionsResult = {
  options: RouteOption[];
  generation?: GenerationSummary | undefined;
};

export async function fetchRouteOptions(flightId: OpaqueId, signal?: AbortSignal): Promise<RouteOptionsResult> {
  const payload = await request("/api/v1/routes/options", {
    method: "POST",
    ...(signal ? { signal } : {}),
    body: JSON.stringify({ flightId }),
  });
  const generation = isRecord(payload) ? normalizeGeneration(payload.generation) : undefined;
  return {
    options: unwrap(payload).flatMap((item, index) => {
      const route = normalizeRoute(item, index);
      return route ? [route] : [];
    }),
    ...(generation ? { generation } : {}),
  };
}

export type SynthesisSegment = {
  kind: "borrowed";
  geometry: Coordinate[];           // parsed from GeoJSON LineString, [lon,lat] -> {lat,lon}
  distanceNm?: number | undefined;
  matchMethod: "reference" | "exact-coordinate";
  donorCount: number;
  donorTruncated?: boolean | undefined;
  proofIds: string[];
};

export type SynthesisCandidate = {
  candidateId: string;
  segments: SynthesisSegment[];
  sourceResolvedDistanceNm?: number | undefined;
  borrowedDistanceNm?: number | undefined;
  estimatedTotalDistanceNm?: number | undefined;
  corridorsCovered: number;
};

export type SynthesisStatus = "not-needed" | "full" | "ambiguous" | "partial" | "unavailable" | "over-limit" | "candidate-limit-exceeded";

export type SynthesisResult = {
  status: SynthesisStatus;
  corridorCount: number;
  corridorsCovered: number;
  candidates: SynthesisCandidate[];
  nextCursor?: string | undefined;
  safety?: string | undefined;
};

export type DonorProofResult = {
  flightId: string;
  occurrences: Array<{ ordinal: number; status: string; label?: string | undefined; coordinate?: Coordinate | undefined; reason?: string | undefined }>;
};

function normalizeSynthesisCandidate(value: unknown): SynthesisCandidate | undefined {
  if (!isRecord(value)) return undefined;
  const candidateId = stringValue(value, "candidateId");
  if (!candidateId || !Array.isArray(value.segments)) return undefined;
  const segments: SynthesisSegment[] = [];
  for (const segment of value.segments) {
    if (!isRecord(segment)) return undefined;
    const geometry = normalizeGeometry(segment.geometry);
    const matchMethod = stringValue(segment, "matchMethod");
    if (!geometry || (matchMethod !== "reference" && matchMethod !== "exact-coordinate")) return undefined;
    segments.push({
      kind: "borrowed",
      geometry,
      ...(finiteNumber(segment, "distanceNm") !== undefined ? { distanceNm: finiteNumber(segment, "distanceNm") } : {}),
      matchMethod,
      donorCount: finiteNumber(segment, "donorCount") ?? 1,
      ...(segment.donorTruncated === true ? { donorTruncated: true } : {}),
      proofIds: Array.isArray(segment.proofIds) ? segment.proofIds.filter((proof): proof is string => typeof proof === "string" && proof.trim().length > 0) : [],
    });
  }
  return {
    candidateId,
    segments,
    ...(finiteNumber(value, "sourceResolvedDistanceNm") !== undefined ? { sourceResolvedDistanceNm: finiteNumber(value, "sourceResolvedDistanceNm") } : {}),
    ...(finiteNumber(value, "borrowedDistanceNm") !== undefined ? { borrowedDistanceNm: finiteNumber(value, "borrowedDistanceNm") } : {}),
    ...(finiteNumber(value, "estimatedTotalDistanceNm") !== undefined ? { estimatedTotalDistanceNm: finiteNumber(value, "estimatedTotalDistanceNm") } : {}),
    corridorsCovered: finiteNumber(value, "corridorsCovered") ?? 0,
  };
}

export async function fetchSynthesis(flightId: OpaqueId, cursor: string | undefined, signal?: AbortSignal): Promise<SynthesisResult> {
  const payload = await request("/api/v1/routes/synthesis", {
    method: "POST",
    ...(signal ? { signal } : {}),
    body: JSON.stringify({ flightId, ...(cursor ? { cursor } : {}) }),
  });
  if (!isRecord(payload)) throw new ApiError(502, "The synthesis response is not an object.", "SYNTHESIS_MALFORMED");
  const status = stringValue(payload, "status");
  if (status !== "not-needed" && status !== "full" && status !== "ambiguous" && status !== "partial" && status !== "unavailable" && status !== "over-limit" && status !== "candidate-limit-exceeded") {
    throw new ApiError(502, "The synthesis response has no usable status.", "SYNTHESIS_MALFORMED");
  }
  return {
    status,
    corridorCount: finiteNumber(payload, "corridorCount") ?? 0,
    corridorsCovered: finiteNumber(payload, "corridorsCovered") ?? 0,
    candidates: Array.isArray(payload.candidates) ? payload.candidates.flatMap((candidate) => { const normalized = normalizeSynthesisCandidate(candidate); return normalized ? [normalized] : []; }) : [],
    ...(stringValue(payload, "nextCursor") ? { nextCursor: stringValue(payload, "nextCursor") } : {}),
    ...(stringValue(payload, "safety") ? { safety: stringValue(payload, "safety") } : {}),
  };
}

export async function fetchDonorProof(proofId: string, signal?: AbortSignal): Promise<DonorProofResult> {
  const payload = await request("/api/v1/routes/source-occurrences", {
    method: "POST",
    ...(signal ? { signal } : {}),
    body: JSON.stringify({ proofId }),
  });
  const data = isRecord(payload) && isRecord(payload.data) ? payload.data : {};
  const flightId = stringValue(data, "flightId") ?? "";
  const occurrences = Array.isArray(data.occurrences) ? data.occurrences.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const ordinal = finiteNumber(entry, "ordinal");
    const entryStatus = stringValue(entry, "status");
    if (ordinal === undefined || !entryStatus) return [];
    const lat = isRecord(entry.coordinate) ? finiteNumber(entry.coordinate, "lat") : undefined;
    const lon = isRecord(entry.coordinate) ? finiteNumber(entry.coordinate, "lon") : undefined;
    return [{
      ordinal, status: entryStatus,
      ...(stringValue(entry, "label") ? { label: stringValue(entry, "label") } : {}),
      ...(lat !== undefined && lon !== undefined ? { coordinate: { lat, lon } } : {}),
      ...(stringValue(entry, "reason") ? { reason: stringValue(entry, "reason") } : {}),
    }];
  }) : [];
  return { flightId, occurrences };
}

export type Readiness = {
  status: string;
  generation?: GenerationSummary | undefined;
  code?: string | undefined;
  retryable?: boolean | undefined;
};


export type RouteOverviewResult = {
  routes: RouteOption[];
  generation: GenerationSummary;
};

export async function fetchRouteOverview(signal?: AbortSignal): Promise<RouteOverviewResult> {
  const routes: RouteOption[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  let generation: GenerationSummary | undefined;
  for (;;) {
    const payload = await request("/api/v1/routes/overview", {
      method: "POST",
      ...(signal ? { signal } : {}),
      body: JSON.stringify({ limit: 25, ...(cursor ? { cursor } : {}) }),
    });
    if (!isRecord(payload)) throw new Error("The route overview response was not usable.");
    const pageGeneration = normalizeGeneration(payload.generation);
    if (!pageGeneration) throw new Error("The route overview did not include a generation.");
    if (generation && generation.id !== pageGeneration.id) throw new ApiError(409, "The data generation changed while loading the overview. Retry the overview.", "GENERATION_CHANGED");
    generation = pageGeneration;
    const page = unwrap(payload).flatMap((item, index) => {
      const route = normalizeRoute(item, routes.length + index);
      return route ? [route] : [];
    });
    for (const route of page) {
      if (seen.has(route.flightId)) throw new Error("The route overview returned a duplicate flight identity.");
      seen.add(route.flightId);
      routes.push(route);
    }
    const nextCursor = stringValue(payload, "nextCursor");
    if (!nextCursor) break;
    if (page.length === 0) throw new Error("The route overview cursor did not make progress.");
    cursor = nextCursor;
  }
  if (!generation) throw new Error("The route overview was empty and had no generation.");
  return { routes, generation };
}
export async function fetchReadiness(signal?: AbortSignal): Promise<Readiness> {
  const payload = await request("/api/v1/readiness", signal ? { signal } : {});
  if (!isRecord(payload)) return { status: "unavailable" };
  const generation = normalizeGeneration(payload.generation);
  return {
    status: stringValue(payload, "status") ?? "unavailable",
    ...(generation ? { generation } : {}),
    ...(stringValue(payload, "code") ? { code: stringValue(payload, "code") } : {}),
    ...(typeof payload.retryable === "boolean" ? { retryable: payload.retryable } : {}),
  };
}

export type RefreshResult = {
  status: string;
  generation: GenerationSummary;
};

export async function refreshLiveData(signal?: AbortSignal): Promise<RefreshResult> {
  const payload = await request("/api/v1/refresh", { method: "POST", ...(signal ? { signal } : {}) });
  if (!isRecord(payload)) throw new Error("The route service did not confirm the refresh.");
  const generation = normalizeGeneration(payload.generation);
  if (!generation) throw new Error("The route service did not return a generation summary.");
  return { status: stringValue(payload, "status") ?? "refreshed", generation };
}

export async function fetchRouteData(routeId: OpaqueId, signal?: AbortSignal): Promise<RouteOption> {
  // URL privacy (plan §2.4): the signed flight token travels in the POST body,
  // never in a request URL.
  const payload = await request("/api/v1/routes/detail", {
    method: "POST",
    ...(signal ? { signal } : {}),
    body: JSON.stringify({ routeId }),
  });
  const route = normalizeRoute(isRecord(payload) && payload.data ? payload.data : payload, 0);
  if (!route) throw new Error("The route response did not contain usable route data.");
  return route;
}

export type DraftRoute = {
  id: OpaqueId;
  origin: string;
  destination: string;
  legs: RouteLeg[];
  gaps: RouteGap[];
  distanceNm?: number | undefined;
  geometry?: Coordinate[] | undefined;
  provenance?: string | undefined;
  freshness?: string | undefined;
  safety?: string | undefined;
};

export type DraftSelection = { sequence: number; locationId: OpaqueId };

export type DraftComparison = {
  id: OpaqueId;
  draft: { origin: string; destination: string; via: string[]; selections: DraftSelection[] };
  route: DraftRoute;
  comparison: {
    status: "complete" | "gap" | string;
    message: string;
    distanceDeltaNm?: number | undefined;
    percentageDistanceDelta?: number | undefined;
    unavailable?: string[] | undefined;
  };
};

export type PointMatch = {
  /** Server-issued generation-bound location token; never a client-supplied coordinate. */
  locationId: OpaqueId;
  identifier: string;
  name: string;
  kind: string;
  coordinate: Coordinate;
  duplicateGroup?: string | undefined;
};

function normalizePointMatch(value: unknown): PointMatch | undefined {
  if (!isRecord(value)) return undefined;
  const locationId = stringValue(value, "id");
  const identifier = stringValue(value, "callsign", "code", "name");
  const coordinateValue = value.coordinate;
  const coordinate = isRecord(coordinateValue)
    ? { lat: finiteNumber(coordinateValue, "lat", "latitude"), lon: finiteNumber(coordinateValue, "lon", "lng", "longitude") }
    : undefined;
  if (!locationId || !identifier || !coordinate || coordinate.lat === undefined || coordinate.lon === undefined) return undefined;
  return {
    locationId,
    identifier,
    name: stringValue(value, "name", "callsign") ?? identifier,
    kind: stringValue(value, "kind") ?? "reference point",
    coordinate: { lat: coordinate.lat, lon: coordinate.lon },
    ...(stringValue(value, "duplicateGroup") ? { duplicateGroup: stringValue(value, "duplicateGroup") } : {}),
  };
}

export type PointLookupResult = {
  matches: PointMatch[];
  /** Present when the ambiguity page bound (50) was reached and more matches exist. */
  truncated: boolean;
};

export async function lookupPoint(reference: string, signal?: AbortSignal): Promise<PointLookupResult> {
  // URL privacy (plan §2.4): the user's search term travels in the POST body,
  // never in a request URL.
  const payload = await request("/api/v1/points/lookup", {
    method: "POST",
    ...(signal ? { signal } : {}),
    body: JSON.stringify({ reference }),
  });
  if (!isRecord(payload)) return { matches: [], truncated: false };
  const values = Array.isArray(payload.matches) ? payload.matches : payload.data ? [payload.data] : [];
  const matches = values.flatMap((value) => {
    const match = normalizePointMatch(value);
    return match ? [match] : [];
  });
  return { matches, truncated: typeof payload.nextCursor === "string" };
}

/**
 * Validates a local draft as the target operand of the two-operand route
 * comparison against a selected recorded baseline route. The server computes
 * the directed modeled-distance difference at full precision; the client only
 * ever formats it.
 */
export async function validateDraft(origin: string, destination: string, via: string[], selections: DraftSelection[], baselineId: OpaqueId, signal?: AbortSignal): Promise<DraftComparison> {
  const payload = await request("/api/v1/routes/compare", {
    method: "POST",
    ...(signal ? { signal } : {}),
    body: JSON.stringify({ baselineId, targetDraft: { origin, destination, via, selections } }),
  });
  if (!isRecord(payload) || !isRecord(payload.target) || !isRecord(payload.comparison)) {
    throw new Error("The route service did not return a usable draft comparison.");
  }
  const route = payload.target;
  const legs = Array.isArray(route.legs) ? route.legs.flatMap((leg, index) => {
    const normalized = normalizeLeg(leg, index);
    return normalized ? [normalized] : [];
  }) : [];
  const gaps = Array.isArray(route.gaps) ? route.gaps.flatMap((gap, index) => {
    const normalized = normalizeGap(gap, index);
    return normalized ? [normalized] : [];
  }) : [];
  const comparison = payload.comparison;
  const message = stringValue(comparison, "message") ?? "Draft validation completed.";
  const id = stringValue(route, "id");
  if (!id) throw new Error("The route service did not return a complete draft identity.");
  return {
    id,
    draft: { origin, destination, via: [...via], selections: selections.map((selection) => ({ sequence: selection.sequence, locationId: selection.locationId })) },
    route: {
      id,
      origin: stringValue(route, "origin") ?? origin,
      destination: stringValue(route, "destination") ?? destination,
      legs,
      gaps,
      ...(finiteNumber(route, "distanceNm") !== undefined ? { distanceNm: finiteNumber(route, "distanceNm") } : {}),
      ...(normalizeGeometry(route.geometry) ? { geometry: normalizeGeometry(route.geometry) } : {}),
      ...(stringValue(route, "provenance") ? { provenance: stringValue(route, "provenance") } : {}),
      ...(stringValue(route, "freshness") ? { freshness: stringValue(route, "freshness") } : {}),
      ...(stringValue(route, "safety") ? { safety: stringValue(route, "safety") } : {}),
    },
    comparison: {
      status: stringValue(comparison, "status") ?? "gap",
      message,
      ...(finiteNumber(comparison, "distanceDeltaNm") !== undefined ? { distanceDeltaNm: finiteNumber(comparison, "distanceDeltaNm") } : {}),
      ...(finiteNumber(comparison, "percentageDistanceDelta") !== undefined ? { percentageDistanceDelta: finiteNumber(comparison, "percentageDistanceDelta") } : {}),
      ...(Array.isArray(comparison.unavailable) ? { unavailable: comparison.unavailable.filter((value): value is string => typeof value === "string") } : {}),
    },
  };
}

// --- Bulk data browse (owner-authorized 2026-08-15) ------------------------
// /api/v1/data/* endpoints serve normalized public DTO fields only; airway
// values/types never appear (counts only). Cursors and limits travel in POST
// bodies, never in URLs.

export type DataFamilySummary = {
  family: string;
  records: number;
  acceptedRecords?: number | undefined;
  rejectedRecords?: number | undefined;
};

export type AirwaySummary = DataFamilySummary & {
  uniqueRecords?: number | undefined;
};

export type DataSummary = {
  generation: GenerationSummary;
  families: DataFamilySummary[];
  airway: AirwaySummary;
};

export type FlightBrowseItem = {
  id: OpaqueId;
  callsign: string;
  departure: string;
  destination: string;
  pointCount: number;
};

export type ReferenceBrowseItem = {
  id: OpaqueId;
  identifier: string;
  name: string;
  kind: string;
  coordinate: Coordinate;
};

export type BrowsePage<T> = {
  items: T[];
  nextCursor?: string | undefined;
  generation?: GenerationSummary | undefined;
};

export async function fetchDataSummary(signal?: AbortSignal): Promise<DataSummary> {
  const payload = await request("/api/v1/data/summary", signal ? { signal } : {});
  const generation = isRecord(payload) ? normalizeGeneration(payload.generation) : undefined;
  if (!generation) throw new Error("The data summary did not include a generation.");
  const families = (isRecord(payload) && Array.isArray(payload.families) ? payload.families : []).flatMap((family) => {
    if (!isRecord(family)) return [];
    const records = finiteNumber(family, "records");
    if (records === undefined) return [];
    const normalized: DataFamilySummary = {
      family: stringValue(family, "family") ?? "unknown",
      records,
      ...(finiteNumber(family, "acceptedRecords") !== undefined ? { acceptedRecords: finiteNumber(family, "acceptedRecords") } : {}),
      ...(finiteNumber(family, "rejectedRecords") !== undefined ? { rejectedRecords: finiteNumber(family, "rejectedRecords") } : {}),
    };
    return [normalized];
  });
  const airwayValue = isRecord(payload) && isRecord(payload.airway) ? payload.airway : undefined;
  const airwayRecords = airwayValue ? finiteNumber(airwayValue, "records") : undefined;
  if (airwayRecords === undefined) throw new Error("The data summary did not include airway counts.");
  return {
    generation,
    families,
    airway: {
      family: "airways",
      records: airwayRecords,
      ...(finiteNumber(airwayValue!, "acceptedRecords") !== undefined ? { acceptedRecords: finiteNumber(airwayValue!, "acceptedRecords") } : {}),
      ...(finiteNumber(airwayValue!, "rejectedRecords") !== undefined ? { rejectedRecords: finiteNumber(airwayValue!, "rejectedRecords") } : {}),
      ...(finiteNumber(airwayValue!, "uniqueRecords") !== undefined ? { uniqueRecords: finiteNumber(airwayValue!, "uniqueRecords") } : {}),
    },
  };
}

async function browsePage<T>(path: string, normalize: (value: unknown, index: number) => T | undefined, limit: number, cursor: string | undefined, signal: AbortSignal | undefined): Promise<BrowsePage<T>> {
  const payload = await request(path, {
    method: "POST",
    ...(signal ? { signal } : {}),
    body: JSON.stringify({ limit, ...(cursor ? { cursor } : {}) }),
  });
  return {
    items: unwrap(payload).flatMap((item, index) => {
      const normalized = normalize(item, index);
      return normalized ? [normalized] : [];
    }),
    ...(isRecord(payload) && stringValue(payload, "nextCursor") ? { nextCursor: stringValue(payload, "nextCursor") } : {}),
    ...(isRecord(payload) ? (normalizeGeneration(payload.generation) ? { generation: normalizeGeneration(payload.generation) } : {}) : {}),
  };
}

function normalizeFlightBrowseItem(value: unknown): FlightBrowseItem | undefined {
  if (!isRecord(value)) return undefined;
  const id = stringValue(value, "id");
  const callsign = stringValue(value, "callsign");
  if (!id || !callsign) return undefined;
  return {
    id,
    callsign,
    departure: stringValue(value, "departure", "origin") ?? "Not supplied",
    destination: stringValue(value, "destination") ?? "Not supplied",
    pointCount: finiteNumber(value, "pointCount") ?? 0,
  };
}

function normalizeReferenceBrowseItem(value: unknown): ReferenceBrowseItem | undefined {
  if (!isRecord(value)) return undefined;
  const id = stringValue(value, "id");
  const identifier = stringValue(value, "callsign", "code", "name");
  const coordinateValue = value.coordinate;
  const coordinate = isRecord(coordinateValue)
    ? { lat: finiteNumber(coordinateValue, "lat", "latitude"), lon: finiteNumber(coordinateValue, "lon", "lng", "longitude") }
    : undefined;
  if (!id || !identifier || !coordinate || coordinate.lat === undefined || coordinate.lon === undefined) return undefined;
  return {
    id,
    identifier,
    name: stringValue(value, "name", "callsign") ?? identifier,
    kind: stringValue(value, "kind") ?? "reference point",
    coordinate: { lat: coordinate.lat, lon: coordinate.lon },
  };
}

export function browseFlights(limit = 50, cursor?: string, signal?: AbortSignal): Promise<BrowsePage<FlightBrowseItem>> {
  return browsePage("/api/v1/data/flights", normalizeFlightBrowseItem, limit, cursor, signal);
}

export function browseFixes(limit = 50, cursor?: string, signal?: AbortSignal): Promise<BrowsePage<ReferenceBrowseItem>> {
  return browsePage("/api/v1/data/fixes", normalizeReferenceBrowseItem, limit, cursor, signal);
}

export function browseAirports(limit = 50, cursor?: string, signal?: AbortSignal): Promise<BrowsePage<ReferenceBrowseItem>> {
  return browsePage("/api/v1/data/airports", normalizeReferenceBrowseItem, limit, cursor, signal);
}

export function browseNavaids(limit = 50, cursor?: string, signal?: AbortSignal): Promise<BrowsePage<ReferenceBrowseItem>> {
  return browsePage("/api/v1/data/navaids", normalizeReferenceBrowseItem, limit, cursor, signal);
}
