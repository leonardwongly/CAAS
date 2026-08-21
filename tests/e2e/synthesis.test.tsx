import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import App from "../../apps/web/src/App.tsx";
import { installApiStub, type CapturedCall } from "../fixtures/web-app.ts";

/**
 * End-to-end coverage for donor-subpath synthesis (issue #44): candidates are
 * assembled ONLY from geometry observed on other recorded routes in the same
 * generation — never interpolated, ranked, or written back to the source.
 */

async function openSynthesisDrawer(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: "Show observed-donor synthesis" }));
  return screen.findByRole("region", { name: "Observed-donor synthesis" });
}

async function selectIncompleteRoute(user: ReturnType<typeof userEvent.setup>, drawer: HTMLElement) {
  await user.click(within(drawer).getByRole("button", { name: /Recorded with unresolved gap/ }));
}

function synthesisCalls(calls: CapturedCall[]): CapturedCall[] {
  return calls.filter((call) => call.method === "POST" && call.url === "/api/v1/routes/synthesis");
}

describe("observed-donor synthesis e2e", () => {
  it("renders borrowed-geometry synthesis for the incomplete source route", async () => {
    const stub = installApiStub();
    const user = userEvent.setup();
    render(<App />);

    // The overview prompt panel advertises the synthesis surface.
    const prompt = await screen.findByText("Show observed-donor synthesis");
    const promptPanel = prompt.closest(".potential-route-prompt");
    expect(promptPanel).toBeTruthy();
    expect(within(promptPanel as HTMLElement).getByText("OBSERVED-DONOR SYNTHESIS")).toBeTruthy();
    expect(within(promptPanel as HTMLElement).getByText(/source route record.* with gaps/)).toBeTruthy();

    const drawer = await openSynthesisDrawer(user);
    // Chooser state: neutral framing, no target selected yet.
    expect(within(drawer).getByRole("heading", { name: "Choose a source route with gaps" })).toBeTruthy();
    expect(within(drawer).getByText(/Nothing is interpolated, ranked, or written back to the source record/)).toBeTruthy();

    await selectIncompleteRoute(user, drawer);

    // Settled status copy for the stubbed full envelope.
    await waitFor(() => expect(within(drawer).getByText(/candidate assembled from geometry observed on other recorded routes in this generation/)).toBeTruthy());
    expect(within(drawer).getByText(/Dotted segments are borrowed; nothing was interpolated/)).toBeTruthy();

    // Candidate chooser group with provenance wording on every button.
    const candidates = within(drawer).getByRole("group", { name: "Synthesis candidates" });
    const candidate = within(candidates).getByRole("button", { name: /Candidate candidate-1/ });
    expect(within(candidate).getByText(/Observed on 1 donor route\(s\) · borrowed 32\.4 NM/)).toBeTruthy();
    expect(within(candidate).getByText("1 corridor covered")).toBeTruthy();

    // Metrics for the selected candidate.
    expect(within(drawer).getByText("Corridors covered")).toBeTruthy();
    expect(within(drawer).getByText(/Estimated total/)).toBeTruthy();

    // The synthesis endpoint was called for the incomplete route's flight.
    const calls = synthesisCalls(stub.calls);
    expect(calls.length).toBeGreaterThan(0);
    expect(JSON.parse(calls[0]?.body ?? "{}")).toMatchObject({ flightId: "flight-4" });

    // Map HUD and the map's accessible name frame borrowed geometry as observed.
    expect(screen.getByText(/Dotted segments were observed on other recorded routes in this generation/)).toBeTruthy();
    expect(screen.getByRole("img", { name: /not estimates or suggestions/ })).toBeTruthy();

    // The retired client midpoint preview must leave no wording behind.
    expect(document.body.textContent ?? "").not.toMatch(/midpoint/i);
  });

  it("reports candidate-limit-exceeded without listing or choosing any candidate", async () => {
    installApiStub({
      synthesis: { status: "candidate-limit-exceeded", corridorCount: 3, corridorsCovered: 3, candidates: [] },
    });
    const user = userEvent.setup();
    render(<App />);

    const drawer = await openSynthesisDrawer(user);
    await selectIncompleteRoute(user, drawer);

    await waitFor(() => expect(within(drawer).getByText(/Too many donor combinations to list/)).toBeTruthy());
    expect(within(drawer).getByText(/No candidate was truncated or silently chosen/)).toBeTruthy();
    expect(within(drawer).queryByRole("group", { name: "Synthesis candidates" })).toBeNull();
    expect(within(drawer).queryByRole("button", { name: /Candidate / })).toBeNull();
  });

  it("reports unavailable synthesis with bounded copy and no candidates", async () => {
    installApiStub({
      synthesis: { status: "unavailable", corridorCount: 1, corridorsCovered: 0, candidates: [] },
    });
    const user = userEvent.setup();
    render(<App />);

    const drawer = await openSynthesisDrawer(user);
    await selectIncompleteRoute(user, drawer);

    await waitFor(() => expect(within(drawer).getByText(/No other recorded route in this generation contains the missing directed subpath/)).toBeTruthy());
    expect(within(drawer).queryByRole("group", { name: "Synthesis candidates" })).toBeNull();
  });

  it("recovers from a failed synthesis request via Retry synthesis", async () => {
    const stub = installApiStub({ failSynthesis: "once" });
    const user = userEvent.setup();
    render(<App />);

    const drawer = await openSynthesisDrawer(user);
    await selectIncompleteRoute(user, drawer);

    const alert = await within(drawer).findByRole("alert");
    expect(within(alert).getByText(/Synthesis unavailable/)).toBeTruthy();
    expect(synthesisCalls(stub.calls)).toHaveLength(1);

    await user.click(within(alert).getByRole("button", { name: "Retry synthesis" }));
    await waitFor(() => expect(synthesisCalls(stub.calls)).toHaveLength(2));
    // The retry succeeds under this stub: the alert clears and candidates settle.
    await waitFor(() => expect(within(drawer).queryByRole("alert")).toBeNull());
    await waitFor(() => expect(within(drawer).getByRole("group", { name: "Synthesis candidates" })).toBeTruthy());
  });
});
