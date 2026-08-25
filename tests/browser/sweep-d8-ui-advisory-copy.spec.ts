// Owner: D8 — briefing copy & flows (adversarial sweep 2026-08-23).
// Confused-user audit of the briefing copy: the advisory band must state its
// demonstration scope and expand to the full notice, the closed workbench
// must name controls that actually exist, and the overview toolbar must
// distinguish "still loading" from "loaded" (never the same static text).
import { expect, test, type Page } from "@playwright/test";

const TILE_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

const generation = {
  id: "d8-copy-generation",
  retrievedAt: "2026-08-16T00:00:00.000Z",
  live: { state: "fresh", retrievedAt: "2026-08-16T00:00:00.000Z", freshUntil: "2026-08-16T01:00:00.000Z", staleUntil: "2026-08-16T02:00:00.000Z" },
  reference: { state: "fresh", retrievedAt: "2026-08-16T00:00:00.000Z", freshUntil: "2026-08-17T00:00:00.000Z", staleUntil: "2026-08-18T00:00:00.000Z" },
  overall: "fresh",
};

const routes = [
  {
    id: "route-copy-1", flightId: "flight-copy-1", callsign: "BRIEF1", status: "complete", complete: true,
    label: "Recorded briefing fixture route", origin: "KOR1", destination: "KDS1", pointCount: 3,
    legs: [{ id: "leg-1", sequence: 1, kind: "direct", from: "KOR1", to: "KDS1", distanceNm: 512.4, status: "resolved" }],
    geometry: { type: "LineString", coordinates: [[-73, 40], [-90, 35], [-118, 33]] }, distanceNm: 512.4,
    provenance: "CAAS normalized live generation", gaps: [],
  },
];

async function installFixture(page: Page, overviewDelayMs = 0) {
  await page.route("**/api/**", async (routeRequest) => {
    const request = routeRequest.request();
    const url = new URL(request.url());
    const respond = (payload: unknown) => routeRequest.fulfill({ contentType: "application/json", body: JSON.stringify(payload) });
    if (url.pathname === "/api/v1/readiness") return respond({ status: "ready", generation });
    if (url.pathname === "/api/v1/routes/overview" && request.method() === "POST") {
      if (overviewDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, overviewDelayMs));
      return respond({ data: routes, generation, loaded: routes.length, total: routes.length });
    }
    if (url.pathname === "/api/v1/points/lookup" && request.method() === "POST") return respond({ matches: [] });
    return routeRequest.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: { code: "NOT_FOUND", message: "Fixture route not implemented." } }) });
  });
  await page.route(/^https:\/\/tile\.openstreetmap\.org\//, (tileRoute) => tileRoute.fulfill({ contentType: "image/png", body: TILE_PNG }));
}

test("the advisory band states the demonstration scope and expands to the full safety notice", async ({ page }) => {
  await installFixture(page);
  await page.goto("/");

  const band = page.locator(".advisory-band");
  await expect(band).toContainText("Demonstration only — not for filing, dispatch, or route advice.");
  // The expanded notice is not reachable content until the disclosure opens:
  // a collapsed <details> must hide the full text from a scanning reader.
  const notice = band.getByText("Demonstration only—not real-time operational tracking or route advice.");
  await expect(notice).toBeHidden();

  await band.getByText("Read advisory").click();
  await expect(notice).toBeVisible();
  await expect(band).toContainText("Operational weather, NOTAM, ATC, fuel, aircraft suitability, and regulatory constraints are not evaluated.");
});

test("the closed workbench names real controls and the toolbar distinguishes loading from loaded", async ({ page }) => {
  await installFixture(page, 700);
  await page.goto("/");

  // Empty-state copy must reference a control the user can actually find:
  // the rail button is "Explore variation", never a nonexistent "Draft".
  const emptyState = page.locator(".workbench-empty");
  await expect(emptyState).toContainText("Explore variation");
  await expect(emptyState).not.toContainText("or Draft");

  // While the overview is in flight the toolbar says so explicitly…
  const toolbar = page.locator(".toolbar-flight");
  await expect(toolbar).toContainText("Loading the all-flight overview…");
  // …and only flips to the settled count once records arrive.
  await expect(toolbar).toContainText("1 flight available. Search a flight number, or select a flight from the list, to see its route.", { timeout: 5000 });
});
