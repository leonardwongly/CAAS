// Owner: D8 — briefing copy & flows (adversarial sweep 2026-08-23).
// API data page UX under hostile data: a failed summary must offer a retry
// (not strand the user), malformed timestamps must never render "Invalid
// Date", switching browse families must never leave the previous family's
// rows on screen, empty-input endpoint runs are guarded, and an empty browse
// result announces itself distinctly from a loading state.
import { expect, test, type Page } from "@playwright/test";

const TILE_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

const generation = {
  id: "d8-apidata-generation",
  retrievedAt: "2026-08-16T00:00:00.000Z",
  live: { state: "fresh", retrievedAt: "2026-08-16T00:00:00.000Z", freshUntil: "2026-08-16T01:00:00.000Z", staleUntil: "2026-08-16T02:00:00.000Z" },
  reference: { state: "fresh", retrievedAt: "2026-08-16T00:00:00.000Z", freshUntil: "2026-08-17T00:00:00.000Z", staleUntil: "2026-08-18T00:00:00.000Z" },
  overall: "fresh",
};

const route = {
  id: "route-data-1", flightId: "flight-data-1", callsign: "DATAFIX1", status: "complete", complete: true,
  label: "Recorded api-data fixture route", origin: "KOR1", destination: "KDS1", pointCount: 3,
  legs: [{ id: "leg-1", sequence: 1, kind: "direct", from: "KOR1", to: "KDS1", distanceNm: 512.4, status: "resolved" }],
  geometry: { type: "LineString", coordinates: [[-73, 40], [-118, 33]] }, distanceNm: 512.4,
  provenance: "CAAS normalized live generation", gaps: [],
};

const flightRows = [
  { id: "browse-flight-1", callsign: "FLBROW1", departure: "KOR1", destination: "KDS1", pointCount: 3 },
  { id: "browse-flight-2", callsign: "FLBROW2", departure: "KOR2", destination: "KDS2", pointCount: 5 },
];
const fixRows = [
  { id: "browse-fix-1", callsign: "FIXALPHA", name: "Fix Alpha", kind: "fix", coordinate: { lat: 12.3456, lon: 98.7654 } },
];

function summaryBody(gen = generation) {
  return {
    generation: gen,
    families: [{ family: "flights", records: 12, acceptedRecords: 12, rejectedRecords: 0 }],
    airway: { records: 5, acceptedRecords: 5, rejectedRecords: 0, uniqueRecords: 4 },
  };
}

type FixtureOptions = {
  summaryMode?: "ok" | "fail-once" | "malformed";
  fixesDelayMs?: number;
};

async function installFixture(page: Page, options: FixtureOptions = {}) {
  let summaryAttempts = 0;
  await page.route("**/api/**", async (routeRequest) => {
    const request = routeRequest.request();
    const url = new URL(request.url());
    const respond = (payload: unknown) => routeRequest.fulfill({ contentType: "application/json", body: JSON.stringify(payload) });
    if (url.pathname === "/api/v1/readiness") return respond({ status: "ready", generation });
    if (url.pathname === "/api/v1/routes/overview" && request.method() === "POST") return respond({ data: [route], generation, loaded: 1, total: 1 });
    if (url.pathname === "/api/v1/points/lookup" && request.method() === "POST") return respond({ matches: [] });
    if (url.pathname === "/api/v1/data/summary") {
      summaryAttempts += 1;
      if (options.summaryMode === "fail-once" && summaryAttempts === 1) {
        return routeRequest.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: { code: "SUMMARY_FAILED", message: "The summary pipeline is temporarily unavailable." } }) });
      }
      if (options.summaryMode === "malformed") {
        const malformed = {
          ...generation,
          retrievedAt: "not-a-timestamp",
          live: { ...generation.live, retrievedAt: "also-not-a-timestamp" },
          reference: { ...generation.reference, retrievedAt: "still-not-a-timestamp" },
        };
        return respond(summaryBody(malformed));
      }
      return respond(summaryBody());
    }
    if (url.pathname === "/api/v1/data/flights" && request.method() === "POST") return respond({ data: flightRows });
    if (url.pathname === "/api/v1/data/fixes" && request.method() === "POST") {
      if (options.fixesDelayMs) await new Promise((resolve) => setTimeout(resolve, options.fixesDelayMs));
      return respond({ data: fixRows });
    }
    if ((url.pathname === "/api/v1/data/airports" || url.pathname === "/api/v1/data/navaids") && request.method() === "POST") return respond({ data: [] });
    return routeRequest.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: { code: "NOT_FOUND", message: "Fixture route not implemented." } }) });
  });
  await page.route(/^https:\/\/tile\.openstreetmap\.org\//, (tileRoute) => tileRoute.fulfill({ contentType: "image/png", body: TILE_PNG }));
}

