import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { beforeAll, describe, expect, it } from "vitest";
import App from "../../apps/web/src/App.tsx";
import { installApiStub } from "../fixtures/web-app.ts";

/**
 * Automated axe audit of every reachable surface (issue #19 / #17 automated
 * portion). jsdom does not parse apps/web/index.html, so mirror its static
 * contract (lang, title, viewport) before auditing. The color-contrast rule
 * is disabled here because axe requires canvas/layout APIs that jsdom does not
 * implement; contrast remains covered by the real-browser evidence. Other
 * layout-dependent rules are recorded as incomplete and re-checked there too
 * (docs/testing/accessibility-evidence.md, issue #18).
 *
 * Generation data is enabled: the merged apps/web/src/App.tsx renders the
 * generation strip inside a labelled `role="region"` landmark
 * ("Live data freshness"), so every audited state includes it.
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
    rules: {
      "color-contrast": { enabled: false },
    },
  });
  const violationIds = results.violations.map((violation) => violation.id);
  expect(violationIds, `${label}: ${JSON.stringify(results.violations, null, 2)}`).toEqual([]);
  for (const rule of results.incomplete) {
    INCOMPLETE_RULES.add(rule.id);
  }
  console.info(`[axe:${label}] ${results.passes.length} passed, ${results.violations.length} violations, ${results.incomplete.length} incomplete (${results.incomplete.map((rule) => rule.id).join(", ")})`);
}

async function selectFixtureFlight(user: ReturnType<typeof userEvent.setup>) {
  const input = screen.getByRole("combobox", { name: "Flight number or code" });
  await user.type(input, "FIXTURE1");
  await user.keyboard("{Enter}");
  await user.keyboard("{ArrowDown}{Enter}");
  await waitFor(() => expect(screen.getByRole("status").textContent).toContain("same-endpoint recorded routes returned"));
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

  it("with the route comparison open passes axe", async () => {
    installApiStub();
    const user = userEvent.setup();
    render(<App />);
    await selectFixtureFlight(user);
    await user.click(screen.getByRole("button", { name: "Compare" }));
    const drawer = await screen.findByRole("region", { name: "Route comparison" });
    await user.click(within(drawer).getByRole("button", { name: /with Recorded via alternate routing/ }));
    await audit("route-comparison");
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
    await user.click(screen.getByRole("button", { name: "Explore variation" }));
    await waitFor(() => expect(screen.getByRole("region", { name: "Explore a route variation" })).toBeTruthy());
    await audit("draft-editor");
  });

  it("with the draft reference listbox open passes axe", async () => {
    installApiStub();
    const user = userEvent.setup();
    render(<App />);
    await selectFixtureFlight(user);
    await user.click(screen.getByRole("button", { name: "Explore variation" }));
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

describe("axe audits — API data page", () => {
  it("with the API data page open and one explorer result rendered passes axe", async () => {
    installApiStub();
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: "API data" }));
    await screen.findByRole("heading", { name: "API data" });
    const readinessCard = screen.getByText("/api/v1/readiness").closest(".explorer-card");
    if (readinessCard instanceof HTMLElement) {
      await user.click(within(readinessCard).getByRole("button", { name: "Run" }));
      await waitFor(() => expect(within(readinessCard).getByText(/"status": "ready"/)).toBeTruthy());
    }
    await audit("api-data");
  });
});
