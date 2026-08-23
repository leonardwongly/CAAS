// Owner: D8 — briefing copy & flows (adversarial sweep 2026-08-23).
// Drawer/flow state and keyboard dead-ends in the real browser: closing the
// synthesis drawer must return focus to its rail trigger (every other surface
// already does), "Choose another" must not strand focus on a removed button,
// and the overlap chooser dialog must receive focus and dismiss with Escape.
import { expect, test, type Page } from "@playwright/test";

const TILE_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

const generation = {
  id: "d8-focus-generation",
  retrievedAt: "2026-08-16T00:00:00.000Z",
  live: { state: "fresh", retrievedAt: "2026-08-16T00:00:00.000Z", freshUntil: "2026-08-16T01:00:00.000Z", staleUntil: "2026-08-16T02:00:00.000Z" },
  reference: { state: "fresh", retrievedAt: "2026-08-16T00:00:00.000Z", freshUntil: "2026-08-17T00:00:00.000Z", staleUntil: "2026-08-18T00:00:00.000Z" },
  overall: "fresh",
};

const completeRoute = {
  id: "route-focus-1", flightId: "flight-focus-1", callsign: "FOCUS1", status: "complete", complete: true,
  label: "Recorded focus fixture route", origin: "KOR1", destination: "KDS1", pointCount: 3,
  legs: [{ id: "leg-1", sequence: 1, kind: "direct", from: "KOR1", to: "KDS1", distanceNm: 512.4, status: "resolved" }],
  geometry: { type: "LineString", coordinates: [[-73, 40], [-90, 35], [-118, 33]] }, distanceNm: 512.4,
  provenance: "CAAS normalized live generation", gaps: [],
};

const gapRoute = {
  id: "route-focus-2", flightId: "flight-focus-2", callsign: "FOCUSGAP", status: "incomplete", complete: false,
  label: "Recorded focus route with a gap", origin: "KOR1", destination: "KDS1", pointCount: 2,
  legs: [{ id: "leg-1", sequence: 1, kind: "gap", status: "gap", reason: "Reference could not be resolved" }],
  geometry: { type: "LineString", coordinates: [[-73, 40], [-90, 35]] },
  provenance: "CAAS normalized live generation",
  gaps: [{ sequence: 1, status: "gap", reason: "Reference could not be resolved" }],
};

const activeElementText = (page: Page) => page.evaluate(() => document.activeElement?.textContent?.trim() ?? "");
const activeElementId = (page: Page) => page.evaluate(() => document.activeElement?.id ?? "");

async function installSynthesisFixture(page: Page) {
  await page.route("**/api/**", async (routeRequest) => {
    const request = routeRequest.request();
    const url = new URL(request.url());
    const respond = (payload: unknown) => routeRequest.fulfill({ contentType: "application/json", body: JSON.stringify(payload) });
    if (url.pathname === "/api/v1/readiness") return respond({ status: "ready", generation });
    if (url.pathname === "/api/v1/routes/overview" && request.method() === "POST") return respond({ data: [completeRoute, gapRoute], generation, loaded: 2, total: 2 });
    if (url.pathname === "/api/v1/routes/synthesis" && request.method() === "POST") return respond({ status: "unavailable", corridorCount: 1, corridorsCovered: 0, candidates: [] });
    if (url.pathname === "/api/v1/points/lookup" && request.method() === "POST") return respond({ matches: [] });
    return routeRequest.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: { code: "NOT_FOUND", message: "Fixture route not implemented." } }) });
  });
  await page.route(/^https:\/\/tile\.openstreetmap\.org\//, (tileRoute) => tileRoute.fulfill({ contentType: "image/png", body: TILE_PNG }));
}

