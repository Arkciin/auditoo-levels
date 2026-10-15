import { describe, expect, it, vi } from "vitest";
import { MAX_DUPLICATED_SPACES, MutationRejectedError, mutationArgsSchemas } from "./mutators";
import type { Mutation } from "./protocol";
import { applyMutations, emptySnapshot, type Snapshot } from "./snapshot";

const PROPERTY = "0199f0a0-0000-7000-8000-000000000001";
const OTHER_PROPERTY = "0199f0a0-0000-7000-8000-000000000002";
const RDC = "0199f0a0-0000-7000-8000-000000000011";
const R1 = "0199f0a0-0000-7000-8000-000000000012";
const OTHER_LEVEL = "0199f0a0-0000-7000-8000-000000000013";
const KITCHEN = "0199f0a0-0000-7000-8000-000000000021";

type Draft = {
  [N in Mutation["name"]]: { name: N; args: Extract<Mutation, { name: N }>["args"] };
}[Mutation["name"]];

let sequence = 0;
function m(draft: Draft, timestamp = 1_000): Mutation {
  sequence += 1;
  return { id: sequence, timestamp, ...draft } as Mutation;
}

const seed: Mutation[] = [
  m({ name: "createProperty", args: { id: PROPERTY, name: "12 rue des Lilas" } }),
  m({ name: "createLevel", args: { id: RDC, propertyId: PROPERTY, name: "RDC", position: "a0" } }),
  m({ name: "createLevel", args: { id: R1, propertyId: PROPERTY, name: "R+1", position: "a1" } }),
  m({ name: "createSpace", args: { id: KITCHEN, levelId: RDC, name: "Cuisine", position: "a0" } }),
];

async function build(...mutations: Mutation[]): Promise<Snapshot> {
  return applyMutations(emptySnapshot, [...seed, ...mutations]);
}

