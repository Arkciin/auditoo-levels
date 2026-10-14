import "fake-indexeddb/auto";
import type { PullResponse } from "@repo/shared";
import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import { type MutationDraft, openSyncStorage } from "./storage";
import { uuid } from "./test-support/fixtures";

const PROPERTY = { id: uuid(1), name: "12 rue des Lilas", createdAt: 1_000, deletedAt: null };
const LEVEL = {
  id: uuid(2),
  propertyId: PROPERTY.id,
  name: "RDC",
  position: "a0",
  deletedAt: null,
};

function createProperty(n: number): MutationDraft {
  return {
    name: "createProperty",
    args: { id: uuid(100 + n), name: `Logement ${n}` },
    timestamp: n,
  };
}

function pull(overrides: Partial<PullResponse>): PullResponse {
  return {
    cursor: 1,
    lastMutationId: 0,
    reset: false,
    changes: { properties: [], levels: [], spaces: [] },
    ...overrides,
  };
}

describe("openSyncStorage", () => {
  it("allocates strictly increasing mutation ids, never reused after pruning", async () => {
    const storage = await openSyncStorage({ indexedDB: new IDBFactory() });
    const first = await storage.enqueue(createProperty(1));
    const second = await storage.enqueue(createProperty(2));
    expect(first).toEqual({ ...createProperty(1), id: 1 });
    expect(second.id).toBeGreaterThan(first.id);

    await storage.commitPull(pull({ lastMutationId: second.id }));
    const third = await storage.enqueue(createProperty(3));
    expect(third.id).toBeGreaterThan(second.id);
    storage.close();
  });

  it("shares the id sequence between the tabs of a device", async () => {
    const indexedDB = new IDBFactory();
    const [tabA, tabB] = await Promise.all([
      openSyncStorage({ indexedDB }),
      openSyncStorage({ indexedDB }),
    ]);
    const ids = [];
    for (let n = 0; n < 6; n++)
      ids.push((await (n % 2 ? tabA : tabB).enqueue(createProperty(n))).id);
    expect(ids).toEqual([1, 2, 3, 4, 5, 6]);
    tabA.close();
    tabB.close();
  });

  it("creates one client id, even when two tabs start together", async () => {
    const indexedDB = new IDBFactory();
    const [tabA, tabB] = await Promise.all([
      openSyncStorage({ indexedDB }),
      openSyncStorage({ indexedDB }),
    ]);
    const [stateA, stateB] = await Promise.all([tabA.loadState(), tabB.loadState()]);
    expect(stateA.clientId).toMatch(/^[0-9a-f-]{36}$/);
    expect(stateB.clientId).toBe(stateA.clientId);
    tabA.close();
    tabB.close();
  });

  it("restores the client id, cursor, base and outbox after a restart", async () => {
    const indexedDB = new IDBFactory();
    const before = await openSyncStorage({ indexedDB });
    const { clientId } = await before.loadState();
    await before.commitPull(
      pull({ cursor: 7, changes: { properties: [PROPERTY], levels: [LEVEL], spaces: [] } }),
    );
    const pending = await before.enqueue(createProperty(1));
    before.close();

    const after = await openSyncStorage({ indexedDB });
    const state = await after.loadState();
    expect(state.clientId).toBe(clientId);
    expect(state.cursor).toBe(7);
    expect(state.base.properties.get(PROPERTY.id)).toEqual(PROPERTY);
    expect(state.base.levels.get(LEVEL.id)).toEqual(LEVEL);
    expect(state.pending).toEqual([pending]);
    after.close();
  });

  it("starts from an empty state", async () => {
    const storage = await openSyncStorage({ indexedDB: new IDBFactory() });
    const state = await storage.loadState();
    expect(state.cursor).toBe(0);
    expect(state.base.properties.size + state.base.levels.size + state.base.spaces.size).toBe(0);
    expect(state.pending).toEqual([]);
    storage.close();
  });

  it("commits a pull: rows upserted, processed mutations pruned, cursor stored", async () => {
    const storage = await openSyncStorage({ indexedDB: new IDBFactory() });
    await storage.enqueue(createProperty(1));
    const processed = await storage.enqueue(createProperty(2));
    const unconfirmed = await storage.enqueue(createProperty(3));
    await storage.commitPull(
      pull({ cursor: 3, changes: { properties: [PROPERTY], levels: [], spaces: [] } }),
    );
    const renamed = { ...PROPERTY, name: "14 rue des Lilas" };
    await storage.commitPull(
      pull({
        cursor: 5,
        lastMutationId: processed.id,
        changes: { properties: [renamed], levels: [LEVEL], spaces: [] },
      }),
    );

    const state = await storage.loadState();
    expect(state.cursor).toBe(5);
    expect([...state.base.properties.values()]).toEqual([renamed]);
    expect([...state.base.levels.values()]).toEqual([LEVEL]);
    expect(state.pending).toEqual([unconfirmed]);
    storage.close();
  });

  it("replaces the base on reset but keeps unconfirmed mutations", async () => {
    const storage = await openSyncStorage({ indexedDB: new IDBFactory() });
    await storage.commitPull(
      pull({ cursor: 9, changes: { properties: [PROPERTY], levels: [LEVEL], spaces: [] } }),
    );
    const pending = await storage.enqueue(createProperty(1));
    const survivor = { ...PROPERTY, id: uuid(3), name: "Seul survivant" };

    await storage.commitPull(
      pull({ cursor: 2, reset: true, changes: { properties: [survivor], levels: [], spaces: [] } }),
    );

    const state = await storage.loadState();
    expect(state.cursor).toBe(2);
    expect([...state.base.properties.values()]).toEqual([survivor]);
    expect(state.base.levels.size).toBe(0);
    expect(state.pending).toEqual([pending]);
    storage.close();
  });

  it("reads the outbox in pages, after a given id", async () => {
    const storage = await openSyncStorage({ indexedDB: new IDBFactory() });
    for (let n = 1; n <= 5; n++) await storage.enqueue(createProperty(n));
    expect((await storage.readOutbox(0, 2)).map((m) => m.id)).toEqual([1, 2]);
    expect((await storage.readOutbox(2, 10)).map((m) => m.id)).toEqual([3, 4, 5]);
    expect(await storage.readOutbox(5, 10)).toEqual([]);
    storage.close();
  });
});
