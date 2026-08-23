// Owner: D7 — map & spatial UX (adversarial sweep 2026-08-23).
// Overlap-chooser hit-target hardening: when two recorded routes overlap, the
// chooser must be dismissible without a selection, every option must be
// keyboard-reachable with a visible focus indicator, and on narrow stages the
// centred chooser must not steal pointer hits from the zoom controls.
import { expect, test, type Page } from "@playwright/test";

const TILE_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

const generation = {
  id: "sweep-d7-overlap-generation",
  retrievedAt: "2026-08-16T00:00:00.000Z",
  live: { state: "fresh", retrievedAt: "2026-08-16T00:00:00.000Z", freshUntil: "2026-08-16T01:00:00.000Z", staleUntil: "2026-08-16T02:00:00.000Z" },
  reference: { state: "fresh", retrievedAt: "2026-08-16T00:00:00.000Z", freshUntil: "2026-08-17T00:00:00.000Z", staleUntil: "2026-08-18T00:00:00.000Z" },
  overall: "fresh",
};

// Two complete records with byte-identical geometry: their projected hit
// paths carry the same signature, so clicking the shared line opens the
// overlap chooser instead of selecting silently.
const makeRoute = (suffix: string) => ({
  id: `route-d7-overlap-${suffix}`, flightId: `flight-d7-overlap-${suffix}`, callsign: `D7OVL${suffix}`, status: "complete", complete: true,
  label: `D7 overlap route ${suffix}`, origin: "KOR1", destination: "KDS1", pointCount: 3,
  legs: [{ id: `leg-${suffix}`, sequence: 1, kind: "direct", from: "KOR1", to: "KDS1", distanceNm: 512.4, status: "resolved" }],
  geometry: { type: "LineString", coordinates: [[-73, 40], [-90, 35], [-118, 33]] }, distanceNm: 512.4,
  provenance: "CAAS normalized live generation", gaps: [],
});
const routes = [makeRoute("A"), makeRoute("B")];

async function installFixture(page: Page) {
  await page.route("**/api/**", async (routeRequest) => {
    const request = routeRequest.request();
    const url = new URL(request.url());
    const respond = (payload: unknown) => routeRequest.fulfill({ contentType: "application/json", body: JSON.stringify(payload) });
    if (url.pathname === "/api/v1/readiness") return respond({ status: "ready", generation });
    if (url.pathname === "/api/v1/routes/overview" && request.method() === "POST") return respond({ data: routes, generation, loaded: 2, total: 2 });
    if (url.pathname === "/api/v1/points/lookup" && request.method() === "POST") return respond({ matches: [], truncated: false });
    return routeRequest.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: { code: "NOT_FOUND", message: "Fixture route not implemented." } }) });
  });
  await page.route(/^https:\/\/tile\.openstreetmap\.org\//, (tileRoute) => tileRoute.fulfill({ contentType: "image/png", body: TILE_PNG }));
}

const tileImgs = (page: Page) => page.locator('img[src^="https://tile.openstreetmap.org/"]');

/** Real-pointer click on the shared route line at the segment-1 midpoint.
 *  The topmost hit path (`.last()`) is clicked: both records project to the
 *  same line, so the first path in DOM order sits under its twin and
 *  Playwright's hit-testing would refuse to target it directly. */
async function clickOverlappingRoute(page: Page) {
  await expect(tileImgs(page).first()).toBeVisible();
  const hit = page.locator("path.route-hit").last();
  await expect(hit).toBeVisible();
  const box = await hit.boundingBox();
  if (!box) throw new Error("Route hit bounding box unavailable.");
  // Midpoint of the first geometry segment in projected bbox space.
  await hit.click({ position: { x: box.width * 0.811, y: box.height * 0.365 } });
  await expect(page.locator(".map-overlap-chooser")).toBeVisible();
  await expect(page.locator(".map-overlap-chooser")).toContainText("2 routes overlap here");
}

test("closing the chooser selects nothing and the map stays pannable", async ({ page }) => {
  await installFixture(page);
  await page.goto("/");
  await clickOverlappingRoute(page);

  // A confused user changes their mind: Close dismisses without a selection.
  await page.locator(".map-overlap-chooser button", { hasText: "Close" }).click();
  await expect(page.locator(".map-overlap-chooser")).toHaveCount(0);
  await expect(page.locator(".map-hud")).toContainText("2 of 2 source route records shown");

  const box = await page.locator(".map-stage").boundingBox();
  if (!box) throw new Error("Stage bounding box unavailable.");
  const before = await tileImgs(page).first().getAttribute("src");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 4; i += 1) await page.mouse.move(box.x + box.width / 2 + i * 40, box.y + box.height / 2);
  await page.mouse.up();
  await expect.poll(async () => await tileImgs(page).first().getAttribute("src")).not.toBe(before);
});

