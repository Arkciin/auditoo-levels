import { describe, expect, it } from "vitest";
import {
  duplicateLevelIndex,
  duplicateLevelName,
  duplicateSpaceNames,
  levelInsertIndex,
  levelRank,
  levelsAndRooms,
  nextSpaceName,
  plural,
  suggestLevelNames,
  suggestSpaceNames,
} from "./suggestions";

describe("levelRank", () => {
  it.each([
    ["Sous-sol", -1],
    ["sous sol 2", -2],
    ["RDC", 0],
    ["Rez-de-chaussée", 0],
    ["R+1", 1],
    ["r + 3", 3],
    ["2e étage", 2],
    ["1er étage", 1],
    ["Combles", 1000],
    ["Grenier", 1000],
    ["Mezzanine", null],
  ])("%s → %s", (name, rank) => {
    expect(levelRank(name)).toBe(rank);
  });
});

describe("suggestLevelNames", () => {
  it("starts with the ground floor", () => {
    expect(suggestLevelNames([])).toEqual(["RDC", "R+1", "Sous-sol", "Combles"]);
  });

  it("proposes the next floor up", () => {
    expect(suggestLevelNames(["RDC", "R+1", "Sous-sol"])).toEqual(["R+2", "Combles"]);
  });
});

describe("levelInsertIndex", () => {
  const levels = [{ name: "RDC" }, { name: "R+1" }, { name: "Garage" }];

  it("puts a basement below the ground floor", () => {
    expect(levelInsertIndex(levels, "Sous-sol")).toBe(0);
  });

  it("puts the next floor right after the highest one", () => {
    expect(levelInsertIndex(levels, "R+2")).toBe(2);
  });

  it("appends names it does not understand", () => {
    expect(levelInsertIndex(levels, "Mezzanine")).toBe(3);
  });
});

describe("suggestSpaceNames", () => {
  it("adapts to the level", () => {
    expect(suggestSpaceNames("Sous-sol", [])[0]).toBe("Cave");
    expect(suggestSpaceNames("RDC", [])[0]).toBe("Entrée");
    expect(suggestSpaceNames("R+1", [])[0]).toBe("Chambre");
  });

  it("moves rooms already present to the end, except bedrooms", () => {
    const names = suggestSpaceNames("RDC", ["Entrée", "Chambre 1"]);
    expect(names.at(-1)).toBe("Entrée");
    expect(names).toContain("Chambre");
    expect(names.indexOf("Chambre")).toBeLessThan(names.indexOf("Entrée"));
  });
});

describe("nextSpaceName", () => {
  it("numbers bedrooms from the start", () => {
    expect(nextSpaceName("Chambre", [])).toBe("Chambre 1");
    expect(nextSpaceName("Chambre", ["Chambre 1", "chambre 3"])).toBe("Chambre 4");
  });

  it("numbers other rooms only when they repeat", () => {
    expect(nextSpaceName("WC", ["Cuisine"])).toBe("WC");
    expect(nextSpaceName("WC", ["WC"])).toBe("WC 2");
  });
});

describe("duplicateLevelName", () => {
  it("makes a floor the next free floor above it", () => {
    expect(duplicateLevelName("R+1", ["RDC", "R+1"])).toBe("R+2");
    expect(duplicateLevelName("R+1", ["RDC", "R+1", "R+2", "3e étage", "Combles"])).toBe("R+4");
    expect(duplicateLevelName("R+2", ["R+1", "R+2", "R+4"])).toBe("R+3");
  });

  it("keeps the spelling of the source", () => {
    expect(duplicateLevelName("1er étage", ["1er étage"])).toBe("2e étage");
    expect(duplicateLevelName("2ème étage", ["2ème étage"])).toBe("3ème étage");
    expect(duplicateLevelName("Étage 1", ["Étage 1"])).toBe("Étage 2");
    expect(duplicateLevelName("r + 1", ["r + 1"])).toBe("r + 2");
  });

  it("names any other level a copy, numbered when the name is taken", () => {
    expect(duplicateLevelName("RDC", ["RDC"])).toBe("RDC (copie)");
    expect(duplicateLevelName("Sous-sol", ["Sous-sol"])).toBe("Sous-sol (copie)");
    expect(duplicateLevelName("Combles", ["Combles"])).toBe("Combles (copie)");
    expect(duplicateLevelName("Mezzanine", ["Mezzanine", "Mezzanine (copie)"])).toBe(
      "Mezzanine (copie 2)",
    );
    // A copy of a copy is a copy of the original.
    expect(duplicateLevelName("RDC (copie)", ["RDC", "RDC (copie)"])).toBe("RDC (copie 2)");
  });

  it("stays within 80 characters, without splitting a character", () => {
    const long = `${"x".repeat(70)}🏠🏠🏠🏠🏠`; // 80 UTF-16 code units
    const copy = duplicateLevelName(long, [long]);
    expect(copy).toBe(`${"x".repeat(70)}🏠 (copie)`);
    expect(copy.length).toBeLessThanOrEqual(80);
  });
});

describe("duplicateLevelIndex", () => {
  const levels = [{ name: "Sous-sol" }, { name: "RDC" }, { name: "R+1" }, { name: "Combles" }];

  it("puts a floor where floors belong", () => {
    expect(duplicateLevelIndex(levels, 2, "R+2")).toBe(3);
  });

  it("puts anything else right after its source", () => {
    expect(duplicateLevelIndex(levels, 0, "Sous-sol (copie)")).toBe(1);
    expect(duplicateLevelIndex(levels, 1, "RDC (copie)")).toBe(2);
  });
});

describe("duplicateSpaceNames", () => {
  it("gives bedrooms the next free numbers of the logement and keeps the other names", () => {
    const source = ["Palier", "Chambre 1", "chambre 2", "Chambre parentale", "WC 2"];
    const property = ["Entrée", "WC", ...source, "Chambre 3"];
    expect(duplicateSpaceNames(source, property)).toEqual([
      "Palier",
      "Chambre 4",
      "Chambre 5",
      "Chambre parentale",
      "WC 2",
    ]);
  });
});

describe("plural", () => {
  it("follows French rules", () => {
    expect(plural(0, "pièce", "pièces")).toBe("0 pièce");
    expect(plural(2, "pièce", "pièces")).toBe("2 pièces");
  });
});

describe("levelsAndRooms", () => {
  it.each([
    [0, 0, "Aucun niveau"],
    [1, 0, "1 niveau, aucune pièce"],
    [2, 0, "2 niveaux, aucune pièce"],
    [1, 1, "1 niveau, 1 pièce"],
    [3, 12, "3 niveaux, 12 pièces"],
  ])("%i levels and %i rooms read « %s »", (levels, rooms, expected) => {
    expect(levelsAndRooms(levels, rooms)).toBe(expected);
  });
});
