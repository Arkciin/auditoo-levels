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
 * - one push/pull cycle at a time per device, across tabs (Web Locks);
 * - when the server's database is replaced (another epoch), the device starts over from the new
 *   database's data and pushes its pending mutations again, none of them skipped;
 * - no change disappears without a word: one the server rejects, or that no longer applies to
 *   newer server data, is reported (`rejections`, `onRejected`) once it leaves the view.
 */
import {
  applyMutation,
  applyMutations,
  applyPull,
  clientTag,
  MAX_MUTATIONS_PER_PUSH,
  type Mutation,
  type MutationArgs,
  type MutationName,
  MutationRejectedError,
  mutationArgsSchemas,
  type PullResponse,
  type PushResponse,
  readStoredMutation,
  type Snapshot,
  SnapshotTx,
} from "@repo/shared";
import { describeRejection } from "./describe";
import {
  type MutationDraft,
  StorageClosedError,
  type StoredState,
  type SyncStorage,
} from "./storage";
import { HttpError, NetworkError, ProtocolError, type Transport } from "./transport";

/** Sync health, for the UI's status indicator. */
export interface SyncStatus {
  /**
   * `"offline"` when the browser reports no network (`navigator.onLine === false`, reliable);
   * `"unreachable"` when it reports one but the last request could not reach the server (it
   * failed or timed out: a network too weak, or a server still waking up), until a request
   * succeeds.
   */
  readonly connection: "online" | "offline" | "unreachable";
  /**
   * `"syncing"` while a push/pull cycle runs, background pulls included; `"error"` when the last
   * cycle failed for a reason other than connectivity (the server rejected the request or answered
   * garbage). Being offline is a normal condition for this app, not an error.
   */
  readonly phase: "idle" | "syncing" | "error";
  /**
   * Local changes are on their way to the server: from the moment a cycle starts pushing pending
   * mutations until it ends with the pull that confirms them. A cycle with nothing to send (the
   * periodic pull, a poke) leaves it false, so that the UI only shows activity when the user's
   * own work is moving.
   */
  readonly sending: boolean;
  /** Local mutations not confirmed by the server yet. */
  readonly pendingCount: number;
  /** End of the last successful cycle (epoch ms), `null` until the first one. */
  readonly lastSyncedAt: number | null;
  /**
   * User-facing (French) description of the failure behind `phase: "error"`. `null` once a cycle
   * succeeds, and when the last one only failed for lack of network.
   */
  readonly lastError: string | null;
  /**
   * When the automatic retry of a failed cycle is due (epoch ms); `null` when none is scheduled,
   * as while offline, where the network's return triggers the next attempt.
   */
  readonly nextAttemptAt: number | null;
}

/**
 * A change made on this device that did not apply: the server rejected it, or it no longer
 * applies to newer server data (its entity was lost with a replaced database, say).
 */
export interface Rejection {
  /** The mutation's id in the outbox. */
  readonly mutationId: number;
  /**
   * The server's code (`RejectionReason`, or a newer one this version does not know), or
   * `not_applicable` when the device found out itself, replaying its queue.
   */
  readonly reason: string;
  /** What was not done, and why, for the user (French), from `describeRejection`. */
  readonly message: string;
  /** When the change left the view (epoch ms). */
  readonly at: number;
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
  /**
   * The latest changes that did not apply, newest first, at most {@link MAX_RECENT_REJECTIONS}.
   * Kept in memory only: a restart forgets them.
   */
  readonly rejections: readonly Rejection[];
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

/** Length of `SyncState.rejections`. */
export const MAX_RECENT_REJECTIONS = 20;
/** Mutation ids remembered as reported, so that none is reported twice (rejections are rare). */
const MAX_REPORTED_IDS = 1_000;

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

/**
 * Why a sync is requested, which decides how it treats the backoff after failed cycles:
 * - `routine` (a local mutation, the periodic tick): while a retry is scheduled, waits for it. It
 *   says nothing about the network or the server, and the mutation is safe in the outbox.
 * - `signal` (a server poke, the event stream (re)connecting, the page becoming visible): syncs
 *   now. The server just proved reachable, or the user is back, maybe where the network is. A new
 *   failure still lengthens the backoff.
 * - `urgent` (`syncNow()`, the `online` event): syncs now and resets the backoff; if the cycle in
 *   flight fails, retries at once.
 */
type SyncTrigger = "routine" | "signal" | "urgent";

interface SyncWaiter {
  /** Index of the last cycle started when `syncNow()` was called: a later one must complete. */
  readonly after: number;
  readonly resolve: () => void;
}

/** A pending mutation a replay found no longer applying, with the state it was refused on. */
interface Refusal {
  readonly mutation: Mutation;
  readonly against: Snapshot;
  readonly error: unknown;
}

/**
 * What tabs tell each other: `"changed"` (reload the storage, the single source of truth), or
 * rejections one of them reported, which the others could not tell from the storage alone.
 */
type TabMessage = "changed" | { readonly type: "rejected"; readonly rejections: Rejection[] };

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
  private readonly rejectionListeners = new Set<(rejection: Rejection) => void>();

