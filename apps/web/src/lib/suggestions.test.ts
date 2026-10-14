import { describe, expect, it } from "vitest";
import {
  levelInsertIndex,
  levelRank,
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

describe("plural", () => {
  it("follows French rules", () => {
    expect(plural(0, "pièce", "pièces")).toBe("0 pièce");
    expect(plural(2, "pièce", "pièces")).toBe("2 pièces");
  });
});
