import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  compareByPosition,
  comparePositions,
  isValidPosition,
  positionAtEnd,
  positionAtIndex,
  positionBetween,
} from "./positions";

/** Small deterministic PRNG (mulberry32) so property tests can drive the jitter. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("isValidPosition", () => {
  it("accepts keys produced by the generator", () => {
    expect(isValidPosition(positionBetween(null, null))).toBe(true);
    expect(isValidPosition("a0")).toBe(true);
    expect(isValidPosition("a0V")).toBe(true);
  });

  it("rejects malformed keys", () => {
    expect(isValidPosition("")).toBe(false);
    expect(isValidPosition("a0!")).toBe(false);
    expect(isValidPosition("a00")).toBe(false); // fractional part must not end with "0"
    expect(isValidPosition("0a")).toBe(false);
    expect(isValidPosition(`a${"1".repeat(200)}`)).toBe(false);
  });
});

describe("comparePositions", () => {
  it("uses code-unit order, unlike localeCompare", () => {
    const keys = ["a0", "Zz", "a0V", "B0"];
    expect([...keys].sort(comparePositions)).toEqual(["B0", "Zz", "a0", "a0V"]);
    // The trap this helper exists for: locale-aware sorting interleaves cases.
    expect([...keys].sort((a, b) => a.localeCompare(b))).not.toEqual(["B0", "Zz", "a0", "a0V"]);
  });

  it("breaks ties by id", () => {
    const a = { id: "1", position: "a1" };
    const b = { id: "2", position: "a1" };
    expect([b, a].sort(compareByPosition)).toEqual([a, b]);
  });
});

describe("positionBetween", () => {
  it("generates a key strictly between its bounds", () => {
    const random = seeded(1);
    const first = positionBetween(null, null, random);
    const last = positionBetween(first, null, random);
    const middle = positionBetween(first, last, random);
    expect(first < middle && middle < last).toBe(true);
    expect(positionBetween(null, first, random) < first).toBe(true);
  });

  it("jitters so that concurrent appends do not collide", () => {
    // Seeded: with Math.random, 1,000 draws among ~14.5 million suffixes collide ~3 % of the
    // time (birthday bound), which would make this test flaky without saying anything useful.
    const random = seeded(7);
    const keys = new Set(Array.from({ length: 1000 }, () => positionBetween("a1", null, random)));
    expect(keys.size).toBe(1000);
  });

  it("degrades gracefully when the neighbours share a key", () => {
    const key = positionBetween("a1", "a1");
    expect(key > "a1").toBe(true);
    expect(isValidPosition(key)).toBe(true);
  });

  it("keeps the list ordered under any sequence of inserts", () => {
    fc.assert(
      fc.property(
        fc.integer(),
        fc.array(fc.nat(), { minLength: 1, maxLength: 200 }),
        (seed, picks) => {
          const random = seeded(seed);
          const list: { id: string; position: string }[] = [];
          picks.forEach((pick, i) => {
            const index = pick % (list.length + 1);
            list.splice(index, 0, {
              id: String(i),
              position: positionAtIndex(list, index, random),
            });
          });
          for (let i = 1; i < list.length; i++) {
            const previous = list[i - 1];
            const current = list[i];
            if (!previous || !current) throw new Error("unreachable");
            expect(previous.position < current.position).toBe(true);
            expect(isValidPosition(current.position)).toBe(true);
          }
        },
      ),
      { numRuns: 300 },
    );
  });

  it("keeps keys short when appending, the most common operation", () => {
    const list: { id: string; position: string }[] = [];
    for (let i = 0; i < 500; i++) list.push({ id: String(i), position: positionAtEnd(list) });
    expect(Math.max(...list.map((item) => item.position.length))).toBeLessThanOrEqual(8);
  });
});
