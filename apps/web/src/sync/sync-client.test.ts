import { MAX_MUTATIONS_PER_PUSH, MutationRejectedError } from "@repo/shared";
import { IDBFactory } from "fake-indexeddb";
import { wrap } from "idb";
import { afterEach, describe, expect, it, vi } from "vitest";
import { describeMutationError } from "./describe";
import { DEFAULT_DATABASE_NAME, openSyncStorage, StorageClosedError } from "./storage";
import { retryDelay, type SyncClient } from "./sync-client";
import {
  closeLikeTheBrowser,
  type DeviceOptions,
  deferred,
  MemoryServer,
  MemoryTransport,
  openTestClient,
  RecordingIDBFactory,
  rowsOf,
  type TestClientOptions,
  TestDevice,
  uuid,
  waitForState,
} from "./test-support/harness";
import { HttpError, NetworkError, type Transport } from "./transport";

const P1 = uuid(1);
const P2 = uuid(2);
const L1 = uuid(11);
const S1 = uuid(21);

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function createDevice(server: MemoryServer, options?: DeviceOptions): Promise<TestDevice> {
  const device = await TestDevice.create(server, options);
  cleanups.push(() => device.close());
  return device;
}

async function createClient(options: TestClientOptions): Promise<SyncClient> {
  const client = await openTestClient(options);
  cleanups.push(() => client.dispose());
  return client;
}

