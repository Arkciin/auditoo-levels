/**
 * Ordering with fractional indexes.
 *
 * Every orderable entity stores a `position` string. Sorting by that string (plain code-unit
 * comparison, see `comparePositions`) gives the display order. Moving an item only rewrites its
 * own key, so a reorder is a single-row, single-mutation change: exactly what an offline queue
 * wants.
 *
 * We add two things on top of the `fractional-indexing` package:
 *
 * 1. **Jitter.** Two devices that are offline and append to the same list compute the *same*
 *    key (the algorithm is deterministic). A short random suffix makes such collisions
 *    practically impossible (~1 in 14 million) without breaking the ordering guarantees.
 * 2. **Deterministic tie-break.** Should two keys still be equal, items are ordered by id, so
 *    every device renders the exact same order.
 */
import { BASE_62_DIGITS, generateKeyBetween } from "fractional-indexing";

const JITTER_LENGTH = 4;
const MAX_POSITION_LENGTH = 128;
const POSITION_PATTERN = /^[A-Za-z][0-9A-Za-z]*$/;

export interface Positioned {
  readonly id: string;
  readonly position: string;
}

/** Returns true when `key` is a well-formed fractional index that the library can build upon. */
export function isValidPosition(key: string): boolean {
  if (key.length > MAX_POSITION_LENGTH || !POSITION_PATTERN.test(key)) return false;
  try {
    // The library validates its inputs and throws on malformed keys.
    generateKeyBetween(key, null);
    return true;
  } catch {
    return false;
  }
}

/**
 * Compares two keys by UTF-16 code units, which is what fractional indexes are designed for.
 * Never use `localeCompare` (or a database collation other than "C"): locale-aware ordering
 * interleaves upper- and lower-case letters and silently breaks the order.
 */
export function comparePositions(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** Display order: by position, then by id so that equal keys still sort identically everywhere. */
export function compareByPosition(a: Positioned, b: Positioned): number {
  return comparePositions(a.position, b.position) || comparePositions(a.id, b.id);
}

export function sortByPosition<T extends Positioned>(items: Iterable<T>): T[] {
  return [...items].sort(compareByPosition);
}

/**
 * Generates a key that sorts strictly between `before` and `after` (`null` = list boundary).
 * `random` is injectable to make tests deterministic.
 */
export function positionBetween(
  before: string | null,
  after: string | null,
  random: () => number = Math.random,
): string {
  if (before !== null && after !== null && before >= after) {
    // Only reachable when two siblings share a key (see module comment). No key fits strictly
    // between equal keys, so the item lands right after them; the order stays deterministic.
    return withJitter(generateKeyBetween(before, null), null, random);
  }
  return withJitter(generateKeyBetween(before, after), after, random);
}

/**
 * Key for an item dropped at `index` among `siblings`.
 * `siblings` must be sorted with `compareByPosition` and must not contain the moved item.
 */
export function positionAtIndex(
  siblings: readonly Positioned[],
  index: number,
  random: () => number = Math.random,
): string {
  const before = index > 0 ? (siblings[index - 1]?.position ?? null) : null;
  const after = siblings[index]?.position ?? null;
  return positionBetween(before, after, random);
}

/** Key placing an item after every sibling. */
export function positionAtEnd(
  siblings: readonly Positioned[],
  random: () => number = Math.random,
): string {
  return positionAtIndex(siblings, siblings.length, random);
}

function withJitter(key: string, after: string | null, random: () => number): string {
  let suffix = "";
  for (let i = 0; i < JITTER_LENGTH - 1; i++) {
    suffix += BASE_62_DIGITS[Math.floor(random() * BASE_62_DIGITS.length)];
  }
  // A fractional part must not end with the zero digit, so the last character skips "0".
  suffix += BASE_62_DIGITS[1 + Math.floor(random() * (BASE_62_DIGITS.length - 1))];

  const candidate = key + suffix;
  // `key + suffix` is always greater than `key`; it only overshoots when `after` starts with
  // `key`. In that rare case we keep the un-jittered key, which is still strictly in range.
  return after === null || candidate < after ? candidate : key;
}
