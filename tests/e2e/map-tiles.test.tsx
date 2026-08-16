import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../../apps/web/src/App.tsx";
import { installApiStub } from "../fixtures/web-app.ts";
import { coordinateFromScreen, fitViewToCoordinates, pixelFromView, tileRange, tileUrl, viewFromZoomAtPoint } from "../../apps/web/src/TileMap.tsx";

/**
 * OSM tile base layer contract (owner-authorized 2026-08-15, design legacy
 * §21 restored as normative evidence): tile URLs carry z/x/y only, tile
 * requests are no-referrer, attribution is preserved, the route overlay
 * renders on top of tiles, and a tile failure falls back to the schematic
 * base map with routes still drawn.
 */

afterEach(() => {
  vi.restoreAllMocks();
});

async function selectFixtureFlight(user: ReturnType<typeof userEvent.setup>) {
  const input = screen.getByRole("combobox", { name: "Flight number or code" });
  await user.type(input, "FIXTURE1");
  await user.keyboard("{Enter}");
  await screen.findByRole("listbox", { name: "Choose an exact flight-plan match" });
  await user.keyboard("{ArrowDown}{Enter}");
  await waitFor(() => expect(screen.getByRole("status").textContent).toContain("same-endpoint recorded routes returned for neutral comparison"));
}

const tileImages = () => [...document.querySelectorAll<HTMLImageElement>('img[src^="https://tile.openstreetmap.org/"]')];

