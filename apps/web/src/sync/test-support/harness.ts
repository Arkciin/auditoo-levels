/**
 * Simulated devices for the sync engine tests. Importing this module installs `fake-indexeddb`'s
 * globals, which idb needs; every device still gets its own `IDBFactory`, hence its own isolated
 * databases.
 */
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { openSyncStorage, type StoredState, type SyncStorage } from "../storage";
import { SyncClient, type SyncClientOptions, type SyncState } from "../sync-client";
import type { Transport } from "../transport";
import { MemoryServer, MemoryTransport } from "./memory-server";

export * from "./fixtures";
export { MemoryServer, MemoryTransport };

export type DeviceOptions = Omit<SyncClientOptions, "storage" | "transport">;

export interface TestClientOptions extends DeviceOptions {
  /** The device's IndexedDB; pass the same factory again to simulate a restart or another tab. */
  readonly indexedDB: IDBFactory;
  readonly transport: Transport;
}

/**
 * A client on the given IndexedDB, isolated from other tabs and seeing the network as up unless
 * told otherwise. It is not started: tests drive syncs with `syncNow()`.
 */
export async function openTestClient({
  indexedDB,
  ...options
}: TestClientOptions): Promise<SyncClient> {
  const storage = await openSyncStorage({ indexedDB });
  return SyncClient.create({ channelName: null, isOnline: () => true, ...options, storage });
}

/** A device: a client plus its private database and network link to a server. */
export class TestDevice {
  private constructor(
    readonly indexedDB: IDBFactory,
    readonly transport: MemoryTransport,
    private readonly options: DeviceOptions,
    public client: SyncClient,
  ) {}

  static async create(server: MemoryServer, options: DeviceOptions = {}): Promise<TestDevice> {
    const indexedDB = new IDBFactory();
    const transport = new MemoryTransport(server);
    const client = await openTestClient({ ...options, indexedDB, transport });
    return new TestDevice(indexedDB, transport, options, client);
  }

  /** Closes the app and opens it again: everything in memory is lost, storage survives. */
  async restart(): Promise<void> {
    await this.client.dispose();
    this.client = await openTestClient({
      ...this.options,
      indexedDB: this.indexedDB,
      transport: this.transport,
    });
  }

  /** What the device has persisted, read through a separate connection (like another tab). */
  async storedState(): Promise<StoredState> {
    this.inspector ??= openSyncStorage({ indexedDB: this.indexedDB });
    return (await this.inspector).loadState();
  }

  /** Disposes the client and closes the inspection connection, if any. */
  async close(): Promise<void> {
    await this.client.dispose();
    (await this.inspector)?.close();
  }

  private inspector: Promise<SyncStorage> | undefined;
}

/** Resolves with the first state (the current one included) matching `predicate`. */
export function waitForState(
  client: SyncClient,
  predicate: (state: SyncState) => boolean,
  timeoutMs = 2_000,
): Promise<SyncState> {
  return new Promise((resolve, reject) => {
    const check = () => {
      const state = client.getState();
      if (!predicate(state)) return;
      cleanup();
      resolve(state);
    };
    const unsubscribe = client.subscribe(check);
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for the expected sync state"));
    }, timeoutMs);
    const cleanup = () => {
      unsubscribe();
      clearTimeout(timer);
    };
    check();
  });
}
