// Owner: D7 — map & spatial UX (adversarial sweep 2026-08-23).
// Zoom disorientation hardening: bounds clamping at MAX_ZOOM (the MIN side is
// pinned by map-controls.spec.ts), rapid double-clicks advancing exactly two
// levels, keyboard activation of the zoom buttons, and wheel events at a zoom
// bound never consuming the burst-debounce lock (legitimate follow-up input
// must still land). All tiles are intercepted offline.
import { expect, test, type Page } from "@playwright/test";

const TILE_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

const generation = {
  id: "sweep-d7-zoom-generation",
  retrievedAt: "2026-08-16T00:00:00.000Z",
  live: { state: "fresh", retrievedAt: "2026-08-16T00:00:00.000Z", freshUntil: "2026-08-16T01:00:00.000Z", staleUntil: "2026-08-16T02:00:00.000Z" },
  reference: { state: "fresh", retrievedAt: "2026-08-16T00:00:00.000Z", freshUntil: "2026-08-17T00:00:00.000Z", staleUntil: "2026-08-18T00:00:00.000Z" },
  overall: "fresh",
};

const route = {
  id: "route-d7-zoom", flightId: "flight-d7-zoom", callsign: "D7ZOOM1", status: "complete", complete: true,
  label: "D7 zoom bounds route", origin: "KOR1", destination: "KDS1", pointCount: 3,
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

async function stableTileZoom(page: Page): Promise<number> {
  await expect(tileImgs(page).first()).toBeVisible();
  let zoom = zoomOf(await tileImgs(page).first().getAttribute("src"));
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await page.waitForTimeout(120);
    const next = zoomOf(await tileImgs(page).first().getAttribute("src"));
    if (next === zoom) return zoom;
    zoom = next;
  }
  return zoom;
}

test("rapid double-click advances exactly two levels, keyboard activates both buttons", async ({ page }) => {
  await installFixture(page);
  await page.goto("/");
  await expect(page.locator(".map-stage")).toBeVisible();
  const zoomIn = page.getByRole("button", { name: "Zoom in" });
  const zoomOut = page.getByRole("button", { name: "Zoom out" });
  const z0 = await stableTileZoom(page);

  // Two clicks in quick succession are two deliberate gestures, not one:
  // both levels must land.
  await zoomIn.click({ delay: 0 });
  await zoomIn.click({ delay: 0 });
  await expect.poll(async () => zoomOf(await tileImgs(page).first().getAttribute("src"))).toBe(z0 + 2);

  // Keyboard users get the same one-level steps via Enter on the focused
  // button (native button activation through real key events).
  await zoomIn.focus();
  await page.keyboard.press("Enter");
  await expect.poll(async () => zoomOf(await tileImgs(page).first().getAttribute("src"))).toBe(z0 + 3);
  await zoomOut.focus();
  await page.keyboard.press("Enter");
  await expect.poll(async () => zoomOf(await tileImgs(page).first().getAttribute("src"))).toBe(z0 + 2);
});

test("zoom clamps at MAX_ZOOM: button disables and no deeper tile is ever requested", async ({ page }) => {
  await installFixture(page);
  await page.goto("/");
  await expect(page.locator(".map-stage")).toBeVisible();
  const zoomIn = page.getByRole("button", { name: "Zoom in" });
  const zoomOut = page.getByRole("button", { name: "Zoom out" });
  await stableTileZoom(page);

  // Drive the control to the ceiling like an impatient user mashing "+".
  for (let press = 0; press < 20 && !(await zoomIn.isDisabled()); press += 1) {
    await zoomIn.click();
    await page.waitForTimeout(30);
  }
  await expect(zoomIn).toBeDisabled();
  await expect(zoomOut).toBeEnabled();

  // The rendered level sits exactly on the ceiling…
  await expect.poll(async () => zoomOf(await tileImgs(page).first().getAttribute("src"))).toBe(19);
  // …and no tile request anywhere in the DOM ever exceeded it.
  const levels = await tileImgs(page).evaluateAll((imgs) => imgs.map((img) => Number(/^https:\/\/tile\.openstreetmap\.org\/(\d+)\//.exec(img.getAttribute("src") ?? "")?.[1] ?? NaN)));
  expect(levels.every((level) => level >= 1 && level <= 19)).toBe(true);

  // Clicking the disabled ceiling button is a true no-op.
  await zoomIn.click({ force: true });
  await page.waitForTimeout(150);
  expect(zoomOf(await tileImgs(page).first().getAttribute("src"))).toBe(19);
});

test("wheel events at a zoom bound do not consume the burst-debounce lock", async ({ page }) => {
  const passiveErrors: string[] = [];
  page.on("console", (message) => { if (message.type() === "error" && message.text().includes("preventDefault")) passiveErrors.push(message.text()); });
  await installFixture(page);
  await page.goto("/");
  const stage = page.locator(".map-stage");
  await expect(stage).toBeVisible();
  const zoomOut = page.getByRole("button", { name: "Zoom out" });

  // Drive to MIN_ZOOM via the button so the wheel lock is untouched.
  await stableTileZoom(page);
  while (!(await zoomOut.isDisabled())) {
    await zoomOut.click();
    await page.waitForTimeout(30);
  }
  await expect.poll(async () => zoomOf(await tileImgs(page).first().getAttribute("src"))).toBe(1);

  const box = await stage.boundingBox();
  if (!box) throw new Error("Stage bounding box unavailable.");
  const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.move(center.x, center.y);

  // Out-of-bounds burst: zoom must hold at the floor…
  await Promise.all([0, 1, 2].map(() => page.mouse.wheel(0, 100)));
  await page.waitForTimeout(120);
  expect(zoomOf(await tileImgs(page).first().getAttribute("src"))).toBe(1);

  // …and the immediately following legitimate in-bounds burst must still
  // land without waiting out the debounce window — bounded gestures never
  // touch the lock.
  await Promise.all([0, 1, 2].map(() => page.mouse.wheel(0, -100)));
  await expect.poll(async () => zoomOf(await tileImgs(page).first().getAttribute("src"))).toBe(2);
  expect(passiveErrors).toEqual([]);
});
