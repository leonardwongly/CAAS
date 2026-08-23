// Domain tag: R2-G2 — web UI state machines (jsdom/vitest lane), round-2
// adversarial gap fill 2026-08-23.
//
// Purpose: jsdom pins for the App.tsx behaviors introduced by commit ff0dad9
// ("honest empty-map and viewport copy, view-toggle indicator, zoom
// explanation, Escape closure, favicon") that previously had zero jsdom unit
// coverage — only the Playwright lane pinned them:
//   - useMediaQuery-driven "(min-width: 1280px)" copy switch (stub matchMedia;
//     jsdom ships no window.matchMedia at all, so every other jsdom suite
//     silently exercises only the narrow-copy branch),
//   - overviewFailed map-empty copy + Retry overview recovery state machine,
//   - aria-pressed honesty of the Map only / API data view toggles,
//   - the schematic-basemap zoom explanation (note + button titles).
//
// Does not duplicate:
//   - tests/browser/r2-d8-viewport-keyboard-copy-confusion.spec.ts (same
//     behaviors pinned in a real browser at real widths — layout/visual
//     concerns; this file pins the state machine with a stubbed media query),
//   - tests/e2e/map-tiles.test.tsx (base-map toggle aria-pressed sync and tile
//     fallback already pinned; here only the ff0dad9 zoom-note/titles are new),
//   - tests/e2e/interaction.test.tsx (Map Only chrome hiding / Restore controls
//     focus return already pinned; here only the strip-pages aria-pressed
//     matrix is new),
//   - tests/adversarial/sec-8.test.tsx (malformed timestamp rendering).
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../../apps/web/src/App.tsx";
import { installApiStub } from "../fixtures/web-app.ts";

/**
 * jsdom ships no window.matchMedia, so App's useMediaQuery currently falls
 * back to `false` in every other jsdom suite. This stub installs a
 * controllable MediaQueryList: per-query match state plus working
 * change-listener registration so the live viewport flip is observable.
 * "(prefers-reduced-motion: reduce)" defaults to true so DistanceTick renders
 * final values deterministically instead of animating via rAF.
 */
function installMatchMedia(initial: Record<string, boolean> = {}) {
  const state = new Map<string, boolean>([["(prefers-reduced-motion: reduce)", true], ...Object.entries(initial)]);
  const listeners = new Map<string, Set<() => void>>();
  const matchMedia = vi.fn((query: string) => ({
    get matches() {
      return state.get(query) ?? false;
    },
    media: query,
    onchange: null,
    addEventListener: (_type: "change", listener: () => void) => {
      const set = listeners.get(query) ?? new Set<() => void>();
      set.add(listener);
      listeners.set(query, set);
    },
    removeEventListener: (_type: "change", listener: () => void) => {
      listeners.get(query)?.delete(listener);
    },
    addListener: (listener: () => void) => {
      const set = listeners.get(query) ?? new Set<() => void>();
      set.add(listener);
      listeners.set(query, set);
    },
    removeListener: (listener: () => void) => {
      listeners.get(query)?.delete(listener);
    },
    dispatchEvent: () => false,
  }));
  vi.stubGlobal("matchMedia", matchMedia);
  return {
    matchMedia,
    setMatches(query: string, matches: boolean) {
      state.set(query, matches);
      for (const listener of listeners.get(query) ?? []) listener();
    },
  };
}

