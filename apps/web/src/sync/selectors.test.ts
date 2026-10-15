import type { Level, Property, Space } from "@repo/shared";
import { describe, expect, it } from "vitest";
import {
  isLevelLive,
  isSpaceLive,
  selectDeletedProperties,
  selectDeletedStructure,
  selectProperties,
  selectProperty,
  selectStructure,
} from "./selectors";
import { snapshotOf, uuid } from "./test-support/fixtures";

function property(n: number, createdAt: number, deletedAt: number | null = null): Property {
  return { id: uuid(n), name: `Logement ${n}`, createdAt, deletedAt };
}

function level(
  n: number,
  propertyId: string,
  position: string,
  deletedAt: number | null = null,
): Level {
  return { id: uuid(n), propertyId, name: `Niveau ${n}`, position, deletedAt };
}

function space(
  n: number,
  levelId: string,
  position: string,
  deletedAt: number | null = null,
): Space {
  return { id: uuid(n), levelId, name: `Pièce ${n}`, position, deletedAt };
}

describe("selectProperties", () => {
  it("lists non-deleted properties, newest first, ties broken by id", () => {
    const view = snapshotOf({
      properties: [
        property(1, 1_000),
        property(2, 3_000),
        property(3, 2_000),
        property(4, 2_000),
        property(5, 4_000, 5_000),
      ],
    });

    const ids = selectProperties(view).map((summary) => summary.property.id);

    expect(ids).toEqual([uuid(2), uuid(4), uuid(3), uuid(1)]);
  });

  it("counts levels and spaces, ignoring deleted ones and the spaces of deleted levels", () => {
    const house = property(1, 1_000);
    const flat = property(2, 2_000);
    const view = snapshotOf({
      properties: [house, flat],
      levels: [
        level(11, house.id, "a0"),
        level(12, house.id, "a1", 9_000),
        level(13, flat.id, "a0"),
      ],
      spaces: [
        space(21, uuid(11), "a0"),
        space(22, uuid(11), "a1", 9_000),
        space(23, uuid(12), "a0"), // Hidden with its deleted level.
      ],
    });

    expect(selectProperties(view)).toEqual([
      { property: flat, levelCount: 1, spaceCount: 0 },
      { property: house, levelCount: 1, spaceCount: 1 },
    ]);
  });

  it("returns the same instance for the same snapshot", () => {
    const view = snapshotOf({ properties: [property(1, 1_000)] });
    const other = snapshotOf({ properties: [property(1, 1_000)] });

    expect(selectProperties(view)).toBe(selectProperties(view));
    expect(selectProperties(other)).not.toBe(selectProperties(view));
    expect(selectProperties(other)).toEqual(selectProperties(view));
  });
});

describe("selectProperty", () => {
  it("returns live properties only", () => {
    const view = snapshotOf({ properties: [property(1, 1_000), property(2, 1_000, 2_000)] });

    expect(selectProperty(view, uuid(1))?.name).toBe("Logement 1");
    expect(selectProperty(view, uuid(2))).toBeUndefined();
    expect(selectProperty(view, uuid(3))).toBeUndefined();
  });
});

describe("isLevelLive and isSpaceLive", () => {
  it("are true only when the entity and all its parents exist and are not deleted", () => {
    const house = property(1, 1_000);
    const gone = property(2, 1_000, 2_000);
    const view = snapshotOf({
      properties: [house, gone],
      levels: [
        level(11, house.id, "a0"),
        level(12, house.id, "a1", 3_000),
        level(13, gone.id, "a0"),
      ],
      spaces: [
        space(21, uuid(11), "a0"),
        space(22, uuid(11), "a1", 4_000),
        space(23, uuid(12), "a0"), // In a deleted level.
        space(24, uuid(13), "a0"), // In a deleted property.
      ],
    });

    expect([11, 12, 13, 99].map((n) => isLevelLive(view, uuid(n)))).toEqual([
      true,
      false,
      false,
      false,
    ]);
    expect([21, 22, 23, 24, 99].map((n) => isSpaceLive(view, uuid(n)))).toEqual([
      true,
      false,
      false,
      false,
      false,
    ]);
  });
});

