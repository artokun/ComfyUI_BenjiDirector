import { createHash } from "node:crypto";
import { defineConfig, devices } from "@playwright/test";

// End-to-end against the dev harness (packages/director-app/index.html), headless Chromium.
//
// Each git worktree gets its OWN port derived from its path, so twenty workers can run their
// suites at once without colliding. Override with E2E_PORT.
const port = Number(process.env.E2E_PORT) || 5200 + (parseInt(createHash("sha1").update(process.cwd()).digest("hex").slice(0, 6), 16) % 400);
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: ".",
  testMatch: /.*\.spec\.ts$/,
  outputDir: "./out/test-results",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"]],
  use: {
    baseURL,
    viewport: { width: 1440, height: 900 },
    colorScheme: "dark",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `npx vite --port ${port} --strictPort --clearScreen false`,
    cwd: "../packages/director-app",
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