describe("mutators", () => {
  it("creates the structure", async () => {
    const snapshot = await build();
    expect(snapshot.properties.get(PROPERTY)).toEqual({
      id: PROPERTY,
      name: "12 rue des Lilas",
      createdAt: 1_000,
      deletedAt: null,
    });
    expect(snapshot.levels.size).toBe(2);
    expect(snapshot.spaces.get(KITCHEN)?.levelId).toBe(RDC);
  });

  it("renames and reorders", async () => {
    const snapshot = await build(
      m({ name: "renameSpace", args: { id: KITCHEN, name: "Cuisine ouverte" } }),
      m({ name: "moveLevel", args: { id: R1, position: "Zz" } }),
    );
    expect(snapshot.spaces.get(KITCHEN)?.name).toBe("Cuisine ouverte");
    expect(snapshot.levels.get(R1)?.position).toBe("Zz");
  });

  it("moves a space to another level of the same property", async () => {
    const snapshot = await build(
      m({ name: "moveSpace", args: { id: KITCHEN, levelId: R1, position: "a5" } }),
    );
    expect(snapshot.spaces.get(KITCHEN)).toMatchObject({ levelId: R1, position: "a5" });
  });

  it("soft-deletes and restores, keeping the level's spaces intact", async () => {
    const deleted = await build(m({ name: "deleteLevel", args: { id: RDC } }, 2_000));
    expect(deleted.levels.get(RDC)?.deletedAt).toBe(2_000);
    expect(deleted.spaces.get(KITCHEN)?.deletedAt).toBeNull();

    const restored = await applyMutations(deleted, [
      m({ name: "restoreLevel", args: { id: RDC } }),
    ]);
    expect(restored.levels.get(RDC)?.deletedAt).toBeNull();
  });

  it("treats deletes as idempotent", async () => {
    const once = await build(m({ name: "deleteSpace", args: { id: KITCHEN } }, 2_000));
    const twice = await applyMutations(once, [
      m({ name: "deleteSpace", args: { id: KITCHEN } }, 3_000),
    ]);
    expect(twice).toBe(once); // nothing written the second time
  });

  describe("edit wins over delete", () => {
    it("revives a deleted level when one of its rooms is renamed", async () => {
      const snapshot = await build(
        m({ name: "deleteLevel", args: { id: RDC } }),
        m({ name: "renameSpace", args: { id: KITCHEN, name: "Cuisine ouverte" } }),
      );
      expect(snapshot.levels.get(RDC)?.deletedAt).toBeNull();
    });

    it("revives the whole chain when a room is added to a deleted level", async () => {
      const space = "0199f0a0-0000-7000-8000-000000000022";
      const snapshot = await build(
        m({ name: "deleteProperty", args: { id: PROPERTY } }),
        m({ name: "deleteLevel", args: { id: R1 } }),
        m({
          name: "createSpace",
          args: { id: space, levelId: R1, name: "Chambre 1", position: "a0" },
        }),
      );
      expect(snapshot.properties.get(PROPERTY)?.deletedAt).toBeNull();
      expect(snapshot.levels.get(R1)?.deletedAt).toBeNull();
      expect(snapshot.spaces.get(space)?.deletedAt).toBeNull();
    });
  });

  describe("rejections", () => {
    it("rejects mutations on unknown entities without partial writes", async () => {
      const onRejected = vi.fn();
      const before = await build();
      const after = await applyMutations(
        before,
        [m({ name: "renameLevel", args: { id: OTHER_LEVEL, name: "Ghost" } })],
        onRejected,
      );
      expect(after).toBe(before);
      expect(onRejected).toHaveBeenCalledWith(
        expect.anything(),
        expect.any(MutationRejectedError),
        before,
      );
    });

    describe("a create over an entity that exists, deleted or not", () => {
      const refused = async (base: Snapshot, mutation: Mutation) => {
        const onRejected = vi.fn();
        const after = await applyMutations(base, [mutation], onRejected);
        expect(onRejected).toHaveBeenCalledWith(mutation, expect.any(MutationRejectedError), base);
        expect(after).toBe(base); // Nothing written.
      };

      it("cannot move a room to another logement, which moveSpace refuses", async () => {
        const base = await build(
          m({ name: "createProperty", args: { id: OTHER_PROPERTY, name: "Autre logement" } }),
          m({
            name: "createLevel",
            args: { id: OTHER_LEVEL, propertyId: OTHER_PROPERTY, name: "RDC", position: "a0" },
          }),
        );
        const reuse = { id: KITCHEN, levelId: OTHER_LEVEL, name: "Cuisine", position: "a0" };
        await refused(base, m({ name: "createSpace", args: reuse }));
        await refused(base, m({ name: "createSpace", args: { ...reuse, levelId: R1 } }));
      });

      it("is refused for every kind of create", async () => {
        const base = await build(
          m({ name: "deleteProperty", args: { id: PROPERTY } }, 2_000),
          m({ name: "deleteLevel", args: { id: R1 } }, 2_000),
          m({ name: "deleteSpace", args: { id: KITCHEN } }, 2_000),
        );
        await refused(base, m({ name: "createProperty", args: { id: PROPERTY, name: "Villa" } }));
        const level = { id: R1, propertyId: PROPERTY, name: "R+2", position: "a2" };
        await refused(base, m({ name: "createLevel", args: level }));
        const space = { id: KITCHEN, levelId: RDC, name: "Salon", position: "a1" };
        await refused(base, m({ name: "createSpace", args: space }));
      });

      it("is refused for a level copy reusing any id, its rooms' included", async () => {
        const copy = "0199f0a0-0000-7000-8000-000000000015";
        const fresh = "0199f0a0-0000-7000-8000-000000000033";
        const duplicate = (id: string, spaceId: string) =>
          m({
            name: "duplicateLevel",
            args: {
              id,
              sourceId: RDC,
              name: "RDC (copie)",
              position: "a0V",
              spaces: [{ id: spaceId, name: "Cuisine", position: "a0" }],
            },
          });
        const base = await build();
        await refused(base, duplicate(R1, fresh));
        await refused(base, duplicate(copy, KITCHEN));
        expect((await applyMutations(base, [duplicate(copy, fresh)])).levels.has(copy)).toBe(true);
      });
    });

    it("refuses to move a space to another property", async () => {
      const onRejected = vi.fn();
      const snapshot = await applyMutations(
        await build(
          m({ name: "createProperty", args: { id: OTHER_PROPERTY, name: "Autre logement" } }),
          m({
            name: "createLevel",
            args: { id: OTHER_LEVEL, propertyId: OTHER_PROPERTY, name: "RDC", position: "a0" },
          }),
        ),
        [m({ name: "moveSpace", args: { id: KITCHEN, levelId: OTHER_LEVEL, position: "a0" } })],
        onRejected,
      );
      expect(onRejected).toHaveBeenCalledOnce();
      expect(snapshot.spaces.get(KITCHEN)?.levelId).toBe(RDC);
    });
  });

  describe("duplicateLevel", () => {
    const COPY = "0199f0a0-0000-7000-8000-000000000014";
    const COPIED_KITCHEN = "0199f0a0-0000-7000-8000-000000000031";
    const COPIED_WC = "0199f0a0-0000-7000-8000-000000000032";
    const args = {
      id: COPY,
      sourceId: RDC,
      name: "RDC (copie)",
      position: "a0V",
      spaces: [
        { id: COPIED_KITCHEN, name: "Cuisine", position: "a0" },
        { id: COPIED_WC, name: "WC", position: "a1" },
      ],
    };
    const duplicate = (timestamp?: number) => m({ name: "duplicateLevel", args }, timestamp);

    it("creates the copy and its rooms in the source's property, in one mutation", async () => {
      const before = await build();
      const after = await applyMutations(before, [duplicate()]);

      expect(after.levels.get(COPY)).toEqual({
        id: COPY,
        propertyId: PROPERTY,
        name: "RDC (copie)",
        position: "a0V",
        deletedAt: null,
      });
      expect([...after.spaces.values()].filter((space) => space.levelId === COPY)).toEqual([
        { id: COPIED_KITCHEN, levelId: COPY, name: "Cuisine", position: "a0", deletedAt: null },
        { id: COPIED_WC, levelId: COPY, name: "WC", position: "a1", deletedAt: null },
      ]);
      // The source and its rooms are only read.
      expect(after.levels.get(RDC)).toBe(before.levels.get(RDC));
      expect(after.spaces.get(KITCHEN)).toBe(before.spaces.get(KITCHEN));
    });

    it("copies a source deleted meanwhile, which stays deleted, and revives the property", async () => {
      const snapshot = await build(
        m({ name: "deleteLevel", args: { id: RDC } }, 2_000),
        m({ name: "deleteProperty", args: { id: PROPERTY } }, 2_000),
        duplicate(),
      );
      expect(snapshot.levels.get(COPY)?.deletedAt).toBeNull();
      expect(snapshot.properties.get(PROPERTY)?.deletedAt).toBeNull();
      expect(snapshot.levels.get(RDC)?.deletedAt).toBe(2_000);
    });

    it("rejects an unknown source without writing anything", async () => {
      const onRejected = vi.fn();
      const before = await build();
      const after = await applyMutations(
        before,
        [m({ name: "duplicateLevel", args: { ...args, sourceId: OTHER_LEVEL } })],
        onRejected,
      );
      expect(after).toBe(before);
      expect(onRejected).toHaveBeenCalledWith(
        expect.anything(),
        expect.any(MutationRejectedError),
        before,
      );
    });

    it("is refused when applied again: the copy exists", async () => {
      const once = await build(duplicate());
      const onRejected = vi.fn();
      expect(await applyMutations(once, [duplicate()], onRejected)).toBe(once);
      expect(onRejected).toHaveBeenCalledOnce();
    });

    describe("arguments", () => {
      const parse = (overrides: Partial<typeof args>) =>
        mutationArgsSchemas.duplicateLevel.safeParse({ ...args, ...overrides });
      const room = (n: number) => ({
        id: `0199f0a0-0000-7000-8000-${String(n).padStart(12, "0")}`,
        name: "Chambre",
        position: "a0",
      });

      it("accepts a copy without rooms, and trims the names like any input", () => {
        expect(parse({ spaces: [] }).success).toBe(true);
        const spaces = [{ id: COPIED_KITCHEN, name: "  Cuisine ", position: "a0" }];
        expect(parse({ name: " R+2 ", spaces }).data).toMatchObject({
          name: "R+2",
          spaces: [{ name: "Cuisine" }],
        });
      });

      it(`refuses more than ${MAX_DUPLICATED_SPACES} rooms, in French`, () => {
        const spaces = Array.from({ length: MAX_DUPLICATED_SPACES + 1 }, (_, i) => room(100 + i));
        expect(parse({ spaces: spaces.slice(1) }).success).toBe(true);
        expect(parse({ spaces }).error?.issues[0]?.message).toBe(
          "Un niveau de plus de 100\u00a0pièces ne peut pas être dupliqué",
        );
      });

      it("refuses ids used twice, or the source's id for the copy", () => {
        expect(parse({ spaces: [room(1), room(1)] }).success).toBe(false);
        expect(parse({ spaces: [{ ...room(1), id: COPY }] }).success).toBe(false);
        expect(parse({ id: RDC }).success).toBe(false);
      });

      it("validates each room like a room created on its own", () => {
        expect(parse({ spaces: [{ ...room(1), name: "Cui\u0000sine" }] }).success).toBe(false);
        expect(parse({ spaces: [{ ...room(1), position: "not a key!" }] }).success).toBe(false);
      });
    });
  });

  it("is deterministic: replaying the same log gives the same state", async () => {
    const log = [
      m({ name: "renameLevel", args: { id: RDC, name: "Rez-de-chaussée" } }),
      m({ name: "moveSpace", args: { id: KITCHEN, levelId: R1, position: "a0" } }),
      m({ name: "deleteLevel", args: { id: RDC } }, 5_000),
    ];
    expect(await build(...log)).toEqual(await build(...log));
  });
});
