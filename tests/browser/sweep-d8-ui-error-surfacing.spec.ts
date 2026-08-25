// Owner: D8 — briefing copy & flows (adversarial sweep 2026-08-23).
// API failures must surface as actionable briefing copy, never cryptic
// transport text: machine-readable codes map to human guidance with a retry
// path (overview and route options), and a bare non-JSON failure still
// renders a bounded fallback message instead of a raw error string.
import { expect, test, type Page } from "@playwright/test";

const TILE_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

const generation = {
  id: "d8-errors-generation",
  retrievedAt: "2026-08-16T00:00:00.000Z",
  live: { state: "fresh", retrievedAt: "2026-08-16T00:00:00.000Z", freshUntil: "2026-08-16T01:00:00.000Z", staleUntil: "2026-08-16T02:00:00.000Z" },
  reference: { state: "fresh", retrievedAt: "2026-08-16T00:00:00.000Z", freshUntil: "2026-08-17T00:00:00.000Z", staleUntil: "2026-08-18T00:00:00.000Z" },
  overall: "fresh",
};

const route = {
  id: "route-err-1", flightId: "flight-err-1", callsign: "ERRFL1", status: "complete", complete: true,
  label: "Recorded error fixture route", origin: "KOR1", destination: "KDS1", pointCount: 3,
  legs: [{ id: "leg-1", sequence: 1, kind: "direct", from: "KOR1", to: "KDS1", distanceNm: 512.4, status: "resolved" }],
  geometry: { type: "LineString", coordinates: [[-73, 40], [-118, 33]] }, distanceNm: 512.4,
  provenance: "CAAS normalized live generation", gaps: [],
};

async function installTiles(page: Page) {
  await page.route(/^https:\/\/tile\.openstreetmap\.org\//, (tileRoute) => tileRoute.fulfill({ contentType: "image/png", body: TILE_PNG }));
}

test("a failed overview shows actionable code copy and Retry recovers", async ({ page }) => {
  let overviewAttempts = 0;
  await page.route("**/api/**", async (routeRequest) => {
    const request = routeRequest.request();
    const url = new URL(request.url());
    const respond = (payload: unknown) => routeRequest.fulfill({ contentType: "application/json", body: JSON.stringify(payload) });
    if (url.pathname === "/api/v1/readiness") return respond({ status: "ready", generation });
    if (url.pathname === "/api/v1/routes/overview" && request.method() === "POST") {
      overviewAttempts += 1;
      if (overviewAttempts === 1) {
        // Code-only envelope: no human message supplied by the server.
        return routeRequest.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "UPSTREAM_UNAVAILABLE" } }) });
      }
      return respond({ data: [route], generation, loaded: 1, total: 1 });
    }
    if (url.pathname === "/api/v1/points/lookup" && request.method() === "POST") return respond({ matches: [] });
    return routeRequest.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: { code: "NOT_FOUND", message: "Fixture route not implemented." } }) });
  });
  await installTiles(page);
  await page.goto("/");

  const manifest = page.getByRole("region", { name: "Full flight list" });
  await expect(manifest).toContainText("Live route data is unavailable right now. Try refreshing in a moment.");
  await expect(manifest).not.toContainText("Request failed (503)");

  await manifest.getByRole("button", { name: "Retry overview" }).click();
  await expect(manifest.getByRole("button", { name: /ERRFL1/ })).toBeVisible({ timeout: 5000 });
});

test("a failed route-options load in the drawer offers actionable code copy and retry", async ({ page }) => {
  let optionsAttempts = 0;
  await page.route("**/api/**", async (routeRequest) => {
    const request = routeRequest.request();
    const url = new URL(request.url());
    const respond = (payload: unknown) => routeRequest.fulfill({ contentType: "application/json", body: JSON.stringify(payload) });
    if (url.pathname === "/api/v1/readiness") return respond({ status: "ready", generation });
    if (url.pathname === "/api/v1/routes/overview" && request.method() === "POST") return respond({ data: [route], generation, loaded: 1, total: 1 });
    if (url.pathname === "/api/v1/routes/options" && request.method() === "POST") {
      optionsAttempts += 1;
      if (optionsAttempts === 1) return routeRequest.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: { code: "GENERATION_STALE" } }) });
      return respond({ data: [route], generation });
    }
    if (url.pathname === "/api/v1/points/lookup" && request.method() === "POST") return respond({ matches: [] });
    return routeRequest.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: { code: "NOT_FOUND", message: "Fixture route not implemented." } }) });
  });
  await installTiles(page);
  await page.goto("/");

  await page.getByRole("button", { name: /ERRFL1/ }).click();
  await page.getByRole("button", { name: "Routes", exact: true }).click();

  const drawer = page.getByRole("region", { name: "Route chooser" });
  await expect(drawer).toContainText("This dataset has expired. Refresh data to acquire a new snapshot.");
  await drawer.getByRole("button", { name: "Retry route options" }).click();
  await expect(drawer).toContainText("Complete recorded route options", { timeout: 5000 });
  await expect(drawer).toContainText("Recorded error fixture route");
});

test("a non-JSON 500 still renders a bounded fallback message, never raw internals", async ({ page }) => {
  await page.route("**/api/**", async (routeRequest) => {
    const request = routeRequest.request();
    const url = new URL(request.url());
    const respond = (payload: unknown) => routeRequest.fulfill({ contentType: "application/json", body: JSON.stringify(payload) });
    if (url.pathname === "/api/v1/readiness") return respond({ status: "ready", generation });
    if (url.pathname === "/api/v1/routes/overview" && request.method() === "POST") return respond({ data: [route], generation, loaded: 1, total: 1 });
    if (url.pathname === "/api/v1/callsigns/search" && request.method() === "POST") {
      return routeRequest.fulfill({ status: 500, contentType: "text/plain", body: "upstream exploded" });
    }
    if (url.pathname === "/api/v1/points/lookup" && request.method() === "POST") return respond({ matches: [] });
    return routeRequest.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: { code: "NOT_FOUND", message: "Fixture route not implemented." } }) });
  });
  await installTiles(page);
  await page.goto("/");

  const input = page.getByRole("combobox", { name: "Flight number or code" });
  await input.click();
  await input.type("ERR");
  await page.keyboard.press("Enter");

  // The field error carries the bounded status fallback, and the raw body of
  // the failing upstream never leaks into the briefing.
  const fieldError = page.getByRole("alert").filter({ hasText: "Request failed (500)" });
  await expect(fieldError).toBeVisible();
  await expect(page.locator("body")).not.toContainText("upstream exploded");
  await expect(page.locator(".sr-status")).toContainText("Flight-plan search failed.");
});
