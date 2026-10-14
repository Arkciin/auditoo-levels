/**
 * Device persistence of the sync engine, in IndexedDB.
 *
 * Object stores:
 * - `meta`: key-value pairs (`clientId`, `cursor`);
 * - `properties`, `levels`, `spaces`: the last snapshot confirmed by the server (the "base");
 * - `outbox`: local mutations the server has not confirmed yet, keyed by their id.
 *
 * Every group of writes that must stay consistent runs in a single transaction, so a crash or a
 * closed tab can never leave a half-applied pull behind, and reads always see base, cursor and
 * outbox from the same instant.
 */
import {
  type Level,
  type Mutation,
  newId,
  type Property,
  type PullResponse,
  type Snapshot,
  type Space,
} from "@repo/shared";
import { type DBSchema, type IDBPDatabase, wrap } from "idb";

/** Name of the IndexedDB database used by the app. */
export const DEFAULT_DATABASE_NAME = "releve-sync";

const DATABASE_VERSION = 1;

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** A mutation before the outbox allocates its `id`. */
export type MutationDraft = DistributiveOmit<Mutation, "id">;

/** Everything a client needs to resume where it left off. */
export interface StoredState {
  /** This device's identity towards the server, shared by all its tabs. */
  readonly clientId: string;
  /** Server version the base is up to date with (0 = never pulled). */
  readonly cursor: number;
  /** Last snapshot confirmed by the server. */
  readonly base: Snapshot;
  /** Mutations not confirmed by the server yet, oldest first. */
  readonly pending: readonly Mutation[];
}

/** Durable device state of the sync engine. See {@link openSyncStorage}. */
export interface SyncStorage {
  /**
   * Reads the whole state in one transaction. On first run, creates and persists the client id
   * (inside that transaction, so two tabs starting together cannot create two ids).
   */
  loadState(): Promise<StoredState>;
  /**
   * Appends a mutation to the outbox and returns it with its id. Ids come from the store's key
   * generator: strictly increasing per device, even across tabs, and never reused. The promise
   * resolves once the write is durable.
   */
  enqueue(draft: MutationDraft): Promise<Mutation>;
  /** Up to `limit` outbox mutations with an id greater than `afterId`, oldest first. */
  readOutbox(afterId: number, limit: number): Promise<Mutation[]>;
  /**
   * Applies a pull response atomically: replaces the base on reset, upserts the changed rows,
   * drops the outbox mutations the server has processed and stores the new cursor.
   */
  commitPull(response: PullResponse): Promise<void>;
  /** Closes the database connection once pending transactions complete. */
  close(): void;
}

/** Options of {@link openSyncStorage}. */
export interface OpenSyncStorageOptions {
  /**
   * IndexedDB database name.
   * @defaultValue {@link DEFAULT_DATABASE_NAME}
   */
  readonly name?: string;
  /**
   * IndexedDB implementation. Tests pass a fresh `fake-indexeddb` factory per device.
   * @defaultValue `globalThis.indexedDB`
   */
  readonly indexedDB?: IDBFactory;
}

interface SyncSchema extends DBSchema {
  meta: { key: "clientId" | "cursor"; value: string | number };
  properties: { key: string; value: Property };
  levels: { key: string; value: Level };
  spaces: { key: string; value: Space };
  outbox: { key: number; value: Mutation };
}

const ALL_STORES = ["meta", "properties", "levels", "spaces", "outbox"] as const;

/** Opens (creating or upgrading if needed) the sync database. */
export async function openSyncStorage(options: OpenSyncStorageOptions = {}): Promise<SyncStorage> {
  const factory = options.indexedDB ?? globalThis.indexedDB;
  if (!factory) {
    throw new Error("Le stockage local (IndexedDB) n'est pas disponible sur cet appareil.");
  }
  const db = await openDatabase(factory, options.name ?? DEFAULT_DATABASE_NAME);
  return new IndexedDbSyncStorage(db);
}

/**
 * Equivalent of idb's `openDB`, which always uses the global `indexedDB`: we need the factory to
 * be injectable so that tests can give every simulated device its own isolated database.
 */
