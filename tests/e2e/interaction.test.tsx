import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../../apps/web/src/App.tsx";
import { installApiStub, type StubOptions } from "../fixtures/web-app.ts";

/**
 * Pointer-driven end-to-end interaction review (issue #16 automated
 * portion): search, duplicate selection, drawers, route data, comparison,
 * editing, error recovery, retries, and Map Only. Status announcements are
 * asserted through the live region so the same strings a screen reader
 * would announce are verified exactly.
 */

// window.confirm is not implemented by jsdom; restore any per-test spy on it.
afterEach(() => {
  vi.restoreAllMocks();
});

async function selectFixtureFlight(user: ReturnType<typeof userEvent.setup>) {
  const input = screen.getByRole("combobox", { name: "Flight number or code" });
  await user.type(input, "FIXTURE1");
  await user.keyboard("{Enter}");
  const listbox = await screen.findByRole("listbox", { name: "Choose an exact flight-plan match" });
  expect(listbox).toBeTruthy();
  await user.keyboard("{ArrowDown}{Enter}");
  await waitFor(() => expect(screen.getByRole("status").textContent).toContain("route options returned"));
}

describe("interaction review", () => {
  it("searches, disambiguates, opens the data drawer, and reads the leg table", async () => {
    installApiStub();
    const user = userEvent.setup();
    render(<App />);
    await selectFixtureFlight(user);

    await user.click(screen.getByRole("button", { name: "Data" }));
    const drawer = await screen.findByRole("region", { name: "Flight and route data" });
    const table = drawer.querySelector("table") as HTMLTableElement;
    expect(table.querySelectorAll("tr").length).toBe(3); // header + 2 legs
    const cells = Array.from(table.querySelectorAll("td, th")).map((cell) => cell.textContent?.trim());
    expect(cells).toContain("KOR1");
    expect(cells).toContain("240.5 NM");
    expect(cells).toContain("MIDPT");
  });

  it("selecting the unranked route updates the HUD and surfaces the gap", async () => {
    installApiStub();
    const user = userEvent.setup();
    render(<App />);
    await selectFixtureFlight(user);

    await user.click(screen.getByRole("button", { name: "Routes" }));
    await user.click(screen.getByRole("button", { name: /Recorded with unresolved gap/ }));
    await waitFor(() => expect(screen.getByText("Recorded with unresolved gap", { selector: ".map-hud strong" })).toBeTruthy());
    expect(screen.getByRole("status").textContent).toContain("Selected Recorded with unresolved gap.");

    await user.click(screen.getByRole("button", { name: "Data" }));
    const data = await screen.findByRole("region", { name: "Flight and route data" });
    expect(within(data).getByText("Unresolved gap")).toBeTruthy();
    expect(within(data).getByText("MIDPT could not be resolved to a single reference")).toBeTruthy();
  });

  it("draws every returned route on the map with alternates dimmed and moves the highlight on selection", async () => {
    installApiStub();
    const user = userEvent.setup();
    const { container } = render(<App />);
    await selectFixtureFlight(user);

    // The auto-selected Rank 1 route is highlighted and the other candidate
    // with geometry is drawn dimmed; the gap-only candidate has no geometry
    // and must not be drawn. The rail badge counts all returned options.
    expect(container.querySelectorAll(".route-path")).toHaveLength(1);
    expect(container.querySelectorAll(".route-path-alternate")).toHaveLength(1);
    expect(container.querySelector(".rail-count")?.textContent).toBe("3");
    expect(screen.getByRole("img", { name: /1 alternate recorded route shown dimmed/ })).toBeTruthy();

    // Choosing a different candidate moves the highlight without changing
    // how many lines are drawn.
    await user.click(screen.getByRole("button", { name: "Routes" }));
    await user.click(screen.getByRole("button", { name: /Recorded via alternate routing/ }));
    await waitFor(() => expect(screen.getByText("Recorded via alternate routing", { selector: ".map-hud strong" })).toBeTruthy());
    expect(container.querySelectorAll(".route-path")).toHaveLength(1);
    expect(container.querySelectorAll(".route-path-alternate")).toHaveLength(1);
    expect(screen.getByRole("img", { name: /1 alternate recorded route shown dimmed/ })).toBeTruthy();
  });

  it("edits a copy and sees the validated comparison metrics", async () => {
    installApiStub();
    const user = userEvent.setup();
    render(<App />);
    await selectFixtureFlight(user);

    await user.click(screen.getByRole("button", { name: "Edit copy" }));
    const editor = await screen.findByRole("region", { name: "Local route editor" });
    await waitFor(() => expect(within(editor).getByText("Draft status")).toBeTruthy());
    expect(screen.getByText("512.4 NM")).toBeTruthy();
    expect(screen.getByText("+0.0 NM")).toBeTruthy();
    expect(screen.getByText("Draft validation completed.")).toBeTruthy();

    const input = screen.getByRole("combobox", { name: "Add an exact reference point" });
    await user.type(input, "MIDPT");
    await user.keyboard("{Enter}");
    await screen.findByRole("listbox", { name: "Resolved reference-point search results" });
    await user.click(screen.getByRole("option", { name: /MIDPT/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Remove MIDPT" })).toBeTruthy());
  });

  it("shows search results as the user types without pressing Enter", async () => {
    installApiStub();
    const user = userEvent.setup();
    render(<App />);

    const input = screen.getByRole("combobox", { name: "Flight number or code" });
    await user.type(input, "FIXTURE1");
    // No Enter: the debounced type-ahead settles and opens the listbox.
    const listbox = await screen.findByRole("listbox", { name: "Choose an exact flight-plan match" }, { timeout: 2000 });
    expect(within(listbox).getAllByRole("option").length).toBe(2);
    // The live region never announced a per-keystroke "Searching" message.
    expect(screen.getByRole("status").textContent).not.toContain("Searching");
  });

  it("recovers from a failed search without reloading", async () => {
    const options: StubOptions = { failSearch: true };
    installApiStub(options);
    const user = userEvent.setup();
    render(<App />);

    const input = screen.getByRole("combobox", { name: "Flight number or code" });
    await user.type(input, "FIXTURE1");
    await user.keyboard("{Enter}");
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Search service unavailable (stub).");

    options.failSearch = false;
    await user.clear(input);
    await user.type(input, "FIXTURE1");
    await user.keyboard("{Enter}");
    await screen.findByRole("listbox", { name: "Choose an exact flight-plan match" });
    expect(screen.getAllByRole("option").length).toBe(2);
  });

  it("Clear session resets the workspace to its initial state", async () => {
    installApiStub();
    const user = userEvent.setup();
    render(<App />);
    await selectFixtureFlight(user);

    await user.click(screen.getByRole("button", { name: "Clear session" }));
    expect((screen.getByRole("combobox", { name: "Flight number or code" }) as HTMLInputElement).value).toBe("");
    expect(screen.getByText("Recorded routes appear after selection")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("Session reset.");
  });

  it("the freshness strip reports the live generation and refresh resets the session", async () => {
    installApiStub();
    const user = userEvent.setup();
    render(<App />);
    await selectFixtureFlight(user);

    // The merged generation strip announces the live tier through a chip and
    // offers a refresh action (jsdom has no window.confirm; accept the prompt).
    const chip = await screen.findByText((content) => content.startsWith("Live data fresh · retrieved"));
    expect(chip).toBeTruthy();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    await user.click(screen.getByRole("button", { name: "Refresh live data" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Live data refreshed."));

    expect((screen.getByRole("combobox", { name: "Flight number or code" }) as HTMLInputElement).value).toBe("");
    expect((screen.getByRole("button", { name: "Routes" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("Map Only hides the chrome and Restore controls returns with focus", async () => {
    installApiStub();
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "Map only" }));
    await waitFor(() => expect(screen.queryByRole("banner")).toBeNull());
    expect(screen.queryByRole("navigation", { name: "Route workspace controls" })).toBeNull();
    expect(screen.queryByText("Search for a recorded flight plan to begin.")).toBeNull();
    const restore = await screen.findByRole("button", { name: "Restore controls" });
    await waitFor(() => expect(document.activeElement).toBe(restore));

    await user.click(restore);
    await waitFor(() => expect(document.activeElement?.textContent).toBe("Map only"));
    expect(screen.getByRole("banner")).toBeTruthy();
  });

  it("the close button in each drawer returns focus to its rail trigger", async () => {
    installApiStub();
    const user = userEvent.setup();
    render(<App />);
    await selectFixtureFlight(user);

    const rail = screen.getByRole("navigation", { name: "Route workspace controls" });
    const cases = [
      { trigger: "Routes", drawer: "Route chooser", close: "Close" },
      { trigger: "Data", drawer: "Flight and route data", close: "Close" },
      { trigger: "Edit copy", drawer: "Local route editor", close: "Close draft" },
    ] as const;
    for (const { trigger, drawer, close } of cases) {
      await user.click(within(rail).getByRole("button", { name: trigger }));
      const surface = await screen.findByRole("region", { name: drawer });
      await user.click(within(surface).getByRole("button", { name: close }));
      await waitFor(() => expect(document.activeElement?.textContent).toBe(trigger), { timeout: 2000 });
    }
  });
});
