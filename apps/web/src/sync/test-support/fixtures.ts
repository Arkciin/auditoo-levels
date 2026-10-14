/** Pure helpers for the sync engine tests (no IndexedDB involved). */
import {
  comparePositions,
  type Level,
  type MutationArgs,
  type MutationName,
  type Property,
  type Snapshot,
  type Space,
} from "@repo/shared";

/** Fixed, readable UUIDs: `uuid(1)` → `00000000-0000-7000-8000-000000000001`. */
export function uuid(n: number): string {
  return `00000000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
}

/** Deterministic PRNG (mulberry32), so that a failing seed can be replayed. */
export function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A version-7-shaped UUID drawn from `random` (deterministic, unlike `newId`). */
export function randomUuid(random: () => number): string {
  const hex = (length: number) =>
    Array.from({ length }, () => Math.floor(random() * 16).toString(16)).join("");
  const variant = "89ab"[Math.floor(random() * 4)] ?? "8";
  return `${hex(8)}-${hex(4)}-7${hex(3)}-${variant}${hex(3)}-${hex(12)}`;
}

/** A user action: a mutation name with its arguments, correlated. */
export type Action = { [N in MutationName]: { name: N; args: MutationArgs<N> } }[MutationName];

/** Builds a snapshot from rows. */
export function snapshotOf(rows: {
  properties?: readonly Property[];
  levels?: readonly Level[];
  spaces?: readonly Space[];
}): Snapshot {
  return {
    properties: new Map((rows.properties ?? []).map((row) => [row.id, row])),
    levels: new Map((rows.levels ?? []).map((row) => [row.id, row])),
    spaces: new Map((rows.spaces ?? []).map((row) => [row.id, row])),
  };
}

/** Rows of a snapshot as plain arrays sorted by id, for deep equality and readable diffs. */
export function rowsOf(snapshot: Snapshot): {
  properties: Property[];
  levels: Level[];
  spaces: Space[];
} {
  const byId = (a: { id: string }, b: { id: string }) => comparePositions(a.id, b.id);
  return {
    properties: [...snapshot.properties.values()].sort(byId),
    levels: [...snapshot.levels.values()].sort(byId),
    spaces: [...snapshot.spaces.values()].sort(byId),
  };
}

/** A promise with its resolve function, to hold a request at a precise point. */
export function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
