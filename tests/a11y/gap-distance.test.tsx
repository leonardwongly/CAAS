import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import App from "../../apps/web/src/App.tsx";
import { GAP_DISTANCE_ANNOTATION_CAVEAT } from "../../apps/web/src/labels.ts";
import { installApiStub } from "../fixtures/web-app.ts";

describe("estimated-distance accessibility", () => {
  it("keeps lower bounds and their non-operational meaning inside the named left drawer", async () => {
    installApiStub();
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole("button", { name: "Show visual estimate" }));
    const drawer = await screen.findByRole("region", { name: "Estimated gap preview" });
    expect(within(drawer).getByRole("heading", { name: "Choose a source route with gaps" })).toBeTruthy();
    await user.click(within(drawer).getByRole("button", { name: /Recorded with unresolved gap/ }));

    await waitFor(() => expect(within(drawer).getByRole("heading", { name: "Estimated gap preview" })).toBeTruthy());
    expect(within(drawer).getByText("Continuous-route minimum")).toBeTruthy();
    expect(within(drawer).getByText("Not an expected or source route total")).toBeTruthy();
    expect(within(drawer).getByText("Calibration status")).toBeTruthy();
    expect(within(drawer).getByText(GAP_DISTANCE_ANNOTATION_CAVEAT)).toBeTruthy();
    expect(within(drawer).getByText("Ranking").nextElementSibling?.textContent).toBe("Excluded");
  });
});
