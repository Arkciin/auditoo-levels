/**
 * The sync engine: an offline-first, optimistic store of the dataset.
 *
 * The client keeps three things (Replicache-style):
 * - `base`: the last snapshot confirmed by the server, persisted in IndexedDB;
 * - `pending`: local mutations the server has not confirmed yet, persisted in the outbox;
 * - `view = applyMutations(base, pending)`: what the UI shows.
 *
 * A user action runs its mutator against the view (instant feedback), is written to the outbox,
 * then pushed. A pull brings the server's changes and tells which of our mutations they already
 * include: those leave the outbox and the others are replayed on top of the new base ("rebase").
 * Mutators are deterministic and the server runs the same code, so the view only differs from the
 * server's state by what the server has not seen yet.
 *
 * Guarantees:
 * - a mutation is durable before the UI shows it, and only leaves the outbox once a pull proves
 *   the server state includes it: failed requests, crashes and restarts never lose one;
 * - state transitions (local mutation, applying a pull, reloading what another tab wrote) are
 *   serialized, so none of them can interleave with another and lose or double-apply a mutation;
 * - one push/pull cycle at a time per device, across tabs (Web Locks).
 */
import {
  applyMutation,
  applyMutations,
  applyPull,
  MAX_MUTATIONS_PER_PUSH,
  type Mutation,
  type MutationArgs,
  type MutationName,
  mutationArgsSchemas,
  type PullResponse,
  type Snapshot,
  SnapshotTx,
} from "@repo/shared";
import type { MutationDraft, StoredState, SyncStorage } from "./storage";
import { HttpError, NetworkError, ProtocolError, type Transport } from "./transport";

/** Sync health, for the UI's status indicator. */
export interface SyncStatus {
  /**
   * `"offline"` when the browser reports no network or when the last request could not reach the
   * server, until a request succeeds.
   */
  readonly connection: "online" | "offline";
  /**
   * `"syncing"` while a push/pull cycle runs; `"error"` when the last cycle failed for a reason
   * other than connectivity (the server rejected the request or answered garbage). Being offline
   * is a normal condition for this app, not an error.
   */
  readonly phase: "idle" | "syncing" | "error";
  /** Local mutations not confirmed by the server yet. */
  readonly pendingCount: number;
  /** End of the last successful cycle (epoch ms), `null` until the first one. */
  readonly lastSyncedAt: number | null;
  /**
   * User-facing (French) description of the failure behind `phase: "error"`. `null` once a cycle
   * succeeds, and when the last one only failed for lack of network.
   */
  readonly lastError: string | null;
}

/**
 * Everything the UI renders. Immutable: a new object replaces it on every change, and each field
 * keeps its identity when it did not change.
 */
export interface SyncState {
  /** Last snapshot confirmed by the server. */
  readonly base: Snapshot;
  /** What the user sees: `base` with the pending mutations replayed on top. */
  readonly view: Snapshot;
  /** Local mutations not confirmed by the server yet, oldest first. */
  readonly pending: readonly Mutation[];
  readonly status: SyncStatus;
}

/** Options of {@link SyncClient.create}. */
export interface SyncClientOptions {
  /** Device persistence. The client owns it from now on and closes it in `dispose()`. */
  readonly storage: SyncStorage;
  readonly transport: Transport;
  /**
   * Clock for mutation timestamps and `lastSyncedAt`.
   * @defaultValue `Date.now`
   */
  readonly now?: () => number;
  /**
   * Whether the device has a network connection; `false` skips sync attempts entirely.
   * @defaultValue `navigator.onLine` (`true` where unavailable)
   */
  readonly isOnline?: () => boolean;
  /**
   * Server-Sent Events endpoint emitting `poke` events. Without it, changes made on other devices
   * arrive with the periodic sync.
   */
  readonly eventsUrl?: string;
  /**
   * Interval of the background sync while the page is visible.
   * @defaultValue 30 000 ms
   */
  readonly pullIntervalMs?: number;
  /**
   * Name of the BroadcastChannel and of the Web Lock shared by the tabs using the same storage.
   * `null` turns cross-tab coordination off (isolated clients in tests).
   * @defaultValue {@link DEFAULT_CHANNEL_NAME}
   */
  readonly channelName?: string | null;
}

