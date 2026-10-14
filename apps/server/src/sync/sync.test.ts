import {
  applyMutations,
  applyPull,
  emptySnapshot,
  type MutationEnvelope,
  newId,
  type PullResponse,
  pullResponseSchema,
  type ReceivedPushRequest,
} from "@repo/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { onlyRow, type SqlClient } from "../db/sql";
import { createTestDb, mutation } from "../testing";
import { processPull } from "./pull";
import { type PushResult, processPush } from "./push";

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
  /** This database's epoch, which every response must carry. */
  let epoch: string;
  beforeEach(async () => {
    db = await createTestDb();
    ({ epoch } = onlyRow(await db.query<{ epoch: string }>("SELECT epoch FROM server_meta")));
  });
  afterEach(() => db.close());

  /** Pulls and checks that the response matches the protocol schema exactly (no extra keys). */
  async function pull(clientId: string, cursor: number): Promise<PullResponse> {
    const response = await processPull(db, { clientId, cursor });
    expect(pullResponseSchema.parse(response)).toEqual(response);
    return response;
  }

  /** Pushes, checks that the result carries this database's epoch, and returns the rest. */
  async function push(request: ReceivedPushRequest): Promise<Omit<PushResult, "epoch">> {
    const { epoch: answered, ...result } = await processPush(db, request);
    expect(answered).toBe(epoch);
    return result;
  }

  it("returns pushed rows in the shared shapes, then nothing new", async () => {
    expect(await push({ clientId: DEVICE_A, mutations: seed })).toEqual({
      lastMutationId: 3,
      version: 3,
      changed: true,
      rejected: [],
    });

    const first = await pull(DEVICE_A, 0);
    expect(first).toEqual({
      epoch,
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
      epoch,
      cursor: 3,
      lastMutationId: 3,
      reset: false,
      changes: noChanges,
    });
  });

  it("sends soft-deleted rows, so that deletions sync", async () => {
    await push({ clientId: DEVICE_A, mutations: seed });
    await push({
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
    const first = await push({ clientId: DEVICE_A, mutations: seed });
    const retry = await push({ clientId: DEVICE_A, mutations: seed });

    expect(retry).toEqual({ ...first, changed: false });
    const rows = await db.query(
      "SELECT version FROM properties UNION ALL SELECT version FROM levels",
    );
    expect(rows).toHaveLength(2);

    // A retry carrying one new mutation applies just that one.
    const next = mutation(4, { name: "renameLevel", args: { id: RDC, name: "Rez-de-chaussée" } });
    expect(await push({ clientId: DEVICE_A, mutations: [...seed, next] })).toEqual({
      lastMutationId: 4,
      version: 4,
      changed: true,
      rejected: [],
    });
  });

  it("acknowledges a rejected mutation without blocking the ones after it", async () => {
    const result = await push({
      clientId: DEVICE_A,
      mutations: [
        createProperty,
        mutation(2, { name: "renameLevel", args: { id: UNKNOWN, name: "Fantôme" } }),
        { ...createLevel, id: 3 },
      ],
    });

    // Reported by id and reason only: nothing of what the user typed is sent back.
    expect(result).toEqual({
      lastMutationId: 3,
      version: 2,
      changed: true,
      rejected: [{ id: 2, reason: "not_applicable" }],
    });
    const { changes } = await pull(DEVICE_A, 0);
    expect(changes.levels.map((level) => level.id)).toEqual([RDC]);
  });

  it("reports a rejection again to a retry, which finds the mutation already processed", async () => {
    const ghost = mutation(2, { name: "renameLevel", args: { id: UNKNOWN, name: "Fantôme" } });
    const first = await push({ clientId: DEVICE_A, mutations: [createProperty, ghost] });
    expect(first.rejected).toEqual([{ id: 2, reason: "not_applicable" }]);

    // The response was lost: the device sends the same mutations again, with a new one.
    const retry = await push({
      clientId: DEVICE_A,
      mutations: [createProperty, ghost, { ...createLevel, id: 3 }],
    });
    expect(retry).toEqual({
      lastMutationId: 3,
      version: 2,
      changed: true,
      rejected: [{ id: 2, reason: "not_applicable" }],
    });

    // Pushes that no longer carry it do not mention it, nor do those of other devices.
    const rename = mutation(4, { name: "renameLevel", args: { id: RDC, name: "Rez-de-chaussée" } });
    expect((await push({ clientId: DEVICE_A, mutations: [rename] })).rejected).toEqual([]);
    const other = mutation(2, { name: "renameProperty", args: { id: PROPERTY, name: "Villa" } });
    expect((await push({ clientId: DEVICE_B, mutations: [other] })).rejected).toEqual([]);
  });

  it("reports a rejection to a retry racing the push it repeats", async () => {
    const request: ReceivedPushRequest = {
      clientId: DEVICE_A,
      mutations: [
        createProperty,
        mutation(2, { name: "renameLevel", args: { id: UNKNOWN, name: "Fantôme" } }),
      ],
    };

    // Whichever processes the rejected mutation, the other skips it and must still report it.
    const results = await Promise.all([push(request), push(request)]);

    expect(results.map((result) => result.rejected)).toEqual([
      [{ id: 2, reason: "not_applicable" }],
      [{ id: 2, reason: "not_applicable" }],
    ]);
  });

  it("processes, and reports, a mutation sent twice in one push once", async () => {
    const ghost = mutation(2, { name: "renameLevel", args: { id: UNKNOWN, name: "Fantôme" } });
    const result = await push({ clientId: DEVICE_A, mutations: [ghost, createProperty, ghost] });

    expect(result).toEqual({
      lastMutationId: 2,
      version: 1,
      changed: true,
      rejected: [{ id: 2, reason: "not_applicable" }],
    });
  });

  it("reports the rejections of a push that failed half-way once it is retried", async () => {
    // The connection drops during the second mutation: the first, rejected, is already committed.
    let transactions = 0;
    const flaky: SqlClient = {
      ...db,
      transaction: (fn, options) =>
        ++transactions === 2
          ? Promise.reject(new Error("Connection terminated unexpectedly"))
          : db.transaction(fn, options),
    };
    const request: ReceivedPushRequest = {
      clientId: DEVICE_A,
      mutations: [
        mutation(1, { name: "renameLevel", args: { id: UNKNOWN, name: "Fantôme" } }),
        { ...createProperty, id: 2 },
      ],
    };
    await expect(processPush(flaky, request)).rejects.toThrow("Connection terminated");

    expect(await push(request)).toEqual({
      lastMutationId: 2,
      version: 1,
      changed: true,
      rejected: [{ id: 1, reason: "not_applicable" }],
    });
  });

  it("acknowledges invalid mutations as rejected and still applies the others", async () => {
    // What another version of the app could send: the envelope is fine, the content is not.
    const invalid: MutationEnvelope[] = [
      { id: 2, name: "renameProperty", args: { id: PROPERTY, name: "" }, timestamp: 1_000 },
      // PostgreSQL text cannot hold NUL: the schema refuses it before it reaches the database.
      { id: 3, name: "renameProperty", args: { id: PROPERTY, name: "Ma\u0000ison" }, timestamp: 1 },
      { id: 4, name: "paintWalls", args: { id: PROPERTY }, timestamp: 1_000 },
    ];
    const result = await push({
      clientId: DEVICE_A,
      mutations: [createProperty, ...invalid, { ...createLevel, id: 5 }],
    });

    expect(result).toEqual({
      lastMutationId: 5,
      version: 2,
      changed: true,
      rejected: [2, 3, 4].map((id) => ({ id, reason: "invalid" })),
    });
    const { changes } = await pull(DEVICE_A, 0);
    expect(changes.properties.map((property) => property.name)).toEqual(["12 rue des Lilas"]);
    expect(changes.levels.map((level) => level.id)).toEqual([RDC]);
  });

  it("rejects a mutation the database refuses (SQLSTATE class 23) as permanent", async () => {
    // A rule only the database knows about, standing for any constraint the schemas cannot see.
    await db.exec(
      "ALTER TABLE properties ADD CONSTRAINT test_no_villa CHECK (name <> 'Villa interdite')",
    );
    const result = await push({
      clientId: DEVICE_A,
      mutations: [
        mutation(1, { name: "createProperty", args: { id: PROPERTY, name: "Villa interdite" } }),
        mutation(2, { name: "createProperty", args: { id: newId(), name: "Appartement" } }),
      ],
    });

    expect(result).toEqual({
      lastMutationId: 2,
      version: 1,
      changed: true,
      rejected: [{ id: 1, reason: "refused_by_database" }],
    });
    const { changes } = await pull(DEVICE_A, 0);
    expect(changes.properties.map((property) => property.name)).toEqual(["Appartement"]);
  });

  it("accepts gaps in mutation ids: they only have to increase", async () => {
    // Devices allocate ids with an IndexedDB key generator, which can skip values.
    const sparse = [
      { ...createProperty, id: 3 },
      { ...createLevel, id: 7 },
      { ...createSpace, id: 20 },
    ];
    expect(await push({ clientId: DEVICE_A, mutations: sparse })).toEqual({
      lastMutationId: 20,
      version: 3,
      changed: true,
      rejected: [],
    });

    // Retrying the batch, plus a new mutation further on, applies only the new one.
    const rename = mutation(42, { name: "renameSpace", args: { id: KITCHEN, name: "Cellier" } });
    expect(await push({ clientId: DEVICE_A, mutations: [...sparse, rename] })).toEqual({
      lastMutationId: 42,
      version: 4,
      changed: true,
      rejected: [],
    });
    const { changes } = await pull(DEVICE_A, 0);
    expect(changes.spaces).toEqual([expect.objectContaining({ id: KITCHEN, name: "Cellier" })]);
  });

  it("does not bump the version for a mutation that changes nothing", async () => {
    await push({ clientId: DEVICE_A, mutations: seed });
    const deleted = await push({
      clientId: DEVICE_A,
      mutations: [
        mutation(4, { name: "deleteSpace", args: { id: KITCHEN } }),
        mutation(5, { name: "deleteSpace", args: { id: KITCHEN } }),
      ],
    });

    expect(deleted).toEqual({ lastMutationId: 5, version: 4, changed: true, rejected: [] });
  });

  it("lets an edit win over a concurrent delete", async () => {
    await push({ clientId: DEVICE_A, mutations: seed });
    await push({
      clientId: DEVICE_A,
      mutations: [mutation(4, { name: "deleteLevel", args: { id: RDC } }, 2_000)],
    });
    // Device B, offline, still saw the level and renamed one of its rooms.
    await push({
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
    await push({ clientId: DEVICE_A, mutations: seed });
    await push({
      clientId: DEVICE_B,
      mutations: [mutation(7, { name: "renameProperty", args: { id: PROPERTY, name: "Villa" } })],
    });

    expect((await pull(DEVICE_A, 0)).lastMutationId).toBe(3);
    expect((await pull(DEVICE_B, 0)).lastMutationId).toBe(7);
    expect((await pull(newId(), 0)).lastMutationId).toBe(0);
  });

  it("processes nothing for a device whose data comes from another epoch", async () => {
    await push({ clientId: DEVICE_A, epoch, mutations: [createProperty] });
    // The database is replaced: restoring a backup draws a new epoch, as migration 002 asks.
    const previous = epoch;
    await db.exec("UPDATE server_meta SET epoch = gen_random_uuid()");
    ({ epoch } = onlyRow(await db.query<{ epoch: string }>("SELECT epoch FROM server_meta")));
    expect(epoch).not.toBe(previous);

    // Still on the previous epoch: refused as a whole, and told the current one (by `push`).
    expect(await push({ clientId: DEVICE_A, epoch: previous, mutations: [createLevel] })).toEqual({
      lastMutationId: 1,
      version: 1,
      changed: false,
      rejected: [],
    });
    expect((await pull(DEVICE_A, 0)).changes.levels).toEqual([]);

    // Once the device has started over from this epoch, its mutations go through again.
    expect(await push({ clientId: DEVICE_A, epoch, mutations: [createLevel] })).toEqual({
      lastMutationId: 2,
      version: 2,
      changed: true,
      rejected: [],
    });
    // A device that never pulled has no epoch to send, nor anything to start over from.
    const other = mutation(1, { name: "createProperty", args: { id: newId(), name: "Villa" } });
    expect(await push({ clientId: DEVICE_B, mutations: [other] })).toMatchObject({
      lastMutationId: 1,
      changed: true,
    });
  });

  it("resends everything with reset when the cursor is ahead of the server", async () => {
    await push({ clientId: DEVICE_A, mutations: seed });

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
    const results = await Promise.all(batches.map((batch) => push(batch)));
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
