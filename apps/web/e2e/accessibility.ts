/**
 * Accessibility scans with axe-core: WCAG 2.2 A and AA rules plus axe's best practices, on the
 * page as it is, in the light and the dark theme.
 *
 * A serious or critical violation fails the test (soft assertion: the test goes on, so one run
 * reports every screen). Moderate and minor ones are recorded as annotations of the test, shown
 * in the HTML report, without failing it.
 */
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";

/** An axe rule that failed, with the elements that failed it (axe-core's `Result`). */
type Violation = Awaited<ReturnType<AxeBuilder["analyze"]>>["violations"][number];

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa", "best-practice"];
const BLOCKING: ReadonlySet<string> = new Set(["serious", "critical"]);
const COLOR_SCHEMES = ["light", "dark"] as const;
const PAGE_STRUCTURE_RULES = ["landmark-one-main", "page-has-heading-one", "region"];

interface ScanOptions {
  /** A modal menu is open and its focus trap was checked (see `expectAccessibleMenu`). */
  readonly menuOpen?: boolean;
}

/** Scans the page in both themes; `state` names what is on screen, for the report. */
export async function expectAccessible(
  page: Page,
  state: string,
  { menuOpen = false }: ScanOptions = {},
): Promise<void> {
  await test.step(`accessibility: ${state}`, async () => {
    for (const colorScheme of COLOR_SCHEMES) {
      await page.emulateMedia({ colorScheme });
      await settled(page);
      // Legacy mode runs axe within the page. The default mode finishes each scan in a new tab,
      // which takes the focus from the page: open menus close and fields being edited blur, so
      // the next theme would be scanned on another state. (No iframes here: nothing is lost.)
      let builder = new AxeBuilder({ page }).withTags(TAGS).setLegacyMode(true);
      // With a modal menu open, only the menu is exposed: page structure rules (one main
      // landmark, an h1, content in landmarks) were checked without the menu.
      if (menuOpen) builder = builder.disableRules(PAGE_STRUCTURE_RULES);
      let { violations } = await builder.analyze();
      if (menuOpen) violations = await withoutPageHiddenByMenu(page, violations);
      const blocking = violations.filter((violation) => BLOCKING.has(violation.impact ?? ""));
      for (const violation of violations.filter((v) => !blocking.includes(v))) {
        test.info().annotations.push({
          type: `accessibility (${violation.impact})`,
          description: `${state}, ${colorScheme} theme: ${violation.id}, ${violation.help}`,
        });
      }
      expect
        .soft(
          blocking.map((violation) => `[${violation.impact}] ${violation.id}`),
          `${state}, ${colorScheme} theme:\n${report(blocking)}`,
        )
        .toEqual([]);
    }
    await page.emulateMedia({ colorScheme: null });
  });
}

/**
 * Scans a screen with a menu open. Radix menus are modal: they hide the rest of the page from
 * assistive technologies (`aria-hidden`, marked `data-aria-hidden`) and keep the keyboard in the
 * menu. axe cannot see that focus trap, so it reports the hidden page's buttons as focusable
 * (aria-hidden-focus). This checks the trap itself, then exempts those elements, and only them.
 */
export async function expectAccessibleMenu(page: Page, state: string): Promise<void> {
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  for (const key of ["Tab", "Shift+Tab"]) {
    await page.keyboard.press(key);
    await expect(menu).toBeVisible();
    expect(await menu.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  }
  await expectAccessible(page, state, { menuOpen: true });
  await expect(menu, "the menu stays open for both scans").toBeVisible();
}

async function withoutPageHiddenByMenu(page: Page, violations: Violation[]): Promise<Violation[]> {
  const kept: Violation[] = [];
  for (const violation of violations) {
    if (violation.id === "aria-hidden-focus") {
      // No frames nor shadow roots in this app: each target is a single selector.
      const selectors = violation.nodes.map((node) => node.target.join(" "));
      const hiddenByMenu = await page.evaluate(
        (list) =>
          list.every(
            (selector) =>
              document.querySelector(selector)?.getAttribute("data-aria-hidden") === "true",
          ),
        selectors,
      );
      if (hiddenByMenu) continue;
    }
    kept.push(violation);
  }
  return kept;
}

/**
 * Waits for sheets, menus and theme transitions to finish: mid-animation, a translucent element
 * would fail colour contrast. Endless animations (a spinner) are not waited for.
 */
async function settled(page: Page): Promise<void> {
  await page.waitForFunction(() =>
    document
      .getAnimations()
      .every(
        (animation) =>
          animation.playState !== "running" ||
          animation.effect?.getComputedTiming().iterations === Number.POSITIVE_INFINITY,
      ),
  );
}

function report(violations: readonly Violation[]): string {
  return violations
    .map((violation) => {
      const nodes = violation.nodes
        .map((node) => `  - ${node.target.join(" ")}\n    ${node.failureSummary ?? ""}`)
        .join("\n");
      return `[${violation.impact}] ${violation.id}: ${violation.help} (${violation.helpUrl})\n${nodes}`;
    })
    .join("\n");
}
