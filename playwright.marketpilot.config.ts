import { defineConfig, devices } from "@playwright/test";
const production = process.env.MARKETPILOT_E2E_PRODUCTION === "1";
const port = process.env.MARKETPILOT_E2E_PORT || "3100";
const baseURL = process.env.MARKETPILOT_E2E_BASE_URL || `http://127.0.0.1:${port}`;
// Test-only credentials for an isolated loopback server; never used by the app as a default.
const password = production ? "marketpilot-local-browser-test" : "";
export default defineConfig({
  testDir: "./tests/marketpilot-browser", fullyParallel: false, workers: 1, timeout: 60000,
  use: { baseURL, trace: "retain-on-failure", screenshot: "only-on-failure", httpCredentials: production ? { username: "pilot", password, send: "always" } : undefined },
  webServer: process.env.MARKETPILOT_E2E_EXTERNAL ? undefined : { command: `node node_modules/next/dist/bin/next ${production ? "start" : "dev"} --hostname 127.0.0.1 --port ${port}`, url: baseURL, reuseExistingServer: false, timeout: 120000, env: { MARKETPILOT_DATA_DIR: `.marketpilot-e2e/run-${Date.now()}`, MARKETPILOT_PASSWORD: password, ANGEL_API_KEY: "", ANGEL_ACCESS_TOKEN: "", MARKETPILOT_SPECS_FILE: "", WTI_CONTEXT_URL: "", BRENT_CONTEXT_URL: "", OIL_NEWS_URL: "" } },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 1100 } } }],
});
