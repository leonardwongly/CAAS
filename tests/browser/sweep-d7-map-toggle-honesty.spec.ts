// Owner: D7 — map & spatial UX (adversarial sweep 2026-08-23).
// Base-map toggle state honesty: aria-pressed must always agree with the
// layer actually rendered (tiles vs schematic) and with the attribution copy,
// and that agreement must survive the re-renders caused by zooming, panning,
// and rapid double-toggling. Distinct from map-controls.spec.ts, which only
// checks the attribute immediately after a single toggle click.
import { expect, test, type Page } from "@playwright/test";

const TILE_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

const generation = {
  id: "sweep-d7-toggle-generation",
  retrievedAt: "2026-08-16T00:00:00.000Z",
  live: { state: "fresh", retrievedAt: "2026-08-16T00:00:00.000Z", freshUntil: "2026-08-16T01:00:00.000Z", staleUntil: "2026-08-16T02:00:00.000Z" },
  reference: { state: "fresh", retrievedAt: "2026-08-16T00:00:00.000Z", freshUntil: "2026-08-17T00:00:00.000Z", staleUntil: "2026-08-18T00:00:00.000Z" },
  overall: "fresh",
};

const route = {
  id: "route-d7-toggle", flightId: "flight-d7-toggle", callsign: "D7TOG1", status: "complete", complete: true,
  label: "D7 toggle honesty route", origin: "KOR1", destination: "KDS1", pointCount: 3,
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
  // Deterministic offline tiles: never hit the real tile server.
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

/** Every observable signal of the active base layer must agree. */
async function expectLayerState(page: Page, tilesOn: boolean) {
  const toggle = page.getByRole("button", { name: "Toggle base map" });
  await expect(toggle).toHaveAttribute("aria-pressed", String(tilesOn));
  if (tilesOn) {
    await expect(tileImgs(page).first()).toBeVisible();
    await expect(page.locator(".map-attribution")).toContainText("OpenStreetMap");
    await expect(page.locator(".world-ocean")).toHaveCount(0);
  } else {
    await expect(tileImgs(page)).toHaveCount(0);
    await expect(page.locator(".map-attribution")).toHaveText("Schematic base map only");
    await expect(page.locator(".world-ocean")).toBeVisible();
  }
}

test("aria-pressed stays honest through zoom and pan re-renders", async ({ page }) => {
  await installFixture(page);
  await page.goto("/");
  await expect(page.locator(".map-stage")).toBeVisible();
  const zoomIn = page.getByRole("button", { name: "Zoom in" });
  const toggle = page.getByRole("button", { name: "Toggle base map" });

  const z0 = await stableTileZoom(page);
  await expectLayerState(page, true);

  // Zoom re-renders the control cluster: the pressed state must not flicker
  // or reset while the view changes.
  await zoomIn.click();
  await expect.poll(async () => zoomOf(await tileImgs(page).first().getAttribute("src"))).toBe(z0 + 1);
  await expectLayerState(page, true);

  // Pan re-renders every tile: honesty must survive the pan as well.
  const box = await page.locator(".map-stage").boundingBox();
  if (!box) throw new Error("Stage bounding box unavailable.");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 4; i += 1) await page.mouse.move(box.x + box.width / 2 + i * 35, box.y + box.height / 2 + i * 15);
  await page.mouse.up();
  await page.waitForTimeout(150);
  await expectLayerState(page, true);

  // Schematic mode: zoom is inert and every signal flips together.
  await toggle.click();
  await expectLayerState(page, false);
  await expect(zoomIn).toBeDisabled();
  await toggle.click();
  await expectLayerState(page, true);
  await expect(zoomIn).toBeEnabled();
  // Re-enabling tiles restores the exact view the user left — no silent reset.
  expect(zoomOf(await tileImgs(page).first().getAttribute("src"))).toBe(z0 + 1);
});

test("rapid double-toggle round-trips without stranding the layer state", async ({ page }) => {
  await installFixture(page);
  await page.goto("/");
  await expect(page.locator(".map-stage")).toBeVisible();
  await stableTileZoom(page);
  const toggle = page.getByRole("button", { name: "Toggle base map" });

  // Two activations in one gesture must land back on the original layer with
  // every signal agreeing (no half-applied state left in the DOM).
  await toggle.dblclick();
  await expectLayerState(page, true);
  await toggle.dblclick();
  await expectLayerState(page, true);

  // A single slow click still flips exactly once.
  await toggle.click();
  await expectLayerState(page, false);
});
