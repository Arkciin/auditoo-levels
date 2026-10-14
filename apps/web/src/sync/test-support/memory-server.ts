/**
 * In-memory reference implementation of the server side of the sync protocol, for tests.
 *
 * Semantics (those the real server must have):
 * - a global version, bumped by every mutation that writes rows; written rows get the new version;
 * - per client, the last processed mutation id: mutations at or below it are skipped, which makes
 *   retried pushes idempotent;
 * - each mutation runs in its own transaction; a `MutationRejectedError` discards its writes but
 *   still counts as processed, so a bad mutation never blocks a device's queue;
 * - a pull returns the rows whose version is above the cursor, the current version as the new
 *   cursor, and the client's last processed id, all from one consistent state; a cursor ahead of
 *   the server (database reset) gets `reset: true` and the full dataset;
 * - requests are serialized, like serializable transactions.
 */
import {
  applyMutation,
  emptySnapshot,
  type Level,
  type Mutation,
  MutationRejectedError,
  type Property,
  type PullRequest,
  type PullResponse,
  type PushRequest,
  type PushResponse,
  pullRequestSchema,
  pullResponseSchema,
  pushRequestSchema,
  pushResponseSchema,
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
  /** Mutations processed but rejected, in processing order. */
  readonly rejected: Mutation[] = [];
  /**
   * Test seam for server-only rules (permissions, quotas…): mutations it matches are rejected
   * even though they apply on the device.
   */
  rejectWhen: ((mutation: Mutation) => boolean) | undefined;

  private data: Snapshot = emptySnapshot;
  private version = 0;
  private rowVersions: Record<Table, Map<string, number>> = emptyVersions();
  private lastMutationIds = new Map<string, number>();
  private queue: Promise<unknown> = Promise.resolve();

  push(request: PushRequest): Promise<PushResponse> {
    return this.exclusive(async () => {
      let lastMutationId = this.lastMutationIds.get(request.clientId) ?? 0;
      for (const mutation of request.mutations) {
        if (mutation.id <= lastMutationId) continue;
        const tx = new RecordingTx(this.data);
        try {
          if (this.rejectWhen?.(mutation)) throw new MutationRejectedError("Server-side rule");
          await applyMutation(tx, mutation);
          this.commit(tx);
        } catch (error) {
          if (!(error instanceof MutationRejectedError)) throw error;
          this.rejected.push(mutation);
        }
        lastMutationId = mutation.id;
        this.lastMutationIds.set(request.clientId, lastMutationId);
      }
      return { lastMutationId };
    });
  }

  pull(request: PullRequest): Promise<PullResponse> {
    return this.exclusive(async () => {
      const reset = request.cursor > this.version;
      const since = reset ? 0 : request.cursor;
      return {
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

  lastMutationIdOf(clientId: string): number {
    return this.lastMutationIds.get(clientId) ?? 0;
  }

  /** Simulates a database recreated from scratch: data, version and client ids are gone. */
  wipe(): void {
    this.data = emptySnapshot;
    this.version = 0;
    this.rowVersions = emptyVersions();
    this.lastMutationIds = new Map();
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
 * - `lossy`: the server processes requests but responses are lost (the case idempotency is for).
 */
export type NetworkMode = "online" | "offline" | "lossy";

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
    this.pushes.push(received.mutations);
    return this.receive(await this.server.push(received), (data) => pushResponseSchema.parse(data));
  }

  async pull(request: PullRequest): Promise<PullResponse> {
    const received = this.send(request, (data) => pullRequestSchema.parse(data));
    return this.receive(await this.server.pull(received), (data) => pullResponseSchema.parse(data));
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

  private receive<T>(response: unknown, parse: (data: unknown) => T): T {
    if (this.mode === "lossy") throw new NetworkError("Simulated network: response lost");
    return parse(overTheWire(response));
  }
}

/** JSON round trip: no object is ever shared between a device and the server. */
function overTheWire(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}