/** Default name of the cross-tab BroadcastChannel and Web Lock. */
export const DEFAULT_CHANNEL_NAME = "releve-sync";

const DEFAULT_PULL_INTERVAL_MS = 30_000;
const RETRY_INITIAL_DELAY_MS = 1_000;
const RETRY_MAX_DELAY_MS = 30_000;
const RETRY_JITTER = 0.2;

/**
 * Delay before the next attempt after `failures` consecutive failed cycles: 1 s doubling up to
 * 30 s, ±20 % jitter so that devices cut off together do not all retry at the same instant (the
 * jitter applies after the cap, where spreading the load matters most).
 */
export function retryDelay(failures: number, random: () => number = Math.random): number {
  const exponent = Math.max(0, failures - 1);
  const delay = Math.min(RETRY_MAX_DELAY_MS, RETRY_INITIAL_DELAY_MS * 2 ** exponent);
  return Math.round(delay * (1 + RETRY_JITTER * (2 * random() - 1)));
}

type CycleOutcome = "ok" | "failed" | "skipped";

interface SyncWaiter {
  /** Index of the last cycle started when `syncNow()` was called: a later one must complete. */
  readonly after: number;
  readonly resolve: () => void;
}

/**
 * Offline-first store of the dataset, synced with the server in the background.
 *
 * ```ts
 * const client = await SyncClient.create({ storage, transport, eventsUrl: "/api/events" });
 * client.start();
 * await client.mutate("createLevel", { id: newId(), propertyId, name: "R+1", position });
 * ```
 */
export class SyncClient {
  /** This device's identity towards the server, shared by all its tabs. */
  readonly clientId: string;

  private readonly storage: SyncStorage;
  private readonly transport: Transport;
  private readonly now: () => number;
  private readonly isOnline: () => boolean;
  private readonly eventsUrl: string | undefined;
  private readonly pullIntervalMs: number;
  private readonly channelName: string | null;
  private readonly channel: BroadcastChannel | undefined;
  private readonly abortController = new AbortController();
  private readonly listeners = new Set<() => void>();

  private state: SyncState;
  /** Server version `state.base` is up to date with. */
  private cursor: number;
  /**
   * Highest mutation id the server is known to have processed: pushing starts after it. Only in
   * memory: after a restart the server's idempotency makes re-sending a few mutations harmless.
   */
  private lastAckedId = 0;
  /** `lastMutationId` of the last applied pull, to tell no-op pulls apart. */
  private lastPulledMutationId = 0;

  // Inputs of `status`, which `publish()` derives from them.
  private phase: SyncStatus["phase"] = "idle";
  private networkDown = false;
  private lastSyncedAt: number | null = null;
  private lastError: string | null = null;

  /** Tail of the queue that serializes state transitions. Never rejects. */
  private transitions: Promise<unknown> = Promise.resolve();
  private reloadScheduled = false;

  // Sync loop: at most one running, extra requests coalesce into one more cycle.
  private loop: Promise<void> = Promise.resolve();
  private looping = false;
  private syncRequested = false;
  /** Set by strong signals (`syncNow()`, network back): they bypass the backoff once. */
  private urgentRequest = false;
  private cyclesStarted = 0;
  private waiters: SyncWaiter[] = [];
  /** Consecutive failed cycles; drives the retry backoff. */
  private failures = 0;

  // Triggers, see start() and stop().
  private started = false;
  private disposed = false;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private pullTimer: ReturnType<typeof setInterval> | undefined;
  private events: EventSource | undefined;

  /**
   * Loads the device state (base snapshot and outbox) and computes the view. The client does not
   * talk to the server until {@link SyncClient.start} or {@link SyncClient.syncNow} is called.
   */
  static async create(options: SyncClientOptions): Promise<SyncClient> {
    const stored = await options.storage.loadState();
    return new SyncClient(options, stored, await replay(stored.base, stored.pending));
  }

