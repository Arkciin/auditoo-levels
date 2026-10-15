import { type Mutation, MutationRejectedError, mutationArgsSchemas } from "@repo/shared";
import { describe, expect, it } from "vitest";
import {
  describeMutation,
  describeMutationError,
  describePendingMutations,
  describeRejection,
} from "./describe";
import { StorageClosedError } from "./storage";
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

const COPY = uuid(14);

/** A copy of RDC carrying `count` rooms. */
function duplicateRdc(count: number): Action {
  const spaces = Array.from({ length: count }, (_, i) => ({
    id: uuid(31 + i),
    name: `Pièce ${i + 1}`,
    position: `a${i}`,
  }));
  return {
    name: "duplicateLevel",
    args: { id: COPY, sourceId: RDC, name: "RDC (copie)", position: "a0V", spaces },
  };
}

/** Writes expectations with plain spaces; French typography wants U+00A0 inside « » and before : */
function french(text: string): string {
  return text.replaceAll("« ", "«\u00a0").replaceAll(" »", "\u00a0»").replaceAll(" :", "\u00a0:");
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
    ["Niveau « RDC » dupliqué en « RDC (copie) » avec ses 3 pièces", duplicateRdc(3)],
    ["Niveau « RDC » dupliqué en « RDC (copie) » avec sa pièce", duplicateRdc(1)],
    ["Niveau « RDC » dupliqué en « RDC (copie) »", duplicateRdc(0)],
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
    const copyOfUnknown = duplicateRdc(0);
    if (copyOfUnknown.name !== "duplicateLevel") throw new Error("unreachable");
    copyOfUnknown.args.sourceId = unknown;
    expect(describeIt(copyOfUnknown)).toBe(french("Niveau dupliqué en « RDC (copie) »"));
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

  it("names the level and the rooms a copy created", () => {
    const pending = [
      mutation(duplicateRdc(1)),
      mutation({ name: "renameSpace", args: { id: uuid(31), name: "Cellier" } }),
      mutation({ name: "moveSpace", args: { id: uuid(31), levelId: RDC, position: "a9" } }),
      mutation({ name: "renameLevel", args: { id: COPY, name: "Studio" } }),
    ];

    expect(describePendingMutations(base, pending)).toEqual(
      [
        "Niveau « RDC » dupliqué en « RDC (copie) » avec sa pièce",
        "« Pièce 1 » renommée en « Cellier »",
        "Pièce « Cellier » déplacée vers « RDC »",
        "« RDC (copie) » renommé en « Studio »",
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

describe("a queued change this version cannot read", () => {
  // Typing boundary: a known kind, with arguments another version of the app wrote.
  const unreadable = {
    id: 99,
    timestamp: 1,
    name: "renameSpace",
    args: null,
  } as unknown as Mutation;

  it("is described as such, its fields never read", () => {
    const otherVersion = "Modification faite avec une autre version de Relevé";
    expect(describeMutation(unreadable, base)).toBe(otherVersion);
    const deleteWc = mutation({ name: "deleteSpace", args: { id: WC } });
    expect(describePendingMutations(base, [unreadable, deleteWc])).toEqual([
      otherVersion,
      french("Pièce « WC » supprimée"),
    ]);
    expect(describeRejection(unreadable, base, "invalid")).toBe(
      "Une modification faite avec une autre version de Relevé n'a pas pu être appliquée.",
    );
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
    const reload = "Relevé a été mis à jour dans un autre onglet. Rechargez cette page.";
    expect(describeMutationError(new StorageClosedError(reload))).toBe(reload);
    expect(describeMutationError(new Error("boom"))).toBe(
      "La modification n'a pas pu être enregistrée sur l'appareil.",
    );
  });
});

describe("describeRejection", () => {
  const refused = "le serveur a refusé de l'enregistrer";

  it.each<[string, Action]>([
    [
      "Le logement « Villa » n'a pas pu être créé",
      { name: "createProperty", args: { id: uuid(2), name: "Villa" } },
    ],
    [
      "Le logement « 12 rue des Lilas » n'a pas pu être renommé en « Villa »",
      { name: "renameProperty", args: { id: PROPERTY, name: "Villa" } },
    ],
    [
      "Le logement « 12 rue des Lilas » n'a pas pu être supprimé",
      { name: "deleteProperty", args: { id: PROPERTY } },
    ],
    [
      "Le logement « 12 rue des Lilas » n'a pas pu être restauré",
      { name: "restoreProperty", args: { id: PROPERTY } },
    ],
    [
      "Le niveau « R+2 » n'a pas pu être ajouté",
      {
        name: "createLevel",
        args: { id: uuid(13), propertyId: PROPERTY, name: "R+2", position: "a2" },
      },
    ],
    [
      "Le niveau « RDC » n'a pas pu être renommé en « Rez-de-chaussée »",
      { name: "renameLevel", args: { id: RDC, name: "Rez-de-chaussée" } },
    ],
    [
      "Le niveau « R+1 » n'a pas pu être déplacé",
      { name: "moveLevel", args: { id: R1, position: "Zz" } },
    ],
    ["Le niveau « RDC » n'a pas pu être supprimé", { name: "deleteLevel", args: { id: RDC } }],
    ["Le niveau « R+1 » n'a pas pu être restauré", { name: "restoreLevel", args: { id: R1 } }],
    ["Le niveau « RDC » n'a pas pu être dupliqué", duplicateRdc(2)],
    [
      "La pièce « Salon » n'a pas pu être ajoutée",
      { name: "createSpace", args: { id: uuid(24), levelId: RDC, name: "Salon", position: "a3" } },
    ],
    [
      "La pièce « Cuisine » n'a pas pu être renommée en « Cellier »",
      { name: "renameSpace", args: { id: KITCHEN, name: "Cellier" } },
    ],
    [
      "La pièce « WC » n'a pas pu être déplacée",
      { name: "moveSpace", args: { id: WC, levelId: RDC, position: "Zz" } },
    ],
    [
      "La pièce « WC » n'a pas pu être déplacée vers « R+1 »",
      { name: "moveSpace", args: { id: WC, levelId: R1, position: "a0" } },
    ],
    ["La pièce « Cave » n'a pas pu être supprimée", { name: "deleteSpace", args: { id: CELLAR } }],
    ["La pièce « Cave » n'a pas pu être restaurée", { name: "restoreSpace", args: { id: CELLAR } }],
  ])("%s", (expected, action) => {
    expect(describeRejection(mutation(action), base, "refused_by_database")).toBe(
      french(`${expected} : ${refused}.`),
    );
  });

  it("says why in words, whatever the server's code", () => {
    const rename = mutation({ name: "renameSpace", args: { id: KITCHEN, name: "Cellier" } });
    const why = (reason: string) => describeRejection(rename, base, reason);

    expect(why("invalid")).toMatch(/: le serveur a jugé la modification invalide\.$/);
    expect(why("refused_by_database")).toMatch(/: le serveur a refusé de l'enregistrer\.$/);
    // A code from a newer server.
    expect(why("forbidden")).toMatch(/: le serveur a refusé la modification\.$/);
    // Nothing missing that the device can see: someone else's change got in the way.
    expect(why("not_applicable")).toMatch(/: les données ont changé entre-temps\.$/);
  });

  it("tells which entity was missing where it was refused, named as before it", () => {
    const otherProperty = uuid(3);
    const elsewhere = uuid(31);
    const refusedOn = snapshotOf({
      properties: [{ id: otherProperty, name: "Villa", createdAt: 1, deletedAt: null }],
      levels: [
        { id: RDC, propertyId: PROPERTY, name: "RDC", position: "a0", deletedAt: null },
        { id: elsewhere, propertyId: otherProperty, name: "RDC", position: "a0", deletedAt: null },
      ],
      spaces: [{ id: KITCHEN, levelId: RDC, name: "Cuisine", position: "a0", deletedAt: null }],
    });
    const notApplicable = (action: Action) =>
      describeRejection(mutation(action), base, "not_applicable", refusedOn);

    expect(
      notApplicable({ name: "moveSpace", args: { id: KITCHEN, levelId: R1, position: "a0" } }),
    ).toBe(
      french(
        "La pièce « Cuisine » n'a pas pu être déplacée vers « R+1 » : le niveau n'existe plus.",
      ),
    );
    expect(notApplicable({ name: "renameSpace", args: { id: WC, name: "Toilettes" } })).toBe(
      french("La pièce « WC » n'a pas pu être renommée en « Toilettes » : elle n'existe plus."),
    );
    expect(notApplicable({ name: "renameLevel", args: { id: R1, name: "Étage" } })).toBe(
      french("Le niveau « R+1 » n'a pas pu être renommé en « Étage » : il n'existe plus."),
    );
    expect(
      notApplicable({
        name: "duplicateLevel",
        args: { id: COPY, sourceId: R1, name: "R+2", position: "a2", spaces: [] },
      }),
    ).toBe(french("Le niveau « R+1 » n'a pas pu être dupliqué : il n'existe plus."));
    expect(
      notApplicable({
        name: "createSpace",
        args: { id: uuid(24), levelId: RDC, name: "Salon", position: "a1" },
      }),
    ).toBe(french("La pièce « Salon » n'a pas pu être ajoutée : le logement n'existe plus."));
    expect(notApplicable({ name: "restoreProperty", args: { id: PROPERTY } })).toBe(
      french("Le logement « 12 rue des Lilas » n'a pas pu être restauré : il n'existe plus."),
    );
    expect(
      notApplicable({
        name: "moveSpace",
        args: { id: KITCHEN, levelId: elsewhere, position: "a0" },
      }),
    ).toMatch(/: une pièce ne peut pas changer de logement\.$/);
  });

  it("says a create was refused because its id exists (only a faulty client reuses one)", () => {
    const notApplicable = (action: Action) =>
      describeRejection(mutation(action), base, "not_applicable");

    expect(notApplicable({ name: "createProperty", args: { id: PROPERTY, name: "Villa" } })).toBe(
      french("Le logement « Villa » n'a pas pu être créé : il existe déjà."),
    );
    expect(
      notApplicable({
        name: "createLevel",
        args: { id: R1, propertyId: PROPERTY, name: "R+2", position: "a2" },
      }),
    ).toBe(french("Le niveau « R+2 » n'a pas pu être ajouté : il existe déjà."));
    expect(
      notApplicable({
        name: "createSpace",
        args: { id: KITCHEN, levelId: RDC, name: "Salon", position: "a3" },
      }),
    ).toBe(french("La pièce « Salon » n'a pas pu être ajoutée : elle existe déjà."));
    const copy = duplicateRdc(1);
    if (copy.name !== "duplicateLevel") throw new Error("unreachable");
    expect(notApplicable({ ...copy, args: { ...copy.args, id: R1 } })).toBe(
      french("Le niveau « RDC » n'a pas pu être dupliqué : sa copie existe déjà."),
    );
    const [room] = copy.args.spaces;
    if (!room) throw new Error("unreachable");
    expect(notApplicable({ ...copy, args: { ...copy.args, spaces: [{ ...room, id: WC }] } })).toBe(
      french("Le niveau « RDC » n'a pas pu être dupliqué : sa copie existe déjà."),
    );
  });

  it("falls back to generic nouns for entities it cannot name", () => {
    const empty = snapshotOf({});
    const rename = mutation({ name: "renameSpace", args: { id: KITCHEN, name: "Cellier" } });

    expect(describeRejection(rename, empty, "not_applicable")).toBe(
      french("La pièce n'a pas pu être renommée en « Cellier » : elle n'existe plus."),
    );
  });
});
