// Owner: D7 — map & spatial UX (adversarial sweep 2026-08-23).
// Adaptive-behavior hardening for the map chrome: with prefers-reduced-motion
// the HUD distance must render its final value without the count-up and the
// draw-on stroke animation must be skipped, while zoom stays functional; with
// forced colors the controls must stay operable and the pressed base-map
// toggle must remain distinguishable from the plain zoom buttons.
import { expect, test, type Page } from "@playwright/test";

const TILE_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

const generation = {
  id: "sweep-d7-motion-generation",
  retrievedAt: "2026-08-16T00:00:00.000Z",
  live: { state: "fresh", retrievedAt: "2026-08-16T00:00:00.000Z", freshUntil: "2026-08-16T01:00:00.000Z", staleUntil: "2026-08-16T02:00:00.000Z" },
  reference: { state: "fresh", retrievedAt: "2026-08-16T00:00:00.000Z", freshUntil: "2026-08-17T00:00:00.000Z", staleUntil: "2026-08-18T00:00:00.000Z" },
  overall: "fresh",
};

const route = {
  id: "route-d7-motion", flightId: "flight-d7-motion", callsign: "D7MOT1", status: "complete", complete: true,
  label: "D7 reduced motion route", origin: "KOR1", destination: "KDS1", pointCount: 3,
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

/** Wait for the rendered tile level to hold steady (the selection fit can
 *  resettle the viewport shortly after load). */
async function stableTileZoom(page: Page): Promise<number> {
  let zoom = zoomOf(await tileImgs(page).first().getAttribute("src"));
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await page.waitForTimeout(120);
    const next = zoomOf(await tileImgs(page).first().getAttribute("src"));
    if (next === zoom) return zoom;
    zoom = next;
  }
  return zoom;
}

test.describe("prefers-reduced-motion", () => {
  test("skips the count-up and draw-on animation but keeps zoom functional", async ({ page }) => {
    await installFixture(page);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/");
    await expect(tileImgs(page).first()).toBeVisible();

    await page.locator(".overview-flight-buttons button", { hasText: "D7MOT1" }).click();
    const path = page.locator("path.route-path").first();
    await expect(path).toBeVisible();

    // Reduced motion renders the final distance immediately — the count-up
    // (rAF over 320ms from zero) must never start, so the very first reading
    // of the HUD already carries the full figure.
    await expect(page.locator(".map-hud")).toContainText("512.4 NM");

    // The draw-on keyframes are collapsed: the steady-state dasharray holds
    // right away instead of animating for ~420ms.
    await expect.poll(() => path.evaluate((element: SVGElement) => getComputedStyle(element).strokeDasharray)).toBe("none");

    // Motion preferences must never disable map functionality. Read the
    // baseline after the selection fit settles so the step is measured from
    // the fitted view.
    const z0 = await stableTileZoom(page);
    await page.getByRole("button", { name: "Zoom in" }).click();
    await expect.poll(async () => zoomOf(await tileImgs(page).first().getAttribute("src"))).toBe(z0 + 1);
  });
});

test("forced colors keep the map chrome operable and the pressed toggle distinguishable", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "forced-colors emulation is exercised on the Chromium lane");
  await installFixture(page);
  await page.emulateMedia({ forcedColors: "active" });
  await page.goto("/");
  await expect(tileImgs(page).first()).toBeVisible();

  const toggle = page.getByRole("button", { name: "Toggle base map" });
  const zoomIn = page.getByRole("button", { name: "Zoom in" });
  await expect(toggle).toBeVisible();
  await expect(zoomIn).toBeVisible();

  // Pressed toggle vs plain zoom button: with every border collapsed to
  // ButtonBorder the pressed state needs its own system color to stay legible.
  const borders = await page.evaluate(() => {
    const pressed = document.querySelector('.map-zoom-controls button[aria-pressed="true"]');
    const plain = document.querySelector('.map-zoom-controls button[aria-label="Zoom in"]');
    return {
      pressed: pressed ? getComputedStyle(pressed).borderColor : "",
      plain: plain ? getComputedStyle(plain).borderColor : "",
    };
  });
  expect(borders.pressed).not.toBe("");
  expect(borders.plain).not.toBe("");
  expect(borders.pressed, "pressed toggle border must differ from a plain zoom button").not.toBe(borders.plain);

  // The layer round-trip still works end to end under forced colors.
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expect(tileImgs(page)).toHaveCount(0);
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect(tileImgs(page).first()).toBeVisible();

  // Route geometry must remain drawn (its stroke is forced, never hidden).
  await page.locator(".overview-flight-buttons button", { hasText: "D7MOT1" }).click();
  const path = page.locator("path.route-path").first();
  await expect(path).toBeVisible();
  const stroke = await path.evaluate((element: SVGElement) => getComputedStyle(element).stroke);
  expect(stroke).not.toBe("none");
  expect(stroke).not.toBe("transparent");
});
