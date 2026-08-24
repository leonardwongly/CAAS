import { expect, test, type Page } from "@playwright/test";
import { fitViewToCoordinates } from "../../apps/web/src/TileMap.tsx";

/**
 * Real-browser regression for the map navigation layer: tile URL contract,
 * zoom buttons under real pointer clicks, wheel-burst debouncing without
 * passive-listener errors, drag panning, base-map toggle, control hit-target
 * integrity (no overlay swallowing clicks), and endpoint marker rendering.
 * Tiles are served from an in-test 1x1 PNG so the lane is deterministic and
 * offline-safe; src attributes still carry the live z/x/y contract.
 */

const TILE_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

const generation = {
  id: "map-controls-generation",
  retrievedAt: "2026-08-16T00:00:00.000Z",
  live: { state: "fresh", retrievedAt: "2026-08-16T00:00:00.000Z", freshUntil: "2026-08-16T01:00:00.000Z", staleUntil: "2026-08-16T02:00:00.000Z" },
  reference: { state: "fresh", retrievedAt: "2026-08-16T00:00:00.000Z", freshUntil: "2026-08-17T00:00:00.000Z", staleUntil: "2026-08-18T00:00:00.000Z" },
  overall: "fresh",
};

const route = {
  id: "route-map-1", flightId: "flight-map-1", callsign: "MAPFIX1", status: "complete", complete: true,
  label: "Recorded map regression route", origin: "KOR1", destination: "KDS1", pointCount: 3,
  legs: [
    { id: "leg-1", sequence: 1, kind: "direct", from: "KOR1", to: "MIDPT", distanceNm: 240.5, status: "resolved" },
    { id: "leg-2", sequence: 2, kind: "direct", from: "MIDPT", to: "KDS1", distanceNm: 271.9, status: "resolved" },
  ],
  geometry: { type: "LineString", coordinates: [[-73, 40], [-90, 35], [-118, 33]] }, distanceNm: 512.4,
  provenance: "CAAS normalized live generation", gaps: [],
};

// A wider complete record so the overview renders a dimmed alternate whose
// geometry must also fit inside the viewport after a selection.
const alternateRoute = {
  id: "route-map-2", flightId: "flight-map-2", callsign: "MAPALT2", status: "complete", complete: true,
  label: "Recorded alternate route", origin: "KOR1", destination: "KDS1", pointCount: 3,
  legs: [
    { id: "alt-leg-1", sequence: 1, kind: "direct", from: "KOR1", to: "NORTH", distanceNm: 1980.2, status: "resolved" },
    { id: "alt-leg-2", sequence: 2, kind: "direct", from: "NORTH", to: "KDS1", distanceNm: 2410.6, status: "resolved" },
  ],
  geometry: { type: "LineString", coordinates: [[-73, 40], [-30, 52], [-118, 33]] }, distanceNm: 4390.8,
  provenance: "CAAS normalized live generation", gaps: [],
};

const toCoordinate = (point: number[]) => ({ lat: point[1]!, lon: point[0]! });
// Union bounded by the fit on selection: source geometry, alternate
// geometry, and both endpoint pins (which sit on the geometry endpoints).
const FIT_COORDINATES = [
  ...route.geometry.coordinates.map(toCoordinate),
  ...alternateRoute.geometry.coordinates.map(toCoordinate),
  { lat: 40, lon: -73 },
  { lat: 33, lon: -118 },
];

async function installMapFixture(page: Page) {
  await page.route("**/api/**", async (routeRequest) => {
    const request = routeRequest.request();
    const url = new URL(request.url());
    const respond = (payload: unknown) => routeRequest.fulfill({ contentType: "application/json", body: JSON.stringify(payload) });
    if (url.pathname === "/api/v1/readiness") return respond({ status: "ready", generation });
    if (url.pathname === "/api/v1/routes/overview" && request.method() === "POST") return respond({ data: [route, alternateRoute], generation, loaded: 2, total: 2 });
    if (url.pathname === "/api/v1/callsigns/search" && request.method() === "POST") return respond({ data: [{ id: "flight-map-1", flightId: "flight-map-1", callsign: "MAPFIX1", departure: "KOR1", destination: "KDS1", routePointCount: 3 }] });
    if (url.pathname === "/api/v1/routes/options" && request.method() === "POST") return respond({ data: [route], generation });
    if (url.pathname === "/api/v1/points/lookup" && request.method() === "POST") {
      // normalizePointMatch shape: id is the location token, code the identifier.
      const body = JSON.parse(request.postData() ?? "{}") as { reference?: string };
      const isOrigin = body.reference?.includes("KOR1");
      return respond({ matches: [{ id: isOrigin ? "loc-kor1" : "loc-kds1", code: isOrigin ? "KOR1" : "KDS1", name: isOrigin ? "Kor One" : "Kee Dees One", kind: "airport", coordinate: isOrigin ? { lat: 40, lon: -73 } : { lat: 33, lon: -118 } }], truncated: false });
    }
    return routeRequest.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: { code: "NOT_FOUND", message: "Fixture route not implemented." } }) });
  });
  // Deterministic offline tiles: fulfill every OSM request with a 1x1 PNG so
  // load/error timing never depends on the network, while src attributes keep
  // the z/x/y contract under test.
  await page.route(/^https:\/\/tile\.openstreetmap\.org\//, (tileRoute) => tileRoute.fulfill({ contentType: "image/png", body: TILE_PNG }));
}