describe("selectStructure", () => {
  const house = property(1, 1_000);
  const other = property(2, 1_000);
  const view = snapshotOf({
    properties: [house, other],
    levels: [
      level(13, house.id, "a1"),
      level(11, house.id, "a1"), // Same key as level 13: the id decides.
      level(12, house.id, "a0"),
      level(14, house.id, "a2", 5_000),
      level(15, other.id, "Zz"),
    ],
    spaces: [
      space(21, uuid(11), "a2"),
      space(22, uuid(11), "a0"),
      space(23, uuid(11), "a1", 5_000),
      space(24, uuid(14), "a0"), // In a deleted level.
      space(25, uuid(15), "a0"), // In another property.
    ],
  });

  it("orders levels and spaces by position, then by id, hiding deleted ones", () => {
    const structure = selectStructure(view, house.id);

    expect(structure.map(({ level }) => level.id)).toEqual([uuid(12), uuid(11), uuid(13)]);
    expect(structure.map(({ spaces }) => spaces.map((s) => s.id))).toEqual([
      [],
      [uuid(22), uuid(21)],
      [],
    ]);
  });

  it("orders with code-unit comparison, not the locale", () => {
    const structure = selectStructure(view, other.id);
    expect(structure.map(({ level }) => level.position)).toEqual(["Zz"]);
    const mixed = snapshotOf({
      levels: [level(31, house.id, "a0"), level(32, house.id, "Zz")],
    });
    expect(selectStructure(mixed, house.id).map(({ level }) => level.position)).toEqual([
      "Zz",
      "a0",
    ]);
  });

  it("returns the same instance for the same snapshot and property", () => {
    expect(selectStructure(view, house.id)).toBe(selectStructure(view, house.id));
    expect(selectStructure(view, other.id)).not.toBe(selectStructure(view, house.id));
    expect(selectStructure(view, uuid(99))).toEqual([]);
  });
});

describe("selectDeletedProperties", () => {
  it("lists deleted properties only, last deleted first, ties broken by id", () => {
    const view = snapshotOf({
      properties: [
        property(1, 1_000, 7_000),
        property(2, 2_000),
        property(3, 3_000, 9_000),
        property(4, 4_000, 7_000),
      ],
    });

    const ids = selectDeletedProperties(view).map((entry) => entry.property.id);

    expect(ids).toEqual([uuid(3), uuid(4), uuid(1)]);
    expect(selectDeletedProperties(view)[0]?.deletedAt).toBe(9_000);
  });

  it("counts what restoring brings back, as the list of logements counts it", () => {
    const house = property(1, 1_000, 9_000);
    const view = snapshotOf({
      properties: [house],
      levels: [level(11, house.id, "a0"), level(12, house.id, "a1", 8_000)],
      spaces: [
        space(21, uuid(11), "a0"),
        space(22, uuid(11), "a1", 8_500),
        space(23, uuid(12), "a0"), // Hidden with its deleted level.
      ],
    });

    expect(selectDeletedProperties(view)).toEqual([
      { property: house, deletedAt: 9_000, levelCount: 1, spaceCount: 1 },
    ]);
  });

  it("returns the same instance for the same snapshot", () => {
    const view = snapshotOf({ properties: [property(1, 1_000, 2_000)] });

    expect(selectDeletedProperties(view)).toBe(selectDeletedProperties(view));
    expect(selectDeletedProperties(snapshotOf({}))).toEqual([]);
  });
});

describe("selectDeletedStructure", () => {
  const house = property(1, 1_000);
  const other = property(2, 1_000);
  const view = snapshotOf({
    properties: [house, other],
    levels: [
      level(11, house.id, "a0"),
      level(12, house.id, "a1", 5_000),
      level(13, house.id, "a2", 6_000),
      level(14, other.id, "a0", 9_000), // In another property.
    ],
    spaces: [
      space(21, uuid(11), "a0", 3_000),
      space(22, uuid(11), "a1", 7_000),
      space(23, uuid(11), "a2"),
      space(24, uuid(12), "a0"),
      space(25, uuid(12), "a1"),
      space(26, uuid(12), "a2", 4_000), // Deleted before its level: not back with it.
      space(27, uuid(14), "a0", 9_500), // In another property.
    ],
  });

  it("lists deleted levels, last deleted first, with the spaces restoring them brings back", () => {
    const { levels } = selectDeletedStructure(view, house.id);

    expect(levels).toEqual([
      { level: level(13, house.id, "a2", 6_000), deletedAt: 6_000, spaceCount: 0 },
      { level: level(12, house.id, "a1", 5_000), deletedAt: 5_000, spaceCount: 2 },
    ]);
  });

  it("lists the deleted spaces of non-deleted levels only, last deleted first", () => {
    const { spaces } = selectDeletedStructure(view, house.id);

    expect(spaces.map((entry) => [entry.space.id, entry.deletedAt, entry.level.id])).toEqual([
      [uuid(22), 7_000, uuid(11)],
      [uuid(21), 3_000, uuid(11)],
    ]);
  });

  it("returns the same instance for the same snapshot and property", () => {
    expect(selectDeletedStructure(view, house.id)).toBe(selectDeletedStructure(view, house.id));
    expect(selectDeletedStructure(view, other.id).levels.map(({ level }) => level.id)).toEqual([
      uuid(14),
    ]);
    expect(selectDeletedStructure(view, uuid(99))).toEqual({ levels: [], spaces: [] });
  });
});