async function openDatabase(factory: IDBFactory, name: string): Promise<IDBPDatabase<SyncSchema>> {
  const request = factory.open(name, DATABASE_VERSION);
  request.addEventListener("upgradeneeded", (event) => {
    // Typing boundary: idb's `wrap` cannot know our schema; `upgrade` creates exactly it.
    upgrade(wrap(request.result) as IDBPDatabase<SyncSchema>, event.oldVersion);
  });
  const db = (await wrap(request)) as IDBPDatabase<SyncSchema>;
  // Another tab is opening a newer version of the app: step aside so its upgrade can proceed
  // instead of being blocked forever. This tab's next storage operation fails, which surfaces as
  // a sync error (and a failed mutation) until the page is reloaded.
  db.addEventListener("versionchange", () => db.close());
  return db;
}

function upgrade(db: IDBPDatabase<SyncSchema>, oldVersion: number): void {
  if (oldVersion < 1) {
    db.createObjectStore("meta");
    db.createObjectStore("properties", { keyPath: "id" });
    db.createObjectStore("levels", { keyPath: "id" });
    db.createObjectStore("spaces", { keyPath: "id" });
    // The key generator of this store allocates the mutation ids. Never delete and recreate the
    // store in a later migration without also rotating the client id: a fresh generator restarts
    // at 1 and the server would silently skip ids it already processed for this client.
    db.createObjectStore("outbox", { keyPath: "id", autoIncrement: true });
  }
}

class IndexedDbSyncStorage implements SyncStorage {
  constructor(private readonly db: IDBPDatabase<SyncSchema>) {}

  async loadState(): Promise<StoredState> {
    // Read-write even though it usually only reads: read-write transactions on overlapping stores
    // are serialized, which is what makes the client id creation race-free across tabs.
    const tx = this.db.transaction(ALL_STORES, "readwrite");
    const meta = tx.objectStore("meta");
    const storedClientId = await meta.get("clientId");
    let clientId: string;
    if (typeof storedClientId === "string") {
      clientId = storedClientId;
    } else {
      clientId = newId();
      await meta.put(clientId, "clientId");
    }
    const [cursor, properties, levels, spaces, pending] = await Promise.all([
      meta.get("cursor"),
      tx.objectStore("properties").getAll(),
      tx.objectStore("levels").getAll(),
      tx.objectStore("spaces").getAll(),
      tx.objectStore("outbox").getAll(),
      tx.done,
    ]);
    return {
      clientId,
      cursor: typeof cursor === "number" ? cursor : 0,
      base: {
        properties: new Map(properties.map((row) => [row.id, row])),
        levels: new Map(levels.map((row) => [row.id, row])),
        spaces: new Map(spaces.map((row) => [row.id, row])),
      },
      pending,
    };
  }

  async enqueue(draft: MutationDraft): Promise<Mutation> {
    // The outbox holds user input that exists nowhere else yet: ask for a write flushed to disk
    // before the UI shows the change. Browsers may default to "relaxed" durability (Chrome does),
    // which can lose the latest writes on power loss.
    const tx = this.db.transaction("outbox", "readwrite", { durability: "strict" });
    // Typing boundary: with a key path and a key generator, IndexedDB allocates `id` and writes it
    // into the stored record, so the record is a complete `Mutation` once added.
    const [id] = await Promise.all([tx.store.add(draft as Mutation), tx.done]);
    return { ...draft, id };
  }

  readOutbox(afterId: number, limit: number): Promise<Mutation[]> {
    return this.db.getAll("outbox", IDBKeyRange.lowerBound(afterId, true), limit);
  }

  async commitPull(response: PullResponse): Promise<void> {
    const tx = this.db.transaction(ALL_STORES, "readwrite");
    const properties = tx.objectStore("properties");
    const levels = tx.objectStore("levels");
    const spaces = tx.objectStore("spaces");
    // Requests of a transaction run in order: the clears happen before the puts. All of them are
    // awaited together so that a failing one rejects (and aborts) without unhandled rejections.
    const requests: Promise<unknown>[] = [];
    if (response.reset) requests.push(properties.clear(), levels.clear(), spaces.clear());
    for (const row of response.changes.properties) requests.push(properties.put(row));
    for (const row of response.changes.levels) requests.push(levels.put(row));
    for (const row of response.changes.spaces) requests.push(spaces.put(row));
    if (response.lastMutationId > 0) {
      requests.push(
        tx.objectStore("outbox").delete(IDBKeyRange.upperBound(response.lastMutationId)),
      );
    }
    requests.push(tx.objectStore("meta").put(response.cursor, "cursor"));
    await Promise.all([...requests, tx.done]);
  }

  close(): void {
    this.db.close();
  }
}
