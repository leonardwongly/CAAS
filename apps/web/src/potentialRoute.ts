import type { Coordinate, RouteOption } from "./api";


export type PotentialEndpoints = {
  origin?: Coordinate | undefined;
  destination?: Coordinate | undefined;
};

export type ConservativePotentialRoute = {
  knownSegments: Coordinate[][];
  inferredSegments: Coordinate[][];
  derivedPoints: Coordinate[];
};

function radians(value: number): number { return (value * Math.PI) / 180; }
function degrees(value: number): number { return (value * 180) / Math.PI; }
function normalizeLongitude(value: number): number { return ((value + 540) % 360) - 180; }

function sameCoordinate(left: Coordinate, right: Coordinate): boolean {
  return left.lat === right.lat && left.lon === right.lon;
}

/** Geographic midpoint, not an invented fix or asserted route waypoint. */
function greatCircleMidpoint(from: Coordinate, to: Coordinate): Coordinate {
  const latitudeFrom = radians(from.lat);
  const latitudeTo = radians(to.lat);
  const longitudeFrom = radians(from.lon);
  const longitudeDelta = radians(normalizeLongitude(to.lon - from.lon));
  const bx = Math.cos(latitudeTo) * Math.cos(longitudeDelta);
  const by = Math.cos(latitudeTo) * Math.sin(longitudeDelta);
  return {
    lat: degrees(Math.atan2(Math.sin(latitudeFrom) + Math.sin(latitudeTo), Math.hypot(Math.cos(latitudeFrom) + bx, by))),
    lon: normalizeLongitude(degrees(longitudeFrom + Math.atan2(by, Math.cos(latitudeFrom) + bx))),
  };
}

/**
 * Produce only a client-side visual estimate for an incomplete route. Recorded
 * geometry is copied unchanged. A dotted span is allowed only between two exact
 * anchors, at least one of which belongs to a recorded component. There is no
 * span-distance upper limit. No topology, fix name, distance,
 * completeness, ranking, comparison, export, or server data is inferred.
 */
export function deriveConservativePotentialRoute(route: RouteOption, endpoints: PotentialEndpoints = {}): ConservativePotentialRoute | undefined {
  if (route.complete || route.gaps.length === 0) return undefined;
  const knownSegments = (route.segments ?? (route.geometry ? [route.geometry] : []))
    .filter((segment) => segment.length >= 2)
    .map((segment) => [...segment]);
  // Endpoints alone do not establish a route direction or intermediate path.
  if (knownSegments.length === 0) return undefined;

  const inferredSegments: Coordinate[][] = [];
  const derivedPoints: Coordinate[] = [];
  const addSpan = (from: Coordinate | undefined, to: Coordinate | undefined) => {
    if (!from || !to || sameCoordinate(from, to)) return;
    const synthetic = greatCircleMidpoint(from, to);
    inferredSegments.push([from, synthetic, to]);
    derivedPoints.push(synthetic);
  };

  const first = knownSegments[0]?.[0];
  const lastSegment = knownSegments[knownSegments.length - 1];
  const last = lastSegment?.[lastSegment.length - 1];
  addSpan(endpoints.origin, first);
  for (let index = 0; index < knownSegments.length - 1; index += 1) {
    addSpan(knownSegments[index]?.at(-1), knownSegments[index + 1]?.[0]);
  }
  addSpan(last, endpoints.destination);

  return { knownSegments, inferredSegments, derivedPoints };
}
