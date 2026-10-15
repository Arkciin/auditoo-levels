/**
 * In-memory reference implementation of the server side of the sync protocol, for tests.
 *
 * Semantics (those the real server must have):
 * - a global version, bumped by every mutation that writes rows; written rows get the new version;
 * - per client, the last processed mutation id: mutations at or below it are skipped, which makes
 *   retried pushes idempotent;
 * - each mutation is validated on its own, then runs in its own transaction; an invalid mutation,
 *   or one whose mutator throws `MutationRejectedError`, writes nothing but still counts as
 *   processed, so a bad mutation never blocks a device's queue;
 * - a push response lists the mutations of the request that were rejected, with a reason code:
 *   those it rejected, and those an earlier push rejected (a retry after a lost response);
 * - a pull returns the rows whose version is above the cursor, the current version as the new
 *   cursor, and the client's last processed id, all from one consistent state; a cursor ahead of
 *   the server (database reset) gets `reset: true` and the full dataset;
 * - every response carries the database's epoch, drawn again by `wipe()`; a push from a device
 *   whose data comes from another epoch processes nothing;
 * - requests are serialized, like serializable transactions.
 */
import {
  applyMutation,
  emptySnapshot,
  type Level,
  type Mutation,
  type MutationEnvelope,
  MutationRejectedError,
  mutationSchema,
  type Property,
  type PullRequest,
  type PullResponse,
  type PushRequest,
  type PushResponse,
  pullRequestSchema,
  pullResponseSchema,
  pushRequestSchema,
  pushResponseSchema,
  type ReceivedPushRequest,
  type RejectionReason,
  type Snapshot,
  SnapshotTx,
  type Space,
} from "@repo/shared";
import { HttpError, NetworkError, type Transport } from "../transport";

type Table = keyof Snapshot;

/** A transaction that records which rows the mutation wrote, to stamp them with a version. */
class RecordingTx extends SnapshotTx {
  readonly written: Record<Table, Set<string>> = {
    properties: new Set(),
    levels: new Set(),
    spaces: new Set(),
  };

  override putProperty(property: Property) {
    this.written.properties.add(property.id);
    return super.putProperty(property);
  }

  override putLevel(level: Level) {
    this.written.levels.add(level.id);
    return super.putLevel(level);
  }

  override putSpace(space: Space) {
    this.written.spaces.add(space.id);
    return super.putSpace(space);
  }
}

export class MemoryServer {
  /** Mutations processed but rejected (invalid, or refused by their mutator), in order. */
  readonly rejected: MutationEnvelope[] = [];
  /** Why mutators refused mutations: their `MutationRejectedError` messages, in order. */
  readonly refusals: string[] = [];
  /**
   * Mutations skipped as already processed although this database never processed them: lost
   * for good. Must stay empty; a device pushing out of order, or to the wrong epoch, fills it.
   */
  readonly lostMutations: MutationEnvelope[] = [];
  /**
   * Test seam for server-only rules (permissions, quotas…): mutations it matches are rejected
   * even though they apply on the device, as `not_applicable` unless it names another reason.
   */
  rejectWhen: ((mutation: Mutation) => boolean | RejectionReason) | undefined;

  private data: Snapshot = emptySnapshot;
  private version = 0;
  private rowVersions: Record<Table, Map<string, number>> = emptyVersions();
  private lastMutationIds = new Map<string, number>();
  private processedIds = new Map<string, Set<number>>();
  /** Per client, the reason of each rejected mutation (the server's `rejected_mutations`). */
  private rejections = new Map<string, Map<number, RejectionReason>>();
  private currentEpoch: string = crypto.randomUUID();
  private queue: Promise<unknown> = Promise.resolve();

  push(request: ReceivedPushRequest): Promise<PushResponse> {
    return this.exclusive(async () => {
      let lastMutationId = this.lastMutationIds.get(request.clientId) ?? 0;
      if (request.epoch !== undefined && request.epoch !== this.currentEpoch) {
        return { lastMutationId, epoch: this.currentEpoch, rejected: [] };
      }
      const processed = this.processedIds.get(request.clientId) ?? new Set<number>();
      this.processedIds.set(request.clientId, processed);
      const rejections =
        this.rejections.get(request.clientId) ?? new Map<number, RejectionReason>();
      this.rejections.set(request.clientId, rejections);
      const rejected: PushResponse["rejected"] = [];
      // In id order, each id once, like the server. (Not `toSorted`: the app's sources, these
      // included, compile against ES2022, its build target.)
      const envelopes = [...request.mutations]
        .sort((a, b) => a.id - b.id)
        .filter((envelope, index, sorted) => envelope.id !== sorted[index - 1]?.id);
      for (const envelope of envelopes) {
        if (envelope.id <= lastMutationId) {
          if (!processed.has(envelope.id)) this.lostMutations.push(envelope);
          // Already processed: reported again, the response that said so may have been lost.
          const reason = rejections.get(envelope.id);
          if (reason !== undefined) rejected.push({ id: envelope.id, reason });
          continue;
        }
        const reason = await this.apply(envelope);
        if (reason !== undefined) {
          this.rejected.push(envelope);
          rejections.set(envelope.id, reason);
          rejected.push({ id: envelope.id, reason });
        }
        processed.add(envelope.id);
        lastMutationId = envelope.id;
        this.lastMutationIds.set(request.clientId, lastMutationId);
      }
      return { lastMutationId, epoch: this.currentEpoch, rejected };
    });
  }

