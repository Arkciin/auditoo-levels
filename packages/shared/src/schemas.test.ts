import { describe, expect, it } from "vitest";
import { levelSchema, nameSchema, propertySchema } from "./schemas";

const char = (codePoint: number) => String.fromCodePoint(codePoint);
const hex = (codePoint: number) => codePoint.toString(16).toUpperCase().padStart(4, "0");

const CONTROL_MESSAGE =
  "Le nom contient des caractères invisibles non autorisés (retour à la ligne, tabulation…)";

describe("nameSchema", () => {
  it("trims surrounding whitespace, line breaks and tabs included", () => {
    expect(nameSchema.parse(`${char(0x0a)}  Cuisine ${char(0x09)}${char(0x0d)}`)).toBe("Cuisine");
  });

  it("keeps letters, digits, punctuation, emoji and non-breaking spaces", () => {
    const names = [
      "Chambre 1",
      "Rez-de-chaussée",
      "Salle d’eau (étage)",
      `R${char(0xa0)}+1`,
      "Séjour 🛋️",
    ];
    for (const name of names) expect(nameSchema.parse(name)).toBe(name);
  });

  // C0 (NUL, which PostgreSQL refuses in text, tab, line feed, escape…), DEL and C1.
  const controls = [0x00, 0x01, 0x09, 0x0a, 0x0d, 0x1b, 0x1f, 0x7f, 0x80, 0x85, 0x9f];
  it.each(controls.map((codePoint) => [hex(codePoint), codePoint] as const))(
    "refuses U+%s inside a name, in French",
    (_, codePoint) => {
      const result = nameSchema.safeParse(`Cui${char(codePoint)}sine`);
      expect(result.success).toBe(false);
      expect(result.error?.issues.map((issue) => issue.message)).toEqual([CONTROL_MESSAGE]);
    },
  );

  // Half an emoji: UTF-8 cannot encode it, and the server would store U+FFFD instead.
  it.each([
    ["a high surrogate alone", "Séjour \ud83d"],
    ["a low surrogate alone", "\ude00 Séjour"],
    ["halves in the wrong order", "Cui\ude00\ud83dsine"],
  ])("refuses broken text: %s, in French", (_, name) => {
    const result = nameSchema.safeParse(name);
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.message)).toEqual([
      "Le nom contient un caractère mal formé (un emoji coupé, par exemple)",
    ]);
  });

  it("keeps whole emoji, made of a surrogate pair", () => {
    expect(nameSchema.parse("Séjour 😀")).toBe("Séjour 😀");
  });

  it("still requires a name of at most 80 characters", () => {
    expect(nameSchema.safeParse(" ").error?.issues[0]?.message).toBe("Le nom est obligatoire");
    expect(nameSchema.safeParse("x".repeat(81)).error?.issues[0]?.message).toBe(
      "Le nom ne doit pas dépasser 80 caractères",
    );
  });
});

describe("row schemas", () => {
  it.each([
    ["a tab", `Ancien${char(0x09)}nom`],
    ["half an emoji", "Ancien nom \ud83d"],
  ])(
    "accept names stored under older rules (%s), so that legacy rows keep syncing",
    (_, legacy) => {
      const property = {
        id: "0199f0a0-0000-7000-8000-000000000001",
        name: legacy,
        createdAt: 1,
        deletedAt: null,
      };
      expect(propertySchema.parse(property)).toEqual(property);
      const level = { ...property, propertyId: property.id, position: "a0" };
      expect(levelSchema.parse(level)).toMatchObject({ name: legacy });
    },
  );
});
