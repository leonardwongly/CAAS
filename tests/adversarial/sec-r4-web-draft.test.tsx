import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../../apps/web/src/App.tsx";
import { installApiStub } from "../fixtures/web-app.ts";

/**
 * Round-4 regressions for the draft editor's optimistic state (sec-r4):
 * - rapid consecutive commits must not drop an earlier commit's explicit
 *   coordinate selection (the optimistic mirrors cover via AND selections);
 * - a reset to endpoint-only must be mirrored immediately, so a commit during
 *   the in-flight window cannot resurrect removed waypoints;
 * - a draft-validation response that lands after the editor was closed/reset
 *   must never render under a different baseline.
 *
 * All three run against deferred draft responses (deferDraft), so the client
 * genuinely races its own optimistic state against the server round-trip.
 */

afterEach(() => {
  vi.restoreAllMocks();
});

async function openEditor(user: ReturnType<typeof userEvent.setup>) {
  const input = screen.getByRole("combobox", { name: "Flight number or code" });
  await user.type(input, "FIXTURE1");
  await user.keyboard("{Enter}");
  await screen.findByRole("listbox", { name: "Choose an exact flight-plan match" });
  await user.keyboard("{ArrowDown}{Enter}");
  await waitFor(() => expect(screen.getByRole("status").textContent).toContain("same-endpoint recorded routes returned for neutral comparison"));
  await user.click(screen.getByRole("button", { name: "Explore variation" }));
  await screen.findByRole("region", { name: "Explore a route variation" });
}

async function commitReference(user: ReturnType<typeof userEvent.setup>, reference: string) {
  const input = screen.getByRole("combobox", { name: "Add an exact reference point" });
  await user.type(input, reference);
  await user.keyboard("{Enter}");
  await screen.findByRole("listbox", { name: "Resolved reference-point search results" });
  await user.click(screen.getByRole("option", { name: new RegExp(reference) }));
}

function compareBodies(calls: Array<{ method: string; url: string; body?: string | undefined }>): Array<{ via: string[]; selections: Array<{ sequence: number; locationId: string }> }> {
  return calls
    .filter((call) => call.method === "POST" && call.url === "/api/v1/routes/compare" && call.body)
    .map((call) => {
      const parsed = JSON.parse(call.body!) as { targetDraft?: { via?: string[]; selections?: Array<{ sequence: number; locationId: string }> } };
      return { via: parsed.targetDraft?.via ?? [], selections: parsed.targetDraft?.selections ?? [] };
    });
}

describe("draft editor optimistic state (sec-r4)", () => {
  it("rapid consecutive commits keep every explicit selection, never drop an earlier one", async () => {
    const { calls, releaseDraft } = installApiStub({ deferDraft: true });
    const user = userEvent.setup();
    render(<App />);
    await openEditor(user);

    await commitReference(user, "MIDPT");
    await commitReference(user, "MIDPT");

    releaseDraft();
    // Both removes appear once every deferred response has applied.
    await waitFor(() => expect(screen.getAllByRole("button", { name: /Remove MIDPT/ }).length).toBe(2));

    const final = compareBodies(calls).at(-1);
    expect(final?.via).toEqual(["MIDPT", "MIDPT"]);
    expect(final?.selections.map((selection) => selection.sequence)).toEqual([0, 1]);
    expect(final?.selections.every((selection) => selection.locationId === "loc-MIDPT")).toBe(true);
  });

  it("a reset to endpoint-only is mirrored: an in-flight commit cannot resurrect removed waypoints", async () => {
    const { calls, releaseDraft } = installApiStub({ deferDraft: true });
    const user = userEvent.setup();
    render(<App />);
    await openEditor(user);

    await commitReference(user, "MIDPT");
    await commitReference(user, "MIDPT");
    releaseDraft();
    await waitFor(() => expect(screen.getAllByRole("button", { name: /Remove MIDPT/ }).length).toBe(2));

    // Now race the reset itself: the reset request is still in flight when the
    // next commit lands. The commit must build on the reset (mirrored), never
    // on the removed waypoints.
    await user.click(screen.getByRole("button", { name: "Reset to endpoint-only draft" }));
    await commitReference(user, "MIDPT");
    releaseDraft();
    await waitFor(() => expect(screen.getAllByRole("button", { name: /Remove MIDPT/ }).length).toBe(1));

    const final = compareBodies(calls).at(-1);
    expect(final?.via).toEqual(["MIDPT"]); // the commit after the reset must build on the reset, not on the removed waypoints
    const finalSelections = final?.selections ?? [];
    expect(finalSelections.map((selection) => selection.sequence)).toEqual([0]);
  });

  it("a draft-validation response landing after the editor closed never renders under a different baseline", async () => {
    const { releaseDraft } = installApiStub({ deferDraft: true });
    const user = userEvent.setup();
    render(<App />);
    await openEditor(user);
    await commitReference(user, "MIDPT");

    // Close the editor while the validation is still in flight, then let the
    // stale response land: it must be dropped, never applied.
    await user.click(screen.getByRole("button", { name: "Close draft" }));
    releaseDraft();
    await waitFor(() => expect(screen.queryByRole("region", { name: "Local route editor" })).toBeNull());
    expect(screen.queryByText(/Local draft validated/)).toBeNull();
    expect(screen.getByRole("status").textContent).not.toContain("Local draft validated against exact reference data.");
  });

  it("a draft-validation response landing after Clear session never resurrects the draft", async () => {
    const { releaseDraft } = installApiStub({ deferDraft: true });
    const user = userEvent.setup();
    render(<App />);
    await openEditor(user);
    await commitReference(user, "MIDPT");

    await user.click(screen.getByRole("button", { name: "Clear session" }));
    releaseDraft();
    await waitFor(() => expect(screen.queryByRole("region", { name: "Local route editor" })).toBeNull());
    expect(screen.queryByText(/Local draft validated/)).toBeNull();
    expect(screen.getByRole("status").textContent).toContain("Session reset.");
  });

  it("a draft-validation response landing after a flight change never renders under the new baseline", async () => {
    const { releaseDraft } = installApiStub({ deferDraft: true });
    const user = userEvent.setup();
    render(<App />);
    await openEditor(user);
    await commitReference(user, "MIDPT");

    // Switch to the OTHER FIXTURE1 flight while the validation is in flight.
    const input = screen.getByRole("combobox", { name: "Flight number or code" });
    await user.clear(input);
    await user.type(input, "FIXTURE1");
    await user.keyboard("{Enter}");
    await screen.findByRole("listbox", { name: "Choose an exact flight-plan match" });
    await user.keyboard("{ArrowDown}{ArrowDown}{Enter}");
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("same-endpoint recorded routes returned for neutral comparison"));

    releaseDraft();
    expect(screen.queryByText(/Local draft validated/)).toBeNull();
    expect(screen.getByRole("status").textContent).not.toContain("Local draft validated against exact reference data.");
  });
});
