// Owner: R2-D8 — viewport / keyboard / copy-confusion (round-2 adversarial sweep 2026-08-23).
// Confused-user regressions for the browser surface: honest empty-map copy when
// the backend is down (#2), viewport-honest "map or list" copy (#3), legend not
// occluding the base-map toggle with the drawer open (#4), an active indicator
// on the Map-only/API-data view toggle (#6), an explanation when the schematic
// basemap disables zoom (#7), and no favicon 404 (#9). Also documents two
// justified keeps: the native
// refresh confirm (pinned by round-1 e2e) with in-app feedback (#1) and the
// separation of the brand accent from the error palette on pressed states (#5).
import { expect, test, type Page } from "@playwright/test";

const TILE_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

const generation = {
  id: "r2-d8-vkc-generation",
  retrievedAt: "2026-08-16T00:00:00.000Z",
  live: { state: "fresh", retrievedAt: "2026-08-16T00:00:00.000Z", freshUntil: "2026-08-16T01:00:00.000Z", staleUntil: "2026-08-16T02:00:00.000Z" },
  reference: { state: "fresh", retrievedAt: "2026-08-16T00:00:00.000Z", freshUntil: "2026-08-17T00:00:00.000Z", staleUntil: "2026-08-18T00:00:00.000Z" },
  overall: "fresh",
};

const route = {
  id: "route-vkc-1", flightId: "flight-vkc-1", callsign: "VKC1", status: "complete", complete: true,
  label: "Recorded viewport fixture route", origin: "KOR1", destination: "KDS1", pointCount: 3,
  legs: [{ id: "leg-1", sequence: 1, kind: "direct", from: "KOR1", to: "KDS1", distanceNm: 512.4, status: "resolved" }],
  geometry: { type: "LineString", coordinates: [[-73, 40], [-118, 33]] }, distanceNm: 512.4,
  provenance: "CAAS normalized live generation", gaps: [],
};

const notFoundBody = JSON.stringify({ error: { code: "NOT_FOUND", message: "Fixture route not implemented." } });

function installApi(page: Page, opts: { overviewFail?: boolean } = {}) {
  return page.route("**/api/**", async (routeRequest) => {
    const request = routeRequest.request();
    const url = new URL(request.url());
    const respond = (payload: unknown) => routeRequest.fulfill({ contentType: "application/json", body: JSON.stringify(payload) });
    if (url.pathname === "/api/v1/readiness") return respond({ status: "ready", generation });
    if (url.pathname === "/api/v1/routes/overview" && request.method() === "POST") {
      if (opts.overviewFail) return routeRequest.fulfill({ status: 502, contentType: "application/json", body: JSON.stringify({ error: { code: "UPSTREAM_UNAVAILABLE", message: "Upstream is down." } }) });
      return respond({ data: [route], generation, loaded: 1, total: 1 });
    }
    if (url.pathname === "/api/v1/refresh" && request.method() === "POST") return respond({ status: "refreshed", generation });
    if (url.pathname === "/api/v1/points/lookup" && request.method() === "POST") return respond({ matches: [] });
    if (url.pathname === "/api/v1/callsigns/search" && request.method() === "POST") return respond({ matches: [] });
    return routeRequest.fulfill({ status: 404, contentType: "application/json", body: notFoundBody });
  });
}

async function installTiles(page: Page) {
  await page.route(/^https:\/\/tile\.openstreetmap\.org\//, (tileRoute) => tileRoute.fulfill({ contentType: "image/png", body: TILE_PNG }));
}

const intersects = (a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

test("#2 backend failure never blames a nonexistent callsign filter on the empty map", async ({ page }) => {
  await installApi(page, { overviewFail: true });
  await installTiles(page);
  await page.goto("/");

  const empty = page.locator(".map-empty");
  await expect(empty).toBeVisible({ timeout: 8000 });
  // The overview failed: the copy must point at the recovery path, not at a
  // callsign filter the user never applied.
  await expect(empty).toContainText("The all-flight overview could not be loaded.");
  await expect(empty).not.toContainText("callsign filter");
});

test("#2 a genuine zero-result filter still offers the callsign-filter hint", async ({ page }) => {
  await installApi(page);
  await installTiles(page);
  await page.goto("/");
  await expect(page.getByRole("button", { name: /VKC1/ })).toBeVisible({ timeout: 5000 });

  // A search that matches nothing filters the overview to zero with NO error:
  // here the callsign-filter hint is the truthful guidance.
  const input = page.getByRole("combobox", { name: "Flight number or code" });
  await input.click();
  await input.type("ZZZ999");
  await page.keyboard.press("Enter");

  const empty = page.locator(".map-empty");
  await expect(empty).toBeVisible({ timeout: 5000 });
  await expect(empty).toContainText("Clear the callsign filter or retry the all-flight overview.");
});

test("#3 narrow viewport hides the list and the copy stops promising one", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await installApi(page);
  await installTiles(page);
  await page.goto("/");

  // The manifest (flight list) is display:none below 1280px…
  await expect(page.getByRole("region", { name: "Full flight list" })).toBeHidden();
  // …so the visible map HUD copy must not claim a list exists.
  const hud = page.locator(".map-hud");
  await expect(hud).toContainText("Select a route from the map.", { timeout: 5000 });
  await expect(hud).not.toContainText("or list");
});

test("#3 wide viewport keeps the manifest and the 'map or list' copy", async ({ page }) => {
  await installApi(page);
  await installTiles(page);
  await page.goto("/");
  await expect(page.getByRole("region", { name: "Full flight list" })).toBeVisible();
  await expect(page.locator(".toolbar-flight")).toContainText("Select a route from the map or list.", { timeout: 5000 });
});

test("#4 the legend never occludes the base-map toggle with the drawer open", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await installApi(page);
  await installTiles(page);
  await page.goto("/");

  // Open the workbench drawer so the map narrows (the occlusion condition).
  await page.locator(".overview-flight-buttons button").first().click();
  await page.getByRole("button", { name: "Routes", exact: true }).click();
  await expect(page.getByRole("region", { name: "Route chooser" })).toBeVisible();

  const legendBox = await page.locator(".map-legend").boundingBox();
  const toggleBox = await page.getByRole("button", { name: "Toggle base map" }).boundingBox();
  expect(legendBox).toBeTruthy();
  expect(toggleBox).toBeTruthy();
  if (legendBox && toggleBox) expect(intersects(legendBox, toggleBox), "legend must not cover the base-map toggle").toBe(false);
});

