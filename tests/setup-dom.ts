import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

/**
 * Shared DOM test setup: unmount React trees and remove the stubbed global
 * `fetch` after every test so suites do not leak state into each other.
 */
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
