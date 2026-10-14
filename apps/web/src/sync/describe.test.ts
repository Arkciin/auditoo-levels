import { type Mutation, MutationRejectedError, mutationArgsSchemas } from "@repo/shared";
import { describe, expect, it } from "vitest";
import { describeMutation, describeMutationError, describePendingMutations } from "./describe";
import { type Action, snapshotOf, uuid } from "./test-support/fixtures";

const PROPERTY = uuid(1);
const RDC = uuid(11);
const R1 = uuid(12);
const KITCHEN = uuid(21);
const WC = uuid(22);
const CELLAR = uuid(23);

const base = snapshotOf({
  properties: [{ id: PROPERTY, name: "12 rue des Lilas", createdAt: 1, deletedAt: null }],
  levels: [
    { id: RDC, propertyId: PROPERTY, name: "RDC", position: "a0", deletedAt: null },
    { id: R1, propertyId: PROPERTY, name: "R+1", position: "a1", deletedAt: 2 },
  ],
  spaces: [
    { id: KITCHEN, levelId: RDC, name: "Cuisine", position: "a0", deletedAt: null },
    { id: WC, levelId: RDC, name: "WC", position: "a1", deletedAt: null },
    { id: CELLAR, levelId: RDC, name: "Cave", position: "a2", deletedAt: null },
  ],
});

let sequence = 0;
function mutation(action: Action): Mutation {
  sequence += 1;
  return { id: sequence, timestamp: 1_000, ...action };
}

/** Writes expectations with plain spaces; French typography wants U+00A0 inside « ». */
function french(text: string): string {
  return text.replaceAll("« ", "«\u00a0").replaceAll(" »", "\u00a0»");
}

describe("describeMutation", () => {
  it.each<[string, Action]>([
    [
      "Logement « 12 rue des Lilas » créé",
      { name: "createProperty", args: { id: uuid(2), name: "12 rue des Lilas" } },
    ],
    [
      "« 12 rue des Lilas » renommé en « 14 rue des Lilas »",
      { name: "renameProperty", args: { id: PROPERTY, name: "14 rue des Lilas" } },
    ],
    ["Logement « 12 rue des Lilas » supprimé", { name: "deleteProperty", args: { id: PROPERTY } }],
    ["Logement « 12 rue des Lilas » restauré", { name: "restoreProperty", args: { id: PROPERTY } }],
    [
      "Niveau « R+2 » ajouté",
      {
        name: "createLevel",
        args: { id: uuid(13), propertyId: PROPERTY, name: "R+2", position: "a2" },
      },
    ],
    [
      "« RDC » renommé en « Rez-de-chaussée »",
      { name: "renameLevel", args: { id: RDC, name: "Rez-de-chaussée" } },
    ],
    ["Niveau « R+1 » déplacé", { name: "moveLevel", args: { id: R1, position: "Zz" } }],
    ["Niveau « RDC » supprimé", { name: "deleteLevel", args: { id: RDC } }],
    ["Niveau « R+1 » restauré", { name: "restoreLevel", args: { id: R1 } }],
    [
      "Pièce « Salon » ajoutée",
      { name: "createSpace", args: { id: uuid(24), levelId: RDC, name: "Salon", position: "a3" } },
    ],
    [
      "« Cuisine » renommée en « Cuisine ouverte »",
      { name: "renameSpace", args: { id: KITCHEN, name: "Cuisine ouverte" } },
    ],
    [
      "Pièce « WC » déplacée",
      { name: "moveSpace", args: { id: WC, levelId: RDC, position: "Zz" } },
    ],
    [
      "Pièce « WC » déplacée vers « R+1 »",
      { name: "moveSpace", args: { id: WC, levelId: R1, position: "a0" } },
    ],
    ["Pièce « Cave » supprimée", { name: "deleteSpace", args: { id: CELLAR } }],
    ["Pièce « Cave » restaurée", { name: "restoreSpace", args: { id: CELLAR } }],
  ])("%s", (expected, action) => {
    expect(describeMutation(mutation(action), base)).toBe(french(expected));
  });

  it("uses non-breaking spaces inside the quotes", () => {
    const text = describeMutation(mutation({ name: "deleteSpace", args: { id: CELLAR } }), base);
    expect(text).toBe("Pièce «\u00a0Cave\u00a0» supprimée");
  });

  it("falls back to a generic noun for entities it cannot find", () => {
    const unknown = uuid(99);
    const describeIt = (action: Action) => describeMutation(mutation(action), base);

    expect(describeIt({ name: "deleteSpace", args: { id: unknown } })).toBe("Pièce supprimée");
    expect(describeIt({ name: "restoreProperty", args: { id: unknown } })).toBe(
      "Logement restauré",
    );
    expect(describeIt({ name: "renameLevel", args: { id: unknown, name: "R+3" } })).toBe(
      french("Niveau renommé en « R+3 »"),
    );
    expect(
      describeIt({ name: "moveSpace", args: { id: KITCHEN, levelId: unknown, position: "a0" } }),
    ).toBe(french("Pièce « Cuisine » déplacée vers un autre niveau"));
  });
});