const WIDE_COPY = "Select a route from the map or list.";
const NARROW_COPY = "Select a route from the map.";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("R2-G2 ff0dad9 pins: viewport-dependent select-route copy", () => {
  it("a wide media query (>=1280px) renders the 'map or list' copy in both the toolbar and the map HUD", async () => {
    installMatchMedia({ "(min-width: 1280px)": true });
    installApiStub();
    render(<App />);

    await waitFor(() => expect(screen.getByText(`3 source flight records available. ${WIDE_COPY}`)).toBeTruthy());
    expect(screen.getByText(`Refreshed source data, not real-time tracking. ${WIDE_COPY}`)).toBeTruthy();
  });

  it("a narrow media query (<1280px) promises only the map, never the hidden manifest list", async () => {
    installMatchMedia({ "(min-width: 1280px)": false });
    installApiStub();
    render(<App />);

    await waitFor(() => expect(screen.getByText(`3 source flight records available. ${NARROW_COPY}`)).toBeTruthy());
    expect(screen.getByText(`Refreshed source data, not real-time tracking. ${NARROW_COPY}`)).toBeTruthy();
    expect(screen.queryByText(/or list/)).toBeNull();
  });

  it("without window.matchMedia (plain jsdom) the narrow copy renders and nothing crashes", async () => {
    installApiStub();
    render(<App />);

    await waitFor(() => expect(screen.getByText(`3 source flight records available. ${NARROW_COPY}`)).toBeTruthy());
  });

  it("a live media-query change flips the copy in place — the change listener is wired, no remount needed", async () => {
    const media = installMatchMedia({ "(min-width: 1280px)": false });
    installApiStub();
    render(<App />);

    await waitFor(() => expect(screen.getByText(`Refreshed source data, not real-time tracking. ${NARROW_COPY}`)).toBeTruthy());

    // The viewport crosses 1280px: the copy must follow without any remount,
    // in both the toolbar and the map HUD.
    media.setMatches("(min-width: 1280px)", true);
    await waitFor(() => expect(screen.getByText(`3 source flight records available. ${WIDE_COPY}`)).toBeTruthy());
    expect(screen.getByText(`Refreshed source data, not real-time tracking. ${WIDE_COPY}`)).toBeTruthy();

    // And back below the breakpoint.
    media.setMatches("(min-width: 1280px)", false);
    await waitFor(() => expect(screen.getByText(`Refreshed source data, not real-time tracking. ${NARROW_COPY}`)).toBeTruthy());
    expect(screen.queryByText(/or list/)).toBeNull();
  });
});

describe("R2-G2 ff0dad9 pins: honest empty-map copy when the overview fails", () => {
  it("an overview failure blames the overview, never a callsign filter the user never applied", async () => {
    installApiStub({ failOverview: true });
    render(<App />);

    // The flight list surfaces the structured error plus the recovery path.
    const notice = await screen.findByRole("alert");
    expect(notice.textContent).toContain("All-flight overview unavailable (stub).");
    expect(within(notice).getByRole("button", { name: "Retry overview" })).toBeTruthy();

    // The map empty state points at Retry overview, not the filter hint.
    expect(await screen.findByText("All-flight overview unavailable")).toBeTruthy();
    expect(screen.getByText("The all-flight overview could not be loaded. Use Retry overview in the flight list.")).toBeTruthy();
    expect(screen.queryByText("Clear the callsign filter or retry the all-flight overview.")).toBeNull();
    // The HUD shows the error in place of the reassuring overview copy — the
    // error string surfaces exactly twice: once in the list alert, once in the
    // map HUD span that otherwise promises "Refreshed source data…".
    expect(screen.getAllByText("All-flight overview unavailable (stub).")).toHaveLength(2);
    // The live status announces the failure.
    expect(screen.getByRole("status").textContent).toContain("The all-flight overview could not be loaded.");
  });

  it("an overview failure keeps the recovery copy even while a callsign filter is active", async () => {
    installApiStub({ failOverview: true });
    const user = userEvent.setup();
    render(<App />);

    await screen.findByText("All-flight overview unavailable");
    await user.type(screen.getByRole("combobox", { name: "Flight number or code" }), "ZZZ");
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("No flight plans matched ZZZ."));

    // The zero-result filter must not drag the failure state back to the
    // filter hint: the overview itself is still down.
    expect(screen.getByText("All-flight overview unavailable")).toBeTruthy();
    expect(screen.getByText("The all-flight overview could not be loaded. Use Retry overview in the flight list.")).toBeTruthy();
  });

  it("a genuine zero-result search (healthy overview) keeps the filter hint", async () => {
    installApiStub();
    const user = userEvent.setup();
    render(<App />);

    await screen.findByText("3 of 3 source route records shown");
    await user.type(screen.getByRole("combobox", { name: "Flight number or code" }), "ZZZ");
    await waitFor(() => expect(screen.getByText("No overview routes to display")).toBeTruthy());
    expect(screen.getByText("Clear the callsign filter or retry the all-flight overview.")).toBeTruthy();
    expect(screen.queryByText("All-flight overview unavailable")).toBeNull();
  });

  it("Retry overview drives the failure → success state machine (failOverview: once)", async () => {
    installApiStub({ failOverview: "once" });
    const user = userEvent.setup();
    render(<App />);

    const notice = await screen.findByRole("alert");
    expect(notice.textContent).toContain("All-flight overview unavailable (stub).");
    await user.click(within(notice).getByRole("button", { name: "Retry overview" }));

    // The retried overview resolves: routes, list, and map lines all return.
    await waitFor(() => expect(screen.getByText("3 of 3 source route records shown")).toBeTruthy());
    expect(screen.queryByText("All-flight overview unavailable")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("status").textContent).toContain("3 source flight records loaded");
  });
});

