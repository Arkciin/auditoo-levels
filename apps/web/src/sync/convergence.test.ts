/**
 * Randomized end-to-end test of the sync engine.
 *
 * Three devices edit the same data through networks that go down or lose responses, sync at random
 * moments and restart at random (losing everything in memory). Each one only acts on what it
 * currently shows, like a user would, so they routinely act on stale data. Once the network is
 * back, every device must hold exactly the server's state, nothing must be lost, and the data must
 * still make sense. A second variant also wipes the server's database along the way.
 *
 * Seeded: a failing seed replays identically.
 */
import {
  applyMutations,
  compareByPosition,
  isValidPosition,
  type Level,
  MAX_DUPLICATED_SPACES,
  type MutationName,
  MutationRejectedError,
  mutationNames,
  type Positioned,
  type Property,
  positionAtEnd,
  positionAtIndex,
  type Snapshot,
  type Space,
} from "@repo/shared";
import { afterAll, afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import {
  type Action,
  createRandom,
  MemoryServer,
  randomUuid,
  rowsOf,
  TestDevice,
} from "./test-support/harness";
import type { NetworkMode } from "./test-support/memory-server";

const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8];
const WIPE_SEEDS = [1, 2, 3, 4];
const STEPS = 300;
const DEVICE_COUNT = 3;
const NETWORK_MODES: readonly NetworkMode[] = [
  "online",
  "online",
  "offline",
  "lossy",
  "lossy-pull",
];

/** Mutation kinds performed over all seeds: each one must have been exercised. */
const performed = new Set<MutationName>();

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(() => {
  expect([...performed].sort()).toEqual([...mutationNames].sort());
});

