// Dependency-free OpenStreetMap raster tile layer (owner-authorized
// 2026-08-15). Web Mercator (EPSG:3857) math with plain <img> tiles; no map
// SDK, no provider API key. Tile URLs carry z/x/y only — never app state.
// jsdom-safe: no canvas, no module-scope window access, zero-size stages fall
// back to DEFAULT_SIZE.
import type { Coordinate } from "./api";

export const MERCATOR_MAX_LAT = 85.05112877980659;
export const MIN_ZOOM = 1;
export const MAX_ZOOM = 19;
export const TILE_SIZE = 256;
export const MAX_TILES_PER_FRAME = 64;
export const TILE_HOST = "https://tile.openstreetmap.org";
export const OSM_ATTRIBUTION = "© OpenStreetMap contributors";
export const DEFAULT_SIZE = { width: 800, height: 600 };

export type TileView = { lat: number; lon: number; zoom: number };
export type MapSize = { width: number; height: number };
export type MercatorProjection = {
  segments: Array<{ path: string }>;
  start?: { x: number; y: number } | undefined;
  end?: { x: number; y: number } | undefined;
  gapBoundaries: Array<{ x: number; y: number }>;
};

export function clampLat(lat: number): number {
  return Math.min(MERCATOR_MAX_LAT, Math.max(-MERCATOR_MAX_LAT, lat));
}

export function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

/** World-pixel coordinate of a lat/lon at zoom z (EPSG:3857, 256px tiles). */
export function worldPixel(lat: number, lon: number, zoom: number): { x: number; y: number } {
  const scale = TILE_SIZE * 2 ** zoom;
  const clamped = clampLat(lat);
  const sinLat = Math.sin((clamped * Math.PI) / 180);
  const x = ((lon + 180) / 360) * scale;
  const y = ((1 - Math.log((1 + sinLat) / (1 - sinLat)) / Math.PI) / 2) * scale;
  return { x, y };
}

/** Screen pixel of a coordinate under the current view; antimeridian-shortest. */
export function pixelFromView(coordinate: Coordinate, view: TileView, size: MapSize): { x: number; y: number } {
  const scale = TILE_SIZE * 2 ** view.zoom;
  const center = worldPixel(view.lat, view.lon, view.zoom);
  const point = worldPixel(coordinate.lat, coordinate.lon, view.zoom);
  let dx = point.x - center.x;
  // Draw across the shorter arc so routes crossing the antimeridian do not
  // shoot across the whole world.
  if (dx > scale / 2) dx -= scale;
  if (dx < -scale / 2) dx += scale;
  const dy = point.y - center.y;
  return { x: size.width / 2 + dx, y: size.height / 2 + dy };
}

/** World coordinate under a screen point for the current view (inverse of pixelFromView). */
export function coordinateFromScreen(point: { x: number; y: number }, view: TileView, size: MapSize): Coordinate {
  const scale = TILE_SIZE * 2 ** view.zoom;
  const center = worldPixel(view.lat, view.lon, view.zoom);
  const worldX = center.x + (point.x - size.width / 2);
  const worldY = center.y + (point.y - size.height / 2);
  const unwrappedLon = (worldX / scale) * 360 - 180;
  const lon = ((unwrappedLon + 180) % 360 + 360) % 360 - 180;
  const n = Math.PI * (1 - (2 * worldY) / scale);
  const lat = (Math.atan(Math.sinh(n)) * 180) / Math.PI;
  return { lat: clampLat(lat), lon };
}

/** Inverse of pixelFromView: the view after dragging the content by screen px. */
export function viewFromPixelDelta(dx: number, dy: number, view: TileView, size: MapSize): TileView {
  const scale = TILE_SIZE * 2 ** view.zoom;
  const center = worldPixel(view.lat, view.lon, view.zoom);
  const nx = center.x - dx;
  const ny = center.y - dy;
  const unwrappedLon = (nx / scale) * 360 - 180;
  const lon = ((unwrappedLon + 180) % 360 + 360) % 360 - 180;
  const n = Math.PI * (1 - (2 * ny) / scale);
  const lat = (Math.atan(Math.sinh(n)) * 180) / Math.PI;
  return { lat: clampLat(lat), lon, zoom: view.zoom };
}

