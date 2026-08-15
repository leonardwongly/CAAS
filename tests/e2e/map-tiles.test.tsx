import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../../apps/web/src/App.tsx";
import { installApiStub } from "../fixtures/web-app.ts";

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
  await waitFor(() => expect(screen.getByRole("status").textContent).toContain("route options returned"));
}

const tileImages = () => [...document.querySelectorAll<HTMLImageElement>('img[src^="https://tile.openstreetmap.org/"]')];

describe("map tiles", () => {
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
