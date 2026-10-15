/**
 * Immutable in-memory dataset + a copy-on-write transaction to run mutators against it.
 *
 * The device's UI state is `applyMutations(serverSnapshot, pendingMutations)`: the last state
 * confirmed by the server with the not-yet-confirmed local mutations replayed on top ("rebase").
 */
import { MutationRejectedError, type MutatorTx } from "./mutators";
import { applyMutation, type Mutation, type PullResponse } from "./protocol";
import type { Level, Property, Space } from "./schemas";

export interface Snapshot {
  readonly properties: ReadonlyMap<string, Property>;
  readonly levels: ReadonlyMap<string, Level>;
  readonly spaces: ReadonlyMap<string, Space>;
}

export const emptySnapshot: Snapshot = Object.freeze({
  properties: new Map(),
  levels: new Map(),
  spaces: new Map(),
});

export class SnapshotTx implements MutatorTx {
  private properties: Map<string, Property> | undefined;
  private levels: Map<string, Level> | undefined;
  private spaces: Map<string, Space> | undefined;

  constructor(private readonly base: Snapshot) {}

  getProperty(id: string) {
    return Promise.resolve((this.properties ?? this.base.properties).get(id));
  }

  getLevel(id: string) {
    return Promise.resolve((this.levels ?? this.base.levels).get(id));
  }

  getSpace(id: string) {
    return Promise.resolve((this.spaces ?? this.base.spaces).get(id));
  }

  getSpaces(ids: readonly string[]) {
    const spaces = this.spaces ?? this.base.spaces;
    return Promise.resolve(ids.flatMap((id) => spaces.get(id) ?? []));
  }

  putProperty(property: Property) {
    this.properties ??= new Map(this.base.properties);
    this.properties.set(property.id, property);
    return Promise.resolve();
  }

  putLevel(level: Level) {
    this.levels ??= new Map(this.base.levels);
    this.levels.set(level.id, level);
    return Promise.resolve();
  }

  putSpace(space: Space) {
    this.spaces ??= new Map(this.base.spaces);
    this.spaces.set(space.id, space);
    return Promise.resolve();
  }

  /** The resulting snapshot. Untouched collections keep their identity (cheap re-renders). */
  commit(): Snapshot {
    if (!this.properties && !this.levels && !this.spaces) return this.base;
    return {
      properties: this.properties ?? this.base.properties,
      levels: this.levels ?? this.base.levels,
      spaces: this.spaces ?? this.base.spaces,
    };
  }
}

/**
 * Replays mutations in order. Each one runs in its own transaction, so a rejected mutation
 * leaves no partial writes behind (mirrors the server, which uses one savepoint per mutation).
 * `onRejected` also receives the state the mutation was refused on.
 */
export async function applyMutations(
  base: Snapshot,
  mutations: readonly Mutation[],
  onRejected?: (mutation: Mutation, error: MutationRejectedError, before: Snapshot) => void,
): Promise<Snapshot> {
  let snapshot = base;
  for (const mutation of mutations) {
    const tx = new SnapshotTx(snapshot);
    try {
      await applyMutation(tx, mutation);
      snapshot = tx.commit();
    } catch (error) {
      if (!(error instanceof MutationRejectedError)) throw error;
      onRejected?.(mutation, error, snapshot);
    }
  }
  return snapshot;
}

/** Merges a pull response into a server snapshot. */
export function applyPull(base: Snapshot, pull: Pick<PullResponse, "reset" | "changes">): Snapshot {
  const start = pull.reset ? emptySnapshot : base;
  const { properties, levels, spaces } = pull.changes;
  return {
    properties: mergeRows(start.properties, properties),
    levels: mergeRows(start.levels, levels),
    spaces: mergeRows(start.spaces, spaces),
  };
}

function mergeRows<T extends { id: string }>(
  current: ReadonlyMap<string, T>,
  rows: readonly T[],
): ReadonlyMap<string, T> {
  if (rows.length === 0) return current;
  const next = new Map(current);
  for (const row of rows) next.set(row.id, row);
  return next;
}
