// D8 — post-review regression: stale drag release.
// Pan capture was deferred from pointerdown to the first ≥3px move, so a
// press that moved <3px and released OUTSIDE the stage never delivered
// pointerup to the stage. The stale drag anchor then turned a later
// buttonless hover into a live pan (viewport snap + capture). A sub-
// threshold press released outside the stage must leave the map inert, and
// a real drag afterwards must still pan. sweep-d7-map-pan-disambiguation
// pins the threshold/capture/release behaviors this spec builds on.
import { expect, test, type Page } from "@playwright/test";

const TILE_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

const generation = {
  id: "sweep-d8-stale-release-generation",
  retrievedAt: "2026-08-16T00:00:00.000Z",
  live: { state: "fresh", retrievedAt: "2026-08-16T00:00:00.000Z", freshUntil: "2026-08-16T01:00:00.000Z", staleUntil: "2026-08-16T02:00:00.000Z" },
  reference: { state: "fresh", retrievedAt: "2026-08-16T00:00:00.000Z", freshUntil: "2026-08-17T00:00:00.000Z", staleUntil: "2026-08-18T00:00:00.000Z" },
  overall: "fresh",
};

const route = {
  id: "route-d8-stale", flightId: "flight-d8-stale", callsign: "D8STL1", status: "complete", complete: true,
  label: "D8 stale release route", origin: "KOR1", destination: "KDS1", pointCount: 3,
  legs: [{ id: "leg-1", sequence: 1, kind: "direct", from: "KOR1", to: "KDS1", distanceNm: 512.4, status: "resolved" }],
  geometry: { type: "LineString", coordinates: [[-73, 40], [-90, 35], [-118, 33]] }, distanceNm: 512.4,
  provenance: "CAAS normalized live generation", gaps: [],
};

async function installFixture(page: Page) {
  await page.route("**/api/**", async (routeRequest) => {
    const request = routeRequest.request();
    const url = new URL(request.url());
    const respond = (payload: unknown) => routeRequest.fulfill({ contentType: "application/json", body: JSON.stringify(payload) });
    if (url.pathname === "/api/v1/readiness") return respond({ status: "ready", generation });
    if (url.pathname === "/api/v1/routes/overview" && request.method() === "POST") return respond({ data: [route], generation, loaded: 1, total: 1 });
    if (url.pathname === "/api/v1/points/lookup" && request.method() === "POST") return respond({ matches: [], truncated: false });
    return routeRequest.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: { code: "NOT_FOUND", message: "Fixture route not implemented." } }) });
  });
  await page.route(/^https:\/\/tile\.openstreetmap\.org\//, (tileRoute) => tileRoute.fulfill({ contentType: "image/png", body: TILE_PNG }));
}

const tileImgs = (page: Page) => page.locator('img[src^="https://tile.openstreetmap.org/"]');

/** Src + inline placement of the first tile: a viewport fingerprint that also
 *  catches pans that keep the same tile coordinates. */
async function tileFingerprint(page: Page): Promise<string> {
  return (await tileImgs(page).first().evaluate((img: HTMLImageElement) => `${img.getAttribute("src") ?? ""}|${img.style.left}|${img.style.top}`)) ?? "";
}

test("a sub-threshold press released outside the stage never becomes a hover pan", async ({ page }) => {
  await installFixture(page);
  await page.goto("/");
  const stage = page.locator(".map-stage");
  await expect(stage).toBeVisible();
  await expect(tileImgs(page).first()).toBeVisible();
  const box = await stage.boundingBox();
  if (!box) throw new Error("Stage bounding box unavailable.");

  // Count capture acquisitions on the stage: the stale gesture must never
  // arm one, and hover must not fire one either.
  await stage.evaluate((element) => {
    (element as HTMLElement & { __captures?: number }).__captures = 0;
    element.addEventListener("gotpointercapture", () => {
      (element as HTMLElement & { __captures?: number }).__captures! += 1;
    });
  });
  const captureCount = () => stage.evaluate((element) => (element as HTMLElement & { __captures?: number }).__captures ?? -1);

  // Press 1px inside the left edge (left-center is clear of every chrome
  // overlay), jitter 2px outward — under the 3px drag threshold — and
  // release over the flight manifest beside the stage.
  const press = { x: box.x + 1, y: box.y + box.height * 0.5 };
  const release = { x: box.x - 1, y: press.y };
  const pressHost = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest(".map-stage")?.className ?? "none", press);
  expect(pressHost, "the press must land on the map stage").toContain("map-stage");
  const pressTag = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.tagName ?? "none", press);
  expect(pressTag, "the press must land on the map surface, not a control").not.toBe("BUTTON");
  expect(pressTag, "the press must land on the map surface, not a control").not.toBe("A");
  const releaseOnStage = await page.evaluate(({ x, y }) => Boolean(document.elementFromPoint(x, y)?.closest(".map-stage")), release);
  expect(releaseOnStage, "the release must land outside the stage").toBe(false);

  const before = await tileFingerprint(page);
  await page.mouse.move(press.x, press.y);
  await page.mouse.down();
  await page.mouse.move(release.x, release.y); // 2px: stays under the drag threshold
  await page.mouse.up(); // released outside: pointerup never reaches the stage

  // Bare hover across the map afterwards: nothing may move, no capture.
  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.4);
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.6, { steps: 10 });
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.5, { steps: 8 });
  await page.waitForTimeout(250);
  expect(await tileFingerprint(page), "hover after a stale release must not pan").toBe(before);
  expect(await captureCount(), "no pointer capture may fire from hover").toBe(0);

  // A real drag afterwards still pans: the state was cleared, not wedged.
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
  await page.mouse.down();
  for (let i = 1; i <= 4; i += 1) await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5 + i * 30);
  await page.mouse.up();
  await expect.poll(async () => await tileFingerprint(page)).not.toBe(before);
});
