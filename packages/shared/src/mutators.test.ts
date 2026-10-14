import { describe, expect, it, vi } from "vitest";
import { MutationRejectedError } from "./mutators";
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

  it("is deterministic: replaying the same log gives the same state", async () => {
    const log = [
      m({ name: "renameLevel", args: { id: RDC, name: "Rez-de-chaussée" } }),
      m({ name: "moveSpace", args: { id: KITCHEN, levelId: R1, position: "a0" } }),
      m({ name: "deleteLevel", args: { id: RDC } }, 5_000),
    ];
    expect(await build(...log)).toEqual(await build(...log));
  });
});
