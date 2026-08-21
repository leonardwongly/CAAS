import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import App from "../../apps/web/src/App.tsx";
import { installApiStub } from "../fixtures/web-app.ts";

// Security sweep (deferred candidate, fixed by triage): malformed generation
// timestamps must never render the literal "Invalid Date" in the freshness
// strip or refresh-failure copy. The chip lives on the API data page
// (.summary-generation), so the test navigates there before asserting.

describe("malformed generation timestamps render defensively", () => {
  it("shows 'unknown time' instead of 'Invalid Date' in the freshness strip", async () => {
    installApiStub({ malformedTimestamps: true });
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "API data" }));
    // The chip's "fresh" word lives in a nested <strong>, so the matcher runs
    // against the element's full textContent rather than its direct text nodes.
    const chip = await screen.findByText(
      (_content, element) => element !== null && /Live data fresh · retrieved/.test(element.textContent ?? ""),
      { selector: ".summary-generation" },
    );
    expect(chip.textContent).not.toContain("Invalid Date");
    expect(chip.textContent).toContain("unknown time");
    expect(document.body.textContent ?? "").not.toContain("Invalid Date");
  });
});