describe("R2-G2 ff0dad9 pins: view-toggle aria-pressed honesty", () => {
  it("Map only / API data expose aria-pressed that tracks the current page and map-only mode exactly", async () => {
    installApiStub();
    const user = userEvent.setup();
    render(<App />);
    const view = screen.getByRole("navigation", { name: "View" });

    const mapOnly = within(view).getByRole("button", { name: "Map only" });
    const apiData = within(view).getByRole("button", { name: "API data" });
    // Idle state: neither page is active, and Map only is armed on the map page.
    expect(mapOnly.getAttribute("aria-pressed")).toBe("false");
    expect(apiData.getAttribute("aria-pressed")).toBe("false");
    expect((mapOnly as HTMLButtonElement).disabled).toBe(false);

    // API data page: its toggle reads pressed, and Map only disarms.
    await user.click(apiData);
    await screen.findByRole("heading", { name: "API data" });
    expect(apiData.getAttribute("aria-pressed")).toBe("true");
    expect(mapOnly.getAttribute("aria-pressed")).toBe("false");
    expect((mapOnly as HTMLButtonElement).disabled).toBe(true);

    // Back to map: pressed state clears.
    await user.click(screen.getByRole("button", { name: "Back to map" }));
    await waitFor(() => expect(screen.queryByRole("heading", { name: "API data" })).toBeNull());
    expect(apiData.getAttribute("aria-pressed")).toBe("false");
    expect((mapOnly as HTMLButtonElement).disabled).toBe(false);

    // Map-only mode: the command strip (and the toggle itself) leaves the DOM
    // entirely with the chrome it hides — a detached button can never lie
    // about being pressed, and Restore controls returns it unpressed.
    await user.click(mapOnly);
    await screen.findByRole("button", { name: "Restore controls" });
    expect(screen.queryByRole("banner")).toBeNull();
    expect(screen.queryByRole("button", { name: "Map only" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Restore controls" }));
    await waitFor(() => expect(screen.getByRole("banner")).toBeTruthy());
    const restoredMapOnly = within(screen.getByRole("navigation", { name: "View" })).getByRole("button", { name: "Map only" });
    expect(restoredMapOnly.getAttribute("aria-pressed")).toBe("false");
    expect((restoredMapOnly as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("R2-G2 ff0dad9 pins: schematic basemap zoom explanation", () => {
  it("toggling the base map off disables zoom with a reason (titles + note); toggling back restores zoom", async () => {
    installApiStub();
    const user = userEvent.setup();
    render(<App />);

    const toggle = await screen.findByRole("button", { name: "Toggle base map" });
    const zoomIn = screen.getByRole("button", { name: "Zoom in" });
    const zoomOut = screen.getByRole("button", { name: "Zoom out" });

    // Tiles on: zoom is live and carries no excuse title or note.
    expect((zoomIn as HTMLButtonElement).disabled).toBe(false);
    expect((zoomOut as HTMLButtonElement).disabled).toBe(false);
    expect(zoomIn.getAttribute("title")).toBeNull();
    expect(screen.queryByText("Zoom & pan need the tiled base map")).toBeNull();

    // Tiles off (schematic): zoom disables and explains why, exactly once.
    await user.click(toggle);
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    expect((zoomIn as HTMLButtonElement).disabled).toBe(true);
    expect((zoomOut as HTMLButtonElement).disabled).toBe(true);
    expect(zoomIn.getAttribute("title")).toBe("Zoom is available on the tiled base map only");
    expect(zoomOut.getAttribute("title")).toBe("Zoom is available on the tiled base map only");
    expect(screen.getByText("Zoom & pan need the tiled base map")).toBeTruthy();
    expect(screen.getAllByText("Zoom & pan need the tiled base map")).toHaveLength(1);

    // Tiles back on: the note and titles disappear and zoom re-enables.
    await user.click(toggle);
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    await waitFor(() => expect((zoomIn as HTMLButtonElement).disabled).toBe(false));
    expect(zoomIn.getAttribute("title")).toBeNull();
    expect(screen.queryByText("Zoom & pan need the tiled base map")).toBeNull();
  });
});
