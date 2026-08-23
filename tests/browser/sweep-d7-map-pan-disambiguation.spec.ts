// Owner: D7 — map & spatial UX (adversarial sweep 2026-08-23).
// Pan confusion hardening: click-vs-drag ambiguity (sub-threshold jitter must
// never pan), drags that start on a stacked control must not pan the map,
// drags leaving the stage edge must keep panning via pointer capture and
// release cleanly (no stuck drag), and the grab/grabbing cursor affordance
// must be honest about which base map accepts drags. map-controls.spec.ts
// only pins that a full drag changes tiles.
import { expect, test, type Page } from "@playwright/test";

const TILE_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

const generation = {
  id: "sweep-d7-pan-generation",
  retrievedAt: "2026-08-16T00:00:00.000Z",
  live: { state: "fresh", retrievedAt: "2026-08-16T00:00:00.000Z", freshUntil: "2026-08-16T01:00:00.000Z", staleUntil: "2026-08-16T02:00:00.000Z" },
  reference: { state: "fresh", retrievedAt: "2026-08-16T00:00:00.000Z", freshUntil: "2026-08-17T00:00:00.000Z", staleUntil: "2026-08-18T00:00:00.000Z" },
  overall: "fresh",
};

const route = {
  id: "route-d7-pan", flightId: "flight-d7-pan", callsign: "D7PAN1", status: "complete", complete: true,
  label: "D7 pan disambiguation route", origin: "KOR1", destination: "KDS1", pointCount: 3,
  legs: [{ id: "leg-1", sequence: 1, kind: "direct", from: "KOR1", to: "KDS1", distanceNm: 512.4, status: "resolved" }],
  geometry: { type: "LineString", coordinates: [[-73, 40], [-90, 35], [-118, 33]] }, distanceNm: 512.4,
  provenance: "CAAS normalized live generation", gaps: [],
};

async function installFixture(page: Page) {
  await page.route("**/api/**", async (routeRequest) => {
    const request = routeRequest.request();
    const url = new URL(request.url());
    const respond = (payload: unknown) => routeRequest.fulfill({ contentType: "application/json", body: JSON.stringify(payload) });
    if (url.pathname === "/api/v1/readiness") return respond({ status: "ready", generation });
    if (url.pathname === "/api/v1/routes/overview" && request.method() === "POST") return respond({ data: [route], generation, loaded: 1, total: 1 });
    if (url.pathname === "/api/v1/points/lookup" && request.method() === "POST") return respond({ matches: [], truncated: false });
    return routeRequest.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: { code: "NOT_FOUND", message: "Fixture route not implemented." } }) });
  });
  await page.route(/^https:\/\/tile\.openstreetmap\.org\//, (tileRoute) => tileRoute.fulfill({ contentType: "image/png", body: TILE_PNG }));
}

const tileImgs = (page: Page) => page.locator('img[src^="https://tile.openstreetmap.org/"]');
const zoomOf = (src: string | null | undefined) => Number(/^https:\/\/tile\.openstreetmap\.org\/(\d+)\//.exec(src ?? "")?.[1] ?? NaN);
const firstTileSrc = (page: Page) => tileImgs(page).first().getAttribute("src");

/** Src + inline placement of the first tile. Pans near a tile-row boundary
 *  can keep the first tile's z/x/y identical while its offset shifts, so the
 *  src alone is not a trustworthy viewport fingerprint there. */
async function tileFingerprint(page: Page): Promise<string> {
  return (await tileImgs(page).first().evaluate((img: HTMLImageElement) => `${img.getAttribute("src") ?? ""}|${img.style.left}|${img.style.top}`)) ?? "";
}

async function stableTileZoom(page: Page): Promise<number> {
  await expect(tileImgs(page).first()).toBeVisible();
  let zoom = zoomOf(await firstTileSrc(page));
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await page.waitForTimeout(120);
    const next = zoomOf(await firstTileSrc(page));
    if (next === zoom) return zoom;
    zoom = next;
  }
  return zoom;
}

