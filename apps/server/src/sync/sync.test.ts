import {
  applyMutations,
  applyPull,
  emptySnapshot,
  newId,
  type PullResponse,
  pullResponseSchema,
} from "@repo/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SqlClient } from "../db/sql";
import { createTestDb, mutation } from "../testing";
import { processPull } from "./pull";
import { processPush } from "./push";

const DEVICE_A = "0199f0a0-0000-7000-8000-0000000000a1";
const DEVICE_B = "0199f0a0-0000-7000-8000-0000000000b1";
const PROPERTY = "0199f0a0-0000-7000-8000-000000000001";
const RDC = "0199f0a0-0000-7000-8000-000000000011";
const KITCHEN = "0199f0a0-0000-7000-8000-000000000021";
const UNKNOWN = "0199f0a0-0000-7000-8000-0000000000ff";

const createProperty = mutation(1, {
  name: "createProperty",
  args: { id: PROPERTY, name: "12 rue des Lilas" },
});
const createLevel = mutation(2, {
  name: "createLevel",
  args: { id: RDC, propertyId: PROPERTY, name: "RDC", position: "a0" },
});
const createSpace = mutation(3, {
  name: "createSpace",
  args: { id: KITCHEN, levelId: RDC, name: "Cuisine", position: "a0" },
});
const seed = [createProperty, createLevel, createSpace];

const noChanges = { properties: [], levels: [], spaces: [] };

