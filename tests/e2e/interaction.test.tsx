import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
  await waitFor(() => expect(screen.getByRole("status").textContent).toContain("same-endpoint recorded routes returned"));
}

describe("interaction review", () => {
  it("lets the user show and select among computed alternates", async () => {
    installApiStub();
    const user = userEvent.setup();
    render(<App />);
    await selectFixtureFlight(user);

    await user.click(screen.getByRole("button", { name: "Show alternates" }));
    const group = await screen.findByRole("group", { name: "Alternate routes" });
    const options = within(group).getAllByRole("button");
    expect(options).toHaveLength(2);
    expect(options[0]!.textContent).toContain("Direct (great-circle) alternate");
    expect(options[1]!.textContent).toContain("Via MIDPT (great-circle)");
    expect(options[0]!.getAttribute("aria-pressed")).toBe("true");

    await user.click(options[1]!);
    expect(options[1]!.getAttribute("aria-pressed")).toBe("true");
    expect(options[0]!.getAttribute("aria-pressed")).toBe("false");
    await waitFor(() => expect(screen.getByLabelText(/Selected alternate distance/).textContent).toContain("2300"));

    await user.click(screen.getByRole("button", { name: "Hide alternates" }));
    await waitFor(() => expect(screen.queryByRole("group", { name: "Alternate routes" })).toBeNull());
  });

  it("keeps the expanded left-side leg table visible while route details open", async () => {
    installApiStub();
    const user = userEvent.setup();
    render(<App />);
    await selectFixtureFlight(user);

    const panel = await screen.findByRole("region", { name: "Route legs" });
    const table = panel.querySelector("table") as HTMLTableElement;
    expect(table.querySelectorAll("tr").length).toBe(3); // header + 2 legs
    const cells = Array.from(table.querySelectorAll("td, th")).map((cell) => cell.textContent?.trim());
    expect(cells).toContain("KOR1");
    expect(cells).toContain("240.5 NM");
    expect(cells).toContain("MIDPT");

    await user.click(screen.getByRole("button", { name: "Data" }));
    expect(await screen.findByRole("region", { name: "Flight and route data" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Route legs" })).toBeTruthy();
  });

  it("shows only complete route options", async () => {
    installApiStub();
    const user = userEvent.setup();
    render(<App />);
    await selectFixtureFlight(user);

    await user.click(screen.getByRole("button", { name: "Routes" }));
    expect(screen.getByRole("heading", { name: "Complete recorded route options" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Recorded via MIDPT/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Recorded via alternate routing/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Recorded with unresolved gap/ })).toBeNull();
    expect(screen.queryByText("Recorded routes with visible gaps")).toBeNull();
  });

  it("draws every returned route on the map with alternates dimmed and moves the highlight on selection", async () => {
    installApiStub();
    const user = userEvent.setup();
    const { container } = render(<App />);
    await selectFixtureFlight(user);

    // Both complete candidates are drawn; the incomplete candidate is not
    // visible or selectable because only complete routes are presented.
    expect(container.querySelectorAll(".route-path")).toHaveLength(1);
    expect(container.querySelectorAll(".route-path-alternate")).toHaveLength(1);
    expect(container.querySelector(".rail-count")?.textContent).toBe("2");
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

  it("compare drawer shows side-by-side metrics and the directed delta", async () => {
    installApiStub();
    const user = userEvent.setup();
    render(<App />);
    await selectFixtureFlight(user);

    await user.click(screen.getByRole("button", { name: "Compare" }));
    const drawer = await screen.findByRole("region", { name: "Route comparison" });
    expect(within(drawer).getAllByText("512.4 NM").length).toBeGreaterThan(0);
    await user.click(within(drawer).getByRole("button", { name: /with Recorded via alternate routing/ }));
    expect(within(drawer).getAllByText("534.1 NM").length).toBeGreaterThan(0);
    expect(within(drawer).getByText("+21.7 NM")).toBeTruthy();
    expect(within(drawer).getByText(/\+4\.2%/)).toBeTruthy();
  });

  it("does not offer incomplete routes for comparison", async () => {
    installApiStub();
    const user = userEvent.setup();
    render(<App />);
    await selectFixtureFlight(user);

    await user.click(screen.getByRole("button", { name: "Compare" }));
    const drawer = await screen.findByRole("region", { name: "Route comparison" });
    expect(within(drawer).getByRole("button", { name: /with Recorded via alternate routing/ })).toBeTruthy();
    expect(within(drawer).queryByRole("button", { name: /with Recorded with unresolved gap/ })).toBeNull();
  });

  it("edits a copy and sees the validated comparison metrics", async () => {
    installApiStub();
    const user = userEvent.setup();
    render(<App />);
    await selectFixtureFlight(user);

    await user.click(screen.getByRole("button", { name: "Explore variation" }));
    const editor = await screen.findByRole("region", { name: "Explore a route variation" });
    await waitFor(() => expect(within(editor).getByText("Draft status")).toBeTruthy());
    expect(within(editor).getByText("512.4 NM")).toBeTruthy();
    expect(within(editor).getByText("+0.0 NM")).toBeTruthy();
    expect(within(editor).getByText("Draft validation completed.")).toBeTruthy();

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
    expect(screen.getByText("3 of 3 routes shown")).toBeTruthy();
    const fullList = screen.getByRole("region", { name: "Full flight list" });
    expect(fullList.querySelectorAll(".overview-flight-buttons button")).toHaveLength(3);
    expect(within(fullList).getByText("Incomplete")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("Session reset.");
    expect((screen.getByRole("button", { name: "Compare" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("keeps refresh available without showing live-data stale status", async () => {
    installApiStub();
    const user = userEvent.setup();
    render(<App />);
    await selectFixtureFlight(user);

    const controls = await screen.findByRole("region", { name: "Data controls" });
    expect(within(controls).getByRole("button", { name: "Refresh data" })).toBeTruthy();
    expect(screen.queryByText("Source data stale")).toBeNull();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    await user.click(within(controls).getByRole("button", { name: "Refresh data" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Data refreshed at"));

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
    expect(screen.queryByRole("region", { name: "Full flight list" })).toBeNull();
    const restore = await screen.findByRole("button", { name: "Restore controls" });
    await waitFor(() => expect(document.activeElement).toBe(restore));

    await user.click(restore);
    await waitFor(() => expect(document.activeElement?.textContent).toBe("Map only"));
    expect(screen.getByRole("banner")).toBeTruthy();
  });

  it("renders more than ten overview routes in both the full list and map", async () => {
    installApiStub({ overviewCount: 12 });
    const { container } = render(<App />);

    await screen.findByText("12 of 12 routes shown");
    const fullList = screen.getByRole("region", { name: "Full flight list" });
    expect(within(fullList).getAllByRole("button")).toHaveLength(12);
    expect(container.querySelectorAll(".route-hit")).toHaveLength(12);
  });

  it("keeps full-list selection synchronized with the map HUD", async () => {
    installApiStub();
    const user = userEvent.setup();
    render(<App />);

    const fullList = await screen.findByRole("region", { name: "Full flight list" });
    const alternate = within(fullList).getByRole("button", { name: /534.1 NM/ });
    await user.click(alternate);

    await screen.findByText("Recorded via alternate routing", { selector: ".map-hud strong" });
    expect(alternate.getAttribute("aria-current")).toBe("true");
  });

  it("keeps map selection synchronized with the full list and HUD", async () => {
    installApiStub();
    const { container } = render(<App />);
    await screen.findByText("3 of 3 routes shown");

    const hits = container.querySelectorAll(".route-hit");
    fireEvent.click(hits[1]!);

    await screen.findByText("Recorded via alternate routing", { selector: ".map-hud strong" });
    const fullList = screen.getByRole("region", { name: "Full flight list" });
    expect(within(fullList).getByRole("button", { name: /534.1 NM/ }).getAttribute("aria-current")).toBe("true");
  });

  it("keeps the full overview visible after direct list selection", async () => {
    installApiStub({ overviewCount: 12 });
    const user = userEvent.setup();
    render(<App />);
    const fullList = await screen.findByRole("region", { name: "Full flight list" });
    expect(within(fullList).getAllByRole("button")).toHaveLength(12);

    await user.click(within(fullList).getByRole("button", { name: /BULK02/ }));

    await screen.findByText("Recorded bulk route 2", { selector: ".map-hud strong" });
    expect(within(screen.getByRole("region", { name: "Full flight list" })).getAllByRole("button")).toHaveLength(12);
  });

  it("applies the callsign filter to both the full list and map", async () => {
    installApiStub({ overviewCount: 12 });
    const user = userEvent.setup();
    const { container } = render(<App />);
    await screen.findByText("12 of 12 routes shown");

    await user.type(screen.getByRole("combobox", { name: "Flight number or code" }), "BULK11");
    await screen.findByText("1 of 12 routes shown");
    const fullList = screen.getByRole("region", { name: "Full flight list" });
    expect(within(fullList).getAllByRole("button")).toHaveLength(1);
    expect(within(fullList).getByText("BULK11")).toBeTruthy();
    expect(container.querySelectorAll(".route-hit")).toHaveLength(1);
  });

  it("offers an explicit chooser for exactly overlapping route paths", async () => {
    installApiStub({ overlappingOverview: true });
    const { container } = render(<App />);
    await screen.findByText("2 of 2 routes shown");

    fireEvent.click(container.querySelector(".route-hit")!);
    const chooser = await screen.findByRole("dialog", { name: "Choose an overlapping recorded flight" });
    expect(within(chooser).getByText("2 routes overlap here")).toBeTruthy();
    fireEvent.click(within(chooser).getByRole("button", { name: /OVERLAP2/ }));

    await screen.findByText("Overlapping route 2", { selector: ".map-hud strong" });
    const fullList = screen.getByRole("region", { name: "Full flight list" });
    expect(within(fullList).getByRole("button", { name: /OVERLAP2/ }).getAttribute("aria-current")).toBe("true");
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
      { trigger: "Explore variation", drawer: "Explore a route variation", close: "Close draft" },
      { trigger: "Compare", drawer: "Route comparison", close: "Close" },
    ] as const;
    for (const { trigger, drawer, close } of cases) {
      await user.click(within(rail).getByRole("button", { name: trigger }));
      const surface = await screen.findByRole("region", { name: drawer });
      await user.click(within(surface).getByRole("button", { name: close }));
      await waitFor(() => expect(document.activeElement?.textContent).toBe(trigger), { timeout: 2000 });
    }
  });
});
