import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import App from "../../apps/web/src/App.tsx";
import { SAFETY_NOTICE } from "../../apps/web/src/labels.ts";
import { COMPLETE_GROUP_TITLE, DRAFT_SAFETY_LABEL, installApiStub, ROUTE_COMPARISON_EXPLANATION } from "../fixtures/web-app.ts";

/**
 * Deterministic ARIA structure assertions (issue #17 automated portion):
 * landmarks, combobox/listbox contract, drawer naming, table semantics,
 * live regions, and the exact strings the README and design bind.
 */

async function selectFixtureFlight(user: ReturnType<typeof userEvent.setup>) {
  const input = screen.getByRole("combobox", { name: "Flight number or code" });
  await user.type(input, "FIXTURE1");
  await user.keyboard("{Enter}");
  const listbox = await screen.findByRole("listbox", { name: "Choose an exact flight-plan match" });
  expect(listbox).toBeTruthy();
  await user.keyboard("{ArrowDown}{Enter}");
  await waitFor(() => expect(screen.getByRole("status").textContent).toContain("same-endpoint recorded routes returned"));
}

describe("ARIA structure", () => {
  it("exposes the expected landmarks, skip link, and map image", () => {
    installApiStub();
    render(<App />);

    const skip = document.querySelector("a.skip-link");
    expect(skip?.getAttribute("href")).toBe("#flight-search");
    expect(document.getElementById("flight-search")).toBeTruthy();
    // The skip link is the first focusable element in the document.
    const focusables = Array.from(document.querySelectorAll<HTMLElement>("a[href], button, input, [tabindex]:not([tabindex='-1'])"));
    expect(focusables[0]).toBe(skip);

    expect(screen.getByRole("banner")).toBeTruthy();
    expect(screen.getByRole("main")).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "Route workspace controls" })).toBeTruthy();
    expect(screen.getByRole("img", { name: /world map/i })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Safety notice" })).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Flight number or code" })).toBeTruthy();
    expect(screen.getByRole("status")).toBeTruthy();
  });

  it("implements the callsign combobox/listbox contract (design §15.6)", async () => {
    installApiStub();
    const user = userEvent.setup();
    render(<App />);

    const input = screen.getByRole("combobox", { name: "Flight number or code" });
    expect(input.getAttribute("aria-autocomplete")).toBe("list");
    expect(input.getAttribute("aria-expanded")).toBe("false");

    // Typing alone opens the listbox once the debounced type-ahead settles
    // (~250 ms after the last keystroke); Enter is no longer required.
    await user.type(input, "FIXTURE1");
    const listbox = await screen.findByRole("listbox", { name: "Choose an exact flight-plan match" }, { timeout: 2000 });
    expect(listbox.getAttribute("id")).toBe("flight-search-results");
    expect(input.getAttribute("aria-expanded")).toBe("true");
    expect(input.getAttribute("aria-controls")).toBe("flight-search-results");
    expect(screen.getAllByRole("option").length).toBe(2);

    await user.keyboard("{ArrowDown}");
    expect(input.getAttribute("aria-activedescendant")).toBe("flight-match-0");
    expect(screen.getAllByRole("option")[0]?.getAttribute("aria-selected")).toBe("true");

    await user.keyboard("{ArrowDown}");
    expect(input.getAttribute("aria-activedescendant")).toBe("flight-match-1");
    expect(screen.getAllByRole("option")[1]?.getAttribute("aria-selected")).toBe("true");

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("listbox", { name: "Choose an exact flight-plan match" })).toBeNull();
    expect(input.getAttribute("aria-expanded")).toBe("false");
    expect(input.getAttribute("aria-activedescendant")).toBeFalsy();

    // Escape also cancels the pending type-ahead timer: a late settle must
    // never reopen a closed listbox.
    await user.type(input, "FIXTURE1");
    await user.keyboard("{Escape}");
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(screen.queryByRole("listbox", { name: "Choose an exact flight-plan match" })).toBeNull();
  });

  it("names the drawer per surface and syncs aria-pressed on the rail", async () => {
    installApiStub();
    const user = userEvent.setup();
    render(<App />);
    await selectFixtureFlight(user);

    const rail = screen.getByRole("navigation", { name: "Route workspace controls" });
    const routesTrigger = within(rail).getByRole("button", { name: "Routes" });
    const dataTrigger = within(rail).getByRole("button", { name: "Data" });
    await user.click(routesTrigger);
    expect(routesTrigger.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("region", { name: "Route chooser" })).toBeTruthy();

    await user.click(dataTrigger);
    expect(routesTrigger.getAttribute("aria-pressed")).toBe("false");
    expect(dataTrigger.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("region", { name: "Flight and route data" })).toBeTruthy();

    await user.click(within(screen.getByRole("region", { name: "Flight and route data" })).getByRole("button", { name: "Explore variation" }));
    expect(screen.getByRole("region", { name: "Explore a route variation" })).toBeTruthy();
    expect(within(rail).getByRole("button", { name: "Explore variation" }).getAttribute("aria-pressed")).toBe("true");

    await user.click(within(rail).getByRole("button", { name: "Compare" }));
    expect(screen.getByRole("region", { name: "Route comparison" })).toBeTruthy();
    expect(within(rail).getByRole("button", { name: "Compare" }).getAttribute("aria-pressed")).toBe("true");
    expect(within(rail).getByRole("button", { name: "Explore variation" }).getAttribute("aria-pressed")).toBe("false");
  });

  it("keeps neutral route groups and a single aria-current selection", async () => {
    installApiStub();
    const user = userEvent.setup();
    render(<App />);
    await selectFixtureFlight(user);
    await user.click(screen.getByRole("button", { name: "Routes" }));

    // The chooser exposes only complete routes; incomplete records are not
    // keyboard- or screen-reader-selectable in this view.
    expect(screen.getByRole("heading", { name: COMPLETE_GROUP_TITLE })).toBeTruthy();
    const selected = screen.getByRole("button", { name: /Recorded via MIDPT/ });
    expect(selected.getAttribute("aria-current")).toBe("true");
    // The explicitly selected source flight carries aria-current; every other
    // complete candidate must not, regardless of modeled distance.
    expect(screen.getByRole("button", { name: /Recorded via alternate routing/ }).getAttribute("aria-current")).toBeNull();
    expect(screen.queryByRole("button", { name: /Recorded with unresolved gap/ })).toBeNull();
  });

  it("keeps the left-side route-leg table expanded, semantic, and scrollable (design §15.6)", async () => {
    installApiStub();
    const user = userEvent.setup();
    render(<App />);
    await selectFixtureFlight(user);

    const panel = screen.getByRole("region", { name: "Route legs" });
    const heading = within(panel).getByRole("heading", { name: "Route legs" });
    const table = within(panel).getByRole("table");
    expect(table.getAttribute("aria-labelledby")).toBe("route-legs-heading");
    expect(heading.getAttribute("id")).toBe("route-legs-heading");
    const columns = within(panel).getAllByRole("columnheader");
    expect(columns.map((cell) => cell.textContent)).toEqual(["Sequence", "From", "To", "Distance", "Status"]);
    expect(screen.getAllByRole("rowheader").length).toBeGreaterThanOrEqual(2);
    const region = screen.getByLabelText("Scrollable route-leg table");
    expect(region.getAttribute("tabindex")).toBe("0");
  });

  it("implements the draft point combobox contract (design §15.6)", async () => {
    installApiStub();
    const user = userEvent.setup();
    render(<App />);
    await selectFixtureFlight(user);
    await user.click(screen.getByRole("button", { name: "Explore variation" }));

    const input = screen.getByRole("combobox", { name: "Add an exact reference point" });
    expect(input.getAttribute("aria-autocomplete")).toBe("list");
    expect(input.getAttribute("aria-expanded")).toBe("false");

    await user.type(input, "MIDPT");
    await user.keyboard("{Enter}");
    const listbox = await screen.findByRole("listbox", { name: "Resolved reference-point search results" });
    expect(listbox.getAttribute("id")).toBe("draft-point-results");
    expect(input.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getAllByRole("option").length).toBe(1);

    await user.keyboard("{ArrowDown}");
    expect(input.getAttribute("aria-activedescendant")).toBe("draft-match-0");
    await user.keyboard("{Enter}");

    expect(screen.queryByRole("listbox", { name: "Resolved reference-point search results" })).toBeNull();
    await waitFor(() => expect(screen.getByRole("button", { name: "Remove MIDPT" })).toBeTruthy());
    expect(screen.getByText("Intermediate points")).toBeTruthy();
  });

  it("exposes the exact binding strings to assistive technology", async () => {
    installApiStub();
    const user = userEvent.setup();
    render(<App />);

    expect(screen.getByText(SAFETY_NOTICE)).toBeTruthy();
    await waitFor(() => expect(screen.getByText("3 of 3 source route records shown")).toBeTruthy());

    await selectFixtureFlight(user);
    await user.click(screen.getByRole("button", { name: "Routes" }));
    expect(screen.getByText(ROUTE_COMPARISON_EXPLANATION)).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Explore variation" }));
    expect(screen.getByText(DRAFT_SAFETY_LABEL)).toBeTruthy();
  });

  it("labels the map endpoint chips as a section (main-tree App.tsx intent)", async () => {
    installApiStub();
    const user = userEvent.setup();
    render(<App />);
    await selectFixtureFlight(user);

    const endpoints = screen.getByLabelText("Route endpoint locations");
    expect(endpoints.tagName).toBe("SECTION");
    expect(within(endpoints).getByText("Departure")).toBeTruthy();
    expect(within(endpoints).getByText("Arrival")).toBeTruthy();
  });
});
