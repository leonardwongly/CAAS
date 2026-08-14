import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import App from "../../apps/web/src/App.tsx";
import { installApiStub } from "../fixtures/web-app.ts";

// Security sweep (deferred candidate, fixed by triage): malformed generation
// timestamps must never render the literal "Invalid Date" in the freshness
// strip or refresh-failure copy.

describe("malformed generation timestamps render defensively", () => {
  it("shows 'unknown time' instead of 'Invalid Date' in the freshness strip", async () => {
    installApiStub({ malformedTimestamps: true });
    render(<App />);
    const chip = await screen.findByText(/Live data fresh · retrieved/);
    expect(chip.textContent).not.toContain("Invalid Date");
    expect(chip.textContent).toContain("unknown time");
    expect(document.body.textContent ?? "").not.toContain("Invalid Date");
  });
});
