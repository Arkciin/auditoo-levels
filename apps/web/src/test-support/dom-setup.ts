/**
 * Setup of the component tests (the `web (dom)` Vitest project, on happy-dom): DOM matchers such
 * as `toBeVisible()` or `toHaveFocus()`, and a clean document between tests (Testing Library only
 * cleans up by itself when test globals are enabled, which they are not).
 */
import "@testing-library/jest-dom/vitest";
import { cleanup, configure } from "@testing-library/react";
import { afterEach } from "vitest";

// `findBy…` and `waitFor` give up after 1 s by default: tight for a few IndexedDB transactions
// on a busy CI runner.
configure({ asyncUtilTimeout: 3_000 });

afterEach(() => {
  cleanup();
});
