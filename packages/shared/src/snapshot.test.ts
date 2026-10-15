import { afterEach, describe, expect, it, vi } from "vitest";
import { MutationRejectedError, mutators } from "./mutators";
import type { Mutation } from "./protocol";
import { applyMutations, applyPull, emptySnapshot } from "./snapshot";

const property = {
  id: "0199f0a0-0000-7000-8000-000000000001",
  name: "Maison",
  createdAt: 1,
  deletedAt: null,
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("applyMutations", () => {
  it("reports a refused mutation with the state it was refused on, and goes on", async () => {
    const level = "0199f0a0-0000-7000-8000-000000000011";
    const mutations: Mutation[] = [
      { id: 1, timestamp: 1, name: "createProperty", args: { id: property.id, name: "Maison" } },
      { id: 2, timestamp: 1, name: "renameLevel", args: { id: level, name: "R+1" } },
      { id: 3, timestamp: 1, name: "renameProperty", args: { id: property.id, name: "Villa" } },
    ];
    const onRejected = vi.fn();

    const after = await applyMutations(emptySnapshot, mutations, onRejected);

    expect(after.properties.get(property.id)?.name).toBe("Villa");
    expect(onRejected).toHaveBeenCalledOnce();
    const [mutation, error, before] = onRejected.mock.lastCall ?? [];
    expect(mutation).toBe(mutations[1]);
    expect(error).toBeInstanceOf(MutationRejectedError);
    // The state just before it: the first mutation applied, not the third.
    expect(before.properties.get(property.id)?.name).toBe("Maison");
  });

  it("refuses a mutation of a kind this version does not know, instead of failing", async () => {
    const create: Mutation = {
      id: 1,
      timestamp: 1,
      name: "createProperty",
      args: { id: property.id, name: "Maison" },
    };
    // Typing boundary: what a newer version of the app may have left in a device's outbox.
    const unknown = { id: 2, timestamp: 1, name: "paintWalls", args: {} } as unknown as Mutation;
    const onRejected = vi.fn();

    const after = await applyMutations(emptySnapshot, [create, unknown], onRejected);

    expect(after.properties.has(property.id)).toBe(true);
    expect(onRejected).toHaveBeenCalledExactlyOnceWith(
      unknown,
      expect.any(MutationRejectedError),
      after,
    );
  });
});

describe("applyMutations, on what another version of the app queued", () => {
  const create: Mutation = {
    id: 1,
    timestamp: 1,
    name: "createProperty",
    args: { id: property.id, name: "Maison" },
  };
  const rename = (id: number, name: unknown): Mutation =>
    // Typing boundary: an outbox entry written under other rules.
    ({ id, timestamp: 1, name: "renameProperty", args: { id: property.id, name } }) as Mutation;

  it("does not run a mutation that breaks today's rules: its mutator would write garbage", async () => {
    const onRejected = vi.fn();
    const after = await applyMutations(
      emptySnapshot,
      [create, rename(2, 42), rename(3, "Villa")],
      onRejected,
    );

    expect(after.properties.get(property.id)?.name).toBe("Villa");
    expect(onRejected).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ id: 2 }),
      expect.any(MutationRejectedError),
      expect.anything(),
    );
  });

  it("goes on past a mutator that throws anything, which only means it does not apply here", async () => {
    const failure = new TypeError("Cannot read properties of undefined");
    vi.spyOn(mutators, "renameProperty").mockRejectedValueOnce(failure);
    const onRejected = vi.fn();

    const after = await applyMutations(
      emptySnapshot,
      [create, rename(2, "Villa"), rename(3, "Manoir")],
      onRejected,
    );

    expect(after.properties.get(property.id)?.name).toBe("Manoir");
    expect(onRejected).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ id: 2 }),
      failure,
      expect.anything(),
    );
  });
});

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