describe("SyncClient", () => {
  it("shows a mutation at once, before any request completes", async () => {
    const server = new MemoryServer();
    const network = new MemoryTransport(server);
    const stalled = deferred();
    const transport: Transport = {
      push: async (request) => {
        await stalled.promise;
        return network.push(request);
      },
      pull: async (request) => {
        await stalled.promise;
        return network.pull(request);
      },
    };
    const client = await createClient({ indexedDB: new IDBFactory(), transport });
    client.start(); // The initial cycle is now stuck on the network.

    await client.mutate("createProperty", { id: P1, name: "12 rue des Lilas" });

    const state = client.getState();
    expect(state.view.properties.get(P1)?.name).toBe("12 rue des Lilas");
    expect(state.status).toMatchObject({ phase: "syncing", pendingCount: 1 });
    expect(server.snapshot().properties.size).toBe(0);

    stalled.resolve();
    await waitForState(client, (s) => s.status.pendingCount === 0 && s.status.phase === "idle");
    expect(server.snapshot().properties.get(P1)?.name).toBe("12 rue des Lilas");
  });

  it("publishes immutable states and keeps the view when a pull brings nothing new", async () => {
    const { client } = await createDevice(new MemoryServer());
    const initial = client.getState();
    expect(client.getState()).toBe(initial);

    const listener = vi.fn();
    client.subscribe(listener);
    await client.mutate("createProperty", { id: P1, name: "Maison" });
    const mutated = client.getState();
    expect(mutated).not.toBe(initial);
    expect(mutated.base).toBe(initial.base);
    expect(listener).toHaveBeenCalled();

    await client.syncNow();
    const synced = client.getState();
    await client.syncNow();
    expect(client.getState().view).toBe(synced.view);
    expect(client.getState().base).toBe(synced.base);
  });

  it("keeps mutations while offline and sends them when the network is back", async () => {
    const browser = new EventTarget();
    vi.stubGlobal("window", browser);
    let online = false;
    const server = new MemoryServer();
    const { client, transport } = await createDevice(server, { isOnline: () => online });
    transport.mode = "offline";
    client.start();

    await client.mutate("createProperty", { id: P1, name: "Maison" });
    await client.mutate("createLevel", { id: L1, propertyId: P1, name: "RDC", position: "a0" });
    await client.mutate("createSpace", { id: S1, levelId: L1, name: "Cuisine", position: "a0" });
    expect(client.getState().status).toMatchObject({ connection: "offline", pendingCount: 3 });
    expect(transport.attempts).toBe(0); // The browser knows it is offline: no doomed request.

    online = true;
    transport.mode = "online";
    browser.dispatchEvent(new Event("online"));

    const state = await waitForState(
      client,
      (s) => s.status.pendingCount === 0 && s.status.phase === "idle",
    );
    expect(state.status).toMatchObject({ connection: "online", lastError: null });
    expect(rowsOf(server.snapshot())).toEqual(rowsOf(state.view));
    expect(server.snapshot().spaces.get(S1)?.name).toBe("Cuisine");
  });

  it("reports an unreachable server as offline and retries with exponential backoff", async () => {
    // Only timers are faked: fake-indexeddb schedules its work with setImmediate.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    vi.spyOn(Math, "random").mockReturnValue(0.5); // No jitter.
    const server = new MemoryServer();
    const { client, transport } = await createDevice(server);
    transport.mode = "offline";
    client.start();
    await waitForState(client, (s) => s.status.connection === "offline"); // Retry in 1 s.

    await client.mutate("createProperty", { id: P1, name: "Maison" }); // Fails again: retry in 2 s.
    await waitForState(client, (s) => transport.attempts === 2 && s.status.phase === "idle");
    expect(client.getState().status).toMatchObject({ connection: "offline", lastError: null });

    transport.mode = "online";
    await vi.advanceTimersByTimeAsync(1_999);
    expect(transport.attempts).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    await waitForState(client, (s) => s.status.pendingCount === 0);
    expect(client.getState().status.connection).toBe("online");
    expect(server.snapshot().properties.has(P1)).toBe(true);
  });

  it("retries at once, ignoring the backoff, when the network comes back mid-attempt", async () => {
    // With fake timers the backoff never elapses: only an immediate retry can complete the sync.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const browser = new EventTarget();
    vi.stubGlobal("window", browser);
    const network = new MemoryTransport(new MemoryServer());
    let down = true;
    const transport: Transport = {
      push: (request) => network.push(request),
      pull: async (request) => {
        if (!down) return network.pull(request);
        down = false;
        browser.dispatchEvent(new Event("online")); // While the doomed request is in flight.
        throw new NetworkError("Simulated network: offline");
      },
    };
    const client = await createClient({ indexedDB: new IDBFactory(), transport });

    client.start();

    await waitForState(client, (s) => s.status.lastSyncedAt !== null);
    expect(client.getState().status.connection).toBe("online");
  });

  it("restores pending mutations after a restart, then syncs them", async () => {
    const server = new MemoryServer();
    const device = await createDevice(server);
    device.transport.mode = "offline";
    await device.client.mutate("createProperty", { id: P1, name: "Maison" });
    await device.client.mutate("createLevel", {
      id: L1,
      propertyId: P1,
      name: "RDC",
      position: "a0",
    });
    await device.client.syncNow(); // Fails: offline.
    const before = device.client.getState();

    await device.restart();

    const after = device.client.getState();
    expect(after.pending).toEqual(before.pending);
    expect(rowsOf(after.view)).toEqual(rowsOf(before.view));
    expect(after.status.pendingCount).toBe(2);

    device.transport.mode = "online";
    await device.client.syncNow();
    expect(device.client.getState().status.pendingCount).toBe(0);
    expect(rowsOf(server.snapshot())).toEqual(rowsOf(before.view));
  });

  it("drops a mutation the server rejects, and never sends it again", async () => {
    const server = new MemoryServer();
    server.rejectWhen = (mutation) =>
      mutation.name === "createProperty" && mutation.args.name === "Refusé";
    const { client, transport } = await createDevice(server);
    await client.mutate("createProperty", { id: P1, name: "Accepté" });
    await client.mutate("createProperty", { id: P2, name: "Refusé" });
    expect(client.getState().view.properties.size).toBe(2);

    await client.syncNow();

    const state = client.getState();
    expect([...state.view.properties.values()].map((property) => property.name)).toEqual([
      "Accepté",
    ]);
    expect(state.pending).toEqual([]);
    expect(server.rejected.map((mutation) => mutation.args)).toEqual([{ id: P2, name: "Refusé" }]);

    await client.mutate("renameProperty", { id: P1, name: "Toujours accepté" });
    await client.syncNow();
    const sent = transport.pushes.flat().filter((mutation) => mutation.args.id === P2);
    expect(sent).toHaveLength(1);
  });

  it("refuses an action on an entity it does not know, and queues nothing", async () => {
    const { client, transport } = await createDevice(new MemoryServer());
    const before = client.getState();

    await expect(client.mutate("renameLevel", { id: L1, name: "R+1" })).rejects.toBeInstanceOf(
      MutationRejectedError,
    );

    expect(client.getState()).toBe(before);
    await client.syncNow(); // Pushes whatever the outbox holds: nothing.
    expect(transport.pushes).toEqual([]);
  });

  it("gets past a queued mutation that today's rules refuse (from an older version)", async () => {
    const server = new MemoryServer();
    const indexedDB = new IDBFactory();
    // An older version of the app allowed tabs in names, and queued this rename offline.
    const older = await openSyncStorage({ indexedDB });
    const tab = String.fromCodePoint(0x09);
    await older.enqueue({ name: "createProperty", args: { id: P1, name: "Maison" }, timestamp: 1 });
    await older.enqueue({
      name: "renameProperty",
      args: { id: P1, name: `Mai${tab}son` },
      timestamp: 2,
    });
    await older.enqueue({ name: "createProperty", args: { id: P2, name: "Villa" }, timestamp: 3 });
    older.close();
    const client = await createClient({ indexedDB, transport: new MemoryTransport(server) });

    await client.syncNow();

    // Rejected on its own: the mutations around it went through, and the queue is empty.
    expect(server.rejected.map((mutation) => mutation.id)).toEqual([2]);
    expect(client.getState().pending).toEqual([]);
    expect(rowsOf(client.getState().view)).toEqual(rowsOf(server.snapshot()));
    expect(client.getState().view.properties.get(P1)?.name).toBe("Maison");
  });

  it("rejects invalid arguments with the schema's French message, and queues nothing", async () => {
    const { client } = await createDevice(new MemoryServer());

    await expect(client.mutate("createProperty", { id: P1, name: "   " })).rejects.toMatchObject({
      name: "ZodError",
      issues: [expect.objectContaining({ message: "Le nom est obligatoire" })],
    });
    expect(client.getState().pending).toEqual([]);
  });

  it("stores and shows arguments the way the server will see them", async () => {
    const server = new MemoryServer();
    const { client } = await createDevice(server);

    await client.mutate("createProperty", { id: P1, name: "  Maison  " });

    expect(client.getState().view.properties.get(P1)?.name).toBe("Maison");
    expect(client.getState().pending[0]?.args).toEqual({ id: P1, name: "Maison" });
    await client.syncNow();
    expect(server.snapshot().properties.get(P1)?.name).toBe("Maison");
  });

  it("keeps a mutation made while a pull is in flight, without applying it twice", async () => {
    const server = new MemoryServer();
    const network = new MemoryTransport(server);
    let hold: ReturnType<typeof deferred> | undefined;
    const answered = deferred();
    const transport: Transport = {
      push: (request) => network.push(request),
      pull: async (request) => {
        const response = await network.pull(request);
        if (hold) {
          answered.resolve();
          await hold.promise; // The response is "in transit".
        }
        return response;
      },
    };
    const client = await createClient({ indexedDB: new IDBFactory(), transport });
    await client.mutate("createProperty", { id: P1, name: "Avant" });
    await client.syncNow();

    hold = deferred();
    const syncing = client.syncNow();
    await answered.promise;
    await client.mutate("renameProperty", { id: P1, name: "Après" });
    hold.resolve();
    await syncing;

    let state = client.getState();
    expect(state.base.properties.get(P1)?.name).toBe("Avant");
    expect(state.view.properties.get(P1)?.name).toBe("Après");
    expect(state.pending.map((mutation) => mutation.name)).toEqual(["renameProperty"]);

    hold = undefined;
    await client.syncNow();
    state = client.getState();
    expect(state.pending).toEqual([]);
    expect(state.view.properties.get(P1)?.name).toBe("Après");
    const renames = network.pushes.flat().filter((mutation) => mutation.name === "renameProperty");
    expect(renames).toHaveLength(1);
  });

  it("pushes long queues in batches", async () => {
    const server = new MemoryServer();
    const { client, transport } = await createDevice(server);
    const count = 2 * MAX_MUTATIONS_PER_PUSH + 50;
    for (let n = 0; n < count; n++) {
      await client.mutate("createProperty", { id: uuid(1_000 + n), name: `Logement ${n}` });
    }

    await client.syncNow();

    expect(transport.pushes.map((batch) => batch.length)).toEqual([
      MAX_MUTATIONS_PER_PUSH,
      MAX_MUTATIONS_PER_PUSH,
      50,
    ]);
    expect(server.snapshot().properties.size).toBe(count);
    expect(client.getState().status.pendingCount).toBe(0);
  });

  it("reports server errors in French, keeps the queue, then recovers", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const server = new MemoryServer();
    const network = new MemoryTransport(server);
    let failures = 1;
    const transport: Transport = {
      push: async (request) => {
        if (failures-- > 0) throw new HttpError(503);
        return network.push(request);
      },
      pull: (request) => network.pull(request),
    };
    const client = await createClient({ indexedDB: new IDBFactory(), transport });
    await client.mutate("createProperty", { id: P1, name: "Maison" });

    await client.syncNow();
    expect(client.getState().status).toMatchObject({
      connection: "online",
      phase: "error",
      pendingCount: 1,
      lastError: "Le serveur est momentanément indisponible (erreur 503).",
    });

    await client.syncNow();
    expect(client.getState().status).toMatchObject({
      phase: "idle",
      pendingCount: 0,
      lastError: null,
    });
  });

  it("starts over from the server's data after a database reset, keeping local work", async () => {
    const server = new MemoryServer();
    const { client } = await createDevice(server);
    await client.mutate("createProperty", { id: P1, name: "Perdu" });
    await client.mutate("renameProperty", { id: P1, name: "Perdu 2" });
    await client.mutate("renameProperty", { id: P1, name: "Perdu 3" });
    await client.syncNow(); // Cursor 3.
    await client.mutate("createProperty", { id: P2, name: "Gardé" });

    server.wipe();
    await client.syncNow(); // Pushes the pending creation, then pulls with a cursor ahead: reset.

    const state = client.getState();
    expect([...state.view.properties.keys()]).toEqual([P2]);
    expect(rowsOf(state.base)).toEqual(rowsOf(server.snapshot()));
    expect(state.pending).toEqual([]);
  });

  it("syncs when the server pokes, and closes the event stream when stopped", async () => {
    class FakeEventSource extends EventTarget {
      static readonly CLOSED = 2;
      static readonly instances: FakeEventSource[] = [];
      readyState = 1;

      constructor(readonly url: string) {
        super();
        FakeEventSource.instances.push(this);
      }

      close() {
        this.readyState = FakeEventSource.CLOSED;
      }
    }
    vi.stubGlobal("EventSource", FakeEventSource);
    const server = new MemoryServer();
    const author = await createDevice(server);
    const reader = await createDevice(server, { eventsUrl: "/api/events" });
    reader.client.start();
    await waitForState(reader.client, (s) => s.status.lastSyncedAt !== null);
    const [events] = FakeEventSource.instances;
    expect(events?.url).toBe("/api/events");

    await author.client.mutate("createProperty", { id: P1, name: "Maison" });
    await author.client.syncNow();
    events?.dispatchEvent(new Event("poke"));

    await waitForState(reader.client, (s) => s.view.properties.has(P1));
    reader.client.stop();
    expect(events?.readyState).toBe(FakeEventSource.CLOSED);
  });

  it("syncs periodically while the page is visible, and when it shows again", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const page = Object.assign(new EventTarget(), {
      visibilityState: "visible" as DocumentVisibilityState,
    });
    vi.stubGlobal("document", page);
    const server = new MemoryServer();
    const author = await createDevice(server);
    const reader = await createDevice(server, { pullIntervalMs: 30_000 });
    reader.client.start();
    await waitForState(reader.client, (s) => s.status.lastSyncedAt !== null);

    await author.client.mutate("createProperty", { id: P1, name: "Maison" });
    await author.client.syncNow();
    await vi.advanceTimersByTimeAsync(30_000);
    await waitForState(reader.client, (s) => s.view.properties.has(P1));

    page.visibilityState = "hidden";
    await vi.advanceTimersByTimeAsync(60_000);
    expect(reader.client.getState().status.phase).toBe("idle"); // No cycle started meanwhile.

    await author.client.mutate("createProperty", { id: P2, name: "Appartement" });
    await author.client.syncNow();
    page.visibilityState = "visible";
    page.dispatchEvent(new Event("visibilitychange"));
    await waitForState(reader.client, (s) => s.view.properties.has(P2));
  });

  it("stops syncing in the background once stopped", async () => {
    const browser = new EventTarget();
    vi.stubGlobal("window", browser);
    const { client, transport } = await createDevice(new MemoryServer());
    client.start();
    await waitForState(client, (s) => s.status.lastSyncedAt !== null);
    client.stop();
    const attempts = transport.attempts;

    await client.mutate("createProperty", { id: P1, name: "Maison" });
    browser.dispatchEvent(new Event("online"));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(transport.attempts).toBe(attempts);
    expect(client.getState().status.pendingCount).toBe(1);
  });

  describe("with several tabs on one device", () => {
    it("shares the outbox and the base through storage and BroadcastChannel", async () => {
      const server = new MemoryServer();
      const indexedDB = new IDBFactory();
      const transport = new MemoryTransport(server);
      const channelName = `releve-sync-test-${crypto.randomUUID()}`;
      const tabA = await createClient({ indexedDB, transport, channelName });
      const tabB = await createClient({ indexedDB, transport, channelName });
      expect(tabB.clientId).toBe(tabA.clientId);

      await tabA.mutate("createProperty", { id: P1, name: "Maison" });
      await waitForState(tabB, (s) => s.view.properties.has(P1) && s.pending.length === 1);

      await tabB.syncNow(); // Tab B pushes tab A's mutation: the outbox is shared.
      expect(server.snapshot().properties.has(P1)).toBe(true);
      await waitForState(tabA, (s) => s.pending.length === 0 && s.base.properties.has(P1));
    });

    it("never pushes a mutation before an older one enqueued by another tab", async () => {
      const server = new MemoryServer();
      const indexedDB = new IDBFactory();
      const transport = new MemoryTransport(server);
      // No channel: tab B never hears about tab A's mutation.
      const tabA = await createClient({ indexedDB, transport });
      const tabB = await createClient({ indexedDB, transport });
      await tabA.mutate("createProperty", { id: P1, name: "Onglet A" });
      await tabB.mutate("createProperty", { id: P2, name: "Onglet B" });
      expect(tabB.getState().pending).toHaveLength(1);

      await tabB.syncNow();

      expect(transport.pushes.flat().map((mutation) => mutation.args.id)).toEqual([P1, P2]);
      expect(server.rejected).toEqual([]);
      expect(rowsOf(tabB.getState().view)).toEqual(rowsOf(server.snapshot()));
    });
  });
});

