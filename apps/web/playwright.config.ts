import { defineConfig, devices } from "@playwright/test";

// End-to-end tests run against the production server (API + built web app), so build first:
// `pnpm build && pnpm e2e`.
const PORT = 4174;
const baseURL = `http://localhost:${PORT}`;

// Optional: a Chromium already on the machine instead of the one `playwright install` downloads.
const chromiumPath = process.env.PLAYWRIGHT_CHROMIUM_PATH;

export default defineConfig({
  testDir: "e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  // In CI: annotations on the run, plus an HTML report (with traces) uploaded when a test fails.
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      // A phone (touch, coarse pointer): rows are deleted by swiping, not with a delete button.
      name: "mobile-chromium",
      use: {
        ...devices["Pixel 7"],
        ...(chromiumPath ? { launchOptions: { executablePath: chromiumPath } } : {}),
      },
    },
  ],
  webServer: {
    command: "node ../server/dist/index.js",
    url: `${baseURL}/api/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    env: {
      PORT: String(PORT),
      // A fresh, empty database for every run, gone with the server: never a real one, even when
      // the shell has a DATABASE_URL (blank means unset for the server).
      DATABASE_URL: "",
      PGLITE_DATA_DIR: "memory://",
    },
  },
});
