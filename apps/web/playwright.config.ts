import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig, devices } from "@playwright/test";

// End-to-end tests run against the production server (API + built web app), so build first:
// `pnpm build && pnpm e2e`.
const PORT = 4174;
const baseURL = `http://localhost:${PORT}`;

// A fresh, empty database for every run. Workers re-evaluate this file: they inherit the
// directory created by the runner through the environment instead of creating their own.
process.env.E2E_PGLITE_DATA_DIR ??= mkdtempSync(join(tmpdir(), "releve-e2e-"));
const pgliteDataDir = process.env.E2E_PGLITE_DATA_DIR;

const chromiumPath = process.env.PLAYWRIGHT_CHROMIUM_PATH;

export default defineConfig({
  testDir: "e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL,
    trace: "on-first-retry",
  },
  projects: [
    {
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
      PGLITE_DATA_DIR: pgliteDataDir,
    },
  },
});
