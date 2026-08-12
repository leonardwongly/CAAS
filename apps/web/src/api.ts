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
  rankDistanceNm?: number | undefined;
  rank?: number | undefined;
  geometry?: Coordinate[] | undefined;
  provenance?: string | undefined;
  freshness?: string | undefined;
  safety?: string | undefined;
  gaps: RouteGap[];
};

export class ApiError extends Error {
  constructor(public readonly status: number, message: string, public readonly code?: string) {
    super(message);
    this.name = "ApiError";
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
    ...(finiteNumber(value, "rankDistanceNm") !== undefined ? { rankDistanceNm: finiteNumber(value, "rankDistanceNm") } : {}),
    ...(finiteNumber(value, "rank") !== undefined ? { rank: finiteNumber(value, "rank") } : {}),
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
    try {
      const body = await response.json() as unknown;
      if (isRecord(body) && isRecord(body.error)) {
        detail = typeof body.error.message === "string" ? body.error.message : detail;
        code = typeof body.error.code === "string" ? body.error.code : undefined;
      }
    } catch { /* Keep the status-only message. */ }
    throw new ApiError(response.status, detail, code);
  }
  return response.json();
}

export async function searchCallsigns(query: string, signal?: AbortSignal): Promise<CallsignMatch[]> {
  const payload = await request(`/api/v1/callsigns/search?query=${encodeURIComponent(query)}`, signal ? { signal } : {});
  return unwrap(payload).flatMap((item) => {
    const match = normalizeMatch(item);
    return match ? [match] : [];
  });
}

export async function fetchRouteOptions(flightId: OpaqueId, signal?: AbortSignal): Promise<RouteOption[]> {
  const payload = await request("/api/v1/routes/options", {
    method: "POST",
    ...(signal ? { signal } : {}),
    body: JSON.stringify({ flightId }),
  });
  return unwrap(payload).flatMap((item, index) => {
    const route = normalizeRoute(item, index);
    return route ? [route] : [];
  });
}

export async function fetchRouteData(routeId: OpaqueId, signal?: AbortSignal): Promise<RouteOption> {
  const payload = await request(`/api/v1/routes/${encodeURIComponent(routeId)}`, signal ? { signal } : {});
  const route = normalizeRoute(isRecord(payload) && payload.data ? payload.data : payload, 0);
  if (!route) throw new Error("The route response did not contain usable route data.");
  return route;
}
