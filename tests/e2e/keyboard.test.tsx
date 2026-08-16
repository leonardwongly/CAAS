import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import App from "../../apps/web/src/App.tsx";
import { installApiStub, type StubOptions } from "../fixtures/web-app.ts";

/**
 * Keyboard-only end-to-end review (issue #16 automated portion). Every
 * interaction here is performed with Tab / Enter / Arrow / Escape only, and
 * asserts focus destinations, exactly as a keyboard-only reviewer would
 * record them. Screen-reader narration of the same flows is the manual
 * portion in docs/testing/keyboard-review.md.
 */

async function tabUntil(user: ReturnType<typeof userEvent.setup>, predicate: (element: Element) => boolean) {
  for (let step = 0; step < 30; step += 1) {
    await user.tab();
    if (predicate(document.activeElement as Element)) return;
  }
  throw new Error(`Tab order ended before reaching a matching element. Active: ${document.activeElement?.outerHTML.slice(0, 120)}`);
}

async function selectFixtureFlight(user: ReturnType<typeof userEvent.setup>) {
  const input = screen.getByRole("combobox", { name: "Flight number or code" });
  await user.type(input, "FIXTURE1");
  await user.keyboard("{Enter}");
  const listbox = await screen.findByRole("listbox", { name: "Choose an exact flight-plan match" });
  expect(listbox).toBeTruthy();
  await user.keyboard("{ArrowDown}{Enter}");
  await waitFor(() => expect(screen.getByRole("status").textContent).toContain("same-endpoint recorded routes returned"));
}