const tileImgs = (page: Page) => page.locator('img[src^="https://tile.openstreetmap.org/"]');

async function selectFixtureRoute(page: Page) {
  await page.getByRole("combobox", { name: "Flight number or code" }).fill("MAPFIX1");
  await page.keyboard.press("Enter");
  await page.getByRole("option", { name: /MAPFIX1/ }).click();
}
const zoomOf = (src: string | null | undefined) => Number(/^https:\/\/tile\.openstreetmap\.org\/(\d+)\//.exec(src ?? "")?.[1] ?? NaN);

async function firstTileZoom(page: Page): Promise<number> {
  await expect(tileImgs(page).first()).toBeVisible();
  return zoomOf(await tileImgs(page).first().getAttribute("src"));
}

/**
 * The selection fit effect can resettle the viewport shortly after load; wait
 * for the rendered tile level to hold steady before issuing gestures so CI
 * timing never races the settle.
 */
async function stableTileZoom(page: Page): Promise<number> {
  let zoom = await firstTileZoom(page);
  for (let i = 0; i < 4; i++) {
    await page.waitForTimeout(120);
    const next = zoomOf(await tileImgs(page).first().getAttribute("src"));
    if (next === zoom) return zoom;
    zoom = next;
  }
  return zoom;
}

test("map controls own their hit targets and survive real pointer clicks", async ({ page }) => {
  await installMapFixture(page);
  await page.goto("/");
  const stage = page.locator(".map-stage");
  await expect(stage).toBeVisible();

  // Hit-target integrity: every map control resolves to itself at its center,
  // so no rail/banner/overlay can swallow its clicks (regression: the rail
  // row used to cover the zoom stack at 1440x900).
  const controls = [page.getByRole("button", { name: "Zoom in" }), page.getByRole("button", { name: "Zoom out" }), page.getByRole("button", { name: "Toggle base map" })];
  for (const control of controls) {
    await expect(control).toBeVisible();
    const box = await control.boundingBox();
    if (!box) throw new Error("Control bounding box unavailable.");
    const hit = await page.evaluate(({ x, y }) => {
      const element = document.elementFromPoint(x, y);
      return element ? `${element.tagName}:${(element as HTMLElement).getAttribute("aria-label") ?? element.textContent?.trim().slice(0, 20)}` : "none";
    }, { x: box.x + box.width / 2, y: box.y + box.height / 2 });
    expect(hit).toContain("BUTTON");
  }

  // Real mouse zoom in/out steps exactly one tile level per click.
  const z0 = await stableTileZoom(page);
  await page.getByRole("button", { name: "Zoom in" }).click();
  await expect.poll(async () => zoomOf(await tileImgs(page).first().getAttribute("src"))).toBe(z0 + 1);
  await page.getByRole("button", { name: "Zoom out" }).click();
  await expect.poll(async () => zoomOf(await tileImgs(page).first().getAttribute("src"))).toBe(z0);

  // Zoom-out disables at MIN_ZOOM and never requests z below it.
  const zoomOut = page.getByRole("button", { name: "Zoom out" });
  for (let i = 0; i < 3 && !(await zoomOut.isDisabled()); i++) await zoomOut.click();
  await expect(zoomOut).toBeDisabled();
  const levels = await tileImgs(page).evaluateAll((imgs) => [...new Set(imgs.map((img) => Number(/^https:\/\/tile\.openstreetmap\.org\/(\d+)\//.exec(img.getAttribute("src") ?? "")?.[1])))]);
  expect(levels.every((level) => level >= 1)).toBe(true);
});

test("wheel bursts zoom one level each with no passive-listener console errors", async ({ page }) => {
  const passiveErrors: string[] = [];
  page.on("console", (message) => { if (message.type() === "error" && message.text().includes("preventDefault")) passiveErrors.push(message.text()); });
  page.on("pageerror", (error) => passiveErrors.push(String(error)));
  await installMapFixture(page);
  await page.goto("/");
  const stage = page.locator(".map-stage");
  await expect(stage).toBeVisible();
  const box = await stage.boundingBox();
  if (!box) throw new Error("Stage bounding box unavailable.");
  const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };

  const z0 = await stableTileZoom(page);
  await page.mouse.move(center.x, center.y);
  // Fire the burst back-to-back: awaited wheel dispatch can exceed the 350 ms
  // debounce window between events on slow CI hosts even though a real gesture
  // arrives as one burst.
  const burst = () => Promise.all([0, 1, 2, 3, 4, 5].map(() => page.mouse.wheel(0, -100)));
  await burst(); // one gesture, many ticks
  await expect.poll(async () => zoomOf(await tileImgs(page).first().getAttribute("src"))).toBe(z0 + 1);

  await page.waitForTimeout(450); // debounce window elapsed: next burst accepted
  await burst();
  await expect.poll(async () => zoomOf(await tileImgs(page).first().getAttribute("src"))).toBe(z0 + 2);

  expect(passiveErrors).toEqual([]);
});

test("drag pans the viewport and the base-map toggle round-trips under real clicks", async ({ page }) => {
  await installMapFixture(page);
  await page.goto("/");
  const stage = page.locator(".map-stage");
  await expect(stage).toBeVisible();
  const box = await stage.boundingBox();
  if (!box) throw new Error("Stage bounding box unavailable.");

  // Drag: tile indices must change with the pan and respond to a return drag.
  await stableTileZoom(page);
  const srcBefore = await tileImgs(page).first().getAttribute("src");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 5; i++) await page.mouse.move(box.x + box.width / 2 + i * 40, box.y + box.height / 2 + i * 20);
  await page.mouse.up();
  await expect.poll(async () => await tileImgs(page).first().getAttribute("src")).not.toBe(srcBefore);

  // Toggle off: schematic base map, inert zoom, attribution swap.
  const toggle = page.getByRole("button", { name: "Toggle base map" });
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expect(tileImgs(page)).toHaveCount(0);
  await expect(page.locator(".world-ocean")).toBeVisible();
  await expect(page.locator(".map-attribution")).toHaveText("Schematic base map only");
  await expect(page.getByRole("button", { name: "Zoom in" })).toBeDisabled();

  // Toggle on: tiles return and zoom re-enables.
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect(tileImgs(page).first()).toBeVisible();
  await expect(page.locator(".map-attribution")).toContainText("OpenStreetMap");
  await expect(page.getByRole("button", { name: "Zoom in" })).toBeEnabled();
});

test("selecting a route renders both endpoint markers and the endpoint panel", async ({ page }) => {
  await installMapFixture(page);
  await page.goto("/");
  await selectFixtureRoute(page);

  await expect(page.locator("g.map-marker.marker-origin")).toHaveCount(1);
  await expect(page.locator("g.map-marker.marker-destination")).toHaveCount(1);
  await expect(page.locator("path.route-path")).toHaveCount(1);
  const endpoints = page.locator("section[aria-label='Route endpoint locations']");
  await expect(endpoints).toContainText("Departure");
  await expect(endpoints).toContainText("Arrival");
  await expect(page.locator(".map-canvas")).toHaveAttribute("aria-label", /departure and .* arrival/);
});

test("selecting a route fits its full geometry, alternates included, without clipping", async ({ page }) => {
  await installMapFixture(page);
  await page.goto("/");
  // Select from the unfiltered source-record list (not the search combobox,
  // which narrows the overview to the searched callsign) so the dimmed
  // alternate stays drawn and must fit alongside the selection.
  await page.locator(".overview-flight-buttons button", { hasText: "MAPFIX1" }).click();
  await expect(page.locator("path.route-path-alternate").first()).toBeVisible();

  const stage = page.locator(".map-stage");
  const stageBox = await stage.boundingBox();
  if (!stageBox) throw new Error("Stage bounding box unavailable.");

  // The fitted zoom matches fitViewToCoordinates over the union of the
  // selected route, its dimmed alternates, and the endpoint pins.
  const expected = fitViewToCoordinates(FIT_COORDINATES, { width: stageBox.width, height: stageBox.height });
  if (!expected) throw new Error("Fixture coordinates did not produce a fit.");
  await expect.poll(async () => zoomOf(await tileImgs(page).first().getAttribute("src"))).toBe(expected.zoom);

  // Nothing drawn for the selection is clipped by the stage (small tolerance
  // for stroke/pin overhang).
  const withinStage = (box: { x: number; y: number; width: number; height: number }) =>
    box.x >= stageBox.x - 2 && box.y >= stageBox.y - 2 &&
    box.x + box.width <= stageBox.x + stageBox.width + 2 &&
    box.y + box.height <= stageBox.y + stageBox.height + 2;
  for (const selector of ["g.map-marker.marker-origin", "g.map-marker.marker-destination", "path.route-path-alternate"]) {
    await expect(page.locator(selector).first()).toBeVisible();
    const box = await page.locator(selector).first().boundingBox();
    if (!box) throw new Error(`Missing geometry for ${selector}.`);
    expect(withinStage(box), `${selector} clipped by the stage`).toBe(true);
  }

  // Base-map toggle round-trip preserves the fitted view: no refit, no reset.
  const toggle = page.getByRole("button", { name: "Toggle base map" });
  await toggle.click();
  await expect(tileImgs(page)).toHaveCount(0);
  await toggle.click();
  await expect(tileImgs(page).first()).toBeVisible();
  expect(zoomOf(await tileImgs(page).first().getAttribute("src"))).toBe(expected.zoom);
});

