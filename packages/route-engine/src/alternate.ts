import { MAX_ROUTE_POINTS, type Coordinate } from "@flight-route-explorer/contracts";
import { degreesToRadians } from "./index.ts";

/**
 * A genuine, coordinate-derived alternate route: the direct great-circle path
 * between two resolved positions, densified so it renders as a true geodesic
 * (not a projected chord) on both Mercator and equirectangular maps.
 *
 * This is the honest form of the challenge's optional "alternate route" task:
 * the supplied Airways endpoint returns names only (no connectivity), so the
 * only alternate that can be computed from the authorized coordinate data is
 * the great-circle direct path between departure and destination.
 */
export const DIRECT_ALTERNATE_SEGMENTS = 32;

export interface DirectAlternate {
  readonly coordinates: readonly Coordinate[];
  readonly segmentCount: number;
}

function greatCirclePoint(departure: Coordinate, destination: Coordinate, t: number): Coordinate {
  if (t <= 0) return { lat: departure.lat, lon: departure.lon };
  if (t >= 1) return { lat: destination.lat, lon: destination.lon };
  const lat1 = degreesToRadians(departure.lat);
  const lon1 = degreesToRadians(departure.lon);
  const lat2 = degreesToRadians(destination.lat);
  const lon2 = degreesToRadians(destination.lon);
  const dLon = lon2 - lon1;
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  const angular = Math.atan2(Math.sqrt(x * x + y * y), Math.sin(lat1) * Math.sin(lat2) + Math.cos(lat1) * Math.cos(lat2) * Math.cos(dLon));
  if (angular < 1e-12) return { lat: departure.lat, lon: departure.lon };
  const sinA = Math.sin(angular);
  const w1 = Math.sin((1 - t) * angular) / sinA;
  const w2 = Math.sin(t * angular) / sinA;
  const px = w1 * Math.cos(lat1) * Math.cos(lon1) + w2 * Math.cos(lat2) * Math.cos(lon2);
  const py = w1 * Math.cos(lat1) * Math.sin(lon1) + w2 * Math.cos(lat2) * Math.sin(lon2);
  const pz = w1 * Math.sin(lat1) + w2 * Math.sin(lat2);
  return {
    lat: Math.atan2(pz, Math.sqrt(px * px + py * py)) * 180 / Math.PI,
    lon: Math.atan2(py, px) * 180 / Math.PI,
  };
}

export function directGreatCircleAlternate(departure: Coordinate, destination: Coordinate, segments = DIRECT_ALTERNATE_SEGMENTS): DirectAlternate {
  if (!Number.isFinite(segments) || !Number.isInteger(segments) || segments < 1) {
    throw new RangeError("segments must be a positive integer");
  }
  const count = Math.min(MAX_ROUTE_POINTS - 1, segments);
  const coordinates: Coordinate[] = [];
  for (let index = 0; index <= count; index += 1) {
    coordinates.push(greatCirclePoint(departure, destination, index / count));
  }
  return { coordinates: Object.freeze(coordinates), segmentCount: count };
}