  private constructor(options: SyncClientOptions, stored: StoredState, view: Snapshot) {
    this.storage = options.storage;
    this.transport = options.transport;
    this.now = options.now ?? Date.now;
    this.isOnline = options.isOnline ?? defaultIsOnline;
    this.eventsUrl = options.eventsUrl;
    this.pullIntervalMs = options.pullIntervalMs ?? DEFAULT_PULL_INTERVAL_MS;
    this.channelName =
      options.channelName === undefined ? DEFAULT_CHANNEL_NAME : options.channelName;
    this.clientId = stored.clientId;
    this.cursor = stored.cursor;
    this.state = {
      base: stored.base,
      view,
      pending: stored.pending,
      status: this.computeStatus(stored.pending.length, undefined),
    };
    if (this.channelName !== null && typeof BroadcastChannel !== "undefined") {
      this.channel = new BroadcastChannel(this.channelName);
      this.channel.addEventListener("message", this.handleTabMessage);
    }
  }

  /** Current state. Same object until something changes (as `useSyncExternalStore` requires). */
  readonly getState = (): SyncState => this.state;

  /** Calls `listener` after every state change. Returns the function that unsubscribes it. */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /**
   * Performs a user action: applied to the view at once, persisted, then synced.
   *
   * Resolves once the mutation is durable on the device and visible in the state. Rejects
   * without changing anything when:
   * - `args` are invalid (`ZodError`);
   * - the action does not apply to the current view, e.g. it targets an entity that does not
   *   exist (`MutationRejectedError`): the user acted on stale state;
   * - the device storage fails (e.g. `QuotaExceededError`).
   *
   * Show `describeMutationError(error)` to the user rather than `error.message`, which Zod 4
   * fills with a JSON dump of the issues.
   *
   * Bound to the client: it can be passed around as a plain function.
   */
  readonly mutate = async <N extends MutationName>(
    name: N,
    args: MutationArgs<N>,
  ): Promise<void> => {
    // Timestamped at call time: it records when the user acted, not when the queue got to it.
    const draft = createDraft(name, args, this.now());
    await this.transition(async () => {
      if (this.disposed) throw new Error("SyncClient is disposed");
      const view = await dryRun(this.state.view, draft);
      const mutation = await this.storage.enqueue(draft);
      this.publish({ view, pending: [...this.state.pending, mutation] });
      this.notifyOtherTabs();
    });
    if (this.started) this.requestSync();
  };

  /**
   * Starts background sync: an initial cycle, then a cycle after each local mutation, when the
   * network comes back, when the page becomes visible, when the server pokes (SSE), every
   * `pullIntervalMs` while visible, and on retries with exponential backoff after a failure.
   */
  start(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    const win = browserWindow();
    win?.addEventListener("online", this.handleOnline);
    win?.addEventListener("offline", this.handleOffline);
    browserDocument()?.addEventListener("visibilitychange", this.handleVisibilityChange);
    this.pullTimer = setInterval(this.handleTick, this.pullIntervalMs);
    this.openEvents();
    this.requestSync();
  }

  /** Stops background sync. A cycle in progress completes; `syncNow()` keeps working. */
  stop(): void {
    if (!this.started) return;
    this.started = false;
    const win = browserWindow();
    win?.removeEventListener("online", this.handleOnline);
    win?.removeEventListener("offline", this.handleOffline);
    browserDocument()?.removeEventListener("visibilitychange", this.handleVisibilityChange);
    clearInterval(this.pullTimer);
    this.pullTimer = undefined;
    this.clearRetry();
    this.events?.close();
    this.events = undefined;
  }

  /**
   * Syncs now (the "Synchroniser" button), resetting the retry backoff. Resolves once a cycle that
   * started after the call has completed, successfully or not: the outcome is in the status.
   */
  syncNow(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    const done = new Promise<void>((resolve) => {
      this.waiters.push({ after: this.cyclesStarted, resolve });
    });
    this.requestUrgentSync();
    return done;
  }