describe("push and pull", () => {
  let db: SqlClient;
  beforeEach(async () => {
    db = await createTestDb();
  });
  afterEach(() => db.close());

  /** Pulls and checks that the response matches the protocol schema exactly (no extra keys). */
  async function pull(clientId: string, cursor: number): Promise<PullResponse> {
    const response = await processPull(db, { clientId, cursor });
    expect(pullResponseSchema.parse(response)).toEqual(response);
    return response;
  }

  it("returns pushed rows in the shared shapes, then nothing new", async () => {
    expect(await processPush(db, { clientId: DEVICE_A, mutations: seed })).toEqual({
      lastMutationId: 3,
      version: 3,
      changed: true,
    });

    const first = await pull(DEVICE_A, 0);
    expect(first).toEqual({
      cursor: 3,
      lastMutationId: 3,
      reset: false,
      changes: {
        properties: [{ id: PROPERTY, name: "12 rue des Lilas", createdAt: 1_000, deletedAt: null }],
        levels: [{ id: RDC, propertyId: PROPERTY, name: "RDC", position: "a0", deletedAt: null }],
        spaces: [{ id: KITCHEN, levelId: RDC, name: "Cuisine", position: "a0", deletedAt: null }],
      },
    });
    // The server computed exactly what the device computed optimistically.
    expect(applyPull(emptySnapshot, first)).toEqual(await applyMutations(emptySnapshot, seed));

    expect(await pull(DEVICE_A, first.cursor)).toEqual({
      cursor: 3,
      lastMutationId: 3,
      reset: false,
      changes: noChanges,
    });
  });

  it("sends soft-deleted rows, so that deletions sync", async () => {
    await processPush(db, { clientId: DEVICE_A, mutations: seed });
    await processPush(db, {
      clientId: DEVICE_A,
      mutations: [mutation(4, { name: "deleteSpace", args: { id: KITCHEN } }, 2_000)],
    });

    const { changes } = await pull(DEVICE_A, 3);
    expect(changes).toEqual({
      ...noChanges,
      spaces: [expect.objectContaining({ deletedAt: 2_000 })],
    });
  });

  it("applies a retried batch only once", async () => {
    const first = await processPush(db, { clientId: DEVICE_A, mutations: seed });
    const retry = await processPush(db, { clientId: DEVICE_A, mutations: seed });

    expect(retry).toEqual({ ...first, changed: false });
    const rows = await db.query(
      "SELECT version FROM properties UNION ALL SELECT version FROM levels",
    );
    expect(rows).toHaveLength(2);

    // A retry carrying one new mutation applies just that one.
    const next = mutation(4, { name: "renameLevel", args: { id: RDC, name: "Rez-de-chaussée" } });
    expect(await processPush(db, { clientId: DEVICE_A, mutations: [...seed, next] })).toEqual({
      lastMutationId: 4,
      version: 4,
      changed: true,
    });
  });

  it("acknowledges a rejected mutation without blocking the ones after it", async () => {
    const result = await processPush(db, {
      clientId: DEVICE_A,
      mutations: [
        createProperty,
        mutation(2, { name: "renameLevel", args: { id: UNKNOWN, name: "Fantôme" } }),
        { ...createLevel, id: 3 },
      ],
    });

    expect(result).toEqual({ lastMutationId: 3, version: 2, changed: true });
    const { changes } = await pull(DEVICE_A, 0);
    expect(changes.levels.map((level) => level.id)).toEqual([RDC]);
  });

  it("rejects a mutation the database refuses (SQLSTATE class 22) as permanent", async () => {
    const result = await processPush(db, {
      clientId: DEVICE_A,
      mutations: [
        // Valid for the schema, but PostgreSQL text cannot contain NUL characters.
        mutation(1, { name: "createProperty", args: { id: PROPERTY, name: "Maison\u0000" } }),
        mutation(2, { name: "createProperty", args: { id: newId(), name: "Appartement" } }),
      ],
    });

    expect(result).toEqual({ lastMutationId: 2, version: 1, changed: true });
    const { changes } = await pull(DEVICE_A, 0);
    expect(changes.properties.map((property) => property.name)).toEqual(["Appartement"]);
  });

  it("does not bump the version for a mutation that changes nothing", async () => {
    await processPush(db, { clientId: DEVICE_A, mutations: seed });
    const deleted = await processPush(db, {
      clientId: DEVICE_A,
      mutations: [
        mutation(4, { name: "deleteSpace", args: { id: KITCHEN } }),
        mutation(5, { name: "deleteSpace", args: { id: KITCHEN } }),
      ],
    });

    expect(deleted).toEqual({ lastMutationId: 5, version: 4, changed: true });
  });

  it("lets an edit win over a concurrent delete", async () => {
    await processPush(db, { clientId: DEVICE_A, mutations: seed });
    await processPush(db, {
      clientId: DEVICE_A,
      mutations: [mutation(4, { name: "deleteLevel", args: { id: RDC } }, 2_000)],
    });
    // Device B, offline, still saw the level and renamed one of its rooms.
    await processPush(db, {
      clientId: DEVICE_B,
      mutations: [
        mutation(1, { name: "renameSpace", args: { id: KITCHEN, name: "Cuisine ouverte" } }),
      ],
    });

    const { changes } = await pull(DEVICE_A, 4);
    expect(changes.levels).toEqual([expect.objectContaining({ id: RDC, deletedAt: null })]);
    expect(changes.spaces).toEqual([expect.objectContaining({ name: "Cuisine ouverte" })]);
  });

  it("reports each device's own lastMutationId", async () => {
    await processPush(db, { clientId: DEVICE_A, mutations: seed });
    await processPush(db, {
      clientId: DEVICE_B,
      mutations: [mutation(7, { name: "renameProperty", args: { id: PROPERTY, name: "Villa" } })],
    });

    expect((await pull(DEVICE_A, 0)).lastMutationId).toBe(3);
    expect((await pull(DEVICE_B, 0)).lastMutationId).toBe(7);
    expect((await pull(newId(), 0)).lastMutationId).toBe(0);
  });

  it("resends everything with reset when the cursor is ahead of the server", async () => {
    await processPush(db, { clientId: DEVICE_A, mutations: seed });

    const fromScratch = await pull(DEVICE_A, 0);
    expect(await pull(DEVICE_A, 42)).toEqual({ ...fromScratch, reset: true });
  });

  it("gives concurrent pushes gapless versions that incremental pulls never miss", async () => {
    const batches = Array.from({ length: 4 }, (_, device) => ({
      clientId: newId(),
      mutations: Array.from({ length: 5 }, (_, i) =>
        mutation(i + 1, {
          name: "createProperty",
          args: { id: newId(), name: `Logement ${device}.${i}` },
        }),
      ),
    }));
    const total = 20;

    // A device keeps pulling incrementally while the pushes run.
    const seen = new Set<string>();
    const puller = (async () => {
      let cursor = 0;
      while (cursor < total) {
        const response = await processPull(db, { clientId: DEVICE_B, cursor });
        for (const property of response.changes.properties) seen.add(property.id);
        cursor = response.cursor;
      }
    })();
    const results = await Promise.all(batches.map((batch) => processPush(db, batch)));
    await puller;

    expect(results.map((result) => result.lastMutationId)).toEqual([5, 5, 5, 5]);
    const versions = await db.query<{ version: number }>(
      "SELECT version FROM properties ORDER BY version",
    );
    expect(versions.map((row) => row.version)).toEqual(
      Array.from({ length: total }, (_, i) => i + 1),
    );
    expect(seen).toEqual(
      new Set(batches.flatMap((batch) => batch.mutations.map((m) => m.args.id))),
    );
  });
});