describe("map tiles", () => {
  it("fits a selected route and endpoint pins into the viewport", () => {
    const size = { width: 1000, height: 600 };
    const view = fitViewToCoordinates([
      { lat: 4.2, lon: 73.5 }, // Velana / Maldives
      { lat: 1.35, lon: 103.99 }, // Singapore
    ], size);
    expect(view).toBeTruthy();
    const departure = pixelFromView({ lat: 4.2, lon: 73.5 }, view!, size);
    const arrival = pixelFromView({ lat: 1.35, lon: 103.99 }, view!, size);
    expect(departure.x).toBeGreaterThanOrEqual(96);
    expect(departure.x).toBeLessThanOrEqual(size.width - 96);
    expect(departure.y).toBeGreaterThanOrEqual(96);
    expect(departure.y).toBeLessThanOrEqual(size.height - 96);
    expect(arrival.x).toBeGreaterThanOrEqual(96);
    expect(arrival.x).toBeLessThanOrEqual(size.width - 96);
    expect(arrival.y).toBeGreaterThanOrEqual(96);
    expect(arrival.y).toBeLessThanOrEqual(size.height - 96);
    expect(view!.zoom).toBeGreaterThan(2);
  });

  it("keeps the cursor geographic anchor stable while zooming", () => {
    const size = { width: 1000, height: 600 };
    const view = { lat: 20, lon: 0, zoom: 2 };
    const cursor = { x: 760, y: 210 };
    const anchor = coordinateFromScreen(cursor, view, size);
    const zoomed = viewFromZoomAtPoint(cursor, view, 3, size);
    const projected = pixelFromView(anchor, zoomed, size);
    expect(zoomed.zoom).toBe(3);
    expect(projected.x).toBeCloseTo(cursor.x, 5);
    expect(projected.y).toBeCloseTo(cursor.y, 5);
  });

  it("repeats world columns to fill a frame wider than one low-zoom world", () => {
    const tiles = tileRange({ lat: 20, lon: 0, zoom: 2 }, { width: 1244, height: 500 });
    expect(tiles.some((tile) => tile.x < 0)).toBe(true);
    expect(tiles.some((tile) => tile.x >= 4)).toBe(true);
    expect(tileUrl({ x: 4, y: 1, z: 2 })).toBe("https://tile.openstreetmap.org/2/0/1.png");
  });

  it("loads z/x/y-only tile URLs with no-referrer and keeps the route overlay", async () => {
    installApiStub();
    const user = userEvent.setup();
    const { container } = render(<App />);

    // Tiles render immediately (default view); every URL is exactly
    // host/z/x/y.png — no query string, no callsign, no route state.
    const initialTiles = container.querySelectorAll<HTMLImageElement>('img[src^="https://tile.openstreetmap.org/"]');
    expect(initialTiles.length).toBeGreaterThan(0);
    for (const tile of initialTiles) {
      expect(tile.src).toMatch(/^https:\/\/tile\.openstreetmap\.org\/\d+\/\d+\/\d+\.png$/);
      expect(tile.getAttribute("referrerpolicy")).toBe("no-referrer");
      expect(tile.alt).toBe("");
    }
    expect(screen.getByText("© OpenStreetMap contributors")).toBeTruthy();
    expect(container.querySelector("iframe")).toBeNull();

    await selectFixtureFlight(user);
    // The route overlay still draws on top of the tiles: one highlighted
    // selected line and one dimmed alternate.
    expect(container.querySelectorAll(".route-path")).toHaveLength(1);
    expect(container.querySelectorAll(".route-path-alternate")).toHaveLength(1);
    expect(screen.getByRole("img", { name: /1 alternate recorded route shown dimmed/ })).toBeTruthy();
  });

  it("zoom changes the requested tile level and the overlay survives", async () => {
    installApiStub();
    const user = userEvent.setup();
    render(<App />);
    const zoomOf = (src: string) => Number(/^https:\/\/tile\.openstreetmap\.org\/(\d+)\//.exec(src)?.[1]);
    const before = tileImages()[0]?.src;
    expect(before).toBeTruthy();
    const zBefore = zoomOf(before!);

    await user.click(screen.getByRole("button", { name: "Zoom in" }));
    await waitFor(() => {
      const next = tileImages()[0]?.src;
      expect(next).toBeTruthy();
      expect(zoomOf(next!)).toBe(zBefore + 1);
    });

    await selectFixtureFlight(user);
    expect(document.querySelectorAll(".route-path")).toHaveLength(1);
  });

  it("wheel zoom steps one level per burst instead of slamming the range", async () => {
    installApiStub();
    render(<App />);
    const zoomOf = (src: string | undefined) => Number(/^https:\/\/tile\.openstreetmap\.org\/(\d+)\//.exec(src ?? "")?.[1]);
    const zBefore = zoomOf(tileImages()[0]?.src);
    expect(zBefore).toBeGreaterThan(0);

    // A single gesture fires many wheel events; only the first may zoom.
    const stage = document.querySelector(".map-stage");
    expect(stage).toBeTruthy();
    fireEvent.wheel(stage!, { deltaY: -100, clientX: 100, clientY: 100 });
    fireEvent.wheel(stage!, { deltaY: -100, clientX: 100, clientY: 100 });
    fireEvent.wheel(stage!, { deltaY: -100, clientX: 100, clientY: 100 });

    await waitFor(() => expect(zoomOf(tileImages()[0]?.src)).toBe(zBefore + 1));
    expect(zoomOf(tileImages()[0]?.src)).toBe(zBefore + 1);
  });

  it("falls back to the schematic base map when a tile fails, routes still drawn", async () => {
    installApiStub();
    const user = userEvent.setup();
    const { container } = render(<App />);

    const tile = container.querySelector<HTMLImageElement>('img[src^="https://tile.openstreetmap.org/"]');
    expect(tile).toBeTruthy();
    fireEvent.error(tile!);

    await waitFor(() => expect(container.querySelector(".world-ocean")).toBeTruthy());
    expect(tileImages()).toHaveLength(0);
    expect(screen.getByText("Schematic base map only")).toBeTruthy();
    // Zoom is inert in fallback mode; the toggle can re-enable tiles.
    expect((screen.getByRole("button", { name: "Zoom in" }) as HTMLButtonElement).disabled).toBe(true);

    await selectFixtureFlight(user);
    expect(container.querySelectorAll(".route-path")).toHaveLength(1);
  });

  it("toggles the base map without a tile failure and syncs aria-pressed", async () => {
    installApiStub();
    const user = userEvent.setup();
    const { container } = render(<App />);

    const toggle = screen.getByRole("button", { name: "Toggle base map" });
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    await user.click(toggle);
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    expect(container.querySelector(".world-ocean")).toBeTruthy();
    expect(tileImages()).toHaveLength(0);

    await user.click(toggle);
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(tileImages().length).toBeGreaterThan(0);
  });
});
