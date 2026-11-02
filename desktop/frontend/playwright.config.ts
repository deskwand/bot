import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  outputDir: "./test-results/artifacts",
  fullyParallel: true,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  globalSetup: "./tests/e2e/global-setup.ts",
  use: {
    baseURL: "http://127.0.0.1:5173",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "npm run dev:test",
    url: "http://127.0.0.1:5173/test.html",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