  /**
   * Stops everything, cancels in-flight requests, waits for pending state transitions and closes
   * the storage. Mutations already accepted are safe in the outbox for the next session.
   */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.stop();
    this.abortController.abort();
    this.releaseWaiters(Number.POSITIVE_INFINITY);
    await this.loop;
    await this.transitions;
    this.channel?.close();
    this.storage.close();
  }

  // --- Sync cycles -----------------------------------------------------------------------------

  private requestSync(): void {
    if (this.disposed) return;
    this.syncRequested = true;
    if (!this.looping) this.loop = this.runLoop();
  }

  /** A sync that skips the backoff: asked for by the user, or the network just came back. */
  private requestUrgentSync(): void {
    this.failures = 0;
    this.urgentRequest = true;
    this.requestSync();
  }

  private async runLoop(): Promise<void> {
    // `looping` is reset in the same synchronous step as the last `syncRequested` check, so a
    // request made at any time either is seen by this loop or starts a new one.
    this.looping = true;
    try {
      while (this.syncRequested && !this.disposed) {
        this.syncRequested = false;
        this.urgentRequest = false; // From now on, only requests made during this cycle count.
        this.clearRetry();
        const cycle = ++this.cyclesStarted;
        const outcome = await this.runCycle();
        this.releaseWaiters(cycle);
        if (outcome === "failed") {
          // An urgent request made while this cycle was failing deserves a fresh attempt. Other
          // triggers (local mutations, pokes, ticks) wait for the backoff instead of hammering a
          // failing server.
          if (this.urgentRequest) {
            this.syncRequested = true;
            continue;
          }
          this.scheduleRetry();
          break;
        }
      }
    } catch (error) {
      // runCycle handles every sync failure and publish isolates listeners: only a bug lands here.
      console.error("Sync loop crashed", error);
    } finally {
      this.looping = false;
    }
  }

  private async runCycle(): Promise<CycleOutcome> {
    if (!this.isOnline()) {
      // `navigator.onLine === false` is reliable: don't even try. The "online" event will.
      this.publish();
      return "skipped";
    }
    this.phase = "syncing";
    this.publish();
    try {
      await this.withSyncLock(() => this.pushThenPull());
    } catch (error) {
      if (!this.disposed) this.recordFailure(error);
      return "failed";
    }
    if (this.disposed) return "ok";
    this.failures = 0;
    this.phase = "idle";
    this.lastError = null;
    this.lastSyncedAt = this.now();
    this.publish();
    return "ok";
  }

  private async pushThenPull(): Promise<void> {
    const signal = this.abortController.signal;
    // Push from storage, not from memory: the tabs of this device share the outbox and the client
    // id, and the server skips ids at or below the last one it processed. Reading the outbox
    // guarantees we never send a mutation before an older one another tab enqueued meanwhile.
    for (;;) {
      const mutations = await this.storage.readOutbox(this.lastAckedId, MAX_MUTATIONS_PER_PUSH);
      if (mutations.length === 0) break;
      const response = await this.transport.push(
        { clientId: this.clientId, mutations },
        { signal },
      );
      this.networkDown = false;
      // No progress means the server knows better (e.g. its database was reset): stop and let
      // the pull reconcile rather than loop forever.
      if (response.lastMutationId <= this.lastAckedId) break;
      this.lastAckedId = response.lastMutationId;
    }
    const response = await this.transport.pull(
      { clientId: this.clientId, cursor: this.cursor },
      { signal },
    );
    this.networkDown = false;
    await this.transition(() => this.applyPullResponse(response));
  }

  private async applyPullResponse(response: PullResponse): Promise<void> {
    if (this.disposed) return;
    const { base, view, pending } = this.state;
    const rowsChanged = response.reset || hasRows(response.changes);
    const nextBase = rowsChanged ? applyPull(base, response) : base;
    // Mutations the server state already includes leave the queue, accepted or rejected alike.
    const unconfirmed = pending.filter((mutation) => mutation.id > response.lastMutationId);
    // Keep identities when nothing changed: periodic pulls must not re-render the UI.
    const nextPending = unconfirmed.length === pending.length ? pending : unconfirmed;
    const nextView =
      nextBase === base && nextPending === pending ? view : await replay(nextBase, nextPending);
    const storageChanged =
      rowsChanged ||
      response.cursor !== this.cursor ||
      response.lastMutationId !== this.lastPulledMutationId;
    // Computed first, persisted next, published last: if anything fails, memory and storage
    // still agree on the previous state and the next cycle simply tries again.
    await this.storage.commitPull(response);
    this.cursor = response.cursor;
    this.lastAckedId = response.lastMutationId;
    this.lastPulledMutationId = response.lastMutationId;
    this.publish({ base: nextBase, view: nextView, pending: nextPending });
    if (storageChanged) this.notifyOtherTabs();
  }

  private recordFailure(error: unknown): void {
    this.failures += 1;
    if (error instanceof NetworkError) {
      this.networkDown = true;
      this.phase = "idle";
      this.lastError = null;
    } else {
      // The server answered, so it is reachable; anything else is unexpected.
      if (error instanceof HttpError || error instanceof ProtocolError) this.networkDown = false;
      console.error("Sync failed", error);
      this.phase = "error";
      this.lastError = describeSyncError(error);
    }
    this.publish();
  }

  private releaseWaiters(completedCycle: number): void {
    const remaining: SyncWaiter[] = [];
    for (const waiter of this.waiters) {
      if (waiter.after < completedCycle) waiter.resolve();
      else remaining.push(waiter);
    }
    this.waiters = remaining;
  }

  private scheduleRetry(): void {
    if (!this.started || this.disposed) return;
    this.clearRetry();
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.requestSync();
    }, retryDelay(this.failures));
  }

  private clearRetry(): void {
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }

  private async withSyncLock(task: () => Promise<void>): Promise<void> {
    // Without cross-tab coordination the loop alone guarantees one cycle at a time.
    if (this.channelName === null) return task();
    const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
    if (locks) {
      await locks.request(this.channelName, { signal: this.abortController.signal }, task);
      return;
    }
    // No Web Locks (older browsers, Node): serialize at least the clients of this JS realm.
    return withInProcessLock(this.channelName, task);
  }

  // --- State -----------------------------------------------------------------------------------

  /** Runs `task` after every transition queued before it. */
  private transition<T>(task: () => Promise<T>): Promise<T> {
    const result = this.transitions.then(task);
    this.transitions = result.catch(() => undefined);
    return result;
  }

  /** Replaces the state if anything changed (status included) and notifies the listeners. */
  private publish(changes: Partial<Pick<SyncState, "base" | "view" | "pending">> = {}): void {
    const previous = this.state;
    const base = changes.base ?? previous.base;
    const view = changes.view ?? previous.view;
    const pending = changes.pending ?? previous.pending;
    const status = this.computeStatus(pending.length, previous.status);
    if (
      base === previous.base &&
      view === previous.view &&
      pending === previous.pending &&
      status === previous.status
    ) {
      return;
    }
    this.state = { base, view, pending, status };
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (error) {
        // A faulty subscriber must not break the sync engine (nor the other subscribers).
        console.error("SyncClient listener failed", error);
      }
    }
  }

  private computeStatus(pendingCount: number, previous: SyncStatus | undefined): SyncStatus {
    const next: SyncStatus = {
      connection: this.networkDown || !this.isOnline() ? "offline" : "online",
      phase: this.phase,
      pendingCount,
      lastSyncedAt: this.lastSyncedAt,
      lastError: this.lastError,
    };
    return previous && sameStatus(previous, next) ? previous : next;
  }

  // --- Other tabs ------------------------------------------------------------------------------

  private notifyOtherTabs(): void {
    // No payload: receivers re-read the storage, the single source of truth.
    this.channel?.postMessage("changed");
  }

  /** Another tab wrote to the shared storage: reload it (bursts of messages coalesce). */
  private readonly handleTabMessage = (): void => {
    if (this.reloadScheduled || this.disposed) return;
    this.reloadScheduled = true;
    this.transition(async () => {
      // Reset before reading: a message arriving during the read must schedule another one.
      this.reloadScheduled = false;
      if (this.disposed) return;
      const stored = await this.storage.loadState();
      const view = await replay(stored.base, stored.pending);
      this.cursor = stored.cursor;
      this.publish({ base: stored.base, view, pending: stored.pending });
    }).catch((error: unknown) => {
      console.error("Could not reload the state written by another tab", error);
    });
  };

  // --- Triggers --------------------------------------------------------------------------------

  private readonly handleOnline = (): void => {
    this.reopenEventsIfClosed();
    this.requestUrgentSync();
  };

  private readonly handleOffline = (): void => {
    this.publish();
  };

  private readonly handleVisibilityChange = (): void => {
    if (isPageVisible()) this.requestSync();
  };

  private readonly handleTick = (): void => {
    // A scheduled retry already covers this period (and respects the backoff).
    if (!isPageVisible() || this.retryTimer !== undefined) return;
    this.reopenEventsIfClosed();
    this.requestSync();
  };

  private readonly handlePoke = (): void => {
    this.requestSync();
  };

  private openEvents(): void {
    if (this.eventsUrl === undefined || typeof EventSource === "undefined") return;
    const events = new EventSource(this.eventsUrl);
    // A poke only says "something changed", and pokes sent while we were not connected are lost:
    // catch up on every (re)connection too.
    events.addEventListener("open", this.handlePoke);
    events.addEventListener("poke", this.handlePoke);
    this.events = events;
  }

  private reopenEventsIfClosed(): void {
    // EventSource reconnects by itself after network errors but gives up for good after an HTTP
    // error response (e.g. a 502 during a deployment).
    if (this.events && this.events.readyState === EventSource.CLOSED) {
      this.events.close();
      this.events = undefined;
      this.openEvents();
    }
  }
}

