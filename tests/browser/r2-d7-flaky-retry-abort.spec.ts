// Owner: R2-D7 — flaky-network recovery journeys (round-2 adversarial sweep 2026-08-23).
// 500-then-recover sequences and mid-flight aborts: every retry path must end
// in a truthful success state, and a response superseded by a newer user
// gesture (another route selected, a newer search page) must NEVER land its
// stale data. All traffic intercepted; no network leaks.
import { expect, test, type Page } from "@playwright/test";

const TILE_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

const generation = {
  id: "r2-d7-retry-generation",
  retrievedAt: "2026-08-16T00:00:00.000Z",
  live: { state: "fresh", retrievedAt: "2026-08-16T00:00:00.000Z", freshUntil: "2026-08-16T01:00:00.000Z", staleUntil: "2026-08-16T02:00:00.000Z" },
  reference: { state: "fresh", retrievedAt: "2026-08-16T00:00:00.000Z", freshUntil: "2026-08-17T00:00:00.000Z", staleUntil: "2026-08-18T00:00:00.000Z" },
  overall: "fresh",
};

const routeAlpha = {
  id: "route-r2d7-alpha", flightId: "flight-r2d7-alpha", callsign: "FR7ALF", status: "complete", complete: true,
  label: "Alpha fixture route", origin: "KOR1", destination: "KDS1", pointCount: 3,
  legs: [{ id: "leg-1", sequence: 1, kind: "direct", from: "KOR1", to: "KDS1", distanceNm: 512.4, status: "resolved" }],
  geometry: { type: "LineString", coordinates: [[-73, 40], [-118, 33]] }, distanceNm: 512.4,
  provenance: "CAAS normalized live generation", gaps: [],
};

const routeBeta = {
  id: "route-r2d7-beta", flightId: "flight-r2d7-beta", callsign: "FR7BET", status: "complete", complete: true,
  label: "Beta fixture route", origin: "KOR2", destination: "KDS2", pointCount: 2,
  legs: [{ id: "leg-1", sequence: 1, kind: "direct", from: "KOR2", to: "KDS2", distanceNm: 311.0, status: "resolved" }],
  geometry: { type: "LineString", coordinates: [[-10, 50], [20, 48]] }, distanceNm: 311.0,
  provenance: "CAAS normalized live generation", gaps: [],
};

async function installTiles(page: Page) {
  await page.route(/^https:\/\/tile\.openstreetmap\.org\//, (tileRoute) => tileRoute.fulfill({ contentType: "image/png", body: TILE_PNG }));
}

test("a 500,500,200 overview sequence ends in a truthful success state", async ({ page }) => {
  let overviewCalls = 0;
  await page.route("**/api/**", async (routeRequest) => {
    const request = routeRequest.request();
    const url = new URL(request.url());
    const respond = (payload: unknown) => routeRequest.fulfill({ contentType: "application/json", body: JSON.stringify(payload) });
    if (url.pathname === "/api/v1/readiness") return respond({ status: "ready", generation });
    if (url.pathname === "/api/v1/routes/overview" && request.method() === "POST") {
      overviewCalls += 1;
      if (overviewCalls <= 2) return routeRequest.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: { message: "Upstream is flaking out." } }) });
      return respond({ data: [routeAlpha, routeBeta], generation, loaded: 2, total: 2 });
    }
    if (url.pathname === "/api/v1/points/lookup" && request.method() === "POST") return respond({ matches: [] });
    return routeRequest.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: { code: "NOT_FOUND", message: "Fixture route not implemented." } }) });
  });
  await installTiles(page);
  await page.goto("/");

  const manifest = page.getByRole("region", { name: "Full flight list" });
  const alert = manifest.locator('[role="alert"]');
  await expect(alert).toContainText("Upstream is flaking out.");
  await expect(page.getByRole("button", { name: /FR7ALF/ })).toHaveCount(0);

  // First retry still hits the second 500: the error must stay honest…
  await alert.getByRole("button", { name: "Retry overview" }).click();
  await expect(alert).toContainText("Upstream is flaking out.");
  await expect(page.getByRole("button", { name: /FR7ALF/ })).toHaveCount(0);

  // …and the second retry lands the real dataset with a truthful count.
  await alert.getByRole("button", { name: "Retry overview" }).click();
  await expect(page.getByRole("button", { name: /FR7ALF/ })).toBeVisible({ timeout: 5000 });
  await expect(page.getByRole("button", { name: /FR7BET/ })).toBeVisible();
  await expect(manifest.locator('[role="alert"]')).toHaveCount(0);
  await expect(page.locator(".sr-status")).toContainText("2 source flight records loaded.");
});

