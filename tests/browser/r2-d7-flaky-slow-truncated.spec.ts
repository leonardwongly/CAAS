// Owner: R2-D7 — flaky-network recovery journeys (round-2 adversarial sweep 2026-08-23).
// Terrible-connection honesty at first paint and mid-traversal: a slow
// readiness/overview must show an honest loading state with zero flash of
// wrong data, and a truncated/partial JSON body must land as a bounded error
// that stands ALONE — never a crash and never a half-rendered stale dataset
// mixed under the error notice. All traffic intercepted; no network leaks.
import { expect, test, type Page } from "@playwright/test";

const TILE_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

const generation = {
  id: "r2-d7-slow-generation",
  retrievedAt: "2026-08-16T00:00:00.000Z",
  live: { state: "fresh", retrievedAt: "2026-08-16T00:00:00.000Z", freshUntil: "2026-08-16T01:00:00.000Z", staleUntil: "2026-08-16T02:00:00.000Z" },
  reference: { state: "fresh", retrievedAt: "2026-08-16T00:00:00.000Z", freshUntil: "2026-08-17T00:00:00.000Z", staleUntil: "2026-08-18T00:00:00.000Z" },
  overall: "fresh",
};

const routeA = {
  id: "route-r2d7-slow", flightId: "flight-r2d7-slow", callsign: "FR7SLO1", status: "complete", complete: true,
  label: "R2-D7 slow fixture route", origin: "KOR1", destination: "KDS1", pointCount: 3,
  legs: [{ id: "leg-1", sequence: 1, kind: "direct", from: "KOR1", to: "KDS1", distanceNm: 512.4, status: "resolved" }],
  geometry: { type: "LineString", coordinates: [[-73, 40], [-118, 33]] }, distanceNm: 512.4,
  provenance: "CAAS normalized live generation", gaps: [],
};

const routeB = {
  id: "route-r2d7-page2", flightId: "flight-r2d7-page2", callsign: "FR7PG2", status: "complete", complete: true,
  label: "R2-D7 second-page fixture route", origin: "KOR2", destination: "KDS2", pointCount: 2,
  legs: [{ id: "leg-1", sequence: 1, kind: "direct", from: "KOR2", to: "KDS2", distanceNm: 311.0, status: "resolved" }],
  geometry: { type: "LineString", coordinates: [[-10, 50], [20, 48]] }, distanceNm: 311.0,
  provenance: "CAAS normalized live generation", gaps: [],
};

async function installTiles(page: Page) {
  await page.route(/^https:\/\/tile\.openstreetmap\.org\//, (tileRoute) => tileRoute.fulfill({ contentType: "image/png", body: TILE_PNG }));
}

test("a slow readiness and overview shows an honest loading state with no early flash of data", async ({ page }) => {
  await page.route("**/api/**", async (routeRequest) => {
    const request = routeRequest.request();
    const url = new URL(request.url());
    const respond = (payload: unknown) => routeRequest.fulfill({ contentType: "application/json", body: JSON.stringify(payload) });
    if (url.pathname === "/api/v1/readiness") return respond({ status: "ready", generation });
    if (url.pathname === "/api/v1/routes/overview" && request.method() === "POST") return respond({ data: [routeA], generation, loaded: 1, total: 1 });
    if (url.pathname === "/api/v1/points/lookup" && request.method() === "POST") return respond({ matches: [] });
    return routeRequest.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: { code: "NOT_FOUND", message: "Fixture route not implemented." } }) });
  });
  // The last-registered handler runs first: every boot round-trip sits on
  // the wire for 900ms before falling through to the fixture handler above.
  await page.route("**/api/**", async (routeRequest) => {
    await new Promise((resolve) => setTimeout(resolve, 900));
    await routeRequest.fallback();
  });
  await installTiles(page);
  await page.goto("/");

  // While the overview is still on the wire the UI says so, explicitly…
  const manifest = page.getByRole("region", { name: "Full flight list" });
  await expect(manifest).toContainText("Loading all route pages…");
  await expect(page.locator(".toolbar-flight")).toContainText("Loading the all-flight overview…");
  // …and no route record, count, or geometry flashes early.
  await page.waitForTimeout(400);
  await expect(page.getByRole("button", { name: /FR7SLO1/ })).toHaveCount(0);
  await expect(page.locator(".sr-status")).not.toContainText("loaded");

  // When the response finally lands the success state is truthful.
  await expect(page.getByRole("button", { name: /FR7SLO1/ })).toBeVisible({ timeout: 8000 });
  await expect(manifest.getByText("Loading all route pages…")).toHaveCount(0);
  await expect(page.locator(".sr-status")).toContainText("1 source flight record loaded.");
});

