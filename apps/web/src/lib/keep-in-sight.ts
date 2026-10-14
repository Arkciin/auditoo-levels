/** Room left between the element and whatever would cover it. */
const MARGIN_PX = 8;

/**
 * Scrolls the page, as little as possible, so that `element`, already partly in sight, is not
 * covered by the sticky header, the bottom action bar or the on-screen keyboard.
 *
 * Browsers only bring a field into view when it gets the focus: not when the keyboard then covers
 * what lies under it, nor when content added above pushes it down. Both bars are known from the
 * root's scroll padding (styles.css); the keyboard, from the visual viewport, which it shrinks.
 * The field matters more than what follows it: the element's top never goes under the header.
 * An element entirely out of sight is left alone: another scroll (to a new level, say) may be on
 * its way, which an instant one would cut short.
 */
export function keepInSight(element: Element): void {
  const { top, bottom } = element.getBoundingClientRect();
  const root = getComputedStyle(document.documentElement);
  const viewport = window.visualViewport;
  const viewportTop = viewport?.offsetTop ?? 0;
  const viewportBottom = viewport ? viewport.offsetTop + viewport.height : window.innerHeight;
  const visibleTop = Math.max(viewportTop, pixels(root.scrollPaddingTop));
  const visibleBottom = Math.min(
    viewportBottom,
    window.innerHeight - pixels(root.scrollPaddingBottom),
  );
  if (top >= visibleBottom || bottom <= visibleTop) return;
  const below = bottom + MARGIN_PX - visibleBottom;
  const delta = Math.min(below, top - MARGIN_PX - visibleTop);
  // Instant: the page moves along with the change that made it necessary (a new row, the
  // keyboard), so what is under the thumb stays put.
  if (delta > 0) window.scrollBy({ top: delta, behavior: "instant" });
}

function pixels(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
