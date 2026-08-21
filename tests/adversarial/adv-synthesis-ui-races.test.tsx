// Sweep owner/domain: adversarial sub-agent A8 — web synthesis drawer
// (apps/web/src/App.tsx synthesis state machine): in-flight abort races,
// out-of-order responses, cursor-paging races, status-copy boundaries, empty
// payloads, and double-trigger dedup. Complements — does not duplicate —
// tests/e2e/synthesis.test.tsx, tests/a11y/synthesis.test.tsx, and
// tests/adversarial/typeahead-race.test.tsx.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../../apps/web/src/App.tsx";
import { installApiStub, type CapturedCall, type StubOptions } from "../fixtures/web-app.ts";

/**
 * The shared fixture has no deferred-synthesis knob, so this harness wraps
 * the fixture fetch: every POST /api/v1/routes/synthesis is captured and
 * HELD until released (FIFO), with the envelope chosen at release time. The
 * stub transport ignores AbortSignal — exactly the hostile transport the
 * App's sequence guard must tolerate (same premise as typeahead-race).
 */
type PendingSynthesis = { resolve: (response: { ok: boolean; status: number; json: () => Promise<unknown> }) => void; reject: (error: unknown) => void };

type StubFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

function installDeferredSynthesisStub(options: StubOptions = {}) {
  const stub = installApiStub(options);
  const underlying = stub.fetchMock as unknown as StubFetch;
  const pending: PendingSynthesis[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    if (method === "POST" && url === "/api/v1/routes/synthesis") {
      stub.calls.push({ method, url, ...(typeof init?.body === "string" ? { body: init.body } : {}) });
      return new Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>((resolve, reject) => pending.push({ resolve, reject }));
    }
    return underlying(input, init);
  });
  const envelope = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
  return {
    calls: stub.calls,
    pendingCount: () => pending.length,
    releaseEnvelope: (body: unknown) => pending.shift()?.resolve(envelope(body)),
    /** Resolve a specific held request (0 = oldest) to model out-of-order arrivals. */
    releaseAt: (index: number, body: unknown) => {
      const entry = pending[index];
      if (entry) {
        pending.splice(index, 1);
        entry.resolve(envelope(body));
      }
    },
    releaseError: (error: unknown) => pending.shift()?.reject(error),
  };
}

const synthesisCalls = (calls: CapturedCall[]) => calls.filter((call) => call.method === "POST" && call.url === "/api/v1/routes/synthesis");

function candidate(candidateId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    candidateId,
    segments: [
      { kind: "borrowed", geometry: { type: "LineString", coordinates: [[-80, 39], [-80.5, 38.8]] }, distanceNm: 32.4, matchMethod: "exact-coordinate", donorCount: 1, proofIds: [`proof-${candidateId}`] },
    ],
    sourceResolvedDistanceNm: 480.1,
    borrowedDistanceNm: 32.4,
    estimatedTotalDistanceNm: 512.5,
    corridorsCovered: 1,
    ...overrides,
  };
}

const fullEnvelope = (candidates: Record<string, unknown>[], extra: Record<string, unknown> = {}) => ({
  status: "full",
  corridorCount: 1,
  corridorsCovered: 1,
  candidates,
  ...extra,
});

async function openDrawer(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: "Show observed-donor synthesis" }));
  return screen.findByRole("region", { name: "Observed-donor synthesis" });
}

async function selectIncompleteRoute(user: ReturnType<typeof userEvent.setup>, drawer: HTMLElement) {
  await user.click(within(drawer).getByRole("button", { name: /Recorded with unresolved gap/ }));
}

