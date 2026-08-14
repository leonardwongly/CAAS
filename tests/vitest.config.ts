import { defineConfig } from "vitest/config";

/**
 * Vitest configuration for the deterministic browser accessibility and
 * interaction lanes (plan §18: `test:a11y`, `test:e2e`). DOM tests run in
 * jsdom; layout-dependent checks (320 px reflow, forced colors, reduced
 * motion) are additionally executed against the built app in a real browser
 * and retained under docs/testing/accessibility-evidence.md.
 */
export default defineConfig({
  test: {
    environment: "jsdom",
    environmentOptions: {
      // pretendToBeVisual gives jsdom a requestAnimationFrame loop, which the
      // app uses for deterministic focus return (design §15.2).
      jsdom: { url: "http://localhost/", pretendToBeVisual: true },
    },
    include: ["a11y/**/*.test.tsx", "e2e/**/*.test.tsx", "responsive/**/*.test.ts", "responsive/**/*.test.tsx", "adversarial/**/*.test.tsx"],
    setupFiles: ["./setup-dom.ts"],
    css: false,
  },
});