test("#6 the view toggle exposes an active indicator for the current page", async ({ page }) => {
  await installApi(page);
  await installTiles(page);
  await page.goto("/");

  const apiButton = page.getByRole("button", { name: "API data" });
  const mapOnlyButton = page.getByRole("button", { name: "Map only" });
  await expect(apiButton).toHaveAttribute("aria-pressed", "false");
  await expect(mapOnlyButton).toHaveAttribute("aria-pressed", "false");

  await apiButton.click();
  await expect(apiButton).toHaveAttribute("aria-pressed", "true");

  // Returning to the map flips the indicator back off.
  await page.getByRole("button", { name: /Back to map/ }).click();
  await expect(apiButton).toHaveAttribute("aria-pressed", "false");
});

test("#7 the schematic basemap explains why zoom is disabled", async ({ page }) => {
  await installApi(page);
  await installTiles(page);
  await page.goto("/");
  await expect(page.locator(".map-stage")).toBeVisible();

  const note = page.locator(".zoom-schematic-note");
  await expect(note).toHaveCount(0); // tiles on: no note needed

  await page.getByRole("button", { name: "Toggle base map" }).click();
  await expect(page.getByRole("button", { name: "Zoom in" })).toBeDisabled();
  await expect(note).toBeVisible();
  await expect(note).toContainText("tiled base map");

  await page.getByRole("button", { name: "Toggle base map" }).click();
  await expect(note).toHaveCount(0);
});

test("#9 the document ships an inline icon so no favicon 404 is requested", async ({ page }) => {
  const favicon404: string[] = [];
  page.on("response", (response) => { if (/\/favicon\.ico$/.test(new URL(response.url()).pathname) && response.status() === 404) favicon404.push(response.url()); });
  await installApi(page);
  await installTiles(page);
  await page.goto("/");

  const icon = page.locator('link[rel="icon"]');
  await expect(icon).toHaveCount(1);
  const href = await icon.getAttribute("href");
  expect(href ?? "").toMatch(/^data:/);
  expect(favicon404).toEqual([]);
});

test("#1 (documented) refresh confirms via the pinned native dialog and then gives in-app feedback", async ({ page }) => {
  let dialogMessage = "";
  page.on("dialog", (dialog) => { dialogMessage = dialog.message(); void dialog.accept(); });
  await installApi(page);
  await installTiles(page);
  await page.goto("/");

  await page.getByRole("button", { name: "Refresh data" }).click();
  // The native confirm is the round-1-pinned destructive guard; its message
  // explains exactly what will happen so the user knows what they confirm.
  expect(dialogMessage).toContain("Refresh the dataset?");
  expect(dialogMessage).toContain("current flight selection will be cleared");
  // After accepting, the app surfaces the outcome in-app (status region).
  await expect(page.locator(".sr-status")).toContainText("Data refreshed at", { timeout: 8000 });
});

test("#5 (documented) pressed controls use the brand accent, not the error palette", async ({ page }) => {
  await installApi(page);
  await installTiles(page);
  await page.goto("/");

  // Open a surface so a spine button is pressed, then compare its colour to
  // the error palette: an active state must never read as an error.
  await page.locator(".overview-flight-buttons button").first().click();
  await page.getByRole("button", { name: "Routes", exact: true }).click();
  const colors = await page.evaluate(() => {
    const pressed = document.querySelector('.workbench-spine button[aria-pressed="true"]');
    const error = document.querySelector(".error-notice") ?? document.createElement("div");
    if (!document.querySelector(".error-notice")) { error.className = "error-notice"; document.body.appendChild(error); }
    return { pressed: pressed ? getComputedStyle(pressed).color : "", error: getComputedStyle(error).color };
  });
  expect(colors.pressed).not.toBe("");
  expect(colors.pressed).not.toBe(colors.error);
});
