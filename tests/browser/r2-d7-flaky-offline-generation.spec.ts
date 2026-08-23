// Owner: R2-D7 — flaky-network recovery journeys (round-2 adversarial sweep 2026-08-23).
// Recovery affordances and honesty under outage and generation churn:
// offline→online recovery through the retry affordance, generation-change
// mid-pagination never silently mixing datasets, a failed refresh never losing
// the prior working state, and switching selection never flashing the
// previous route's endpoint pins. All traffic intercepted; no network leaks.
import { expect, test, type Page } from "@playwright/test";

const TILE_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

function makeGeneration(id: string, retrievedAt: string) {
  return {
    id,
    retrievedAt,
    live: { state: "fresh", retrievedAt, freshUntil: "2026-08-16T01:00:00.000Z", staleUntil: "2026-08-16T02:00:00.000Z" },
    reference: { state: "fresh", retrievedAt, freshUntil: "2026-08-17T00:00:00.000Z", staleUntil: "2026-08-18T00:00:00.000Z" },
    overall: "fresh",
  };
}

const generationA = makeGeneration("r2-d7-gen-a", "2026-08-16T00:00:00.000Z");
const generationB = makeGeneration("r2-d7-gen-b", "2026-08-16T06:00:00.000Z");

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

const notFoundBody = JSON.stringify({ error: { code: "NOT_FOUND", message: "Fixture route not implemented." } });

