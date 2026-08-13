import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { beforeAll, describe, expect, it } from "vitest";
import App from "../../apps/web/src/App.tsx";
import { installApiStub } from "../fixtures/web-app.ts";

/**
 * Automated axe audit of every reachable surface (issue #19 / #17 automated
 * portion). jsdom does not parse apps/web/index.html, so mirror its static
 * contract (lang, title, viewport) before auditing. Layout-dependent rules
 * (color-contrast, link-in-text-block, scrollable-region-focusable) return
 * "incomplete" in jsdom and are recorded, then re-checked in a real browser
 * (docs/testing/accessibility-evidence.md, issue #18).
 */

beforeAll(() => {
  document.documentElement.lang = "en";
  document.title = "Flight Route Explorer";
  const viewport = document.createElement("meta");
  viewport.name = "viewport";
  viewport.content = "width=device-width, initial-scale=1";
  document.head.appendChild(viewport);
});

const INCOMPLETE_RULES = new Set<string>();

async function audit(label: string) {
  const results = await axe.run(document.body, {
    runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "best-practice"] },
  });
  const violationIds = results.violations.map((violation) => violation.id);
  expect(violationIds, `${label}: ${JSON.stringify(results.violations, null, 2)}`).toEqual([]);
  for (const rule of results.incomplete) {
    if (rule.id === "color-contrast") continue; // layout-dependent, checked in real browser
    INCOMPLETE_RULES.add(rule.id);
  }
  console.info(`[axe:${label}] ${results.passes.length} passed, ${results.violations.length} violations, ${results.incomplete.length} incomplete (${results.incomplete.map((rule) => rule.id).join(", ")})`);
}

async function selectFixtureFlight(user: ReturnType<typeof userEvent.setup>) {
  const input = screen.getByRole("combobox", { name: "Flight number or code" });
  await user.type(input, "FIXTURE1");
  await user.keyboard("{Enter}");
  await user.keyboard("{ArrowDown}{Enter}");
  await waitFor(() => expect(screen.getByRole("status").textContent).toContain("route options returned"));
}

describe("axe audits", () => {
  it("initial state passes axe", async () => {
    installApiStub();
    render(<App />);
    await audit("initial");
  });

  it("after selecting a flight passes axe", async () => {
    installApiStub();
    const user = userEvent.setup();
    render(<App />);
    await selectFixtureFlight(user);
    await audit("flight-selected");
  });

  it("with the route chooser open passes axe", async () => {
    installApiStub();
    const user = userEvent.setup();
    render(<App />);
    await selectFixtureFlight(user);
    await user.click(screen.getByRole("button", { name: "Routes" }));
    await audit("route-chooser");
  });

  it("with the route data drawer open passes axe", async () => {
    installApiStub();
    const user = userEvent.setup();
    render(<App />);
    await selectFixtureFlight(user);
    await user.click(screen.getByRole("button", { name: "Data" }));
    await audit("route-data");
  });

  it("with the draft editor open passes axe", async () => {
    installApiStub();
    const user = userEvent.setup();
    render(<App />);
    await selectFixtureFlight(user);
    await user.click(screen.getByRole("button", { name: "Edit copy" }));
    await waitFor(() => expect(screen.getByRole("region", { name: "Local route editor" })).toBeTruthy());
    await audit("draft-editor");
  });

  it("with the draft reference listbox open passes axe", async () => {
    installApiStub();
    const user = userEvent.setup();
    render(<App />);
    await selectFixtureFlight(user);
    await user.click(screen.getByRole("button", { name: "Edit copy" }));
    const input = screen.getByRole("combobox", { name: "Add an exact reference point" });
    await user.type(input, "MIDPT");
    await user.keyboard("{Enter}");
    await screen.findByRole("listbox", { name: "Resolved reference-point search results" });
    await audit("draft-reference-listbox");
  });

  it("in Map Only mode passes axe", async () => {
    installApiStub();
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: "Map only" }));
    await waitFor(() => expect(screen.queryByRole("banner")).toBeNull());
    await audit("map-only");
  });
});