test("plain clicks and sub-threshold jitter never pan the map", async ({ page }) => {
  await installFixture(page);
  await page.goto("/");
  const stage = page.locator(".map-stage");
  await expect(stage).toBeVisible();
  await stableTileZoom(page);
  const box = await stage.boundingBox();
  if (!box) throw new Error("Stage bounding box unavailable.");
  const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };

  // A confused user clicks the map to "select" it: nothing may move.
  const beforeClick = await firstTileSrc(page);
  await page.mouse.click(center.x, center.y);
  await page.waitForTimeout(200);
  expect(await firstTileSrc(page)).toBe(beforeClick);

  // A press with 2px of nervous jitter stays under the drag threshold.
  const beforeJitter = await firstTileSrc(page);
  await page.mouse.move(center.x, center.y);
  await page.mouse.down();
  await page.mouse.move(center.x + 2, center.y + 1);
  await page.mouse.up();
  await page.waitForTimeout(200);
  expect(await firstTileSrc(page)).toBe(beforeJitter);
});

test("a drag that starts on a map control never pans the map", async ({ page }) => {
  await installFixture(page);
  await page.goto("/");
  const stage = page.locator(".map-stage");
  await expect(stage).toBeVisible();
  await stableTileZoom(page);
  const before = await firstTileSrc(page);

  // Pressing on the zoom button and sweeping across the stage must be treated
  // as control interaction, not as a pan (no pointer capture on controls).
  const zoomIn = page.getByRole("button", { name: "Zoom in" });
  const buttonBox = await zoomIn.boundingBox();
  const stageBox = await stage.boundingBox();
  if (!buttonBox || !stageBox) throw new Error("Bounding box unavailable.");
  await page.mouse.move(buttonBox.x + buttonBox.width / 2, buttonBox.y + buttonBox.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 5; i += 1) await page.mouse.move(buttonBox.x + buttonBox.width / 2 + i * 40, buttonBox.y + buttonBox.height / 2);
  await page.mouse.up();
  await page.waitForTimeout(200);
  expect(await firstTileSrc(page)).toBe(before);
});

test("drags past the stage edge keep panning via pointer capture and release cleanly", async ({ page }) => {
  await installFixture(page);
  await page.goto("/");
  const stage = page.locator(".map-stage");
  await expect(stage).toBeVisible();
  await stableTileZoom(page);
  const box = await stage.boundingBox();
  if (!box) throw new Error("Stage bounding box unavailable.");

  // Drag well past the right edge: capture keeps the pan alive outside.
  const before = await tileFingerprint(page);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 8; i += 1) await page.mouse.move(box.x + box.width / 2 + i * 60, box.y + box.height / 2);
  await page.mouse.up();
  await expect.poll(async () => await tileFingerprint(page)).not.toBe(before);

  // Release outside: no stuck drag. Bare movement must not move the map…
  const settled = await tileFingerprint(page);
  await page.mouse.move(box.x + box.width / 3, box.y + box.height / 3, { steps: 6 });
  await page.waitForTimeout(200);
  expect(await tileFingerprint(page)).toBe(settled);

  // …and a fresh drag still pans (the capture slot was released).
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 4; i += 1) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + i * 30);
  await page.mouse.up();
  await expect.poll(async () => await tileFingerprint(page)).not.toBe(settled);
});

test("the cursor affordance is honest: grab only while tiles accept drags", async ({ page }) => {
  await installFixture(page);
  await page.goto("/");
  const stage = page.locator(".map-stage");
  await expect(stage).toBeVisible();
  await stableTileZoom(page);
  const cursorOf = () => stage.evaluate((element) => getComputedStyle(element).cursor);
  const box = await stage.boundingBox();
  if (!box) throw new Error("Stage bounding box unavailable.");

  // Tiles on: the stage advertises itself as draggable…
  expect(await cursorOf()).toBe("grab");
  // …and shows the grabbing state while the surface is actually pressed.
  // Press at a spot guaranteed to resolve to a tile (away from the fixture
  // route line and every chrome overlay), so the press lands on the map.
  const press = { x: box.x + box.width * 0.7, y: box.y + box.height * 0.5 };
  const pressedTag = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.tagName ?? "none", press);
  // The point must sit on the map surface (tile or graticule), never on a
  // stacked control — controls carry their own cursor and never pan.
  expect(pressedTag, "press point must sit on the map surface").not.toBe("BUTTON");
  expect(pressedTag, "press point must sit on the map surface").not.toBe("A");
  await page.mouse.move(press.x, press.y);
  await page.mouse.down();
  expect(await cursorOf()).toBe("grabbing");
  await page.mouse.up();
  expect(await cursorOf()).toBe("grab");

  // Schematic mode rejects drags, so the affordance must disappear with the
  // tiles instead of promising a pan that will not happen.
  await page.getByRole("button", { name: "Toggle base map" }).click();
  await expect(tileImgs(page)).toHaveCount(0);
  expect(await cursorOf()).not.toBe("grab");
});