async function installTiles(page: Page) {
  await page.route(/^https:\/\/tile\.openstreetmap\.org\//, (tileRoute) => tileRoute.fulfill({ contentType: "image/png", body: TILE_PNG }));
}

test("offline boot recovers through the retry affordance once the connection returns", async ({ page }) => {
  let offline = true;
  await page.route("**/api/**", async (routeRequest) => {
    if (offline) return routeRequest.abort("internetdisconnected");
    const request = routeRequest.request();
    const url = new URL(request.url());
    const respond = (payload: unknown) => routeRequest.fulfill({ contentType: "application/json", body: JSON.stringify(payload) });
    if (url.pathname === "/api/v1/readiness") return respond({ status: "ready", generation: generationA });
    if (url.pathname === "/api/v1/routes/overview" && request.method() === "POST") return respond({ data: [routeAlpha], generation: generationA, loaded: 1, total: 1 });
    if (url.pathname === "/api/v1/points/lookup" && request.method() === "POST") return respond({ matches: [] });
    return routeRequest.fulfill({ status: 404, contentType: "application/json", body: notFoundBody });
  });
  await installTiles(page);
  await page.goto("/");

  const manifest = page.getByRole("region", { name: "Full flight list" });
  const alert = manifest.locator('[role="alert"]');
  await expect(alert).toBeVisible({ timeout: 8000 });
  await expect(page.getByRole("button", { name: /FR7ALF/ })).toHaveCount(0);

  // Back online: the same retry affordance completes the recovery without a
  // page reload.
  offline = false;
  await alert.getByRole("button", { name: "Retry overview" }).click();
  await expect(page.getByRole("button", { name: /FR7ALF/ })).toBeVisible({ timeout: 5000 });
  await expect(alert).toHaveCount(0);
  await expect(page.locator(".sr-status")).toContainText("1 source flight record loaded.");
});

test("a generation change mid-pagination surfaces an error and never mixes datasets", async ({ page }) => {
  let mixed = false;
  await page.route("**/api/**", async (routeRequest) => {
    const request = routeRequest.request();
    const url = new URL(request.url());
    const respond = (payload: unknown) => routeRequest.fulfill({ contentType: "application/json", body: JSON.stringify(payload) });
    if (url.pathname === "/api/v1/readiness") return respond({ status: "ready", generation: generationA });
    if (url.pathname === "/api/v1/routes/overview" && request.method() === "POST") {
      const body = request.postDataJSON() as { cursor?: string };
      if (!body.cursor) return respond({ data: [routeAlpha], generation: generationA, nextCursor: "cursor-2" });
      if (!mixed) {
        mixed = true;
        // The source rotated to a new generation between pages: page 2
        // belongs to generation B while page 1 came from generation A.
        return respond({ data: [routeBeta], generation: generationB });
      }
      return respond({ data: [routeBeta], generation: generationA });
    }
    if (url.pathname === "/api/v1/points/lookup" && request.method() === "POST") return respond({ matches: [] });
    return routeRequest.fulfill({ status: 404, contentType: "application/json", body: notFoundBody });
  });
  await installTiles(page);
  await page.goto("/");

  const manifest = page.getByRole("region", { name: "Full flight list" });
  const alert = manifest.locator('[role="alert"]');
  await expect(alert).toContainText("The data generation changed while loading the overview.", { timeout: 8000 });

  // Honesty: the generation-A page-1 record must NOT stay rendered under the
  // error — that would silently mix data from two different generations.
  await expect(page.getByRole("button", { name: /FR7ALF/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /FR7BET/ })).toHaveCount(0);
  // The command-strip stamp still carries the last generation the client
  // actually trusted; it never jumps to a half-loaded one.
  await expect(page.locator(".gen-stamp")).toContainText("GEN");

  // Retry re-traverses under a single generation and lands truthfully.
  await alert.getByRole("button", { name: "Retry overview" }).click();
  await expect(page.getByRole("button", { name: /FR7ALF/ })).toBeVisible({ timeout: 5000 });
  await expect(page.getByRole("button", { name: /FR7BET/ })).toBeVisible();
  await expect(page.locator(".sr-status")).toContainText("2 source flight records loaded.");
});

test("a failed refresh keeps the prior generation serving and the selection honest", async ({ page }) => {
  let refreshCalls = 0;
  await page.route("**/api/**", async (routeRequest) => {
    const request = routeRequest.request();
    const url = new URL(request.url());
    const respond = (payload: unknown) => routeRequest.fulfill({ contentType: "application/json", body: JSON.stringify(payload) });
    if (url.pathname === "/api/v1/readiness") return respond({ status: "ready", generation: generationA });
    if (url.pathname === "/api/v1/routes/overview" && request.method() === "POST") {
      // After a successful refresh the service serves the new generation.
      const serving = refreshCalls >= 2 ? generationB : generationA;
      return respond({ data: [routeAlpha], generation: serving, loaded: 1, total: 1 });
    }
    if (url.pathname === "/api/v1/refresh" && request.method() === "POST") {
      refreshCalls += 1;
      if (refreshCalls === 1) {
        return routeRequest.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: { code: "REFRESH_FAILED", message: "Upstream rejected the refresh." }, retained: { generation: generationA } }) });
      }
      return respond({ status: "refreshed", generation: generationB });
    }
    if (url.pathname === "/api/v1/points/lookup" && request.method() === "POST") return respond({ matches: [] });
    return routeRequest.fulfill({ status: 404, contentType: "application/json", body: notFoundBody });
  });
  await installTiles(page);
  await page.goto("/");

  // Make a selection first: the refresh race must not lose it silently.
  await page.getByRole("button", { name: /FR7ALF/ }).click();
  await expect(page.locator(".selected-route-label")).toContainText("FR7ALF");

  page.on("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Refresh source data" }).click();

  // Failure mid-flight: the prior generation is still serving, the selection
  // survives, and the recovery affordance stays actionable.
  const alert = page.locator(".refresh-error[role='alert']");
  await expect(alert).toContainText("Live data refresh failed. The prior generation retrieved at");
  await expect(alert).toContainText("is still serving requests.");
  await expect(page.locator(".selected-route-label")).toContainText("FR7ALF");
  await expect(page.getByRole("button", { name: /FR7ALF/ })).toBeVisible();
  const refreshButton = page.getByRole("button", { name: "Refresh source data" });
  await expect(refreshButton).toBeEnabled();

  // Second attempt recovers: new generation stamp, selection cleared, and a
  // truthful overview reload under the new generation. The stamp text is
  // locale-rendered, so pin the CHANGE, not the wall-clock formatting.
  const stampBefore = await page.locator(".gen-stamp").textContent();
  await refreshButton.click();
  await expect(page.locator(".gen-stamp")).not.toHaveText(stampBefore ?? "", { timeout: 8000 });
  await expect(page.locator(".selected-route-label")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /FR7ALF/ })).toBeVisible();
  await expect(page.locator(".sr-status")).toContainText("Source data refreshed at");
});