function createDraft<N extends MutationName>(
  name: N,
  args: MutationArgs<N>,
  timestamp: number,
): MutationDraft {
  // Parsing also normalizes (names are trimmed): the device must store and replay exactly what the
  // server will see once it has validated the push, or the view would change on the next pull.
  const parsed = mutationArgsSchemas[name].parse(args);
  // Typing boundary: TypeScript cannot correlate `name` and `parsed`, both coming from `N`.
  return { name, args: parsed, timestamp } as MutationDraft;
}

/** Runs the mutator against `view` and returns the resulting snapshot, or throws its rejection. */
async function dryRun(view: Snapshot, draft: MutationDraft): Promise<Snapshot> {
  const tx = new SnapshotTx(view);
  // Mutators never read the id; a placeholder lets us run the mutation before the outbox has
  // allocated its real one (which only happens if this succeeds).
  await applyMutation(tx, { ...draft, id: 0 });
  return tx.commit();
}

/** The rebase: replays pending mutations on top of a server snapshot. */
function replay(base: Snapshot, pending: readonly Mutation[]): Promise<Snapshot> {
  return applyMutations(base, pending, (mutation, error) => {
    // It stays in the outbox: the server is authoritative and will settle it, after which the
    // next pull drops it like any processed mutation.
    console.warn(`Pending mutation ${mutation.id} (${mutation.name}) no longer applies`, error);
  });
}

