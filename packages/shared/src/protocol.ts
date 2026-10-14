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
  type MutatorTx,
  mutationArgsSchemas,
  mutators,
} from "./mutators";
import { idSchema, levelSchema, propertySchema, spaceSchema, timestampSchema } from "./schemas";

export const MAX_MUTATIONS_PER_PUSH = 100;

function envelope<N extends MutationName>(name: N) {
  return z.object({
    /** Per-device sequence number, strictly increasing. */
    id: z.number().int().positive(),
    name: z.literal(name),
    args: mutationArgsSchemas[name],
    /** When the user performed the action, on their device. */
    timestamp: timestampSchema,
  });
}

export const mutationSchema = z.discriminatedUnion("name", [
  envelope("createProperty"),
  envelope("renameProperty"),
  envelope("deleteProperty"),
  envelope("restoreProperty"),
  envelope("createLevel"),
  envelope("renameLevel"),
  envelope("moveLevel"),
  envelope("deleteLevel"),
  envelope("restoreLevel"),
  envelope("createSpace"),
  envelope("renameSpace"),
  envelope("moveSpace"),
  envelope("deleteSpace"),
  envelope("restoreSpace"),
]);
export type Mutation = z.infer<typeof mutationSchema>;

/** Runs a mutation's mutator. Callers own the transaction (and its rollback on error). */
export function applyMutation(tx: MutatorTx, mutation: Mutation): Promise<void> {
  // Sound cast: the discriminated union guarantees `args` matches `name`.
  const run = mutators[mutation.name] as (
    tx: MutatorTx,
    args: unknown,
    ctx: MutationContext,
  ) => Promise<void>;
  return run(tx, mutation.args, { timestamp: mutation.timestamp });
}

/**
 * A mutation as a push carries it: only its envelope is checked when the request arrives. The
 * server then validates each mutation on its own with `mutationSchema`, and treats an invalid one
 * (e.g. written by another version of the app, under rules that have changed since) like any
 * mutation that cannot apply: acknowledged, rejected, nothing written. One bad mutation must not
 * fail the whole push, or the device would retry it forever and never sync again.
 */
export const mutationEnvelopeSchema = z.object({
  id: z.number().int().positive(),
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

export const pushResponseSchema = z.object({
  /** Highest mutation id the server has processed for this device. */
  lastMutationId: z.number().int().nonnegative(),
  /** The server's epoch. When it differs from the request's, nothing was processed. */
  epoch: idSchema,
});
export type PushResponse = z.infer<typeof pushResponseSchema>;

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