test("closing the synthesis drawer returns focus to the Synthesis rail trigger", async ({ page }) => {
  await installSynthesisFixture(page);
  await page.goto("/");

  await page.getByRole("button", { name: "Show observed-donor synthesis" }).click();
  const drawer = page.getByRole("region", { name: "Observed-donor synthesis" });
  await drawer.getByRole("button", { name: /FOCUSGAP/ }).click();
  await expect(drawer).toContainText("No other recorded route in this generation contains the missing directed subpath.");

  await drawer.getByRole("button", { name: "Close" }).click();
  // Focus must land back on the rail trigger, not fall to the document body.
  await expect.poll(() => activeElementText(page)).toBe("Synthesis");

  // Re-open: the drawer resumes the previous synthesis result (no refetch,
  // no stale chooser state), and "Choose another" must not strand focus on
  // the button it unmounts — the chooser heading takes it.
  await page.getByRole("button", { name: "Synthesis", exact: true }).click();
  await expect(drawer).toContainText("Synthesis result");
  await expect(drawer).toContainText("No other recorded route in this generation contains the missing directed subpath.");
  await drawer.getByRole("button", { name: "Choose another" }).click();
  await expect.poll(() => activeElementId(page)).toBe("synthesis-heading");
  await expect(drawer).toContainText("Choose a source route with gaps");
});

test("the overlap chooser receives focus on open and dismisses with Escape", async ({ page }, testInfo) => {
  // Two complete routes with identical geometry overlap exactly; clicking the
  // shared line opens the disambiguation dialog instead of selecting.
  const overlapping = [
    { ...completeRoute, id: "route-overlap-1", flightId: "flight-overlap-1", callsign: "OVERLAP1", label: "Overlap option one" },
    { ...completeRoute, id: "route-overlap-2", flightId: "flight-overlap-2", callsign: "OVERLAP2", label: "Overlap option two" },
  ];
  await page.route("**/api/**", async (routeRequest) => {
    const request = routeRequest.request();
    const url = new URL(request.url());
    const respond = (payload: unknown) => routeRequest.fulfill({ contentType: "application/json", body: JSON.stringify(payload) });
    if (url.pathname === "/api/v1/readiness") return respond({ status: "ready", generation });
    if (url.pathname === "/api/v1/routes/overview" && request.method() === "POST") return respond({ data: overlapping, generation, loaded: 2, total: 2 });
    if (url.pathname === "/api/v1/routes/options" && request.method() === "POST") return respond({ data: overlapping, generation });
    if (url.pathname === "/api/v1/points/lookup" && request.method() === "POST") return respond({ matches: [] });
    return routeRequest.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: { code: "NOT_FOUND", message: "Fixture route not implemented." } }) });
  });
  await page.route(/^https:\/\/tile\.openstreetmap\.org\//, (tileRoute) => tileRoute.fulfill({ contentType: "image/png", body: TILE_PNG }));
  await page.goto("/");

  await expect(page.locator(".route-hit")).toHaveCount(2);
  // The identical geometries stack; the last path in paint order is topmost at
  // the click point, so it is the one a real pointer would hit.
  await page.locator(".route-hit").last().click();

  const dialog = page.getByRole("dialog", { name: "Choose an overlapping recorded flight" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("2 routes overlap here");
  // The dialog opened from an SVG click: focus must move into it (onto Close,
  // the first focusable control) so a keyboard-only user is not left staring
  // at an unreachable popup.
  await expect.poll(() => activeElementText(page)).toBe("Close");

  // Escape dismisses it, and focus returns to a stable map anchor instead of
  // being dropped onto the body when the focused button unmounts.
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => activeElementId(page)).toBe("map-heading");

  // Re-open and choose a route with the keyboard. Chromium walks Close →
  // candidate with Tab; headless webkit only tabs into form fields (engine
  // limitation), so there the candidate is focused directly — in both cases
  // Enter on the focused option commits the selection.
  await page.locator(".route-hit").last().click();
  await expect(dialog).toBeVisible();
  await expect.poll(() => activeElementText(page)).toBe("Close");
  const firstOption = dialog.getByRole("button", { name: /OVERLAP1/ });
  if (testInfo.project.name === "webkit") {
    await firstOption.focus();
  } else {
    await page.keyboard.press("Tab");
    await expect.poll(() => activeElementText(page)).toBe("OVERLAP1KOR1 → KDS1");
  }
  await page.keyboard.press("Enter");
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(".map-hud")).toContainText("Overlap option");
});
