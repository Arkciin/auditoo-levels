import { describe, expect, it } from "vitest";
import { formatSince } from "./relative-time";

const NOW = Date.UTC(2026, 9, 15, 10, 0, 0);
const SECOND = 1_000;
const MINUTE = 60 * SECOND;

describe("formatSince", () => {
  it.each([
    [0, "à l’instant"],
    [44 * SECOND, "à l’instant"],
    [2 * MINUTE, "il y a 2 minutes"],
    [59 * MINUTE, "il y a 59 minutes"],
    [3 * 60 * MINUTE, "il y a 3 heures"],
    [24 * 60 * MINUTE, "hier"],
  ])("%i ms ago reads « %s »", (ago, expected) => {
    expect(formatSince(NOW - ago, NOW)).toBe(expected);
  });

  it("never dates something after now, which a ticking clock can lag behind", () => {
    expect(formatSince(NOW + 2 * MINUTE, NOW)).toBe("à l’instant");
  });
});
