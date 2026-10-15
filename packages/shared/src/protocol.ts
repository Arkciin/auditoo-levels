/**
 * Wire protocol between devices and the server (inspired by Replicache's push/pull).
 *
 * - **Push**: a device sends its queued mutations, in order. Each mutation carries a per-device
 *   sequence number (`id`); the server remembers the last one it processed per device
 *   (`lastMutationId`), which makes retries idempotent.
 * - **Pull**: a device asks for every row that changed since its `cursor` (a global, monotonic
 *   server version). The answer also says which of the device's mutations are already included
 *   (`lastMutationId`), all read from one consistent database snapshot. The device then drops
 *   those from its queue and replays the remaining ones on top of the fresh server state.
 * - **Epoch**: every response carries the epoch of the server's database, a random id drawn when
 *   that database is created. A device records the epoch its data comes from and sends it with
 *   its pushes. Another epoch means the database was replaced (recreated, or restored from a
 *   backup): the device's cursor and acknowledged mutations mean nothing there, so the server
 *   processes none of its mutations until the device has started over from a full pull.
 */
import { z } from "zod";
import {
  type MutationContext,
  type MutationName,
  MutationRejectedError,
  type MutatorTx,
  mutationArgsSchemas,
  mutationNames,
  mutators,
} from "./mutators";
import { idSchema, levelSchema, propertySchema, spaceSchema, timestampSchema } from "./schemas";

export const MAX_MUTATIONS_PER_PUSH = 100;

/** Per-device sequence number of a mutation, strictly increasing (gaps allowed). */
const mutationIdSchema = z.number().int().positive();

function envelope<N extends MutationName>(name: N) {
  return z.object({
    id: mutationIdSchema,
    name: z.literal(name),
    args: mutationArgsSchemas[name],
    /** When the user performed the action, on their device. */
    timestamp: timestampSchema,
  });
}

type AnyEnvelope = { [N in MutationName]: ReturnType<typeof envelope<N>> }[MutationName];

// One envelope per mutation of `mutationArgsSchemas`, so that a new mutation can never be missing
// here (the server would reject it as invalid). Typing boundary: `map` cannot express that it
// returns one envelope per name, and at least one; `Mutation` stays a union discriminated by name.
const envelopes = mutationNames.map((name) => envelope(name)) as [AnyEnvelope, ...AnyEnvelope[]];

export const mutationSchema = z.discriminatedUnion("name", envelopes);
export type Mutation = z.infer<typeof mutationSchema>;

/**
 * Runs a mutation's mutator. Callers own the transaction (and its rollback on error).
 *
 * A mutation of a kind this version does not know is refused like any mutation that cannot apply
 * (`MutationRejectedError`). The types rule it out, but a device's outbox may hold what another
 * version of the app wrote: a newer one, then rolled back, or a newer tab next to an older one.
 */
export function applyMutation(tx: MutatorTx, mutation: Mutation): Promise<void> {
  if (!Object.hasOwn(mutators, mutation.name)) {
    return Promise.reject(new MutationRejectedError(`Unknown mutation ${mutation.name}`));
  }
  // Sound cast: the discriminated union guarantees `args` matches `name`.
  const run = mutators[mutation.name] as (
    tx: MutatorTx,
    args: unknown,
    ctx: MutationContext,
  ) => Promise<void>;
  return run(tx, mutation.args, { timestamp: mutation.timestamp });
}

/** Verdicts of {@link isReadable}, per mutation object. */
const readable = new WeakMap<Mutation, boolean>();

/**
 * Whether this version can run, and read field by field, a mutation of a device's outbox: it
 * follows today's `mutationSchema`. The outbox may hold entries another version of the app wrote,
 * under other rules: an older one, or a newer one (then rolled back, or in another tab). Those
 * stay queued for the server to judge, but the device neither replays nor describes them. Cached
 * per object: a device replays its queue at every pull.
 */
export function isReadable(mutation: Mutation): boolean {
  let verdict = readable.get(mutation);
  if (verdict === undefined) {
    verdict = mutationSchema.safeParse(mutation).success;
    readable.set(mutation, verdict);
  }
  return verdict;
}

/**
 * An outbox entry as this version reads it: parsed, hence normalized the way the server will apply
 * it, or, when it breaks today's rules, as it is, which {@link isReadable} then says.
 */
export function readStoredMutation(entry: Mutation): Mutation {
  const parsed = mutationSchema.safeParse(entry);
  if (!parsed.success) {
    readable.set(entry, false);
    return entry;
  }
  readable.set(parsed.data, true);
  return parsed.data;
}

/**
 * A mutation as a push carries it: only its envelope is checked when the request arrives. The
 * server then validates each mutation on its own with `mutationSchema`, and treats an invalid one
 * (e.g. written by another version of the app, under rules that have changed since) like any
 * mutation that cannot apply: acknowledged, rejected, nothing written. One bad mutation must not
 * fail the whole push, or the device would retry it forever and never sync again.
 */