async function flushSettled() {
  await new Promise((resolve) => setTimeout(resolve, 25));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("A8 synthesis drawer: in-flight abort and supersession races", () => {
  it("a deferred response released after 'Choose another' never lands on the chooser", async () => {
    const defer = installDeferredSynthesisStub();
    const user = userEvent.setup();
    render(<App />);

    const drawer = await openDrawer(user);
    await selectIncompleteRoute(user, drawer);
    await waitFor(() => expect(defer.pendingCount()).toBe(1));

    // Navigate away mid-flight: the chooser returns and the state resets.
    await user.click(within(drawer).getByRole("button", { name: "Choose another" }));
    await waitFor(() => expect(within(drawer).getByRole("heading", { name: "Choose a source route with gaps" })).toBeTruthy());

    // The late response lands: no settled synthesis may surface.
    defer.releaseEnvelope(fullEnvelope([candidate("stale-1")]));
    await flushSettled();
    expect(within(drawer).getByRole("heading", { name: "Choose a source route with gaps" })).toBeTruthy();
    expect(within(drawer).queryByRole("group", { name: "Synthesis candidates" })).toBeNull();
    expect(within(drawer).queryByText(/candidate assembled/i)).toBeNull();
    expect(within(drawer).queryByRole("alert")).toBeNull();
  });

  it("out-of-order arrivals: the current flight settles first and the stale first flight never lands", async () => {
    const defer = installDeferredSynthesisStub();
    const user = userEvent.setup();
    render(<App />);

    const drawer = await openDrawer(user);
    await selectIncompleteRoute(user, drawer);
    await waitFor(() => expect(defer.pendingCount()).toBe(1));

    // Supersede flight A with flight B for the same target. The pending queue
    // holds flight A first (index 0) and flight B second (index 1).
    await user.click(within(drawer).getByRole("button", { name: "Choose another" }));
    await selectIncompleteRoute(user, drawer);
    await waitFor(() => expect(defer.pendingCount()).toBe(2));
    expect(synthesisCalls(defer.calls)).toHaveLength(2);

    // Out of order: flight B's response arrives before flight A's.
    defer.releaseAt(1, fullEnvelope([candidate("flight-b", { borrowedDistanceNm: 41.9, estimatedTotalDistanceNm: 522.0 })]));
    await waitFor(() => expect(within(drawer).getByText("41.9 NM")).toBeTruthy());
    expect(within(drawer).queryByText(/Requesting observed-donor synthesis candidates/)).toBeNull();

    // Flight A's late payload must be discarded by the sequence guard.
    defer.releaseAt(0, fullEnvelope([candidate("flight-a", { borrowedDistanceNm: 999.0, estimatedTotalDistanceNm: 1479.1 })]));
    await flushSettled();

    expect(within(drawer).queryByText(/999\.0 NM/)).toBeNull();
    expect(within(drawer).queryByText(/1479\.1 NM/)).toBeNull();
    // Exactly one pressed candidate, drawn from flight B's envelope only.
    const group = within(drawer).getByRole("group", { name: "Synthesis candidates" });
    expect(within(group).getAllByRole("button").filter((button) => button.getAttribute("aria-pressed") === "true")).toHaveLength(1);
    expect(within(drawer).getByText(/Estimated total/)).toBeTruthy();
    expect(within(drawer).getByText("522.0 NM")).toBeTruthy();
  });

  it("unmount mid-flight: releasing afterwards is harmless and a fresh session starts clean", async () => {
    const defer = installDeferredSynthesisStub();
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const user = userEvent.setup();
    const view = render(<App />);

    const drawer = await openDrawer(user);
    await selectIncompleteRoute(user, drawer);
    await waitFor(() => expect(defer.pendingCount()).toBe(1));

    view.unmount();
    // A late resolution after unmount must not throw or warn.
    defer.releaseEnvelope(fullEnvelope([candidate("orphan")]));
    await flushSettled();
    expect(consoleSpy).not.toHaveBeenCalled();

    // Next session: brand-new state, chooser only, no leaked settled result.
    const defer2 = installDeferredSynthesisStub();
    const user2 = userEvent.setup();
    render(<App />);
    const drawer2 = await openDrawer(user2);
    expect(within(drawer2).getByRole("heading", { name: "Choose a source route with gaps" })).toBeTruthy();
    expect(within(drawer2).queryByRole("group", { name: "Synthesis candidates" })).toBeNull();
    await selectIncompleteRoute(user2, drawer2);
    defer2.releaseEnvelope(fullEnvelope([candidate("fresh")]));
    await waitFor(() => expect(within(drawer2).getByRole("group", { name: "Synthesis candidates" })).toBeTruthy());
  });
});

describe("A8 synthesis drawer: candidate switching consistency", () => {
  it("rapid 1↔2 switching always renders exactly one candidate's geometry and provenance", async () => {
    const defer = installDeferredSynthesisStub();
    const user = userEvent.setup();
    render(<App />);

    const drawer = await openDrawer(user);
    await selectIncompleteRoute(user, drawer);
    defer.releaseEnvelope(fullEnvelope([
      candidate("candidate-1"),
      candidate("candidate-2", {
        segments: [{ kind: "borrowed", geometry: { type: "LineString", coordinates: [[-80, 39], [-82, 37], [-80.5, 38.8]] }, distanceNm: 41.9, matchMethod: "reference", donorCount: 2, proofIds: ["proof-candidate-2"] }],
        borrowedDistanceNm: 41.9,
        estimatedTotalDistanceNm: 522.0,
      }),
    ]));
    const group = await within(drawer).findByRole("group", { name: "Synthesis candidates" });
    const first = within(group).getByRole("button", { name: /^Candidate 1(?!\d)/ });
    const second = within(group).getByRole("button", { name: /^Candidate 2(?!\d)/ });
    expect(within(drawer).getAllByText("Borrowed segment provenance")).toHaveLength(1);

    // Rapid alternating switching: 2 → 1 → 2 → 1.
    await user.click(second);
    await user.click(first);
    await user.click(second);
    await user.click(first);

    const pressed = within(group).getAllByRole("button").filter((button) => button.getAttribute("aria-pressed") === "true");
    expect(pressed).toHaveLength(1);
    expect(pressed[0]).toBe(first);
    // Candidate 1's exact-coordinate provenance only — no reference-match copy
    // from candidate 2 mixed in, and exactly one provenance row.
    expect(within(drawer).getAllByText("Borrowed segment provenance")).toHaveLength(1);
    expect(within(drawer).getByText(/match by exact coordinate/)).toBeTruthy();
    expect(within(drawer).queryByText(/match by exact reference identity/)).toBeNull();
    // The metric grid reflects candidate 1 only (41.9 NM still legitimately
    // appears on candidate 2's chooser label, so scope to the metrics).
    const metrics = drawer.querySelector(".metric-grid");
    expect(metrics).toBeTruthy();
    expect(within(metrics as HTMLElement).getByText("32.4 NM")).toBeTruthy();
    expect(within(metrics as HTMLElement).getByText("512.5 NM")).toBeTruthy();
    expect(within(metrics as HTMLElement).queryByText(/41\.9 NM/)).toBeNull();
  });
});

describe("A8 synthesis drawer: cursor paging races and terminal guards", () => {
  it("pages merge in order; the end state is sticky with no phantom page requests", async () => {
    const defer = installDeferredSynthesisStub();
    const user = userEvent.setup();
    render(<App />);

    const drawer = await openDrawer(user);
    await selectIncompleteRoute(user, drawer);
    await waitFor(() => expect(defer.pendingCount()).toBe(1));
    defer.releaseEnvelope(fullEnvelope([candidate("page-1-candidate")], { nextCursor: "p2" }));

    // The follow-up page request carries the cursor in the body only.
    await waitFor(() => expect(synthesisCalls(defer.calls)).toHaveLength(2));
    expect(JSON.parse(synthesisCalls(defer.calls)[1]?.body ?? "{}")).toMatchObject({ flightId: "flight-4", cursor: "p2" });
    defer.releaseEnvelope(fullEnvelope([candidate("page-2-candidate")], { status: "ambiguous" }));

    const group = await within(drawer).findByRole("group", { name: "Synthesis candidates" });
    expect(within(group).getByRole("button", { name: /^Candidate 1(?!\d)/ })).toBeTruthy();
    expect(within(group).getByRole("button", { name: /^Candidate 2(?!\d)/ })).toBeTruthy();
    // Last-page envelope supplies the status copy and the auto-selection.
    expect(within(drawer).getByText(/2 candidates assembled from geometry observed/)).toBeTruthy();
    expect(within(group).getAllByRole("button").find((button) => button.getAttribute("aria-pressed") === "true")).toBeTruthy();

    // Sticky end state: nothing further is requested.
    await flushSettled();
    expect(synthesisCalls(defer.calls)).toHaveLength(2);
    expect(defer.pendingCount()).toBe(0);
  });

  it("a page released after the user left mid-paging is discarded (no perpetual spinner)", async () => {
    const defer = installDeferredSynthesisStub();
    const user = userEvent.setup();
    render(<App />);

    const drawer = await openDrawer(user);
    await selectIncompleteRoute(user, drawer);
    await waitFor(() => expect(defer.pendingCount()).toBe(1));
    defer.releaseEnvelope(fullEnvelope([candidate("page-1")], { nextCursor: "p2" }));
    await waitFor(() => expect(synthesisCalls(defer.calls)).toHaveLength(2));

    // Leave while page 2 is in flight, then release page 2 into the void.
    await user.click(within(drawer).getByRole("button", { name: "Choose another" }));
    defer.releaseEnvelope(fullEnvelope([candidate("page-2")], { status: "ambiguous" }));
    await flushSettled();

    expect(within(drawer).getByRole("heading", { name: "Choose a source route with gaps" })).toBeTruthy();
    expect(within(drawer).queryByRole("group", { name: "Synthesis candidates" })).toBeNull();
    expect(within(drawer).queryByText(/Requesting observed-donor synthesis candidates/)).toBeNull();
  });

  it("an empty page carrying a repeated cursor terminates paging instead of looping", async () => {
    const defer = installDeferredSynthesisStub();
    const user = userEvent.setup();
    render(<App />);

    const drawer = await openDrawer(user);
    await selectIncompleteRoute(user, drawer);
    await waitFor(() => expect(defer.pendingCount()).toBe(1));
    defer.releaseEnvelope(fullEnvelope([candidate("only-candidate")], { nextCursor: "p2" }));
    await waitFor(() => expect(synthesisCalls(defer.calls)).toHaveLength(2));
    // Misbehaving server: empty page that still advertises a cursor.
    defer.releaseEnvelope(fullEnvelope([], { nextCursor: "p3" }));

    await waitFor(() => expect(within(drawer).getByRole("group", { name: "Synthesis candidates" })).toBeTruthy());
    expect(within(drawer).getByText(/1 candidate assembled from geometry observed/)).toBeTruthy();
    await flushSettled();
    // Terminal guard held: exactly two requests, spinner cleared.
    expect(synthesisCalls(defer.calls)).toHaveLength(2);
    expect(defer.pendingCount()).toBe(0);
    expect(within(drawer).queryByText(/Requesting observed-donor synthesis candidates/)).toBeNull();
  });
});

describe("A8 synthesis drawer: status copy boundaries not covered by e2e", () => {
  it("ambiguous renders neutral candidate copy without ranking language", async () => {
    const defer = installDeferredSynthesisStub();
    const user = userEvent.setup();
    render(<App />);

    const drawer = await openDrawer(user);
    await selectIncompleteRoute(user, drawer);
    defer.releaseEnvelope(fullEnvelope([candidate("a1"), candidate("a2")], { status: "ambiguous" }));

    await waitFor(() => expect(within(drawer).getByText(/2 candidates assembled from geometry observed on other recorded routes in this generation/)).toBeTruthy());
    expect(within(drawer).getByRole("group", { name: "Synthesis candidates" })).toBeTruthy();
    // Ambiguous is a settled state: no unavailable tone, no ranking copy.
    expect(drawer.querySelector(".synthesis-unavailable")).toBeNull();
    expect(within(drawer).queryByText(/best|shortest|recommended|preferred/i)).toBeNull();
  });

  it("over-limit renders the bounded neutral copy with the unavailable tone and no candidates", async () => {
    const defer = installDeferredSynthesisStub();
    const user = userEvent.setup();
    render(<App />);

    const drawer = await openDrawer(user);
    await selectIncompleteRoute(user, drawer);
    defer.releaseEnvelope({ status: "over-limit", corridorCount: 3, corridorsCovered: 3, candidates: [] });

    await waitFor(() => expect(within(drawer).getByText(/Too many donor combinations to list/)).toBeTruthy());
    expect(within(drawer).getByText(/No candidate was truncated or silently chosen/)).toBeTruthy();
    expect(within(drawer).queryByRole("group", { name: "Synthesis candidates" })).toBeNull();
    expect(drawer.querySelector(".synthesis-status.synthesis-unavailable")).toBeTruthy();
  });

  it("not-needed renders the complete-source neutral copy", async () => {
    const defer = installDeferredSynthesisStub();
    const user = userEvent.setup();
    render(<App />);

    const drawer = await openDrawer(user);
    await selectIncompleteRoute(user, drawer);
    defer.releaseEnvelope({ status: "not-needed", corridorCount: 0, corridorsCovered: 0, candidates: [] });

    await waitFor(() => expect(within(drawer).getByText(/Source route is complete; no synthesis is needed/)).toBeTruthy());
    expect(within(drawer).queryByRole("group", { name: "Synthesis candidates" })).toBeNull();
  });
});

describe("A8 synthesis drawer: failures and boundary payloads", () => {
  it("a network-level failure renders the structured error alert and recovers via Retry synthesis", async () => {
    const defer = installDeferredSynthesisStub();
    const user = userEvent.setup();
    render(<App />);

    const drawer = await openDrawer(user);
    await selectIncompleteRoute(user, drawer);
    await waitFor(() => expect(defer.pendingCount()).toBe(1));
    // Transport-level failure (never an HTTP envelope).
    defer.releaseError(new TypeError("Failed to fetch"));

    const alert = await within(drawer).findByRole("alert");
    // apiMessage surfaces the transport error's own message for non-ApiError failures.
    expect(within(alert).getByText("Failed to fetch")).toBeTruthy();
    expect(within(drawer).queryByRole("group", { name: "Synthesis candidates" })).toBeNull();

    await user.click(within(alert).getByRole("button", { name: "Retry synthesis" }));
    await waitFor(() => expect(defer.pendingCount()).toBe(1));
    defer.releaseEnvelope(fullEnvelope([candidate("recovered")]));
    await waitFor(() => expect(within(drawer).queryByRole("alert")).toBeNull());
    expect(within(drawer).getByRole("group", { name: "Synthesis candidates" })).toBeTruthy();
  });

  it("partial status with an empty candidate list renders neutral copy without metrics or crash", async () => {
    const defer = installDeferredSynthesisStub();
    const user = userEvent.setup();
    render(<App />);

    const drawer = await openDrawer(user);
    await selectIncompleteRoute(user, drawer);
    defer.releaseEnvelope({ status: "partial", corridorCount: 2, corridorsCovered: 1, candidates: [] });

    await waitFor(() => expect(within(drawer).getByText(/Only some gap corridors could be covered by observed donor geometry/)).toBeTruthy());
    expect(within(drawer).queryByRole("group", { name: "Synthesis candidates" })).toBeNull();
    expect(drawer.querySelector(".metric-grid")).toBeNull();
    // The fixed inspection-aid evidence still renders alongside the status.
    expect(within(drawer).getByText(/inspection aids only/)).toBeTruthy();
  });

  it("a candidate at the provenance cap (8 borrowed segments) renders every row without crashing", async () => {
    const defer = installDeferredSynthesisStub();
    const user = userEvent.setup();
    render(<App />);

    const drawer = await openDrawer(user);
    await selectIncompleteRoute(user, drawer);
    defer.releaseEnvelope(fullEnvelope([candidate("capped", {
      segments: Array.from({ length: 8 }, (_, index) => ({
        kind: "borrowed",
        geometry: { type: "LineString", coordinates: [[-80 - index, 39], [-80.5 - index, 38.8]] },
        distanceNm: 10 + index,
        matchMethod: index % 2 === 0 ? "exact-coordinate" : "reference",
        donorCount: 1,
        proofIds: [`proof-cap-${index}`],
      })),
    })]));

    await waitFor(() => expect(within(drawer).getByRole("group", { name: "Synthesis candidates" })).toBeTruthy());
    expect(within(drawer).getAllByText("Borrowed segment provenance")).toHaveLength(8);
    expect(within(drawer).getAllByText(/match by exact coordinate/)).toHaveLength(4);
    expect(within(drawer).getAllByText(/match by exact reference identity/)).toHaveLength(4);
  });
});

describe("A8 synthesis drawer: double-open and double-trigger dedup", () => {
  it("double-clicking the drawer trigger yields one drawer and one synthesis request per selection", async () => {
    const defer = installDeferredSynthesisStub();
    const user = userEvent.setup();
    render(<App />);

    await user.dblClick(await screen.findByRole("button", { name: "Show observed-donor synthesis" }));
    // Exactly one drawer instance — no duplicated surface.
    expect(screen.getAllByRole("region", { name: "Observed-donor synthesis" })).toHaveLength(1);
    expect(synthesisCalls(defer.calls)).toHaveLength(0);

    const drawer = screen.getByRole("region", { name: "Observed-donor synthesis" });
    await selectIncompleteRoute(user, drawer);
    // The double-open must not have armed duplicate requests: selecting the
    // target fires exactly one POST /api/v1/routes/synthesis.
    await waitFor(() => expect(synthesisCalls(defer.calls)).toHaveLength(1));
    defer.releaseEnvelope(fullEnvelope([candidate("single")]));
    await waitFor(() => expect(within(drawer).getByRole("group", { name: "Synthesis candidates" })).toBeTruthy());
    expect(synthesisCalls(defer.calls)).toHaveLength(1);
  });
});