test("switching selection never leaves the previous route's endpoint pins on the map", async ({ page }) => {
  await page.route("**/api/**", async (routeRequest) => {
    const request = routeRequest.request();
    const url = new URL(request.url());
    const respond = (payload: unknown) => routeRequest.fulfill({ contentType: "application/json", body: JSON.stringify(payload) });
    if (url.pathname === "/api/v1/readiness") return respond({ status: "ready", generation: generationA });
    if (url.pathname === "/api/v1/routes/overview" && request.method() === "POST") return respond({ data: [routeAlpha, routeBeta], generation: generationA, loaded: 2, total: 2 });
    if (url.pathname === "/api/v1/points/lookup" && request.method() === "POST") {
      const body = request.postDataJSON() as { reference: string };
      if (body.reference === "KOR1") {
        return respond({ matches: [{ id: "loc-kor1", callsign: "KOR1", name: "Origin One Airport", kind: "airport", coordinate: { lat: 40, lon: -73 } }] });
      }
      if (body.reference === "KDS1") {
        return respond({ matches: [{ id: "loc-kds1", callsign: "KDS1", name: "Dest One Airport", kind: "airport", coordinate: { lat: 33, lon: -118 } }] });
      }
      // Beta's endpoint lookups crawl on the wire (a real in-handler delay;
      // route.fulfill has no delay option): whatever the endpoint panel shows
      // during that silence is exactly what a user on a terrible connection
      // would see, so it must never be alpha's resolved identity.
      if (body.reference === "KOR2") {
        await new Promise((resolve) => setTimeout(resolve, 1200));
        return routeRequest.fulfill({ contentType: "application/json", body: JSON.stringify({ matches: [{ id: "loc-kor2", callsign: "KOR2", name: "Origin Two Field", kind: "airport", coordinate: { lat: 50, lon: -10 } }] }) }).catch(() => undefined);
      }
      if (body.reference === "KDS2") {
        await new Promise((resolve) => setTimeout(resolve, 1200));
        return routeRequest.fulfill({ contentType: "application/json", body: JSON.stringify({ matches: [{ id: "loc-kds2", callsign: "KDS2", name: "Dest Two Field", kind: "airport", coordinate: { lat: 48, lon: 20 } }] }) }).catch(() => undefined);
      }
      return respond({ matches: [] });
    }
    return routeRequest.fulfill({ status: 404, contentType: "application/json", body: notFoundBody });
  });
  await installTiles(page);
  await page.goto("/");

  await page.getByRole("button", { name: /FR7ALF/ }).click();
  await expect(page.locator(".map-endpoints")).toContainText("Origin One Airport", { timeout: 5000 });

  // Switch selection while beta's lookups are still crawling on the wire.
  await page.getByRole("button", { name: /FR7BET/ }).click();
  await expect(page.locator(".selected-route-label")).toContainText("FR7BET");

  // During the whole silent window the panel may only show beta's own
  // route-level fallback identity — never alpha's resolved names. Pinned
  // across the window (not a single negated sample) so a lingering or
  // re-appearing stale label cannot slip through.
  const endpointPanel = page.locator(".map-endpoints");
  await expect(endpointPanel.locator(".departure")).toContainText("KOR2", { timeout: 400 });
  await expect(endpointPanel).not.toContainText("Origin One Airport", { timeout: 250 });
  await page.waitForTimeout(900);
  await expect(endpointPanel).not.toContainText("Origin One Airport", { timeout: 250 });
  await expect(page.locator("body")).not.toContainText("Dest One Airport");

  // And once beta's lookups finally land, only beta's identity resolves.
  await expect(endpointPanel).toContainText("Origin Two Field", { timeout: 5000 });
  await expect(endpointPanel).toContainText("Dest Two Field");
});
