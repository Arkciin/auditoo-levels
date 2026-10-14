import { compareByPosition, type Level, mutationArgsSchemas, type Space } from "@repo/shared";
import { describe, expect, it } from "vitest";

import type { LevelStructure } from "@/sync";
import { uuid } from "@/sync/test-support/fixtures";
import { planDuplicate } from "./use-duplicate-level";

const PROPERTY = uuid(1);

function level(n: number, name: string, position: string): Level {
  return { id: uuid(n), propertyId: PROPERTY, name, position, deletedAt: null };
}

/** Rooms with ids from `firstId` on. */
function rooms(levelId: string, firstId: number, names: string[]): Space[] {
  return names.map((name, i) => ({
    id: uuid(firstId + i),
    levelId,
    name,
    position: `a${i}`,
    deletedAt: null,
  }));
}

const rdc = level(11, "RDC", "a0");
const r1 = level(12, "R+1", "a1");
const attic = level(13, "Combles", "a2");
const structure: LevelStructure[] = [
  { level: rdc, spaces: rooms(rdc.id, 100, ["Entrée", "Séjour", "Chambre 1"]) },
  { level: r1, spaces: rooms(r1.id, 200, ["Palier", "Chambre 2", "Chambre 3", "Salle de bain"]) },
  { level: attic, spaces: [] },
];

let ids = 1000;
const createId = () => uuid(++ids);

/** Level names in display order once `copy` is inserted. */
function levelsWith(copy: { id: string; name: string; position: string }): string[] {
  return [...structure.map((group) => group.level), copy]
    .sort(compareByPosition)
    .map((l) => l.name);
}

describe("planDuplicate", () => {
  it("copies a floor as the next floor, above it, with its bedrooms renumbered", () => {
    const copy = planDuplicate(structure, r1.id, createId);
    if (!copy) throw new Error("R+1 is in the structure");

    expect(mutationArgsSchemas.duplicateLevel.parse(copy)).toEqual(copy);
    expect(copy).toMatchObject({ sourceId: r1.id, name: "R+2" });
    expect(levelsWith(copy)).toEqual(["RDC", "R+1", "R+2", "Combles"]);
    // Same order as the source, bedrooms numbered after every bedroom of the logement.
    const names = [...copy.spaces].sort(compareByPosition).map((space) => space.name);
    expect(names).toEqual(["Palier", "Chambre 4", "Chambre 5", "Salle de bain"]);
  });

  it("copies any other level right after it", () => {
    const copy = planDuplicate(structure, rdc.id, createId);
    if (!copy) throw new Error("RDC is in the structure");

    expect(copy.name).toBe("RDC (copie)");
    expect(levelsWith(copy)).toEqual(["RDC", "RDC (copie)", "R+1", "Combles"]);
    expect(copy.spaces.map((space) => space.name)).toEqual(["Entrée", "Séjour", "Chambre 4"]);
  });

  it("copies an empty level, and nothing for a level it does not show", () => {
    expect(planDuplicate(structure, attic.id, createId)).toMatchObject({
      name: "Combles (copie)",
      spaces: [],
    });
    expect(planDuplicate(structure, uuid(99), createId)).toBeUndefined();
  });
});
