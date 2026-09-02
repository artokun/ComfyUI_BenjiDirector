import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { defineConfig, devices } from "@playwright/test";

/**
 * A Chromium to launch. Playwright wants the exact build its version pins; when that download
 * is missing or half-finished (a 150 MB pull on a slow link), any COMPLETE Chromium in the
 * shared cache is close enough for a dark canvas screenshot. PLAYWRIGHT_CHROME overrides.
 */
function chromiumExecutable(): string | undefined {
  if (process.env.PLAYWRIGHT_CHROME) return process.env.PLAYWRIGHT_CHROME;
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH || (process.platform === "win32" ? join(process.env.LOCALAPPDATA ?? "", "ms-playwright") : join(process.env.HOME ?? "", ".cache", "ms-playwright"));
  if (!existsSync(cache)) return undefined;
  const builds = readdirSync(cache)
    .filter((d) => /^chromium-\d+$/.test(d))
    .sort((a, b) => Number(b.slice(9)) - Number(a.slice(9)));
  for (const b of builds) {
    for (const rel of ["chrome-win64/chrome.exe", "chrome-win/chrome.exe", "chrome-linux/chrome", "chrome-mac/Chromium.app/Contents/MacOS/Chromium"]) {
      const exe = join(cache, b, rel);
      if (existsSync(exe)) return exe;
    }
  }
  return undefined;
}
const executablePath = chromiumExecutable();

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
  // `channel: "chromium"` runs the full Chromium build rather than the headless shell — one
  // binary to download (`npx playwright install chromium`), and screenshots match a real tab.
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], ...(executablePath ? { launchOptions: { executablePath } } : { channel: "chromium" }) } }],
  webServer: {
    command: `npx vite --host 127.0.0.1 --port ${port} --strictPort --clearScreen false`,
    cwd: "../packages/director-app",
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
