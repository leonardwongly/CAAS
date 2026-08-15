import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import App from "../../apps/web/src/App.tsx";
import { installApiStub } from "../fixtures/web-app.ts";

/**
 * Type-ahead supersession (search-as-you-type): a response from an older
 * query must never land visibly after a newer query has settled, even when
 * the transport ignores the abort signal. The client's sequence guard makes
 * this deterministic; the stub's deferred responses make it testable.
 */

describe("type-ahead supersession", () => {
  it("a stale deferred response never lands after a newer query settles", async () => {
    const stub = installApiStub({ deferSearch: true });
    const user = userEvent.setup();
    render(<App />);

    const input = screen.getByRole("combobox", { name: "Flight number or code" });

    // Query A ("F"): matches both fixture flights, held by the stub.
    await user.type(input, "F");
    await new Promise((resolve) => setTimeout(resolve, 400)); // debounce elapses → request A fires
    expect(stub.calls.filter((call) => call.url === "/api/v1/callsigns/search").length).toBe(1);

    // Query B ("Z"): supersedes A (abort + new request), also held.
    await user.clear(input);
    await user.type(input, "Z");
    await new Promise((resolve) => setTimeout(resolve, 400)); // debounce elapses → request B fires
    expect(stub.calls.filter((call) => call.url === "/api/v1/callsigns/search").length).toBe(2);

    // Release B first: the settled result is B's (no matches).
    stub.releaseSearch();
    const status = await screen.findByRole("status");
    expect(status.textContent).toContain("No flight plans matched Z.");

    // Release A afterwards: its stale payload must produce no visible change.
    stub.releaseSearch();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByRole("listbox", { name: "Choose an exact flight-plan match" })).toBeNull();
    expect(screen.getByRole("status").textContent).toContain("No flight plans matched Z.");
    expect((screen.getByRole("combobox", { name: "Flight number or code" }) as HTMLInputElement).value).toBe("Z");
  });
});
