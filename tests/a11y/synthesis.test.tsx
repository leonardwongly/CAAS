import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { beforeAll, describe, expect, it } from "vitest";
import App from "../../apps/web/src/App.tsx";
import { installApiStub } from "../fixtures/web-app.ts";

/**
 * Automated accessibility coverage for the observed-donor synthesis surface
 * (issue #44): axe audits of the chooser and settled states, keyboard
 * reachability of the candidate chooser, and the labelled drawer/section
 * structure. Mirrors the jsdom contract setup from a11y/axe.test.tsx.
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

/**
 * Full best-practice ruleset on every state: the drawer (`role="region"`
 * aria-label "Observed-donor synthesis") and the settled section heading
 * ("Synthesis result") are deliberately distinct so `landmark-unique` stays
 * enabled. Color contrast is covered by the real-browser evidence lane.
 */
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

async function tabUntil(user: ReturnType<typeof userEvent.setup>, predicate: (element: Element) => boolean) {
  for (let step = 0; step < 30; step += 1) {
    await user.tab();
    if (predicate(document.activeElement as Element)) return;
  }
  throw new Error(`Tab order ended before reaching a matching element. Active: ${document.activeElement?.outerHTML.slice(0, 120)}`);
}

/** Two valid borrowed-subpath candidates so pressed-state toggling is observable. */
const twoCandidateEnvelope = {
  status: "full",
  corridorCount: 1,
  corridorsCovered: 1,
  candidates: [
    {
      candidateId: "candidate-1",
      segments: [{ kind: "borrowed", geometry: { type: "LineString", coordinates: [[-80, 39], [-80.5, 38.8]] }, distanceNm: 32.4, matchMethod: "exact-coordinate", donorCount: 1, proofIds: ["proof-fixture-1"] }],
      sourceResolvedDistanceNm: 480.1,
      borrowedDistanceNm: 32.4,
      estimatedTotalDistanceNm: 512.5,
      corridorsCovered: 1,
    },
    {
      candidateId: "candidate-2",
      segments: [{ kind: "borrowed", geometry: { type: "LineString", coordinates: [[-80, 39], [-82, 37], [-80.5, 38.8]] }, distanceNm: 41.9, matchMethod: "reference", donorCount: 2, proofIds: ["proof-fixture-2"] }],
      sourceResolvedDistanceNm: 480.1,
      borrowedDistanceNm: 41.9,
      estimatedTotalDistanceNm: 522.0,
      corridorsCovered: 1,
    },
  ],
};

async function openSynthesisDrawer(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: "Show observed-donor synthesis" }));
  return screen.findByRole("region", { name: "Observed-donor synthesis" });
}

async function selectIncompleteRoute(user: ReturnType<typeof userEvent.setup>, drawer: HTMLElement) {
  await user.click(within(drawer).getByRole("button", { name: /Recorded with unresolved gap/ }));
}

describe("synthesis drawer accessibility", () => {
  it("chooser state passes axe and is labelled via synthesis-heading", async () => {
    installApiStub();
    const user = userEvent.setup();
    render(<App />);

    const drawer = await openSynthesisDrawer(user);
    const section = drawer.querySelector("section.potential-route-section");
    expect(section).toBeTruthy();
    expect(section?.getAttribute("aria-labelledby")).toBe("synthesis-heading");
    const heading = within(drawer).getByRole("heading", { name: "Choose a source route with gaps" });
    expect(heading.id).toBe("synthesis-heading");
    await audit("synthesis-chooser");
  });

  it("settled candidate state passes axe with a named drawer", async () => {
    installApiStub({ synthesis: twoCandidateEnvelope });
    const user = userEvent.setup();
    render(<App />);

    const drawer = await openSynthesisDrawer(user);
    await selectIncompleteRoute(user, drawer);
    await waitFor(() => expect(within(drawer).getByRole("group", { name: "Synthesis candidates" })).toBeTruthy());
    expect(within(drawer).getByRole("heading", { name: "Synthesis result" })).toBeTruthy();
    await audit("synthesis-candidates");
  });

  it("unavailable state passes axe", async () => {
    installApiStub({ synthesis: { status: "unavailable", corridorCount: 1, corridorsCovered: 0, candidates: [] } });
    const user = userEvent.setup();
    render(<App />);

    const drawer = await openSynthesisDrawer(user);
    await selectIncompleteRoute(user, drawer);
    await waitFor(() => expect(within(drawer).getByText(/No other recorded route in this generation contains the missing directed subpath/)).toBeTruthy());
    await audit("synthesis-unavailable");
  });

  it("candidate chooser buttons are keyboard-reachable and toggle aria-pressed", async () => {
    installApiStub({ synthesis: twoCandidateEnvelope });
    const user = userEvent.setup();
    render(<App />);

    const drawer = await openSynthesisDrawer(user);
    await selectIncompleteRoute(user, drawer);
    const group = await within(drawer).findByRole("group", { name: "Synthesis candidates" });
    const first = within(group).getByRole("button", { name: /^Candidate 1(?!\d)/ });
    const second = within(group).getByRole("button", { name: /^Candidate 2(?!\d)/ });
    // The first candidate is auto-selected; the chooser stays neutral.
    expect(first.getAttribute("aria-pressed")).toBe("true");
    expect(second.getAttribute("aria-pressed")).toBe("false");

    // Tab reaches both candidate buttons inside the drawer.
    await tabUntil(user, (element) => element === first);
    expect(drawer.contains(document.activeElement)).toBe(true);
    await user.tab();
    expect(document.activeElement).toBe(second);

    // Selecting the second candidate moves the pressed state without ranking copy.
    await user.keyboard("{Enter}");
    expect(first.getAttribute("aria-pressed")).toBe("false");
    expect(second.getAttribute("aria-pressed")).toBe("true");
    expect(within(drawer).queryByText(/best|shortest|recommended/i)).toBeNull();
  });
});
