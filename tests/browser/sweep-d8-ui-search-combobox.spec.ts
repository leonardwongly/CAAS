// Owner: D8 — briefing copy & flows (adversarial sweep 2026-08-23).
// Search combobox keyboard flows under a real browser transport: Enter fires
// immediately (no debounce wait), arrow keys clamp at the picker edges,
// keyboard selection commits and keeps focus in the input, and a no-results
// state is visually distinguishable from a still-loading search.
import { expect, test, type Page } from "@playwright/test";

const TILE_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

const generation = {
  id: "d8-search-generation",
  retrievedAt: "2026-08-16T00:00:00.000Z",
  live: { state: "fresh", retrievedAt: "2026-08-16T00:00:00.000Z", freshUntil: "2026-08-16T01:00:00.000Z", staleUntil: "2026-08-16T02:00:00.000Z" },
  reference: { state: "fresh", retrievedAt: "2026-08-16T00:00:00.000Z", freshUntil: "2026-08-17T00:00:00.000Z", staleUntil: "2026-08-18T00:00:00.000Z" },
  overall: "fresh",
};

const route = {
  id: "route-search-1", flightId: "flight-search-1", callsign: "SQ321B", status: "complete", complete: true,
  label: "Recorded search fixture route", origin: "WSSS", destination: "EGLL", pointCount: 3,
  legs: [{ id: "leg-1", sequence: 1, kind: "direct", from: "WSSS", to: "EGLL", distanceNm: 5800.2, status: "resolved" }],
  geometry: { type: "LineString", coordinates: [[103.99, 1.35], [60, 30], [-0.45, 51.47]] }, distanceNm: 5800.2,
  provenance: "CAAS normalized live generation", gaps: [],
};

const matches = [
  { id: "flight-search-1", flightId: "flight-search-1", callsign: "SQ321B", departure: "Singapore (WSSS)", destination: "London (EGLL)", routePointCount: 3 },
  { id: "flight-search-2", flightId: "flight-search-2", callsign: "SQ321A", departure: "Singapore (WSSS)", destination: "London (EGLL)", routePointCount: 4 },
];

async function installFixture(page: Page, searchDelayMs = 0) {
  await page.route("**/api/**", async (routeRequest) => {
    const request = routeRequest.request();
    const url = new URL(request.url());
    const body = request.postData() ?? "";
    const respond = (payload: unknown) => routeRequest.fulfill({ contentType: "application/json", body: JSON.stringify(payload) });
    if (url.pathname === "/api/v1/readiness") return respond({ status: "ready", generation });
    if (url.pathname === "/api/v1/routes/overview" && request.method() === "POST") return respond({ data: [route], generation, loaded: 1, total: 1 });
    if (url.pathname === "/api/v1/callsigns/search" && request.method() === "POST") {
      if (searchDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, searchDelayMs));
      const query = (JSON.parse(body) as { query?: string }).query ?? "";
      if (query.includes("ZZZ")) return respond({ data: [] });
      return respond({ data: matches });
    }
    if (url.pathname === "/api/v1/routes/options" && request.method() === "POST") return respond({ data: [route], generation });
    if (url.pathname === "/api/v1/points/lookup" && request.method() === "POST") return respond({ matches: [] });
    return routeRequest.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: { code: "NOT_FOUND", message: "Fixture route not implemented." } }) });
  });
  await page.route(/^https:\/\/tile\.openstreetmap\.org\//, (tileRoute) => tileRoute.fulfill({ contentType: "image/png", body: TILE_PNG }));
}

test("Enter searches immediately and arrow keys clamp at the picker edges before committing", async ({ page }) => {
  await installFixture(page);
  await page.goto("/");

  const input = page.getByRole("combobox", { name: "Flight number or code" });
  await input.click();
  await input.type("SQ", { delay: 20 });
  // Enter fires the search without waiting for the 250ms type-ahead settle.
  await page.keyboard.press("Enter");

  const listbox = page.getByRole("listbox", { name: "Choose an exact flight-plan match" });
  await expect(listbox).toBeVisible();
  await expect(page.getByRole("option")).toHaveCount(2);

  // ArrowDown past the last option stays on the last option…
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await expect(input).toHaveAttribute("aria-activedescendant", "flight-match-1");
  // …and ArrowUp past the first stays on the first (no focus dead-end).
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await expect(input).toHaveAttribute("aria-activedescendant", "flight-match-0");

  // Enter commits the active option; the picker closes and focus stays in the
  // search input so the flow can continue without hunting for focus.
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(listbox).toHaveCount(0);
  await expect(page.locator(".selected-value")).toContainText("SQ321A");
  await expect.poll(() => page.evaluate(() => document.activeElement?.id ?? "")).toBe("flight-search");
});

test("a no-results search is distinguishable from a still-loading search", async ({ page }) => {
  await installFixture(page, 600);
  await page.goto("/");

  const input = page.getByRole("combobox", { name: "Flight number or code" });
  await input.click();
  await input.type("ZZZ");
  await page.keyboard.press("Enter");

  // While the request is in flight the button carries the spinner and no
  // final verdict text is shown yet.
  await expect(page.locator(".search-button .spinner")).toBeVisible();
  await expect(page.getByText("No matching flight plans returned.")).toHaveCount(0);

  // Once settled, the spinner is gone and the explicit no-results copy lands.
  await expect(page.locator(".search-button .spinner")).toHaveCount(0, { timeout: 3000 });
  await expect(page.getByText("No matching flight plans returned.")).toBeVisible();
  await expect(page.locator(".sr-status")).toContainText("No flight plans matched ZZZ.");
});
