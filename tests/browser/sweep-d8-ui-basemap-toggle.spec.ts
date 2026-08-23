// Owner: D8 — briefing copy & flows (adversarial sweep 2026-08-23).
// Basemap toggle state honesty after a tile failure: the pressed state must
// track the user's basemap preference (tilesEnabled), not the derived
// tiles-on state, so the first click after a tile failure visibly changes
// the control instead of silently flipping hidden internal state.
import { expect, test, type Page } from "@playwright/test";

const TILE_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

const generation = {
  id: "d8-basemap-generation",
  retrievedAt: "2026-08-16T00:00:00.000Z",
  live: { state: "fresh", retrievedAt: "2026-08-16T00:00:00.000Z", freshUntil: "2026-08-16T01:00:00.000Z", staleUntil: "2026-08-16T02:00:00.000Z" },
  reference: { state: "fresh", retrievedAt: "2026-08-16T00:00:00.000Z", freshUntil: "2026-08-17T00:00:00.000Z", staleUntil: "2026-08-18T00:00:00.000Z" },
  overall: "fresh",
};

const route = {
  id: "route-base-1", flightId: "flight-base-1", callsign: "BASEFL1", status: "complete", complete: true,
  label: "Recorded basemap fixture route", origin: "KOR1", destination: "KDS1", pointCount: 3,
  legs: [{ id: "leg-1", sequence: 1, kind: "direct", from: "KOR1", to: "KDS1", distanceNm: 512.4, status: "resolved" }],
  geometry: { type: "LineString", coordinates: [[-73, 40], [-118, 33]] }, distanceNm: 512.4,
  provenance: "CAAS normalized live generation", gaps: [],
};

const tileImgs = (page: Page) => page.locator('img[src^="https://tile.openstreetmap.org/"]');

test("after a tile failure the toggle stays honest and one click per state change is visible", async ({ page }) => {
  await page.route("**/api/**", async (routeRequest) => {
    const request = routeRequest.request();
    const url = new URL(request.url());
    const respond = (payload: unknown) => routeRequest.fulfill({ contentType: "application/json", body: JSON.stringify(payload) });
    if (url.pathname === "/api/v1/readiness") return respond({ status: "ready", generation });
    if (url.pathname === "/api/v1/routes/overview" && request.method() === "POST") return respond({ data: [route], generation, loaded: 1, total: 1 });
    if (url.pathname === "/api/v1/points/lookup" && request.method() === "POST") return respond({ matches: [] });
    return routeRequest.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: { code: "NOT_FOUND", message: "Fixture route not implemented." } }) });
  });

  // Tiles load cleanly at first, then fail once the fixture flips.
  let tilesFailing = false;
  await page.route(/^https:\/\/tile\.openstreetmap\.org\//, (tileRoute) => {
    if (tilesFailing) return tileRoute.fulfill({ status: 500, contentType: "text/plain", body: "tile outage" });
    return tileRoute.fulfill({ contentType: "image/png", body: TILE_PNG });
  });
  await page.goto("/");

  const toggle = page.getByRole("button", { name: "Toggle base map" });
  await expect(tileImgs(page).first()).toBeVisible();

  // Zooming forces fresh tile requests; they fail, and the map drops into
  // the schematic fallback.
  tilesFailing = true;
  await page.getByRole("button", { name: "Zoom in" }).click();
  await expect(page.locator(".map-attribution")).toContainText("Schematic base map only", { timeout: 5000 });
  await expect(tileImgs(page)).toHaveCount(0);

  // …but the user never turned the basemap off: the pressed state still
  // reflects their preference, so the FIRST click visibly changes it.
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expect(tileImgs(page)).toHaveCount(0);

  // Clicking again re-enables tiles (clearing the failure latch) and, with
  // the tile feed recovered, the base map returns.
  tilesFailing = false;
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect(tileImgs(page).first()).toBeVisible({ timeout: 5000 });
});
