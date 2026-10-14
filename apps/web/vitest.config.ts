import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

// Tests of UI code (components and screens) run in a simulated DOM; everything else, the sync
// engine first, in plain Node: faster, and nothing there should need a document.
const DOM_TESTS = ["src/components/**/*.test.{ts,tsx}", "src/features/**/*.test.{ts,tsx}"];

// Declaring projects makes this config a container named "web": `vitest --project web` runs both
// projects below, "web (node)" and "web (dom)", which inherit the alias.
export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    name: "web",
    projects: [
      {
        test: {
          name: "node",
          environment: "node",
          include: ["src/**/*.test.{ts,tsx}"],
          exclude: [...configDefaults.exclude, ...DOM_TESTS],
        },
      },
      {
        // React components rendered into happy-dom and driven like a user would, by role and
        // accessible name (Testing Library). happy-dom has no layout engine: tests that depend on
        // sizes stub them (e.g. a row's width for the swipe threshold).
        test: {
          name: "dom",
          environment: "happy-dom",
          include: DOM_TESTS,
          setupFiles: ["src/test-support/dom-setup.ts"],
        },
      },
    ],
  },
});
