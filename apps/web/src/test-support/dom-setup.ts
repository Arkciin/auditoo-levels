/**
 * Setup of the component tests (the `web-dom` Vitest project, on happy-dom): DOM matchers such as
 * `toBeVisible()` or `toHaveFocus()`, and a clean document between tests (Testing Library only
 * cleans up by itself when test globals are enabled, which they are not).
 */
import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(() => {
  cleanup();
});