describe("when the server's database is replaced", () => {
  // Starting over is logged on purpose; keep the test output clean.
  const warn = () => vi.spyOn(console, "warn").mockImplementation(() => {});

  it("starts over from the new database, even once its version passed the cursor", async () => {
    warn();
    const server = new MemoryServer();
    const device = await createDevice(server);
    await device.client.mutate("createProperty", { id: P1, name: "Disparu avec l'ancienne base" });
    await device.client.syncNow();
    const { cursor } = await device.storedState();

    server.wipe();
    // Another device fills the new database: `cursor > version` can no longer reveal the change.
    const other = await createDevice(server);
    for (let n = 0; n <= cursor; n++) {
      await other.client.mutate("createProperty", { id: uuid(100 + n), name: `Logement ${n}` });
    }
    await other.client.syncNow();
    expect(server.currentVersion).toBeGreaterThan(cursor);

    await device.client.mutate("createProperty", { id: P2, name: "Créé hors ligne" });
    await device.client.syncNow();

    const state = device.client.getState();
    expect(rowsOf(state.view)).toEqual(rowsOf(server.snapshot()));
    expect(state.view.properties.has(P1)).toBe(false); // Gone with the old database.
    expect(state.view.properties.get(P2)?.name).toBe("Créé hors ligne"); // Pushed again.
    expect(state.pending).toEqual([]);
    expect((await device.storedState()).epoch).toBe(server.epoch);
  });

  it.each([
    ["a device that has synced before", true],
    ["a device that never pulled", false],
  ])(
    "never lets the new database skip mutations the old one acknowledged (%s)",
    async (_, syncedBefore) => {
      warn();
      const server = new MemoryServer();
      const network = new MemoryTransport(server);
      let losePulls = false;
      const transport: Transport = {
        push: (request) => network.push(request),
        pull: async (request) => {
          if (losePulls) throw new NetworkError("Simulated network: pull lost");
          return network.pull(request);
        },
      };
      const client = await createClient({ indexedDB: new IDBFactory(), transport });
      if (syncedBefore) {
        await client.mutate("createProperty", { id: P1, name: "Maison" });
        await client.syncNow();
      }
      // Pushed and acknowledged, but the pull that would confirm (and prune) them fails.
      losePulls = true;
      await client.mutate("createProperty", { id: P2, name: "Appartement" });
      await client.mutate("renameProperty", { id: P2, name: "Appartement rénové" });
      await client.syncNow();
      expect(client.getState().pending).toHaveLength(2);

      server.wipe();
      losePulls = false;
      await client.mutate("createProperty", { id: uuid(3), name: "Villa" });
      await client.syncNow();

      // Had the new database processed "Villa" first, it would have counted the two earlier
      // mutations as processed, and they would be lost.
      const names = [...server.snapshot().properties.values()].map((property) => property.name);
      expect(names.sort()).toEqual(["Appartement rénové", "Villa"]);
      expect(server.lostMutations).toEqual([]);
      expect(client.getState().pending).toEqual([]);
      expect(rowsOf(client.getState().view)).toEqual(rowsOf(server.snapshot()));
    },
  );

  it("starts over once when its data predates epochs (installed before they existed)", async () => {
    const warning = warn();
    const server = new MemoryServer();
    const device = await createDevice(server);
    await device.client.mutate("createProperty", { id: P1, name: "Maison" });
    await device.client.syncNow();
    expect(warning).not.toHaveBeenCalled();

    // The previous version of the app stored the same data, without an epoch.
    await device.restart(async () => {
      const db = await wrap(device.indexedDB.open(DEFAULT_DATABASE_NAME));
      await db?.delete("meta", "epoch");
      db?.close();
    });
    expect((await device.storedState()).epoch).toBeNull();
    await device.client.syncNow();
    await device.client.syncNow();

    expect(warning).toHaveBeenCalledOnce();
    expect((await device.storedState()).epoch).toBe(server.epoch);
    expect(rowsOf(device.client.getState().view)).toEqual(rowsOf(server.snapshot()));
  });
});