function hasRows(changes: PullResponse["changes"]): boolean {
  return changes.properties.length > 0 || changes.levels.length > 0 || changes.spaces.length > 0;
}

function sameStatus(a: SyncStatus, b: SyncStatus): boolean {
  return (
    a.connection === b.connection &&
    a.phase === b.phase &&
    a.pendingCount === b.pendingCount &&
    a.lastSyncedAt === b.lastSyncedAt &&
    a.lastError === b.lastError
  );
}

function describeSyncError(error: unknown): string {
  if (error instanceof HttpError) {
    return error.status >= 500
      ? `Le serveur est momentanément indisponible (erreur ${error.status}).`
      : `Le serveur a refusé la synchronisation (erreur ${error.status}).`;
  }
  if (error instanceof ProtocolError) return "Le serveur a envoyé une réponse inattendue.";
  if (error instanceof Error && error.name === "QuotaExceededError") {
    return "L'appareil n'a plus assez d'espace de stockage pour enregistrer les données reçues.";
  }
  return "La synchronisation a échoué de façon inattendue.";
}

function defaultIsOnline(): boolean {
  // `onLine === false` reliably means "no network" (`true` only means "maybe"). Node has a
  // `navigator` without `onLine`.
  return typeof navigator === "undefined" || navigator.onLine !== false;
}

function isPageVisible(): boolean {
  return typeof document === "undefined" || document.visibilityState !== "hidden";
}

function browserWindow(): Window | undefined {
  return typeof window === "undefined" ? undefined : window;
}

function browserDocument(): Document | undefined {
  return typeof document === "undefined" ? undefined : document;
}

const inProcessLocks = new Map<string, Promise<void>>();

/** Fallback for `navigator.locks`: a promise chain per lock name. */
function withInProcessLock(name: string, task: () => Promise<void>): Promise<void> {
  const result = (inProcessLocks.get(name) ?? Promise.resolve()).then(task);
  const tail = result.catch(() => undefined);
  inProcessLocks.set(name, tail);
  void tail.then(() => {
    if (inProcessLocks.get(name) === tail) inProcessLocks.delete(name);
  });
  return result;
}