  private state: SyncState;
  /** Server version `state.base` is up to date with. */
  private cursor: number;
  /** Epoch of the server database `state.base` comes from, `null` until the first pull. */
  private epoch: string | null;
  /**
   * Highest mutation id the server is known to have processed: pushing starts after it. Only in
   * memory: after a restart the server's idempotency makes re-sending a few mutations harmless.
   */
  private lastAckedId = 0;
  /** `lastMutationId` of the last applied pull, to tell no-op pulls apart. */
  private lastPulledMutationId = 0;

  /**
   * Rejections pushes reported, by mutation id, held until their mutation leaves the queue (at the
   * pull that confirms it): the user then hears of a change as it disappears from the screen.
   */
  private readonly rejectedByServer = new Map<number, Omit<Rejection, "mutationId" | "at">>();
  /** Ids of the mutations already reported as rejected (oldest first, bounded). */
  private readonly reported = new Set<number>();

  // Inputs of `status`, which `publish()` derives from them.
  private phase: SyncStatus["phase"] = "idle";
  private sending = false;
  private networkDown = false;
  private lastSyncedAt: number | null = null;
  private lastError: string | null = null;
  private nextAttemptAt: number | null = null;

  /** Tail of the queue that serializes state transitions. Never rejects. */
  private transitions: Promise<unknown> = Promise.resolve();
  private reloadScheduled = false;