describe("convergence", () => {
  it.each(SEEDS)("devices converge to the server's state (seed %i)", async (seed) => {
    const warn = vi.spyOn(console, "warn");
    const error = vi.spyOn(console, "error");

    const { server, reported } = await runScenario(seed, { wipes: [] });

    expect(server.snapshot().spaces.size).toBeGreaterThan(10); // The scenario did build something.
    // Every mutation reached the server (checked by runScenario), and none was rejected: each one
    // applied on its device, so it applied on the server too. Nor did any pending mutation ever
    // stop applying on its device: no user was told of a change that did not apply.
    expect(server.rejected).toEqual([]);
    expect([...reported.values()].flatMap((ids) => [...ids])).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it.each(WIPE_SEEDS)(
    "devices converge across wipes of the server database (seed %i)",
    async (seed) => {
      // Logged on purpose: devices starting over from a new database.
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const error = vi.spyOn(console, "error");

      // What a wipe destroyed is gone, but whatever was still pending on a device then, or was
      // done since, must have reached the new database, and every mutation it rejected must have
      // been reported to its user (both checked by runScenario).
      await runScenario(seed, { wipes: [100, 200] });

      expect(error).not.toHaveBeenCalled();
    },
  );
});

interface Scenario {
  readonly server: MemoryServer;
  readonly devices: readonly TestDevice[];
  /** Ids of the mutations each device reported as not applying, across its restarts. */
  readonly reported: ReadonlyMap<TestDevice, ReadonlySet<number>>;
}

/**
 * Plays a seeded scenario, wiping the server's database at the given steps. Then brings every
 * device back online, syncs them all, and checks what must hold after any scenario.
 */
async function runScenario(
  seed: number,
  { wipes }: { wipes: readonly number[] },
): Promise<Scenario> {
  const random = createRandom(seed);
  const pick = picker(random);
  const nextAction = simulateUser(random);

  let clock = Date.UTC(2026, 9, 14);
  const server = new MemoryServer();
  const devices = await Promise.all(
    Array.from({ length: DEVICE_COUNT }, () => TestDevice.create(server, { now: () => clock })),
  );
  onTestFinished(() => Promise.all(devices.map((device) => device.close())).then(() => {}));
  /** Mutations each device enqueued: the outbox allocates ids 1, 2, 3…, so also the last id. */
  const enqueued = new Map<TestDevice, number>();
  /**
   * Ids of the mutations the final server must have processed: all of them without wipes; with
   * wipes, those still in the outbox at the last wipe (unconfirmed, so the device kept them)
   * and those enqueued since. What a wipe destroyed once confirmed is gone, by nature.
   */
  const mustReach = new Map<TestDevice, Set<number>>(devices.map((device) => [device, new Set()]));
  /** Property each space was created in: moves must never take it elsewhere. */
  const propertyOfSpace = new Map<string, string>();
  const reported = new Map<TestDevice, Set<number>>(devices.map((device) => [device, new Set()]));
  /** Records what the device's current client reports: at startup (listed), then as it goes. */
  const listen = (device: TestDevice) => {
    const ids = reported.get(device);
    for (const rejection of device.client.getState().rejections) ids?.add(rejection.mutationId);
    device.client.onRejected((rejection) => ids?.add(rejection.mutationId));
  };
  for (const device of devices) listen(device);

  /** The user acts on what the device shows at this very moment. */
  const act = async (device: TestDevice) => {
    const { view } = device.client.getState();
    const action = nextAction(view);
    if (action.name === "createSpace") {
      const level = view.levels.get(action.args.levelId);
      if (level) propertyOfSpace.set(action.args.id, level.propertyId);
    } else if (action.name === "duplicateLevel") {
      const source = view.levels.get(action.args.sourceId);
      if (source) {
        for (const space of action.args.spaces) propertyOfSpace.set(space.id, source.propertyId);
      }
    }
    try {
      await device.client.mutate<MutationName>(action.name, action.args);
    } catch (error) {
      // Valid on what the device showed, by construction. Only a wipe can make it stale: a sync
      // in flight may start the device over from the new database before the action applies,
      // and the user is then told the data changed meanwhile. Anything else is a bug.
      if (!(error instanceof MutationRejectedError) || wipes.length === 0) throw error;
      return;
    }
    performed.add(action.name);
    const id = (enqueued.get(device) ?? 0) + 1;
    enqueued.set(device, id);
    mustReach.get(device)?.add(id);
  };

  for (let step = 0; step < STEPS; step++) {
    clock += 1_000;
    if (wipes.includes(step)) {
      server.wipe();
      for (const device of devices) {
        const { pending } = await device.storedState();
        mustReach.set(device, new Set(pending.map((mutation) => mutation.id)));
      }
    }
    const device = pick(devices);
    const roll = random();
    if (roll < 0.5) {
      await act(device);
    } else if (roll < 0.62) {
      device.transport.mode = pick(NETWORK_MODES);
    } else if (roll < 0.8) {
      await device.client.syncNow();
    } else if (roll < 0.97) {
      // The user keeps working while a sync is in flight; how far the sync got varies. Waiting
      // on IndexedDB rather than on a timer keeps the interleaving independent of wall-clock
      // time (fake-indexeddb schedules everything in one FIFO queue), hence reproducible.
      const syncing = device.client.syncNow();
      for (let turns = pick([0, 0, 1, 2]); turns > 0; turns--) await device.storedState();
      await act(device);
      await syncing;
    } else {
      await device.restart();
      listen(device);
    }
    await expectConsistent(device);
  }

  // The network comes back: two rounds let every device push, then pull everyone's work.
  for (const device of devices) device.transport.mode = "online";
  for (let round = 0; round < 2; round++) {
    for (const device of devices) await device.client.syncNow();
  }

  const expected = rowsOf(server.snapshot());
  for (const device of devices) {
    const state = device.client.getState();
    expect(state.pending).toEqual([]);
    expect(state.status).toMatchObject({ connection: "online", phase: "idle" });
    expect(rowsOf(state.view)).toEqual(expected);
  }
  // What each device persisted is that same state, with an empty outbox.
  for (const device of devices) {
    await device.restart();
    expect(rowsOf(device.client.getState().view)).toEqual(expected);
    expect(device.client.getState().pending).toEqual([]);
  }
  // Nothing lost: the server processed every mutation it had to, and never skipped one as
  // already processed without having processed it.
  for (const device of devices) {
    const processed = server.processedIdsOf(device.client.clientId);
    const missing = [...(mustReach.get(device) ?? [])].filter((id) => !processed.has(id));
    expect(missing).toEqual([]);
  }
  expect(server.lostMutations).toEqual([]);
  // No silent rejection: whatever the database rejected, its device told the user, even when the
  // response saying so was lost or the device restarted meanwhile.
  for (const device of devices) {
    const rejected = [...server.rejectionsOf(device.client.clientId).keys()];
    expect(rejected.filter((id) => !reported.get(device)?.has(id))).toEqual([]);
  }
  expect(invariantViolations(server.snapshot(), propertyOfSpace)).toEqual([]);
  return { server, devices, reported };
}

/**
 * Between two steps, a device's memory must match what it persisted (a crash at any point loses
 * nothing visible) and its view must be its base with its pending mutations replayed on top: in
 * particular, the user's own changes never vanish, even transiently.
 */
async function expectConsistent(device: TestDevice): Promise<void> {
  const state = device.client.getState();
  const stored = await device.storedState();
  expect(state.pending).toEqual(stored.pending);
  expect(rowsOf(state.base)).toEqual(rowsOf(stored.base));
  expect(rowsOf(state.view)).toEqual(rowsOf(await applyMutations(state.base, state.pending)));
}

function picker(random: () => number) {
  return <T>(items: readonly T[]): T => {
    const item = items[Math.floor(random() * items.length)];
    if (item === undefined) throw new Error("Cannot pick from an empty list");
    return item;
  };
}

/** What a device shows: the lists a user can act on. Deleted items only serve to restore them. */
class Screen {
  readonly liveProperties: Property[];
  readonly deletedProperties: Property[];
  readonly visibleLevels: Level[];
  readonly deletedLevels: Level[];
  readonly visibleSpaces: Space[];
  readonly deletedSpaces: Space[];

  constructor(readonly view: Snapshot) {
    const properties = [...view.properties.values()];
    this.liveProperties = properties.filter(isLive);
    this.deletedProperties = properties.filter((property) => !isLive(property));
    const levels = this.liveProperties.flatMap((property) => this.allLevelsOf(property.id));
    this.visibleLevels = levels.filter(isLive);
    this.deletedLevels = levels.filter((level) => !isLive(level));
    const spaces = this.visibleLevels.flatMap((level) => this.allSpacesOf(level.id));
    this.visibleSpaces = spaces.filter(isLive);
    this.deletedSpaces = spaces.filter((space) => !isLive(space));
  }

  /** Live levels of a property in display order, without `except` (the item being moved). */
  levelsOf(propertyId: string, except?: string): Level[] {
    return this.allLevelsOf(propertyId)
      .filter((level) => isLive(level) && level.id !== except)
      .sort(compareByPosition);
  }

  /** Live spaces of a level in display order, without `except` (the item being moved). */
  spacesOf(levelId: string, except?: string): Space[] {
    return this.allSpacesOf(levelId)
      .filter((space) => isLive(space) && space.id !== except)
      .sort(compareByPosition);
  }

  private allLevelsOf(propertyId: string): Level[] {
    return [...this.view.levels.values()].filter((level) => level.propertyId === propertyId);
  }

  private allSpacesOf(levelId: string): Space[] {
    return [...this.view.spaces.values()].filter((space) => space.levelId === levelId);
  }
}

interface ActionKind<N extends MutationName> {
  /** Relative likelihood; 0 when the action is not possible on this screen. */
  weight(screen: Screen): number;
  build(screen: Screen): Extract<Action, { name: N }>;
}

/** Returns a function picking a plausible user action on what a device shows. */
function simulateUser(random: () => number): (view: Snapshot) => Action {
  const pick = picker(random);
  let names = 0;
  const name = (noun: string) => `${noun} ${++names}`;
  const id = () => randomUuid(random);
  /** Position of an item dropped at a random place among `siblings`, like drag and drop does. */
  const drop = (siblings: readonly Positioned[]) =>
    positionAtIndex(siblings, Math.floor(random() * (siblings.length + 1)), random);
  const when = (condition: boolean, weight: number) => (condition ? weight : 0);

  const kinds: { readonly [N in MutationName]: ActionKind<N> } = {
    createProperty: {
      weight: (s) => (s.liveProperties.length < 3 ? 6 : 1),
      build: () => ({ name: "createProperty", args: { id: id(), name: name("Logement") } }),
    },
    renameProperty: {
      weight: (s) => when(s.liveProperties.length > 0, 3),
      build: (s) => ({
        name: "renameProperty",
        args: { id: pick(s.liveProperties).id, name: name("Logement") },
      }),
    },
    deleteProperty: {
      weight: (s) => when(s.liveProperties.length > 0, 1),
      build: (s) => ({ name: "deleteProperty", args: { id: pick(s.liveProperties).id } }),
    },
    restoreProperty: {
      weight: (s) => when(s.deletedProperties.length > 0, 1),
      build: (s) => ({ name: "restoreProperty", args: { id: pick(s.deletedProperties).id } }),
    },
    createLevel: {
      weight: (s) => when(s.liveProperties.length > 0, 8),
      build: (s) => {
        const property = pick(s.liveProperties);
        const position = drop(s.levelsOf(property.id));
        const args = { id: id(), propertyId: property.id, name: name("Niveau"), position };
        return { name: "createLevel", args };
      },
    },
    renameLevel: {
      weight: (s) => when(s.visibleLevels.length > 0, 3),
      build: (s) => ({
        name: "renameLevel",
        args: { id: pick(s.visibleLevels).id, name: name("Niveau") },
      }),
    },
    moveLevel: {
      weight: (s) => when(s.visibleLevels.length > 0, 5),
      build: (s) => {
        const level = pick(s.visibleLevels);
        const position = drop(s.levelsOf(level.propertyId, level.id));
        return { name: "moveLevel", args: { id: level.id, position } };
      },
    },
    deleteLevel: {
      weight: (s) => when(s.visibleLevels.length > 0, 2),
      build: (s) => ({ name: "deleteLevel", args: { id: pick(s.visibleLevels).id } }),
    },
    restoreLevel: {
      weight: (s) => when(s.deletedLevels.length > 0, 2),
      build: (s) => ({ name: "restoreLevel", args: { id: pick(s.deletedLevels).id } }),
    },
    duplicateLevel: {
      weight: (s) => when(s.visibleLevels.length > 0, 2),
      build: (s) => {
        const source = pick(s.visibleLevels);
        // The rooms the device shows, in order, under new ids and fresh positions.
        const spaces: { id: string; name: string; position: string }[] = [];
        for (const space of s.spacesOf(source.id).slice(0, MAX_DUPLICATED_SPACES)) {
          spaces.push({ id: id(), name: space.name, position: positionAtEnd(spaces, random) });
        }
        const position = drop(s.levelsOf(source.propertyId));
        const args = { id: id(), sourceId: source.id, name: name("Niveau"), position, spaces };
        return { name: "duplicateLevel", args };
      },
    },
    createSpace: {
      weight: (s) => when(s.visibleLevels.length > 0, 12),
      build: (s) => {
        const level = pick(s.visibleLevels);
        const position = drop(s.spacesOf(level.id));
        const args = { id: id(), levelId: level.id, name: name("Pièce"), position };
        return { name: "createSpace", args };
      },
    },
    renameSpace: {
      weight: (s) => when(s.visibleSpaces.length > 0, 4),
      build: (s) => ({
        name: "renameSpace",
        args: { id: pick(s.visibleSpaces).id, name: name("Pièce") },
      }),
    },
    moveSpace: {
      weight: (s) => when(s.visibleSpaces.length > 0, 10),
      build: (s) => {
        const space = pick(s.visibleSpaces);
        const propertyId = s.view.levels.get(space.levelId)?.propertyId;
        if (propertyId === undefined) throw new Error("A visible space has a visible level");
        // Within its level or to another level of the same property, as drag and drop allows.
        const target = pick(s.levelsOf(propertyId));
        const position = drop(s.spacesOf(target.id, space.id));
        return { name: "moveSpace", args: { id: space.id, levelId: target.id, position } };
      },
    },
    deleteSpace: {
      weight: (s) => when(s.visibleSpaces.length > 0, 3),
      build: (s) => ({ name: "deleteSpace", args: { id: pick(s.visibleSpaces).id } }),
    },
    restoreSpace: {
      weight: (s) => when(s.deletedSpaces.length > 0, 2),
      build: (s) => ({ name: "restoreSpace", args: { id: pick(s.deletedSpaces).id } }),
    },
  };

  return (view) => {
    const screen = new Screen(view);
    const weights = mutationNames.map((kind) => kinds[kind].weight(screen));
    let roll = random() * weights.reduce((sum, weight) => sum + weight, 0);
    for (const [index, kind] of mutationNames.entries()) {
      roll -= weights[index] ?? 0;
      if (roll < 0) return kinds[kind].build(screen);
    }
    throw new Error("unreachable: creating a property is always possible");
  };
}

function isLive(row: { readonly deletedAt: number | null }): boolean {
  return row.deletedAt === null;
}

function invariantViolations(
  snapshot: Snapshot,
  propertyOfSpace: ReadonlyMap<string, string>,
): string[] {
  const violations: string[] = [];
  for (const level of snapshot.levels.values()) {
    if (!snapshot.properties.has(level.propertyId)) {
      violations.push(`level ${level.id} belongs to an unknown property`);
    }
    if (!isValidPosition(level.position)) violations.push(`level ${level.id}: invalid position`);
  }
  for (const space of snapshot.spaces.values()) {
    const level = snapshot.levels.get(space.levelId);
    if (!level) violations.push(`space ${space.id} belongs to an unknown level`);
    else if (level.propertyId !== propertyOfSpace.get(space.id)) {
      violations.push(`space ${space.id} left its property`);
    }
    if (!isValidPosition(space.position)) violations.push(`space ${space.id}: invalid position`);
  }
  return violations;
}
