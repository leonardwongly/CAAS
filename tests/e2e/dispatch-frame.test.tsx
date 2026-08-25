import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../../apps/web/src/App.tsx";
import { installApiStub } from "../fixtures/web-app.ts";

/**
 * DISPATCH briefing frame structure (redesign Task 4): the docked
 * command strip, manifest, workbench spine, and doc-control footer
 * replace the old floating topbar/rail/drawer layout. Render/mock
 * setup mirrors tests/e2e/interaction.test.tsx.
 */

// window.confirm is not implemented by jsdom; restore any per-test spy on it.
afterEach(() => {
  vi.restoreAllMocks();
});

describe("DISPATCH briefing frame", () => {
  it("renders the command strip, manifest, workbench spine, and doc-control footer", async () => {
    installApiStub();
    render(<App />);

    expect(screen.getByRole("banner", { name: "Command strip" })).toBeTruthy();
    expect(document.querySelector(".briefing-frame")).toBeTruthy();
    // DOM order pin: the command strip precedes the advisory band.
    const strip = screen.getByRole("banner", { name: "Command strip" });
    const advisory = screen.getByRole("region", { name: "Safety notice" });
    expect(strip.compareDocumentPosition(advisory) & document.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(document.querySelector(".manifest")).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "Route workspace controls" })).toBeTruthy();
    expect(screen.getByText("SPEC-FRE-002")).toBeTruthy();
    expect(screen.getByText(/REV C/)).toBeTruthy();
    for (const tab of ["Routes", "Data", "Compare"]) {
      expect(screen.getByRole("button", { name: tab })).toBeTruthy();
    }
    expect(screen.getByRole("button", { name: "Explore variation" })).toBeTruthy();
  });
});
