import { tmpdir } from "node:os";
import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

const e2ePort = Number(process.env.SUNABOT_E2E_PORT ?? "15174");
const e2eBaseUrl = `http://127.0.0.1:${e2ePort}`;
const e2eWebOutDir = JSON.stringify(path.join(tmpdir(), `sunabot-playwright-web-${e2ePort}`));

export default defineConfig({
  testDir: "./tests/e2e",
  outputDir: "./test-results/playwright",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"], ["html", { outputFolder: "playwright-report", open: "never" }]],
  use: {
    baseURL: e2eBaseUrl,
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
    command: `npm run build:web -- --outDir ${e2eWebOutDir} && npx vite preview --config apps/admin-web/vite.config.ts --host 127.0.0.1 --port ${e2ePort} --outDir ${e2eWebOutDir}`,
    url: e2eBaseUrl,
    reuseExistingServer: false,
    timeout: 120_000
  }
});