test("a truncated JSON body mid-pagination is a bounded error standing alone, and Retry recovers", async ({ page }) => {
  let overviewCalls = 0;
  await page.route("**/api/**", async (routeRequest) => {
    const request = routeRequest.request();
    const url = new URL(request.url());
    const respond = (payload: unknown) => routeRequest.fulfill({ contentType: "application/json", body: JSON.stringify(payload) });
    if (url.pathname === "/api/v1/readiness") return respond({ status: "ready", generation });
    if (url.pathname === "/api/v1/routes/overview" && request.method() === "POST") {
      const body = request.postDataJSON() as { cursor?: string };
      if (!body.cursor) {
        overviewCalls += 1;
        // First traversal: page 1 lands, page 2 arrives truncated mid-body.
        // Retry traversal: both pages arrive intact.
        if (overviewCalls === 1) return respond({ data: [routeA], generation, nextCursor: "cursor-2" });
        return respond({ data: [routeA, routeB], generation, loaded: 2, total: 2 });
      }
      if (overviewCalls === 1) return routeRequest.fulfill({ status: 200, contentType: "application/json", body: '{"data":[{"id":"route-r2d7-page2","flightId":"flig' });
      return respond({ data: [routeB], generation });
    }
    if (url.pathname === "/api/v1/points/lookup" && request.method() === "POST") return respond({ matches: [] });
    return routeRequest.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: { code: "NOT_FOUND", message: "Fixture route not implemented." } }) });
  });
  await installTiles(page);
  await page.goto("/");

  const manifest = page.getByRole("region", { name: "Full flight list" });
  const alert = manifest.locator('[role="alert"]');
  await expect(alert).toBeVisible({ timeout: 8000 });

  // The partial first page must NOT stay rendered underneath the error:
  // a truncated traversal produces no defensible dataset at all.
  await expect(page.getByRole("button", { name: /FR7SLO1/ })).toHaveCount(0);
  await expect(page.locator(".map-empty")).toBeVisible();

  // Page errors never crash the shell; the recovery affordance works.
  await alert.getByRole("button", { name: "Retry overview" }).click();
  await expect(page.getByRole("button", { name: /FR7SLO1/ })).toBeVisible({ timeout: 5000 });
  await expect(page.getByRole("button", { name: /FR7PG2/ })).toBeVisible();
  await expect(page.locator(".sr-status")).toContainText("2 source flight records loaded.");
});

test("a structurally valid but non-object overview body is a bounded error, never a crash", async ({ page }) => {
  let overviewCalls = 0;
  await page.route("**/api/**", async (routeRequest) => {
    const request = routeRequest.request();
    const url = new URL(request.url());
    const respond = (payload: unknown) => routeRequest.fulfill({ contentType: "application/json", body: JSON.stringify(payload) });
    if (url.pathname === "/api/v1/readiness") return respond({ status: "ready", generation });
    if (url.pathname === "/api/v1/routes/overview" && request.method() === "POST") {
      overviewCalls += 1;
      if (overviewCalls === 1) return routeRequest.fulfill({ status: 200, contentType: "application/json", body: '"not-an-object"' });
      return respond({ data: [routeA], generation, loaded: 1, total: 1 });
    }
    if (url.pathname === "/api/v1/points/lookup" && request.method() === "POST") return respond({ matches: [] });
    return routeRequest.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: { code: "NOT_FOUND", message: "Fixture route not implemented." } }) });
  });
  await installTiles(page);
  await page.goto("/");

  const manifest = page.getByRole("region", { name: "Full flight list" });
  const alert = manifest.locator('[role="alert"]');
  await expect(alert).toContainText("The route overview response was not usable.");
  await expect(page.getByRole("button", { name: /FR7SLO1/ })).toHaveCount(0);

  await alert.getByRole("button", { name: "Retry overview" }).click();
  await expect(page.getByRole("button", { name: /FR7SLO1/ })).toBeVisible({ timeout: 5000 });
});