/** Visible tile coordinates for the view; bounded by the per-frame tile cap. */
export function tileRange(view: TileView, size: MapSize): Array<{ x: number; y: number; z: number }> {
  const z = Math.round(clampZoom(view.zoom));
  const n = 2 ** z;
  const centerX = ((view.lon + 180) / 360) * n * TILE_SIZE;
  const centerY = worldPixel(view.lat, view.lon, z).y;
  const xMin = Math.max(0, Math.floor((centerX - size.width / 2) / TILE_SIZE));
  const xMax = Math.min(n - 1, Math.floor((centerX + size.width / 2) / TILE_SIZE));
  const yMin = Math.max(0, Math.floor((centerY - size.height / 2) / TILE_SIZE));
  const yMax = Math.min(n - 1, Math.floor((centerY + size.height / 2) / TILE_SIZE));
  const tiles: Array<{ x: number; y: number; z: number }> = [];
  for (let y = yMin; y <= yMax && tiles.length < MAX_TILES_PER_FRAME; y++) {
    for (let x = xMin; x <= xMax && tiles.length < MAX_TILES_PER_FRAME; x++) {
      tiles.push({ x: ((x % n) + n) % n, y, z });
    }
  }
  return tiles;
}

export function tileUrl(tile: { x: number; y: number; z: number }): string {
  // z/x/y only: no query string, no application state, per the tile-URL
  // contract (design legacy §21, restored as normative evidence in tests).
  return `${TILE_HOST}/${tile.z}/${tile.x}/${tile.y}.png`;
}

/** Projects route segments to screen pixels under the current tile view. */
export function projectWorldSegmentsMercator(segments: Coordinate[][], view: TileView, size: MapSize): MercatorProjection | undefined {
  const validSegments = segments.filter((segment) => segment.length >= 2);
  if (!validSegments.length) return undefined;
  const projected = validSegments.map((segment) => segment.map((coordinate) => pixelFromView(coordinate, view, size)));
  return {
    segments: validSegments.map((segment, segmentIndex) => ({ path: segment.map((coordinate, pointIndex) => {
      const previous = segment[pointIndex - 1];
      const wrap = pointIndex === 0 || (previous !== undefined && Math.abs(coordinate.lon - previous.lon) > 180);
      const point = projected[segmentIndex]![pointIndex]!;
      return `${wrap ? "M" : "L"} ${point.x.toFixed(1)} ${point.y.toFixed(1)}`;
    }).join(" ") })),
    start: projected[0]?.[0],
    end: projected.at(-1)?.at(-1),
    gapBoundaries: projected.slice(0, -1).flatMap((segment, index) => projected[index + 1] ? [segment.at(-1)!, projected[index + 1]![0]!] : []),
  };
}

/** Presentational tile grid; interaction and controls live in the parent map. */
export function TileLayer({ view, size, onTileFailure }: { view: TileView; size: MapSize; onTileFailure: () => void }) {
  const z = Math.round(clampZoom(view.zoom));
  const n = 2 ** z;
  const centerX = ((view.lon + 180) / 360) * n * TILE_SIZE;
  const centerY = worldPixel(view.lat, view.lon, z).y;
  const offsetLeft = size.width / 2 - centerX;
  const offsetTop = size.height / 2 - centerY;
  return <div className="tile-layer" data-testid="tile-layer" aria-hidden="true">
    {tileRange(view, size).map((tile) => <img key={`${tile.z}/${tile.x}/${tile.y}`} src={tileUrl(tile)} alt="" draggable={false} referrerPolicy="no-referrer" onError={onTileFailure} style={{ left: offsetLeft + tile.x * TILE_SIZE, top: offsetTop + tile.y * TILE_SIZE, width: TILE_SIZE, height: TILE_SIZE }} />)}
  </div>;
}
