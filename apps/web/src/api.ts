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

export type OperationalProxy = {
  mode: "operational-proxy";
  eligible: boolean;
  criterion: string;
  summary: string;
  rank?: number | undefined;
  exclusion?: string | undefined;
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
  rankDistanceNm?: number | undefined;
  rank?: number | undefined;
  operationalProxy?: OperationalProxy | undefined;
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

function finiteNumber(record: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
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
  const lon = typeof value[0] === "number" ? value[0] : Number(value[0]);
  const lat = typeof value[1] === "number" ? value[1] : Number(value[1]);
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
      const lat = typeof point.lat === "number" ? point.lat : Number(point.lat ?? point.latitude);
      const lon = typeof point.lon === "number" ? point.lon : Number(point.lon ?? point.longitude ?? point.lng);
      return Number.isFinite(lat) && Number.isFinite(lon) ? [{ lat, lon }] : [];
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

function normalizeOperationalProxy(value: unknown): OperationalProxy | undefined {
  if (!isRecord(value) || value.mode !== "operational-proxy" || typeof value.eligible !== "boolean") return undefined;
  const criterion = stringValue(value, "criterion");
  const summary = stringValue(value, "summary");
  if (!criterion || !summary) return undefined;
  return {
    mode: "operational-proxy",
    eligible: value.eligible,
    criterion,
    summary,
    ...(finiteNumber(value, "rank") !== undefined ? { rank: finiteNumber(value, "rank") } : {}),
    ...(stringValue(value, "exclusion") ? { exclusion: stringValue(value, "exclusion") } : {}),
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
  const operationalProxy = normalizeOperationalProxy(value.operationalProxy);
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
    ...(finiteNumber(value, "rankDistanceNm") !== undefined ? { rankDistanceNm: finiteNumber(value, "rankDistanceNm") } : {}),
    ...(finiteNumber(value, "rank") !== undefined ? { rank: finiteNumber(value, "rank") } : {}),
    ...(operationalProxy ? { operationalProxy } : {}),
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
  rankLabel?: string | undefined;
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
    ...(isRecord(payload) && stringValue(payload, "rankLabel") ? { rankLabel: stringValue(payload, "rankLabel") } : {}),
    ...(generation ? { generation } : {}),
  };
}

export type Readiness = {
  status: string;
  generation?: GenerationSummary | undefined;
  code?: string | undefined;
  retryable?: boolean | undefined;
};

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
  const payload = await request(`/api/v1/routes/${encodeURIComponent(routeId)}`, signal ? { signal } : {});
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
  rankDistanceNm?: number | undefined;
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
  const payload = await request(`/api/v1/points/${encodeURIComponent(reference)}`, signal ? { signal } : {});
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
      ...(finiteNumber(route, "rankDistanceNm") !== undefined ? { rankDistanceNm: finiteNumber(route, "rankDistanceNm") } : {}),
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