describe("keyboard-only review", () => {
  it("skip link is first in tab order and targets the search field", async () => {
    installApiStub();
    const user = userEvent.setup();
    render(<App />);

    await user.tab();
    expect(document.activeElement).toBe(document.querySelector("a.skip-link"));
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("combobox", { name: "Flight number or code" }));
  });

  it("duplicate flight plans are disambiguated with arrows and Enter", async () => {
    installApiStub();
    const user = userEvent.setup();
    render(<App />);
    await selectFixtureFlight(user);

    const selectedFlight = screen.getByRole("group", { name: "Selected flight" });
    expect(within(selectedFlight).getByText("FIXTURE1")).toBeTruthy();
    expect(within(selectedFlight).getByText("KOR1 → KDS1")).toBeTruthy();
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("2 complete same-endpoint recorded routes returned"));
  });

  it("closing the route chooser with its Close button returns focus to Routes", async () => {
    installApiStub();
    const user = userEvent.setup();
    render(<App />);
    await selectFixtureFlight(user);

    const rail = screen.getByRole("navigation", { name: "Route workspace controls" });
    await tabUntil(user, (element) => element.textContent === "Routes");
    await user.keyboard("{Enter}");
    const drawer = await screen.findByRole("region", { name: "Route chooser" });
    await tabUntil(user, (element) => element.textContent === "Close" && drawer.contains(element));
    await user.keyboard("{Enter}");
    await waitFor(() => expect(document.activeElement?.textContent).toBe("Routes"));
  });

  it("closing the route comparison with its Close button returns focus to Compare", async () => {
    installApiStub();
    const user = userEvent.setup();
    render(<App />);
    await selectFixtureFlight(user);

    const rail = screen.getByRole("navigation", { name: "Route workspace controls" });
    await tabUntil(user, (element) => element.textContent === "Compare");
    await user.keyboard("{Enter}");
    const drawer = await screen.findByRole("region", { name: "Route comparison" });
    await tabUntil(user, (element) => element.textContent === "Close" && drawer.contains(element));
    await user.keyboard("{Enter}");
    await waitFor(() => expect(document.activeElement?.textContent).toBe("Compare"));
  });

  it("selecting a route with Enter closes the drawer and returns focus to Routes", async () => {
    installApiStub();
    const user = userEvent.setup();
    render(<App />);
    await selectFixtureFlight(user);

    await tabUntil(user, (element) => element.textContent === "Routes");
    await user.keyboard("{Enter}");
    await screen.findByRole("region", { name: "Route chooser" });
    await tabUntil(user, (element) => element.textContent?.startsWith("Recorded via MIDPT") === true);
    await user.keyboard("{Enter}");
    await waitFor(() => expect(document.activeElement?.textContent).toBe("Routes"));
  });

  it("Map Only keeps the app keyboard-usable and Escape returns to the trigger", async () => {
    installApiStub();
    const user = userEvent.setup();
    render(<App />);

    await tabUntil(user, (element) => element.textContent === "Map only");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(document.activeElement?.textContent).toBe("Restore controls"));
    expect(screen.queryByRole("banner")).toBeNull();
    expect(screen.queryByRole("navigation", { name: "Route workspace controls" })).toBeNull();

    await user.keyboard("{Escape}");
    await waitFor(() => expect(document.activeElement?.textContent).toBe("Map only"));
    expect(screen.getByRole("banner")).toBeTruthy();
  });

  it("retrying a failed route load returns focus to the route options heading", async () => {
    const options: StubOptions = { failRoutes: true };
    installApiStub(options);
    const user = userEvent.setup();
    render(<App />);
    // With the route endpoint failing, selection succeeds but route loading
    // does not; wait only for the flight to be selected.
    const input = screen.getByRole("combobox", { name: "Flight number or code" });
    await user.type(input, "FIXTURE1");
    await user.keyboard("{Enter}");
    await user.keyboard("{ArrowDown}{Enter}");
    await waitFor(() => expect(within(screen.getByRole("group", { name: "Selected flight" })).getByText("KOR1 → KDS1")).toBeTruthy());

    const rail = screen.getByRole("navigation", { name: "Route workspace controls" });
    await tabUntil(user, (element) => element.textContent === "Routes");
    await user.keyboard("{Enter}");
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Could not load route options.");

    options.failRoutes = false;
    await tabUntil(user, (element) => element.textContent === "Retry route options" && screen.getByRole("region", { name: "Route chooser" }).contains(element));
    await user.keyboard("{Enter}");
    await waitFor(() => expect(document.activeElement?.id).toBe("options-heading"));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("2 complete same-endpoint recorded routes returned"));
  });

  it("retrying a failed draft validation returns focus to the draft heading", async () => {
    const options: StubOptions = { failDraft: true };
    installApiStub(options);
    const user = userEvent.setup();
    render(<App />);
    await selectFixtureFlight(user);

    const rail = screen.getByRole("navigation", { name: "Route workspace controls" });
    await tabUntil(user, (element) => element.textContent === "Explore variation");
    await user.keyboard("{Enter}");
    const editor = await screen.findByRole("region", { name: "Explore a route variation" });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Draft validation unavailable (stub).");

    options.failDraft = false;
    await tabUntil(user, (element) => element.textContent === "Retry draft validation" && editor.contains(element));
    await user.keyboard("{Enter}");
    await waitFor(() => expect(document.activeElement?.id).toBe("draft-heading"));
    await waitFor(() => expect(screen.getByText("Draft status")).toBeTruthy());
  });

  it("draft reference points can be added and removed without a pointer", async () => {
    installApiStub();
    const user = userEvent.setup();
    render(<App />);
    await selectFixtureFlight(user);

    const rail = screen.getByRole("navigation", { name: "Route workspace controls" });
    await tabUntil(user, (element) => element.textContent === "Explore variation");
    await user.keyboard("{Enter}");
    await screen.findByRole("region", { name: "Explore a route variation" });

    const input = screen.getByRole("combobox", { name: "Add an exact reference point" });
    await user.type(input, "MIDPT");
    await user.keyboard("{Enter}");
    await screen.findByRole("listbox", { name: "Resolved reference-point search results" });
    await user.keyboard("{ArrowDown}{Enter}");
    const remove = await screen.findByRole("button", { name: "Remove MIDPT" });

    await tabUntil(user, (element) => element.getAttribute("aria-label") === "Remove MIDPT");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(screen.queryByRole("button", { name: "Remove MIDPT" })).toBeNull());
    expect(screen.getByText("No intermediate points. This draft uses a direct modeled endpoint-to-endpoint segment.")).toBeTruthy();
  });
  it("selects an overview flight from the full list with Enter", async () => {
    installApiStub();
    const user = userEvent.setup();
    render(<App />);

    const fullList = await screen.findByRole("region", { name: "Full flight list" });
    const alternate = within(fullList).getByRole("button", { name: /534.1 NM/ });
    alternate.focus();
    await user.keyboard("{Enter}");

    await screen.findByText("Recorded via alternate routing", { selector: ".map-hud strong" });
    expect(alternate.getAttribute("aria-current")).toBe("true");
  });
});

describe("API data page focus flow", () => {
  it("moves focus to the page heading on open and back to the trigger on return", async () => {
    installApiStub();
    const user = userEvent.setup();
    render(<App />);

    const trigger = screen.getByRole("button", { name: "API data" });
    await user.click(trigger);
    const heading = await screen.findByRole("heading", { name: "API data" });
    await waitFor(() => expect(document.activeElement).toBe(heading));

    await user.click(screen.getByRole("button", { name: "Back to map" }));
    await waitFor(() => expect(document.activeElement?.textContent).toBe("API data"));
    expect(screen.getByRole("navigation", { name: "Route workspace controls" })).toBeTruthy();
  });
});
