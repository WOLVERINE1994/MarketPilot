import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/marketpilot-browser", fullyParallel: false, workers: 1, timeout: 60000,
  use: { baseURL: process.env.MARKETPILOT_E2E_BASE_URL || "http://127.0.0.1:3100", trace: "retain-on-failure", screenshot: "only-on-failure" },
  webServer: process.env.MARKETPILOT_E2E_EXTERNAL ? undefined : { command: "node node_modules/next/dist/bin/next dev --hostname 127.0.0.1 --port 3100", url: "http://127.0.0.1:3100", reuseExistingServer: false, timeout: 120000, env: { MARKETPILOT_DATA_DIR: `.marketpilot-e2e/run-${Date.now()}`, MARKETPILOT_PASSWORD: "", ANGEL_API_KEY: "", MARKETPILOT_SPECS_FILE: "" } },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 1100 } } }],
});
