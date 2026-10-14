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

export const pushRequestSchema = z.object({
  clientId: idSchema,
  mutations: z.array(mutationSchema).max(MAX_MUTATIONS_PER_PUSH),
});
export type PushRequest = z.infer<typeof pushRequestSchema>;

export const pushResponseSchema = z.object({
  /** Highest mutation id the server has processed for this device. */
  lastMutationId: z.number().int().nonnegative(),
});
export type PushResponse = z.infer<typeof pushResponseSchema>;

export const pullRequestSchema = z.object({
  clientId: idSchema,
  /** Server version the device is up to date with (0 = nothing yet). */
  cursor: z.number().int().nonnegative(),
});
export type PullRequest = z.infer<typeof pullRequestSchema>;

export const pullResponseSchema = z.object({
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
