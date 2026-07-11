import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  outputDir: "./test-results/playwright",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"], ["html", { outputFolder: "playwright-report", open: "never" }]],
  use: {
    baseURL: "http://127.0.0.1:5174",
    trace: "retain-on-failure",
    screenshot: "only-on-failure"
  },
  projects: [
    {
      name: "e2e",
      testIgnore: /visual\.spec\.ts/,
      use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } }
    },
    {
      name: "visual-light",
      testMatch: /visual\.spec\.ts/,
      use: { ...devices["Desktop Chrome"], colorScheme: "light" }
    },
    {
      name: "visual-dark",
      testMatch: /visual\.spec\.ts/,
      use: { ...devices["Desktop Chrome"], colorScheme: "dark" }
    }
  ],
  webServer: {
    command: "npm run build:web && npx vite preview --config web/vite.config.ts --host 127.0.0.1 --port 5174",
    url: "http://127.0.0.1:5174",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000
  }
});