describe("when the browser closes the device database", () => {
  it("keeps working: the database reopens transparently", async () => {
    const server = new MemoryServer();
    const indexedDB = new RecordingIDBFactory();
    const client = await createClient({ indexedDB, transport: new MemoryTransport(server) });
    await client.mutate("createProperty", { id: P1, name: "Maison" });

    closeLikeTheBrowser(indexedDB.lastConnection); // e.g. iOS, while the app was in the background
    await client.mutate("renameProperty", { id: P1, name: "Villa" });
    await client.syncNow();

    expect(client.getState().status).toMatchObject({ phase: "idle", pendingCount: 0 });
    expect(server.snapshot().properties.get(P1)?.name).toBe("Villa");
  });

  it("asks, in French, to reload once a newer app version took the database over", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const indexedDB = new IDBFactory();
    const transport = new MemoryTransport(new MemoryServer());
    const client = await createClient({ indexedDB, transport });
    const message =
      "Relevé a été mis à jour dans un autre onglet. Rechargez cette page pour continuer.";

    const newer = await wrap(indexedDB.open(DEFAULT_DATABASE_NAME, 1_000)); // Another tab.
    newer?.close();

    const error = await client.mutate("createProperty", { id: P1, name: "Maison" }).then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(StorageClosedError);
    expect(describeMutationError(error)).toBe(message);
    expect(client.getState().pending).toEqual([]);

    await client.syncNow();
    expect(client.getState().status).toMatchObject({ phase: "error", lastError: message });
  });
});

describe("retryDelay", () => {
  it("doubles from 1 s up to 30 s", () => {
    const noJitter = () => 0.5;
    expect([1, 2, 3, 4, 5, 6, 7, 1_000].map((failures) => retryDelay(failures, noJitter))).toEqual([
      1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000,
    ]);
  });

  it("spreads retries by ±20 %", () => {
    expect(retryDelay(1, () => 0)).toBe(800);
    expect(retryDelay(1, () => 1)).toBe(1_200);
    expect(retryDelay(50, () => 0)).toBe(24_000);
  });
});
