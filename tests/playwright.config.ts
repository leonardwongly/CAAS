import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./browser",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  // The HTML report must not live inside outputDir (test-results): Playwright
  // clears the report folder at generation, which would delete the failure
  // traces/videos CI uploads. Keep it a sibling so tests/test-results stays intact.
  reporter: process.env.CI ? [["github"], ["html", { outputFolder: "test-results-html/playwright-report", open: "never" }]] : "list",
  use: {
    baseURL: "http://127.0.0.1:4173",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
  webServer: {
    command: "pnpm --filter @flight-route-explorer/web run build && pnpm --filter @flight-route-explorer/web exec vite preview --host 127.0.0.1 --port 4173 --strictPort",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