async function openApiData(page: Page) {
  await page.getByRole("button", { name: "API data" }).click();
  await expect(page.getByRole("heading", { name: "API data" })).toBeVisible();
}

test("a failed data summary shows an actionable error and recovers through Retry", async ({ page }) => {
  await installFixture(page, { summaryMode: "fail-once" });
  await page.goto("/");
  await openApiData(page);

  const alert = page.getByRole("alert").filter({ hasText: "Could not load the data summary." });
  await expect(alert).toBeVisible();
  await expect(alert).toContainText("The summary pipeline is temporarily unavailable.");
  await alert.getByRole("button", { name: "Retry summary" }).click();

  await expect(page.getByRole("table", { name: "Family record counts" })).toBeVisible({ timeout: 5000 });
  await expect(page.locator(".summary-generation")).toContainText("Live data");
});

test("malformed generation timestamps render as unknown time, never Invalid Date", async ({ page }) => {
  await installFixture(page, { summaryMode: "malformed" });
  await page.goto("/");
  await openApiData(page);

  await expect(page.locator(".summary-generation")).toContainText("retrieved unknown time");
  const bodyText = await page.locator("body").innerText();
  expect(bodyText).not.toContain("Invalid Date");
});

test("switching browse families never leaves the previous family's rows on screen", async ({ page }) => {
  await installFixture(page, { fixesDelayMs: 600 });
  await page.goto("/");
  await openApiData(page);

  const flightsTable = page.getByRole("table", { name: "Flight plans browse results" });
  await expect(flightsTable).toContainText("FLBROW1");

  await page.getByRole("tab", { name: "Fixes" }).click();
  // The previous family's rows are cleared immediately — they must not linger
  // under the new family's header while the fixes page is still loading.
  await expect(page.getByText("FLBROW1")).toHaveCount(0);
  await expect(page.getByText("FLBROW2")).toHaveCount(0);

  await expect(page.getByRole("table", { name: "Fixes browse results" })).toContainText("FIXALPHA", { timeout: 4000 });
});

test("empty inputs guard the explorer runs and an empty browse result is announced", async ({ page }) => {
  await installFixture(page);
  await page.goto("/");
  await openApiData(page);

  // Lookup cannot run against an empty reference.
  const lookupCard = page.locator(".explorer-card", { hasText: "/api/v1/points/lookup" });
  await expect(lookupCard.getByRole("button", { name: "Run" })).toBeDisabled();
  await lookupCard.getByRole("textbox", { name: "Reference" }).fill("MIDPT");
  await expect(lookupCard.getByRole("button", { name: "Run" })).toBeEnabled();

  // Clearing the search query disables the run and explains why.
  const searchCard = page.locator(".explorer-card", { hasText: "/api/v1/callsigns/search" });
  await searchCard.getByRole("textbox", { name: "Query" }).fill("");
  await expect(searchCard.getByRole("button", { name: "Run" })).toBeDisabled();
  await expect(searchCard).toContainText("Type a query before running the search.");

  // An empty family page says so explicitly (distinct from "Loading…").
  await page.getByRole("tab", { name: "NAVAIDs" }).click();
  await expect(page.locator(".browse-pager [aria-live]")).toContainText("No rows returned");
  await expect(page.locator(".browse-pager [aria-live]")).not.toContainText("Loading");
});
