import { createRequire } from "node:module";
import { expect, test, type Page } from "@playwright/test";

const require = createRequire(import.meta.url);
const axePath = require.resolve("axe-core");
const safetyNotice = "Demonstration only. Operational weather, NOTAM, ATC, fuel, aircraft suitability, and regulatory constraints are not evaluated.";
const generation = {
  id: "browser-fixture-generation",
  retrievedAt: "2026-08-16T00:00:00.000Z",
  live: { state: "fresh", retrievedAt: "2026-08-16T00:00:00.000Z", freshUntil: "2026-08-16T01:00:00.000Z", staleUntil: "2026-08-16T02:00:00.000Z" },
  reference: { state: "fresh", retrievedAt: "2026-08-16T00:00:00.000Z", freshUntil: "2026-08-17T00:00:00.000Z", staleUntil: "2026-08-18T00:00:00.000Z" },
  overall: "fresh",
};
const routes = [
  {
    id: "route-browser-1", flightId: "flight-browser-1", callsign: "BROWSER1", status: "complete", complete: true,
    label: "Recorded browser fixture route", origin: "KOR1", destination: "KDS1", pointCount: 3,
    legs: [
      { id: "leg-1", sequence: 1, kind: "direct", from: "KOR1", to: "MIDPT", distanceNm: 240.5, status: "resolved" },
      { id: "leg-2", sequence: 2, kind: "direct", from: "MIDPT", to: "KDS1", distanceNm: 271.9, status: "resolved" },
    ],
    geometry: { type: "LineString", coordinates: [[-73, 40], [-90, 35], [-118, 33]] }, distanceNm: 512.4,
    provenance: "CAAS normalized live generation", gaps: [],
  },
  {
    id: "route-browser-2", flightId: "flight-browser-2", callsign: "BROWSER2", status: "complete", complete: true,
    label: "Recorded browser alternate route", origin: "KOR1", destination: "KDS1", pointCount: 3,
    legs: [], geometry: { type: "LineString", coordinates: [[-73, 40], [-86, 39], [-118, 33]] }, distanceNm: 534.1,
    provenance: "CAAS normalized live generation", gaps: [],
  },
];

async function installSameOriginFixture(page: Page) {
  const calls: Array<{ url: string; method: string; body: string }> = [];
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const body = request.postData() ?? "";
    calls.push({ url: request.url(), method: request.method(), body });
    const respond = (payload: unknown) => route.fulfill({ contentType: "application/json", body: JSON.stringify(payload) });
    if (url.pathname === "/api/v1/readiness") return respond({ status: "ready", generation });
    if (url.pathname === "/api/v1/routes/overview" && request.method() === "POST") return respond({ data: routes, generation, loaded: routes.length, total: routes.length });
    if (url.pathname === "/api/v1/callsigns/search" && request.method() === "POST") return respond({ data: [{ id: "flight-browser-1", flightId: "flight-browser-1", callsign: "BROWSER1", departure: "KOR1", destination: "KDS1", routePointCount: 3 }] });
    if (url.pathname === "/api/v1/routes/options" && request.method() === "POST") return respond({ data: routes, generation });
    return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: { code: "NOT_FOUND", message: "Fixture route not implemented." } }) });
  });
  return calls;
}

test("loads the complete overview, keeps API calls same-origin, and selects a route", async ({ page, baseURL }) => {
  const calls = await installSameOriginFixture(page);
  await page.goto("/");

  const safetyBanner = page.locator(".safety-banner");
  await expect(safetyBanner).toContainText("Demonstration only");
  await expect(safetyBanner).toContainText("Operational weather, NOTAM, ATC, fuel, aircraft suitability, and regulatory constraints are not evaluated.");
  await expect(page.getByRole("region", { name: "Full flight list" })).toBeVisible();
  await expect(page.getByText("2 of 2 routes shown")).toBeVisible();

  await page.getByRole("combobox", { name: "Flight number or code" }).fill("BROWSER1");
  await page.keyboard.press("Enter");
  await page.getByRole("option", { name: /BROWSER1/ }).click();
  await expect(page.getByText("Recorded browser fixture route", { exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Route legs" })).toContainText("240.5 NM");

  const origin = new URL(baseURL!).origin;
  expect(calls.length).toBeGreaterThanOrEqual(4);
  for (const call of calls) expect(new URL(call.url).origin).toBe(origin);
  const search = calls.find((call) => call.url.endsWith("/api/v1/callsigns/search"));
  expect(search).toBeDefined();
  expect(search?.method).toBe("POST");
  expect(search?.body).toContain("BROWSER1");
  expect(search?.url).not.toContain("BROWSER1");
});

test("critical map surface has no WCAG A/AA axe violations", async ({ page }) => {
  await installSameOriginFixture(page);
  await page.goto("/");
  await expect(page.getByRole("region", { name: "Full flight list" })).toBeVisible();
  await page.addScriptTag({ path: axePath });
  const violations = await page.evaluate(async () => {
    const axe = (window as unknown as Window & { axe: { run: (node: Node, options: unknown) => Promise<{ violations: Array<{ id: string; impact: string | null }> }> } }).axe;
    return (await axe.run(document.body, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] } })).violations;
  });
  expect(violations).toEqual([]);
});