test("every chooser option is keyboard-reachable with a visible focus indicator", async ({ page, browserName }, testInfo) => {
  await installFixture(page);
  await page.goto("/");
  await clickOverlappingRoute(page);
  const chooser = page.locator(".map-overlap-chooser");

  // The chooser opens from an unfocusable SVG hit line: focus must move into
  // the dialog (onto Close) so keyboard users are not stranded.
  await expect.poll(() => page.evaluate(() => {
    const element = document.activeElement;
    return element instanceof HTMLElement && element.closest(".map-overlap-chooser") ? element.textContent ?? "" : "";
  })).toContain("Close");

  // macOS WebKit honours the system "keyboard navigation" preference and Tab
  // only cycles text fields there (verified with a two-button minimal page on
  // this runner): Tab-driven traversal is untestable on that combination.
  // There the keyboard path is exercised via Enter on the auto-focused Close
  // button instead; every other engine runs the full Tab traversal.
  const tabTraversalBlocked = browserName === "webkit" && process.platform === "darwin";
  if (tabTraversalBlocked) {
    await page.keyboard.press("Enter");
    await expect(chooser).toHaveCount(0);
    testInfo.annotations.push({ type: "note", description: "Tab traversal skipped: macOS WebKit tab order excludes buttons/links." });
    return;
  }

  // Leave the chooser and re-enter with the keyboard so every focus indicator
  // below is driven by real keyboard navigation (:focus-visible).
  await page.keyboard.press("Shift+Tab");
  const focusInfo = () => page.evaluate(() => {
    const element = document.activeElement;
    if (!(element instanceof HTMLElement)) return undefined;
    const styles = getComputedStyle(element);
    return { text: element.textContent ?? "", inChooser: Boolean(element.closest(".map-overlap-chooser")), outlineStyle: styles.outlineStyle, outlineColor: styles.outlineColor };
  });
  const visited: string[] = [];
  // Focus can leave the dialog mid-traversal (the SVG hit line is not
  // focusable, so Tab order re-enters it); record only in-chooser stops and
  // keep tabbing until the last option has been visited.
  for (let step = 0; step < 12; step += 1) {
    await page.keyboard.press("Tab");
    const info = await focusInfo();
    if (!info) break;
    if (!info.inChooser) continue;
    visited.push(info.text);
    expect(info.outlineStyle, `focus outline style on "${info.text.trim()}"`).not.toBe("none");
    expect(info.outlineColor, `focus outline color on "${info.text.trim()}"`).not.toBe("transparent");
    if (info.text.includes("D7OVLB")) break;
  }
  const visitedDigest = () => JSON.stringify(visited.map((text) => text.trim().slice(0, 24)));
  expect(visited.some((text) => text.includes("Close")), `Close button reachable by Tab (visited ${visitedDigest()})`).toBe(true);
  expect(visited.some((text) => text.includes("D7OVLA")), `first route option reachable by Tab (visited ${visitedDigest()})`).toBe(true);
  expect(visited.some((text) => text.includes("D7OVLB")), `second route option reachable by Tab (visited ${visitedDigest()})`).toBe(true);

  // Step back to the first route option and activate it with Enter.
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Enter");
  await expect(chooser).toHaveCount(0);
  await expect(page.locator(".map-hud")).toContainText("D7 overlap route A");
});

test("Escape dismisses the chooser without selecting a route", async ({ page }) => {
  await installFixture(page);
  await page.goto("/");
  await clickOverlappingRoute(page);
  await expect(page.locator(".map-overlap-chooser")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".map-overlap-chooser")).toHaveCount(0);
  await expect(page.locator(".map-hud")).toContainText("2 of 2 source route records shown");
});

test("zoom controls keep their pointer hit targets under the chooser on narrow stages", async ({ page }) => {
  await page.setViewportSize({ width: 420, height: 700 });
  await installFixture(page);
  await page.goto("/");
  await expect(tileImgs(page).first()).toBeVisible();

  // At this width the fixture route projects left of the visible stage; pan
  // it into view before clicking the shared line.
  const stageBox = await page.locator(".map-stage").boundingBox();
  if (!stageBox) throw new Error("Stage bounding box unavailable.");
  await page.mouse.move(stageBox.x + stageBox.width / 2, stageBox.y + stageBox.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 5; i += 1) await page.mouse.move(stageBox.x + stageBox.width / 2 + i * 50, stageBox.y + stageBox.height / 2);
  await page.mouse.up();

  await clickOverlappingRoute(page);

  const zoomIn = page.getByRole("button", { name: "Zoom in" });
  const chooser = page.locator(".map-overlap-chooser");
  const zoomBox = await zoomIn.boundingBox();
  const chooserBox = await chooser.boundingBox();
  if (!zoomBox || !chooserBox) throw new Error("Bounding box unavailable.");
  // Precondition: the centred chooser really does cover the zoom stack at
  // this width, so the hit-target assertion below is load-bearing.
  const overlaps = zoomBox.x < chooserBox.x + chooserBox.width && chooserBox.x < zoomBox.x + zoomBox.width &&
    zoomBox.y < chooserBox.y + chooserBox.height && chooserBox.y < zoomBox.y + zoomBox.height;
  expect(overlaps, "expected the chooser to cover the zoom stack at 420px").toBe(true);

  // The control must still resolve to itself at its centre.
  const hit = await page.evaluate(({ x, y }) => {
    const element = document.elementFromPoint(x, y);
    return element ? `${element.tagName}:${(element as HTMLElement).getAttribute("aria-label") ?? element.textContent?.trim().slice(0, 20)}` : "none";
  }, { x: zoomBox.x + zoomBox.width / 2, y: zoomBox.y + zoomBox.height / 2 });
  expect(hit).toContain("BUTTON");
  expect(hit).toContain("Zoom in");
});