  // Sync loop: at most one running, extra requests coalesce into one more cycle.
  private loop: Promise<void> = Promise.resolve();
  private looping = false;
  private syncRequested = false;
  /** An `urgent` request came during the current cycle: retry at once if it fails. */
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
    const stored = readStoredState(await options.storage.loadState());
    // Never throws: a queued change this version cannot replay is listed as not applying, not a
    // reason to refuse to start (the page would say « Stockage indisponible » for good).
    const { view, refused } = await replay(stored.base, stored.pending);
    // Without WebCrypto (plain HTTP from another host than localhost), every poke counts as
    // another device's: one pull too many after each push, as before pokes named their pusher.
    const tag = await clientTag(stored.clientId).catch(() => null);
    const client = new SyncClient(options, stored, view, tag);
    // Queued changes that no longer apply (reported in an earlier session, most likely): listed
    // in the state, but nobody listens to `onRejected` yet, so no toast for old news.
    await client.reportRefusals(refused, stored);
    return client;
  }

  private constructor(
    options: SyncClientOptions,
    stored: StoredState,
    view: Snapshot,
    private readonly tag: string | null,
  ) {
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
    this.epoch = stored.epoch;
    this.state = {
      base: stored.base,
      view,
      pending: stored.pending,
      status: this.computeStatus(stored.pending.length, undefined),
      rejections: [],
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
   * Calls `listener` with each change of this device found not to apply from now on (the server
   * rejected it, or it no longer applies to newer server data), once, as it leaves the view and
   * after the state listing it is published. Returns the function that unsubscribes it.
   */
  readonly onRejected = (listener: (rejection: Rejection) => void): (() => void) => {
    this.rejectionListeners.add(listener);
    return () => {
      this.rejectionListeners.delete(listener);
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
    if (this.started) this.requestSync("routine");
  };

  /**
   * Starts background sync: an initial cycle, then a cycle after each local mutation, when the
   * network comes back, when the page becomes visible, when the server pokes (SSE), every
   * `pullIntervalMs` while visible, and on retries with exponential backoff after a failure
   * (which local mutations and the periodic sync wait for, see {@link SyncTrigger}).
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
    this.requestSync("signal");
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
    if (!this.disposed) this.publish(); // No retry is due any more.
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
    this.requestSync("urgent");
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

  private requestSync(trigger: SyncTrigger): void {
    if (this.disposed) return;
    if (trigger === "urgent") {
      this.failures = 0;
      this.urgentRequest = true;
    }
    this.syncRequested = true;
    // Backing off: the scheduled retry will see the request.
    if (trigger === "routine" && this.retryTimer !== undefined) return;
    if (!this.looping) this.loop = this.runLoop();
  }

  private async runLoop(): Promise<void> {
    // `looping` is reset in the same synchronous step as the last `syncRequested` check, so a
    // request made at any time is seen by this loop, starts a new one, or waits for the retry.
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
          // requests made meanwhile wait for the retry, and so do the routine ones made after it
          // (see SyncTrigger): no hammering a failing server.
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
    this.sending = false;
    this.lastError = null;
    this.lastSyncedAt = this.now();
    this.publish();
    return "ok";
  }

  private async pushThenPull(): Promise<void> {
    await this.push();
    if (await this.pull()) {
      // The device started over from a new database, which knows none of its pending mutations:
      // send them right away rather than at the next cycle, then confirm them.
      await this.push();
      await this.pull();
    }
  }

  private async push(): Promise<void> {
    const signal = this.abortController.signal;
    // Push from storage, not from memory: the tabs of this device share the outbox and the client
    // id, and the server skips ids at or below the last one it processed. Reading the outbox
    // guarantees we never send a mutation before an older one another tab enqueued meanwhile.
    for (;;) {
      const mutations = await this.storage.readOutbox(this.lastAckedId, MAX_MUTATIONS_PER_PUSH);
      if (mutations.length === 0) return;
      if (!this.sending) {
        this.sending = true;
        this.publish();
      }
      const response = await this.transport.push(
        { clientId: this.clientId, epoch: this.epoch ?? undefined, mutations },
        { signal },
      );
      this.networkDown = false;
      // Another database answered: it processed nothing, and the pull will start over.
      if (this.epoch !== null && response.epoch !== this.epoch) return;
      // A device that has never pulled learns here which database acknowledges its mutations, so
      // that it notices if another one answers later. (One that synced before epochs existed must
      // not: its data may come from yet another database, and its pull will start over anyway.)
      if (this.epoch === null && this.cursor === 0) this.epoch = response.epoch;
      await this.holdServerRejections(mutations, response.rejected);
      // No progress means the server knows better: stop and let the pull reconcile rather than
      // loop forever.
      if (response.lastMutationId <= this.lastAckedId) return;
      this.lastAckedId = response.lastMutationId;
    }
  }

  /**
   * Words the rejections a push reported, now, while the queue still holds their mutations (for
   * names as the user saw them). They are announced once the mutations leave the queue.
   */
  private async holdServerRejections(
    batch: readonly Mutation[],
    rejected: PushResponse["rejected"],
  ): Promise<void> {
    if (rejected.length === 0) return;
    const reasons = new Map(rejected.map(({ id, reason }) => [id, reason]));
    const refusedByServer = (id: number) =>
      reasons.has(id) || this.rejectedByServer.has(id) || this.reported.has(id);
    const { base, pending } = this.state;
    for (const mutation of batch) {
      const reason = reasons.get(mutation.id);
      if (reason === undefined) continue;
      // Already known: reported, or held since an earlier attempt (this push is a retry).
      if (this.reported.has(mutation.id) || this.rejectedByServer.has(mutation.id)) continue;
      const earlier = pending.filter((other) => other.id < mutation.id);
      const before = await applyMutations(base, earlier);
      // What the server held when it refused it, as far as this device knows: the confirmed state
      // and the earlier changes it accepted (a room fails when the level it goes in was refused).
      const against = await applyMutations(
        base,
        earlier.filter((other) => !refusedByServer(other.id)),
      );
      const message = describeRejection(mutation, before, reason, against);
      this.rejectedByServer.set(mutation.id, { reason, message });
    }
  }

  /** Pulls and applies the server's changes. Returns true when the device had to start over. */
  private async pull(): Promise<boolean> {
    const signal = this.abortController.signal;
    const request = { clientId: this.clientId, cursor: this.cursor };
    let response = await this.transport.pull(request, { signal });
    this.networkDown = false;
    // A device that synced before epochs existed cannot tell where its data comes from either.
    const startOver = this.epoch === null ? this.cursor > 0 : response.epoch !== this.epoch;
    if (startOver) {
      // The server's database is not the one our data comes from (recreated, or restored from a
      // backup): our cursor means nothing to it, nor do the acknowledgements we got. Start over
      // from its full state. The outbox stays, to be pushed again from its first mutation.
      console.warn("The server's database was replaced: resyncing from scratch");
      this.lastAckedId = 0;
      // The previous database's verdicts too: the new one judges the mutations again.
      this.rejectedByServer.clear();
      const full = await this.transport.pull({ ...request, cursor: 0 }, { signal });
      response = { ...full, reset: true };
    }
    await this.transition(() => this.applyPullResponse(response));
    return startOver;
  }

  private async applyPullResponse(response: PullResponse): Promise<void> {
    if (this.disposed) return;
    const previous = this.state;
    const { base, view, pending } = previous;
    const rowsChanged = response.reset || hasRows(response.changes);
    const nextBase = rowsChanged ? applyPull(base, response) : base;
    // Mutations the server state already includes leave the queue, accepted or rejected alike.
    const unconfirmed = pending.filter((mutation) => mutation.id > response.lastMutationId);
    // Keep identities when nothing changed: periodic pulls must not re-render the UI.
    const nextPending = unconfirmed.length === pending.length ? pending : unconfirmed;
    const replayed =
      nextBase === base && nextPending === pending
        ? undefined
        : await replay(nextBase, nextPending);
    const nextView = replayed?.view ?? view;
    const storageChanged =
      rowsChanged ||
      response.epoch !== this.epoch ||
      response.cursor !== this.cursor ||
      response.lastMutationId !== this.lastPulledMutationId;
    // Computed first, persisted next, published last: if anything fails, memory and storage
    // still agree on the previous state and the next cycle simply tries again.
    await this.storage.commitPull(response);
    this.epoch = response.epoch;
    this.cursor = response.cursor;
    this.lastAckedId = response.lastMutationId;
    this.lastPulledMutationId = response.lastMutationId;
    this.publish({ base: nextBase, view: nextView, pending: nextPending });
    if (storageChanged) this.notifyOtherTabs();
    this.reportSettledRejections();
    if (replayed) await this.reportRefusals(replayed.refused, previous);
  }

  private recordFailure(error: unknown): void {
    this.failures += 1;
    this.sending = false;
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
    const delay = retryDelay(this.failures);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.requestSync("routine");
    }, delay);
    this.nextAttemptAt = this.now() + delay;
    this.publish();
  }

  /** Cancels the scheduled retry; whoever calls it publishes the status soon after. */
  private clearRetry(): void {
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.nextAttemptAt = null;
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
  private publish(
    changes: Partial<Pick<SyncState, "base" | "view" | "pending" | "rejections">> = {},
  ): void {
    const previous = this.state;
    const base = changes.base ?? previous.base;
    const view = changes.view ?? previous.view;
    const pending = changes.pending ?? previous.pending;
    const rejections = changes.rejections ?? previous.rejections;
    const status = this.computeStatus(pending.length, previous.status);
    if (
      base === previous.base &&
      view === previous.view &&
      pending === previous.pending &&
      status === previous.status &&
      rejections === previous.rejections
    ) {
      return;
    }
    this.state = { base, view, pending, status, rejections };
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
      connection: !this.isOnline() ? "offline" : this.networkDown ? "unreachable" : "online",
      phase: this.phase,
      sending: this.sending,
      pendingCount,
      lastSyncedAt: this.lastSyncedAt,
      lastError: this.lastError,
      nextAttemptAt: this.nextAttemptAt,
    };
    return previous && sameStatus(previous, next) ? previous : next;
  }

  // --- Rejections ------------------------------------------------------------------------------

  /** Reports the rejections held for mutations that have left the queue. */
  private reportSettledRejections(): void {
    if (this.rejectedByServer.size === 0) return;
    const queued = new Set(this.state.pending.map((mutation) => mutation.id));
    const at = this.now();
    const settled: Rejection[] = [];
    for (const [mutationId, rejection] of this.rejectedByServer) {
      if (queued.has(mutationId)) continue;
      this.rejectedByServer.delete(mutationId);
      if (this.claim(mutationId)) settled.push({ mutationId, ...rejection, at });
    }
    this.report(settled);
  }

  /**
   * Reports the pending mutations a replay found no longer applying: their effect just left the
   * view. They are named as in `previous`, the state in which they still applied.
   */
  private async reportRefusals(
    refused: readonly Refusal[],
    previous: Pick<SyncState, "base" | "pending">,
  ): Promise<void> {
    const fresh = refused.filter(({ mutation }) => this.claim(mutation.id));
    if (fresh.length === 0) return;
    const at = this.now();
    const rejections: Rejection[] = [];
    for (const { mutation, against, error } of fresh) {
      // Not a verdict on the data, but a mutator failing on what another version queued, or a
      // bug: worth a trace, once.
      if (!(error instanceof MutationRejectedError)) {
        console.error(`Queued mutation ${mutation.id} failed to replay`, error);
      }
      const earlier = previous.pending.filter((other) => other.id < mutation.id);
      const before = await applyMutations(previous.base, earlier);
      const message = describeRejection(mutation, before, "not_applicable", against);
      rejections.push({ mutationId: mutation.id, reason: "not_applicable", message, at });
    }
    this.report(rejections);
  }

  /** Marks a mutation as reported; false if it already was. */
  private claim(mutationId: number): boolean {
    if (this.reported.has(mutationId)) return false;
    this.reported.add(mutationId);
    if (this.reported.size > MAX_REPORTED_IDS) {
      const [oldest] = this.reported;
      if (oldest !== undefined) this.reported.delete(oldest);
    }
    return true;
  }

  /**
   * Lists newly claimed rejections in the state, then tells the `onRejected` listeners and the
   * other tabs (which cannot tell a rejection from the storage, where it only leaves the outbox).
   */
  private report(rejections: readonly Rejection[], { fromOtherTab = false } = {}): void {
    if (rejections.length === 0 || this.disposed) return;
    // Not `toSorted`: the app targets ES2022, for the older Safari found on tablets.
    const newestFirst = [...rejections].sort((a, b) => b.at - a.at || b.mutationId - a.mutationId);
    this.publish({
      rejections: [...newestFirst, ...this.state.rejections].slice(0, MAX_RECENT_REJECTIONS),
    });
    for (const rejection of rejections) {
      for (const listener of this.rejectionListeners) {
        try {
          listener(rejection);
        } catch (error) {
          console.error("SyncClient rejection listener failed", error);
        }
      }
    }
    if (!fromOtherTab) {
      this.channel?.postMessage({
        type: "rejected",
        rejections: [...rejections],
      } satisfies TabMessage);
    }
  }

  // --- Other tabs ------------------------------------------------------------------------------

  private notifyOtherTabs(): void {
    // No payload: receivers re-read the storage, the single source of truth.
    this.channel?.postMessage("changed" satisfies TabMessage);
  }

  /**
   * Another tab reported rejections, or wrote to the shared storage: reload it then (bursts of
   * messages coalesce).
   */
  private readonly handleTabMessage = (event: MessageEvent<unknown>): void => {
    if (this.disposed) return;
    const rejections = rejectionsIn(event.data);
    if (rejections) {
      const fresh = rejections.filter((rejection) => this.claim(rejection.mutationId));
      this.report(fresh, { fromOtherTab: true });
      return;
    }
    if (this.reloadScheduled) return;
    this.reloadScheduled = true;
    this.transition(async () => {
      // Reset before reading: a message arriving during the read must schedule another one.
      this.reloadScheduled = false;
      if (this.disposed) return;
      const previous = this.state;
      const stored = readStoredState(await this.storage.loadState());
      const { view, refused } = await replay(stored.base, stored.pending);
      // Another tab started over from a new database: what we know was acknowledged no longer is,
      // and the previous database's verdicts no longer stand.
      if (stored.epoch !== this.epoch) {
        this.lastAckedId = 0;
        this.rejectedByServer.clear();
      }
      this.epoch = stored.epoch;
      this.cursor = stored.cursor;
      this.publish({ base: stored.base, view, pending: stored.pending });
      this.reportSettledRejections();
      await this.reportRefusals(refused, previous);
    }).catch((error: unknown) => {
      console.error("Could not reload the state written by another tab", error);
    });
  };

  // --- Triggers --------------------------------------------------------------------------------

  private readonly handleOnline = (): void => {
    this.reopenEventsIfClosed();
    this.requestSync("urgent");
  };

  private readonly handleOffline = (): void => {
    this.publish();
  };

  private readonly handleVisibilityChange = (): void => {
    if (isPageVisible()) this.requestSync("signal");
  };

  private readonly handleTick = (): void => {
    if (!isPageVisible()) return;
    // Even while backing off: a stream that opens again tells that the server is back.
    this.reopenEventsIfClosed();
    this.requestSync("routine");
  };

  private readonly handleStreamOpen = (): void => {
    this.requestSync("signal");
  };

  private readonly handlePoke = (event: Event): void => {
    // A push from this device caused it (from this tab or another: they share the client id).
    // The pushing cycle pulls right after its push, and tells the other tabs over the
    // BroadcastChannel: no pull for it. Unless this tab is waiting out a failure: the poke then
    // proves the server reachable, like any other.
    const own = this.tag !== null && pokeTag(event) === this.tag;
    if (own && this.retryTimer === undefined) return;
    this.requestSync("signal");
  };

  private openEvents(): void {
    if (this.eventsUrl === undefined || typeof EventSource === "undefined") return;
    const events = new EventSource(this.eventsUrl);
    // A poke only says "something changed", and pokes sent while we were not connected are lost:
    // catch up on every (re)connection too.
    events.addEventListener("open", this.handleStreamOpen);
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

/**
 * The stored state with its outbox as this version reads it: each entry validated, as another
 * version of the app may have written it (see `readStoredMutation`).
 */
function readStoredState(stored: StoredState): StoredState {
  return { ...stored, pending: stored.pending.map(readStoredMutation) };
}

/**
 * The rebase: replays pending mutations on top of a server snapshot, noting those refused. Never
 * throws: whatever stops a mutation here only means it does not apply on this device.
 */
async function replay(
  base: Snapshot,
  pending: readonly Mutation[],
): Promise<{ view: Snapshot; refused: Refusal[] }> {
  const refused: Refusal[] = [];
  // A refused mutation stays in the outbox: the server is authoritative and will settle it, after
  // which the next pull drops it like any processed mutation.
  const view = await applyMutations(base, pending, (mutation, error, against) => {
    refused.push({ mutation, against, error });
  });
  return { view, refused };
}

/** The rejections another tab reported, if `data` is such a message (checked field by field). */
function rejectionsIn(data: unknown): Rejection[] | undefined {
  if (
    typeof data !== "object" ||
    data === null ||
    !("type" in data) ||
    data.type !== "rejected" ||
    !("rejections" in data) ||
    !Array.isArray(data.rejections)
  ) {
    return undefined;
  }
  return data.rejections.filter(isRejection);
}

function isRejection(value: unknown): value is Rejection {
  return (
    typeof value === "object" &&
    value !== null &&
    "mutationId" in value &&
    Number.isInteger(value.mutationId) &&
    "reason" in value &&
    typeof value.reason === "string" &&
    "message" in value &&
    typeof value.message === "string" &&
    "at" in value &&
    typeof value.at === "number"
  );
}

/** The tag of the device whose push caused a poke, if the event carries one (see `Poke`). */
function pokeTag(event: Event): string | undefined {
  if (!(event instanceof MessageEvent) || typeof event.data !== "string") return undefined;
  try {
    const poke: unknown = JSON.parse(event.data);
    return typeof poke === "object" &&
      poke !== null &&
      "clientTag" in poke &&
      typeof poke.clientTag === "string"
      ? poke.clientTag
      : undefined;
  } catch {
    return undefined; // Not ours to judge: any poke is still a reason to pull.
  }
}

function hasRows(changes: PullResponse["changes"]): boolean {
  return changes.properties.length > 0 || changes.levels.length > 0 || changes.spaces.length > 0;
}

function sameStatus(a: SyncStatus, b: SyncStatus): boolean {
  return (
    a.connection === b.connection &&
    a.phase === b.phase &&
    a.sending === b.sending &&
    a.pendingCount === b.pendingCount &&
    a.lastSyncedAt === b.lastSyncedAt &&
    a.lastError === b.lastError &&
    a.nextAttemptAt === b.nextAttemptAt
  );
}

function describeSyncError(error: unknown): string {
  if (error instanceof HttpError) {
    return error.status >= 500
      ? `Le serveur est momentanément indisponible (erreur ${error.status}).`
      : `Le serveur a refusé la synchronisation (erreur ${error.status}).`;
  }
  if (error instanceof ProtocolError) return "Le serveur a envoyé une réponse inattendue.";
  if (error instanceof StorageClosedError) return error.message;
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