test("a 500-then-recover route-options load retries cleanly inside the drawer", async ({ page }) => {
  let optionsCalls = 0;
  await page.route("**/api/**", async (routeRequest) => {
    const request = routeRequest.request();
    const url = new URL(request.url());
    const respond = (payload: unknown) => routeRequest.fulfill({ contentType: "application/json", body: JSON.stringify(payload) });
    if (url.pathname === "/api/v1/readiness") return respond({ status: "ready", generation });
    if (url.pathname === "/api/v1/routes/overview" && request.method() === "POST") return respond({ data: [routeAlpha], generation, loaded: 1, total: 1 });
    if (url.pathname === "/api/v1/routes/options" && request.method() === "POST") {
      optionsCalls += 1;
      if (optionsCalls === 1) return routeRequest.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: { message: "Options endpoint hiccup." } }) });
      return respond({ data: [routeAlpha], generation });
    }
    if (url.pathname === "/api/v1/points/lookup" && request.method() === "POST") return respond({ matches: [] });
    return routeRequest.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: { code: "NOT_FOUND", message: "Fixture route not implemented." } }) });
  });
  await installTiles(page);
  await page.goto("/");

  await page.getByRole("button", { name: /FR7ALF/ }).click();
  await page.getByRole("button", { name: "Routes", exact: true }).click();

  const drawer = page.getByRole("region", { name: "Route chooser" });
  await expect(drawer).toContainText("Options endpoint hiccup.");

  await drawer.getByRole("button", { name: "Retry route options" }).click();
  await expect(drawer).toContainText("Complete recorded route options", { timeout: 5000 });
  await expect(drawer).toContainText("Alpha fixture route");
  await expect(drawer.locator('[role="alert"]')).toHaveCount(0);
});

test("selecting a second route mid-flight never lets the first options response land", async ({ page }) => {
  let alphaOptionsSettled = false;
  await page.route("**/api/**", async (routeRequest) => {
    const request = routeRequest.request();
    const url = new URL(request.url());
    const respond = (payload: unknown) => routeRequest.fulfill({ contentType: "application/json", body: JSON.stringify(payload) });
    if (url.pathname === "/api/v1/readiness") return respond({ status: "ready", generation });
    if (url.pathname === "/api/v1/routes/overview" && request.method() === "POST") return respond({ data: [routeAlpha, routeBeta], generation, loaded: 2, total: 2 });
    if (url.pathname === "/api/v1/routes/options" && request.method() === "POST") {
      const body = request.postDataJSON() as { flightId: string };
      // Alpha's answer crawls in late (real in-handler delay); beta's lands
      // immediately.
      if (body.flightId === "flight-r2d7-alpha") {
        await new Promise((resolve) => setTimeout(resolve, 800));
        alphaOptionsSettled = true;
        return routeRequest.fulfill({ contentType: "application/json", body: JSON.stringify({ data: [routeAlpha], generation }) }).catch(() => undefined);
      }
      return respond({ data: [routeBeta], generation });
    }
    if (url.pathname === "/api/v1/points/lookup" && request.method() === "POST") return respond({ matches: [] });
    return routeRequest.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: { code: "NOT_FOUND", message: "Fixture route not implemented." } }) });
  });
  await installTiles(page);
  await page.goto("/");

  await page.getByRole("button", { name: /FR7ALF/ }).click();
  await page.getByRole("button", { name: "Routes", exact: true }).click();
  // Change the selection while alpha's options are still on the wire.
  await page.getByRole("button", { name: /FR7BET/ }).click();

  const drawer = page.getByRole("region", { name: "Route chooser" });
  await expect(drawer).toContainText("Beta fixture route", { timeout: 5000 });
  await expect(page.locator(".selected-route-label")).toContainText("FR7BET");

  // Wait well past alpha's 800ms delay: the stale response has settled on
  // the wire but its payload must never appear anywhere in the UI.
  await page.waitForTimeout(1100);
  expect(alphaOptionsSettled).toBe(true);
  await expect(drawer.getByText("Alpha fixture route")).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText("Alpha fixture route");
});

test("a search page-2 failure never lands page-1 partial matches", async ({ page }) => {
  let searchCalls = 0;
  await page.route("**/api/**", async (routeRequest) => {
    const request = routeRequest.request();
    const url = new URL(request.url());
    const respond = (payload: unknown) => routeRequest.fulfill({ contentType: "application/json", body: JSON.stringify(payload) });
    if (url.pathname === "/api/v1/readiness") return respond({ status: "ready", generation });
    if (url.pathname === "/api/v1/routes/overview" && request.method() === "POST") return respond({ data: [routeAlpha], generation, loaded: 1, total: 1 });
    if (url.pathname === "/api/v1/callsigns/search" && request.method() === "POST") {
      searchCalls += 1;
      const body = request.postDataJSON() as { cursor?: string };
      if (!body.cursor) {
        return respond({ data: [{ flightId: "flight-r2d7-alpha", callsign: "FR7P1", departure: "KOR1", destination: "KDS1", routePointCount: 3 }], nextCursor: "page-2" });
      }
      return routeRequest.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: { message: "Second search page exploded." } }) });
    }
    if (url.pathname === "/api/v1/points/lookup" && request.method() === "POST") return respond({ matches: [] });
    return routeRequest.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: { code: "NOT_FOUND", message: "Fixture route not implemented." } }) });
  });
  await installTiles(page);
  await page.goto("/");

  const input = page.getByRole("combobox", { name: "Flight number or code" });
  await input.click();
  await input.fill("FR7");
  await page.keyboard.press("Enter");

  // The traversal failed mid-chain: the complete match set is unknowable, so
  // no partial match may be offered — only a bounded error carrying the
  // server's message (raw body bytes never leak).
  const fieldError = page.getByRole("alert").filter({ hasText: "Second search page exploded." });
  await expect(fieldError).toBeVisible();
  await expect(page.locator("#flight-search-results [role='option']")).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText("FR7P1");
  await expect(page.locator(".sr-status")).toContainText("Flight-plan search failed.");
  expect(searchCalls).toBeGreaterThanOrEqual(2);
});
