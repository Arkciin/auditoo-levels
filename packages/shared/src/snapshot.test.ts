import { describe, expect, it } from "vitest";
import { applyPull, emptySnapshot } from "./snapshot";

const property = {
  id: "0199f0a0-0000-7000-8000-000000000001",
  name: "Maison",
  createdAt: 1,
  deletedAt: null,
};

describe("applyPull", () => {
  it("merges changed rows and keeps untouched collections by reference", () => {
    const snapshot = applyPull(emptySnapshot, {
      reset: false,
      changes: { properties: [property], levels: [], spaces: [] },
    });
    expect(snapshot.properties.get(property.id)).toEqual(property);
    expect(snapshot.levels).toBe(emptySnapshot.levels);
  });

  it("starts from scratch on reset", () => {
    const stale = applyPull(emptySnapshot, {
      reset: false,
      changes: { properties: [property], levels: [], spaces: [] },
    });
    const fresh = applyPull(stale, {
      reset: true,
      changes: { properties: [], levels: [], spaces: [] },
    });
    expect(fresh.properties.size).toBe(0);
  });
});
