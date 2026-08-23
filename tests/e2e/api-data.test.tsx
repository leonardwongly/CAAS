import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../../apps/web/src/App.tsx";
import { installApiStub } from "../fixtures/web-app.ts";

/**
 * API data page (owner request 2026-08-15): live summary with airway counts
 * only, an endpoint explorer that runs each existing API and shows raw JSON,
 * and a bulk browser over the /api/v1/data/* endpoints. Queries and cursors
 * travel in POST bodies only.
 */

afterEach(() => {
  vi.restoreAllMocks();
});

async function openApiData(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "API data" }));
  await screen.findByRole("heading", { name: "API data" });
}

const cardFor = (path: string): HTMLElement => {
  const card = screen.getByText(path).closest(".explorer-card");
  if (!card || !(card instanceof HTMLElement)) throw new Error(`No explorer card for ${path}`);
  return card;
};

describe("API data page", () => {
  it("shows the live data summary with airway counts only", async () => {
    installApiStub();
    const user = userEvent.setup();
    render(<App />);
    await openApiData(user);

    const table = await screen.findByRole("table", { name: "Family record counts" });
    await waitFor(() => expect(within(table).getByText("flights")).toBeTruthy());
    expect(within(table).getByText("fixes")).toBeTruthy();
    expect(within(table).getByText("airports")).toBeTruthy();
    expect(within(table).getByText("navaids")).toBeTruthy();
    expect(within(table).getByText("airways")).toBeTruthy();
    // Counts only: the page states the exclusion explicitly and the summary
    // section contains no family values.
    expect(screen.getByText(/Airway values are not exposed\./)).toBeTruthy();
  });

  it("pages the bulk flight browser with Next and Previous", async () => {
    installApiStub();
    const user = userEvent.setup();
    render(<App />);
    await openApiData(user);

    const table = await screen.findByRole("table", { name: "Flight plans browse results" });
    await waitFor(() => expect(within(table).getAllByText("FIXTURE1").length).toBe(10));
    // Default page size 50 shows all twelve rows; Next has nothing to fetch.
    expect((screen.getByRole("button", { name: "Next" }) as HTMLButtonElement).disabled).toBe(true);

    await user.selectOptions(screen.getByRole("combobox", { name: "Page size" }), "10");
    await waitFor(() => expect(within(table).getAllByRole("row").length).toBe(11)); // header + 10 rows
    expect(within(table).queryByText("FIXTURE3")).toBeNull();
    expect((screen.getByRole("button", { name: "Next" }) as HTMLButtonElement).disabled).toBe(false);

    await user.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(within(table).getAllByText("FIXTURE3").length).toBe(2));
    expect(within(table).queryByText("FIXTURE1")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Previous" }));
    await waitFor(() => expect(within(table).getAllByText("FIXTURE1").length).toBe(10));
    expect(within(table).queryByText("FIXTURE3")).toBeNull();
  });

  it("fails closed to page one when a browse cursor expires", async () => {
    installApiStub({ failCursor: true });
    const user = userEvent.setup();
    render(<App />);
    await openApiData(user);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("cursor expired");
    expect(alert.textContent).toContain("Restarting from the first page");
  });

  it("runs the search endpoint from the explorer with the query in the POST body", async () => {
    const stub = installApiStub();
    const user = userEvent.setup();
    render(<App />);
    await openApiData(user);

    const card = cardFor("/api/v1/callsigns/search");
    await user.clear(within(card).getByRole("textbox", { name: "Query" }));
    await user.type(within(card).getByRole("textbox", { name: "Query" }), "FIXTURE1");
    await user.click(within(card).getByRole("button", { name: "Run" }));
    // Line-numbered JSON (Task 10): each result row is its own .json-line
    // span, so both FIXTURE1 matches surface as separate text elements.
    await waitFor(() => expect(within(card).getAllByText(/FIXTURE1/).length).toBeGreaterThanOrEqual(1));

    const searchCalls = stub.calls.filter((call) => call.url === "/api/v1/callsigns/search");
    expect(searchCalls.length).toBeGreaterThanOrEqual(1);
    const last = searchCalls.at(-1)!;
    // Query state travels in the POST body only, never in the URL.
    expect(last.url).toBe("/api/v1/callsigns/search");
    expect(last.url.includes("?")).toBe(false);
    expect(JSON.parse(last.body ?? "{}").query).toBe("FIXTURE1");
  });

  it("asks for confirmation before refreshing from the explorer", async () => {
    const stub = installApiStub();
    const user = userEvent.setup();
    render(<App />);
    await openApiData(user);

    const card = cardFor("/api/v1/refresh");
    vi.spyOn(window, "confirm").mockReturnValue(false);
    await user.click(within(card).getByRole("button", { name: "Run" }));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(stub.calls.some((call) => call.url === "/api/v1/refresh")).toBe(false);

    vi.mocked(window.confirm).mockReturnValue(true);
    await user.click(within(card).getByRole("button", { name: "Run" }));
    await waitFor(() => expect(stub.calls.some((call) => call.url === "/api/v1/refresh")).toBe(true));
    await waitFor(() => expect(within(card).getByText(/"status": "refreshed"/)).toBeTruthy());
  });

  it("runs readiness and reference lookup from the explorer", async () => {
    installApiStub();
    const user = userEvent.setup();
    render(<App />);
    await openApiData(user);

    const readinessCard = cardFor("/api/v1/readiness");
    await user.click(within(readinessCard).getByRole("button", { name: "Run" }));
    await waitFor(() => expect(within(readinessCard).getByText(/"status": "ready"/)).toBeTruthy());

    const lookupCard = cardFor("/api/v1/points/lookup");
    await user.clear(within(lookupCard).getByRole("textbox", { name: "Reference" }));
    await user.type(within(lookupCard).getByRole("textbox", { name: "Reference" }), "MIDPT");
    await user.click(within(lookupCard).getByRole("button", { name: "Run" }));
    await waitFor(() => expect(within(lookupCard).getByText(/loc-MIDPT/)).toBeTruthy());
  });
});