describe("describePendingMutations", () => {
  it("names entities as they were just before each mutation", () => {
    const pending = [
      mutation({ name: "renameSpace", args: { id: KITCHEN, name: "Cuisine ouverte" } }),
      mutation({ name: "renameSpace", args: { id: KITCHEN, name: "Cuisine américaine" } }),
      mutation({
        name: "createLevel",
        args: { id: uuid(13), propertyId: PROPERTY, name: "Combles", position: "a2" },
      }),
      mutation({ name: "renameLevel", args: { id: uuid(13), name: "Grenier" } }),
      mutation({
        name: "createSpace",
        args: { id: uuid(24), levelId: uuid(13), name: "Débarras", position: "a0" },
      }),
      mutation({ name: "moveSpace", args: { id: uuid(24), levelId: RDC, position: "a9" } }),
      mutation({ name: "moveSpace", args: { id: uuid(24), levelId: RDC, position: "a1" } }),
      mutation({ name: "deleteSpace", args: { id: uuid(24) } }),
    ];

    expect(describePendingMutations(base, pending)).toEqual(
      [
        "« Cuisine » renommée en « Cuisine ouverte »",
        "« Cuisine ouverte » renommée en « Cuisine américaine »",
        "Niveau « Combles » ajouté",
        "« Combles » renommé en « Grenier »",
        "Pièce « Débarras » ajoutée",
        "Pièce « Débarras » déplacée vers « RDC »",
        "Pièce « Débarras » déplacée",
        "Pièce « Débarras » supprimée",
      ].map(french),
    );
  });

  it("is memoized per state", () => {
    const pending = [mutation({ name: "deleteSpace", args: { id: WC } })];
    const descriptions = describePendingMutations(base, pending);

    expect(describePendingMutations(base, pending)).toBe(descriptions);
    expect(describePendingMutations(snapshotOf({}), pending)).toEqual(["Pièce supprimée"]);
  });
});

describe("describeMutationError", () => {
  it("shows the schema's French message for invalid input", () => {
    const { error } = mutationArgsSchemas.createProperty.safeParse({ id: PROPERTY, name: " " });
    expect(describeMutationError(error)).toBe("Le nom est obligatoire");
  });

  it("explains stale actions and storage failures", () => {
    expect(describeMutationError(new MutationRejectedError("Unknown level"))).toBe(
      "Cette action ne s'applique plus : les données ont changé entre-temps.",
    );
    expect(describeMutationError(new DOMException("Quota", "QuotaExceededError"))).toBe(
      "L'appareil n'a plus assez d'espace de stockage pour enregistrer la modification.",
    );
    expect(describeMutationError(new Error("boom"))).toBe(
      "La modification n'a pas pu être enregistrée sur l'appareil.",
    );
  });
});