export const mutationEnvelopeSchema = z.object({
  id: mutationIdSchema,
  name: z.string(),
  args: z.unknown(),
  timestamp: timestampSchema,
});
export type MutationEnvelope = z.infer<typeof mutationEnvelopeSchema>;

/** A push as the server accepts it (see `mutationEnvelopeSchema`). */
export const pushRequestSchema = z.object({
  clientId: idSchema,
  /**
   * Epoch the device's data comes from (its last pull), absent before its first pull. A server
   * with another epoch processes nothing: the device's outbox may still hold mutations a previous
   * database acknowledged, and processing a later one first would make the new database count
   * them as processed, and skip them forever.
   */
  epoch: idSchema.optional(),
  mutations: z.array(mutationEnvelopeSchema).max(MAX_MUTATIONS_PER_PUSH),
});
/** A push as the server receives it: its mutations still have to be validated one by one. */
export type ReceivedPushRequest = z.infer<typeof pushRequestSchema>;

/** A push as a device sends it: devices only ever produce valid mutations. */
export interface PushRequest extends ReceivedPushRequest {
  mutations: Mutation[];
}

/**
 * Why the server rejected a mutation (it still counts as processed: one bad mutation must not block
 * a device's queue). A code, never user data: devices put it into words themselves.
 * - `invalid`: its content breaks the rules of `mutationSchema` (e.g. it was written by another
 *   version of the app, under rules that have changed since);
 * - `not_applicable`: its mutator refused it (`MutationRejectedError`), e.g. its entity is unknown;
 * - `refused_by_database`: the database refused it (SQLSTATE class 22 or 23).
 */
export type RejectionReason = "invalid" | "not_applicable" | "refused_by_database";

export const pushResponseSchema = z.object({
  /** Highest mutation id the server has processed for this device. */
  lastMutationId: z.number().int().nonnegative(),
  /** The server's epoch. When it differs from the request's, nothing was processed. */
  epoch: idSchema,
  /**
   * The mutations of this push the server rejected: now, or when an earlier attempt processed them
   * (that attempt's response may have been lost). Servers older than this field leave it out.
   */
  rejected: z
    .array(
      z.object({
        id: mutationIdSchema,
        /**
         * A {@link RejectionReason}, read as any string: a device must keep syncing when a newer
         * server adds a code it does not know yet (a failed parse would block its queue).
         */
        reason: z.string(),
      }),
    )
    .default(() => []),
});
export type PushResponse = z.infer<typeof pushResponseSchema>;

/**
 * The `poke` event the server sends to every connected device after a push that changed data.
 * Devices only use it as a signal to pull, and ignore what they do not know: fields can be added.
 */
export interface Poke {
  /** The server version after the push. */
  readonly version: number;
  /** {@link clientTag} of the device that pushed (absent from servers older than the field). */
  readonly clientTag?: string;
}

/** WebCrypto's digest, which browsers (in secure contexts) and Node both provide. */
interface Digest {
  digest(algorithm: "SHA-256", data: Uint8Array): Promise<ArrayBuffer>;
}

/**
 * Names the device behind a poke without disclosing its client id: the first 16 bytes of the
 * id's SHA-256, in hex. A device skips the pokes of its own pushes (it pulls right after pushing
 * anyway). Not the id itself: anyone can listen to the event stream, and a client id is all it
 * takes to push as that device; a forged push with a high mutation id would make the server skip
 * that device's later changes, silently and for good. Rejects where WebCrypto is unavailable
 * (a page served over plain HTTP from another host than localhost).
 */
export async function clientTag(clientId: string): Promise<string> {
  // Typing boundary: this package builds without DOM or Node typings, both runtimes have it.
  const subtle = (globalThis as { crypto?: { subtle?: Digest } }).crypto?.subtle;
  if (!subtle) throw new Error("WebCrypto is unavailable");
  // Client ids are UUIDs: ASCII.
  const bytes = Uint8Array.from(clientId, (character) => character.charCodeAt(0));
  const digest = new Uint8Array(await subtle.digest("SHA-256", bytes));
  return Array.from(digest.subarray(0, 16), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export const pullRequestSchema = z.object({
  clientId: idSchema,
  /** Server version the device is up to date with (0 = nothing yet). */
  cursor: z.number().int().nonnegative(),
});
export type PullRequest = z.infer<typeof pullRequestSchema>;

export const pullResponseSchema = z.object({
  /** The server's epoch: when it differs from the device's, the device must start over. */
  epoch: idSchema,
  cursor: z.number().int().nonnegative(),
  lastMutationId: z.number().int().nonnegative(),
  /**
   * True when the device's cursor is ahead of the server (e.g. the database was reset). The
   * response then contains the full dataset and the device must replace its snapshot.
   */
  reset: z.boolean(),
  /** Rows changed since `cursor`, soft-deleted ones included. */
  changes: z.object({
    properties: z.array(propertySchema),
    levels: z.array(levelSchema),
    spaces: z.array(spaceSchema),
  }),
});
export type PullResponse = z.infer<typeof pullResponseSchema>;
