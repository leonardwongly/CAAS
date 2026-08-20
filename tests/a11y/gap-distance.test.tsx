import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import App from "../../apps/web/src/App.tsx";
import { GAP_DISTANCE_ANNOTATION_CAVEAT } from "../../apps/web/src/labels.ts";
import { installApiStub } from "../fixtures/web-app.ts";

describe("observed-donor synthesis accessibility", () => {
  it("keeps borrowed geometry, provenance, and the separate statistical annotation inside the named left drawer", async () => {
    installApiStub();
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole("button", { name: "Show observed-donor synthesis" }));
    const drawer = await screen.findByRole("region", { name: "Observed-donor synthesis" });
    expect(within(drawer).getByRole("heading", { name: "Choose a source route with gaps" })).toBeTruthy();
    await user.click(within(drawer).getByRole("button", { name: /Recorded with unresolved gap/ }));

    await waitFor(() => expect(within(drawer).getByRole("heading", { name: "Observed-donor synthesis" })).toBeTruthy());
    // Candidate chooser: neutral, pressed-state semantics; no ranking wording anywhere.
    const candidate = within(drawer).getByRole("button", { name: /Observed on 1 donor route\(s\) · borrowed 32\.4 NM/ });
    expect(candidate.getAttribute("aria-pressed")).toBe("true");
    expect(within(drawer).queryByText(/best|shortest|recommended/i)).toBeNull();
    expect(within(drawer).getByText("Corridors covered")).toBeTruthy();
    expect(within(drawer).getByText("1/1")).toBeTruthy();
    // The statistical annotation survives under its own heading, never mixed
    // into candidate totals.
    await waitFor(() => expect(within(drawer).getByText("Separate statistical annotation (not synthesis)")).toBeTruthy());
    expect(within(drawer).getByText(GAP_DISTANCE_ANNOTATION_CAVEAT)).toBeTruthy();
    expect(within(drawer).getByText(/Lower bounds remain available/)).toBeTruthy();
    // Screen-reader live region distinguishes solid recorded vs dotted borrowed.
    expect(drawer.textContent).toContain("Solid segments are recorded for this flight; dotted segments were observed on other flights in the same data generation.");
  });
});
