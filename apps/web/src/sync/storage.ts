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
  /** Epoch of the server database the base comes from, `null` until the first pull. */
  readonly epoch: string | null;
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
   * drops the outbox mutations the server has processed and stores the new cursor and epoch.
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
  meta: { key: "clientId" | "cursor" | "epoch"; value: string | number };
  properties: { key: string; value: Property };
  levels: { key: string; value: Level };
  spaces: { key: string; value: Space };
  outbox: { key: number; value: Mutation };
}

const ALL_STORES = ["meta", "properties", "levels", "spaces", "outbox"] as const;

/**
 * The device storage can no longer be used by this page, which must be reloaded: the database
 * was deleted, or a newer version of the app took it over from another tab. The message is
 * user-facing (French).
 */
export class StorageClosedError extends Error {
  override readonly name = "StorageClosedError";
}

const DELETED =
  "Les données de Relevé ont été effacées de cet appareil. Rechargez la page pour continuer.";
const UPGRADED =
  "Relevé a été mis à jour dans un autre onglet. Rechargez cette page pour continuer.";
const UNAVAILABLE =
  "Le stockage de l'appareil est devenu inaccessible. Rechargez la page pour continuer.";

/** Opens (creating or upgrading if needed) the sync database. */
export async function openSyncStorage(options: OpenSyncStorageOptions = {}): Promise<SyncStorage> {
  const factory = options.indexedDB ?? globalThis.indexedDB;
  if (!factory) {
    throw new Error("Le stockage local (IndexedDB) n'est pas disponible sur cet appareil.");
  }
  const name = options.name ?? DEFAULT_DATABASE_NAME;
  return new IndexedDbSyncStorage(factory, name, await openDatabase(factory, name));
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
  return (await wrap(request)) as IDBPDatabase<SyncSchema>;
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

/**
 * Errors of an operation on a connection the browser closed. Its transaction, if any, wrote
 * nothing (IndexedDB transactions are atomic), so the operation can safely run again.
 */
function isConnectionLost(error: unknown): boolean {
  return error instanceof Error && ["InvalidStateError", "UnknownError"].includes(error.name);
}

class IndexedDbSyncStorage implements SyncStorage {
  private connection: Promise<IDBPDatabase<SyncSchema>>;
  /** The browser closed the connection (iOS in the background, storage pressure…). */
  private lost = false;
  /** Why this page can no longer use the database, if so (French, user-facing). */
  private unusable: string | undefined;
  private closed = false;
  /** Identity of the data, to check that a reopened database is still the same one. */
  private clientId: string | undefined;

  constructor(
    private readonly factory: IDBFactory,
    private readonly name: string,
    db: IDBPDatabase<SyncSchema>,
  ) {
    this.watch(db);
    this.connection = Promise.resolve(db);
  }

  loadState(): Promise<StoredState> {
    return this.run(async (db) => {
      // Read-write even though it usually only reads: read-write transactions on overlapping
      // stores are serialized, which is what makes the client id creation race-free across tabs.
      const tx = db.transaction(ALL_STORES, "readwrite");
      const meta = tx.objectStore("meta");
      const storedClientId = await meta.get("clientId");
      let clientId: string;
      if (typeof storedClientId === "string") {
        clientId = storedClientId;
      } else {
        clientId = newId();
        await meta.put(clientId, "clientId");
      }
      const [cursor, epoch, properties, levels, spaces, pending] = await Promise.all([
        meta.get("cursor"),
        meta.get("epoch"),
        tx.objectStore("properties").getAll(),
        tx.objectStore("levels").getAll(),
        tx.objectStore("spaces").getAll(),
        tx.objectStore("outbox").getAll(),
        tx.done,
      ]);
      this.clientId = clientId;
      return {
        clientId,
        cursor: typeof cursor === "number" ? cursor : 0,
        epoch: typeof epoch === "string" ? epoch : null,
        base: {
          properties: new Map(properties.map((row) => [row.id, row])),
          levels: new Map(levels.map((row) => [row.id, row])),
          spaces: new Map(spaces.map((row) => [row.id, row])),
        },
        pending,
      };
    });
  }

  enqueue(draft: MutationDraft): Promise<Mutation> {
    return this.run(async (db) => {
      // The outbox holds user input that exists nowhere else yet: ask for a write flushed to
      // disk before the UI shows the change. Browsers may default to "relaxed" durability (Chrome
      // does), which can lose the latest writes on power loss.
      const tx = db.transaction("outbox", "readwrite", { durability: "strict" });
      // Typing boundary: with a key path and a key generator, IndexedDB allocates `id` and writes
      // it into the stored record, so the record is a complete `Mutation` once added.
      const [id] = await Promise.all([tx.store.add(draft as Mutation), tx.done]);
      return { ...draft, id };
    });
  }

  readOutbox(afterId: number, limit: number): Promise<Mutation[]> {
    return this.run((db) => db.getAll("outbox", IDBKeyRange.lowerBound(afterId, true), limit));
  }

  commitPull(response: PullResponse): Promise<void> {
    return this.run(async (db) => {
      const tx = db.transaction(ALL_STORES, "readwrite");
      const properties = tx.objectStore("properties");
      const levels = tx.objectStore("levels");
      const spaces = tx.objectStore("spaces");
      // Requests of a transaction run in order: the clears happen before the puts. All of them
      // are awaited together so that a failing one rejects (and aborts) without unhandled
      // rejections.
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
      const meta = tx.objectStore("meta");
      requests.push(meta.put(response.cursor, "cursor"), meta.put(response.epoch, "epoch"));
      await Promise.all([...requests, tx.done]);
    });
  }

  close(): void {
    this.closed = true;
    this.connection.then(
      (db) => db.close(),
      () => {},
    );
  }

  /**
   * Runs `operation` on a live connection. When the browser closed the connection under it, the
   * connection is reopened and the operation, which wrote nothing, runs once more.
   */
  private async run<T>(operation: (db: IDBPDatabase<SyncSchema>) => Promise<T>): Promise<T> {
    try {
      return await operation(await this.open());
    } catch (error) {
      if (this.closed || this.unusable !== undefined) throw error;
      if (!this.lost && !isConnectionLost(error)) throw error;
      this.lost = true;
      return operation(await this.open());
    }
  }

  private open(): Promise<IDBPDatabase<SyncSchema>> {
    if (this.closed) return Promise.reject(new Error("The sync storage is closed"));
    if (this.unusable !== undefined) return Promise.reject(new StorageClosedError(this.unusable));
    if (this.lost) {
      this.lost = false;
      // Usually closed already; not if only an error revealed the problem.
      this.connection.then(
        (db) => db.close(),
        () => {},
      );
      this.connection = this.reopen();
    }
    return this.connection;
  }

  private async reopen(): Promise<IDBPDatabase<SyncSchema>> {
    let db: IDBPDatabase<SyncSchema> | undefined;
    try {
      db = await openDatabase(this.factory, this.name);
      // Cleared meanwhile (the site's data was erased), the database comes back empty: our data
      // is gone, and its fresh key generator would hand out mutation ids the server already saw.
      const clientId = await db.get("meta", "clientId");
      if (this.clientId !== undefined && clientId !== this.clientId) {
        this.unusable = DELETED;
        throw new StorageClosedError(DELETED);
      }
    } catch (error) {
      db?.close();
      if (this.unusable !== undefined) throw error;
      this.lost = true; // Maybe a transient failure: the next operation tries again.
      throw new StorageClosedError(UNAVAILABLE, { cause: error });
    }
    this.watch(db);
    return db;
  }

  private watch(db: IDBPDatabase<SyncSchema>): void {
    db.addEventListener("close", () => {
      this.lost = true;
    });
    // Another tab opens a newer version of the app, or deletes the database: step aside, or it
    // would be blocked forever. This page runs older code, or lost its data: it must reload.
    db.addEventListener("versionchange", (event) => {
      db.close();
      this.unusable = event.newVersion === null ? DELETED : UPGRADED;
    });
  }
}