  pull(request: PullRequest): Promise<PullResponse> {
    return this.exclusive(async () => {
      const reset = request.cursor > this.version;
      const since = reset ? 0 : request.cursor;
      return {
        epoch: this.currentEpoch,
        cursor: this.version,
        lastMutationId: this.lastMutationIds.get(request.clientId) ?? 0,
        reset,
        changes: {
          properties: this.changedSince("properties", this.data.properties, since),
          levels: this.changedSince("levels", this.data.levels, since),
          spaces: this.changedSince("spaces", this.data.spaces, since),
        },
      };
    });
  }

  /** The authoritative dataset. */
  snapshot(): Snapshot {
    return this.data;
  }

  /** Identity of the current database, drawn again by `wipe()`. */
  get epoch(): string {
    return this.currentEpoch;
  }

  /** The current version (the cursor a full pull returns). */
  get currentVersion(): number {
    return this.version;
  }

  /** Ids of the client's mutations this database processed (applied or rejected). */
  processedIdsOf(clientId: string): ReadonlySet<number> {
    return this.processedIds.get(clientId) ?? new Set();
  }

  lastMutationIdOf(clientId: string): number {
    return this.lastMutationIds.get(clientId) ?? 0;
  }

  /** The client's mutations this database rejected, with their reason, by id. */
  rejectionsOf(clientId: string): ReadonlyMap<number, RejectionReason> {
    return this.rejections.get(clientId) ?? new Map();
  }

  /** Simulates a database recreated from scratch: new epoch, data, version and clients gone. */
  wipe(): void {
    this.currentEpoch = crypto.randomUUID();
    this.processedIds = new Map();
    this.rejections = new Map();
    this.data = emptySnapshot;
    this.version = 0;
    this.rowVersions = emptyVersions();
    this.lastMutationIds = new Map();
  }

  /**
   * Validates and runs one mutation in its own transaction. Returns why it was rejected, if it
   * was (the database refusing it can only come from `rejectWhen` here).
   */
  private async apply(envelope: MutationEnvelope): Promise<RejectionReason | undefined> {
    const parsed = mutationSchema.safeParse(envelope);
    if (!parsed.success) return "invalid";
    const mutation: Mutation = parsed.data;
    const rule = this.rejectWhen?.(mutation) ?? false;
    if (rule !== false) return rule === true ? "not_applicable" : rule;
    const tx = new RecordingTx(this.data);
    try {
      await applyMutation(tx, mutation);
    } catch (error) {
      if (!(error instanceof MutationRejectedError)) throw error;
      this.refusals.push(error.message);
      return "not_applicable";
    }
    this.commit(tx);
    return undefined;
  }

  private commit(tx: RecordingTx): void {
    const { written } = tx;
    if (written.properties.size + written.levels.size + written.spaces.size === 0) return;
    this.version += 1;
    this.data = tx.commit();
    for (const table of ["properties", "levels", "spaces"] as const) {
      for (const id of written[table]) this.rowVersions[table].set(id, this.version);
    }
  }

  private changedSince<T extends { id: string }>(
    table: Table,
    rows: ReadonlyMap<string, T>,
    cursor: number,
  ): T[] {
    const versions = this.rowVersions[table];
    return [...rows.values()].filter((row) => (versions.get(row.id) ?? 0) > cursor);
  }

  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(task);
    this.queue = result.catch(() => undefined);
    return result;
  }
}

function emptyVersions(): Record<Table, Map<string, number>> {
  return { properties: new Map(), levels: new Map(), spaces: new Map() };
}

/**
 * - `online`: requests and responses go through;
 * - `offline`: requests fail before reaching the server;
 * - `lossy`: the server processes requests but responses are lost (the case idempotency is for);
 * - `lossy-pull`: pushes go through, pull responses are lost: the device's mutations are
 *   acknowledged but stay in its outbox, unconfirmed.
 */
export type NetworkMode = "online" | "offline" | "lossy" | "lossy-pull";

/**
 * Transport to a {@link MemoryServer} through a simulated network. Payloads cross it as JSON and
 * are validated on both ends, like over HTTP (an invalid request is a 400).
 */
export class MemoryTransport implements Transport {
  mode: NetworkMode = "online";
  /** Requests attempted, whatever the network did with them. */
  attempts = 0;
  /** Mutation batches that reached the server, in order. */
  readonly pushes: Mutation[][] = [];

  constructor(private readonly server: MemoryServer) {}

  async push(request: PushRequest): Promise<PushResponse> {
    const received = this.send(request, (data) => pushRequestSchema.parse(data));
    this.pushes.push(request.mutations);
    const response = await this.server.push(received);
    return this.receive(this.mode === "lossy", response, (data) => pushResponseSchema.parse(data));
  }

  async pull(request: PullRequest): Promise<PullResponse> {
    const received = this.send(request, (data) => pullRequestSchema.parse(data));
    const response = await this.server.pull(received);
    const lost = this.mode === "lossy" || this.mode === "lossy-pull";
    return this.receive(lost, response, (data) => pullResponseSchema.parse(data));
  }

  private send<T>(request: unknown, parse: (data: unknown) => T): T {
    this.attempts += 1;
    if (this.mode === "offline") throw new NetworkError("Simulated network: offline");
    try {
      return parse(overTheWire(request));
    } catch (error) {
      throw new HttpError(400, `Invalid request: ${String(error)}`);
    }
  }

  private receive<T>(lost: boolean, response: unknown, parse: (data: unknown) => T): T {
    if (lost) throw new NetworkError("Simulated network: response lost");
    return parse(overTheWire(response));
  }
}

/** JSON round trip: no object is ever shared between a device and the server. */
function overTheWire(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}
