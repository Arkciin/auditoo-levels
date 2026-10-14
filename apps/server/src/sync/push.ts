import {
  applyMutation,
  type Mutation,
  type MutationEnvelope,
  MutationRejectedError,
  mutationSchema,
  type ReceivedPushRequest,
} from "@repo/shared";
import type { z } from "zod";
import { onlyRow, type Queryable, type SqlClient } from "../db/sql";
import { logger } from "../logger";
import { readSyncState, type SyncState } from "./queries";
import { ServerTx } from "./server-tx";

export interface PushResult extends SyncState {
  /** Whether any row changed, i.e. whether connected devices should be poked. */
  changed: boolean;
}

/**
 * Applies a device's mutations in order, one transaction per mutation: when one fails
 * transiently, the ones before it stay committed, and the device's retry skips them. A device
 * whose data comes from another epoch of the database gets nothing processed (see below).
 */
export async function processPush(
  db: SqlClient,
  { clientId, epoch, mutations }: ReceivedPushRequest,
): Promise<PushResult> {
  let changed = false;
  let state: SyncState | undefined;
  for (const mutation of mutations.toSorted((a, b) => a.id - b.id)) {
    const outcome = await db.transaction((tx) => processMutation(tx, clientId, epoch, mutation));
    if (!outcome) break;
    changed ||= outcome.changed;
    state = outcome;
  }
  state ??= await readSyncState(db, clientId);
  return { ...state, changed };
}

/** Returns undefined, having done nothing, when the device must start over first. */
async function processMutation(
  tx: Queryable,
  clientId: string,
  deviceEpoch: string | undefined,
  mutation: MutationEnvelope,
): Promise<PushResult | undefined> {
  // Lock the server_meta row first. This serializes writers, so versions are assigned in commit
  // order, which is what makes the pull cursor safe. With a plain sequence, a transaction could
  // commit version N after another one committed N + 1: a device pulling in between would move
  // its cursor to N + 1 and never receive the rows of N.
  const { version, epoch } = onlyRow(
    await tx.query<{ version: number; epoch: string }>(
      "SELECT version, epoch FROM server_meta WHERE id = 1 FOR UPDATE",
    ),
  );
  // The device's data comes from a database this one replaced. Its outbox may still hold
  // mutations that database acknowledged: processing a later one first would make this database
  // count them as processed and skip them forever. It must start over (a full pull) first.
  if (deviceEpoch !== undefined && deviceEpoch !== epoch) return undefined;

  // A separate statement, run once the lock is held: under READ COMMITTED it sees whatever a
  // concurrent push of the same mutations (a retry) committed while we were waiting.
  const [client] = await tx.query<{ lastMutationId: number }>(
    `SELECT last_mutation_id AS "lastMutationId" FROM clients WHERE id = $1`,
    [clientId],
  );
  const lastMutationId = client?.lastMutationId ?? 0;
  if (mutation.id <= lastMutationId) return { version, epoch, lastMutationId, changed: false };

  const changed = await runMutation(tx, clientId, mutation, version + 1);
  if (changed) await tx.query("UPDATE server_meta SET version = version + 1 WHERE id = 1");
  await tx.query(
    `INSERT INTO clients (id, last_mutation_id) VALUES ($1, $2)
     ON CONFLICT (id) DO UPDATE
     SET last_mutation_id = excluded.last_mutation_id, last_seen_at = now()`,
    [clientId, mutation.id],
  );
  return { version: changed ? version + 1 : version, epoch, lastMutationId: mutation.id, changed };
}

/**
 * Validates the mutation, then runs its mutator in a savepoint, stamping its writes with
 * `version`. Returns whether it wrote anything.
 *
 * A mutation that can never apply (invalid, or refused by its mutator or by the database) is
 * rejected: nothing is written, yet it counts as processed, because a bad mutation must not block
 * a device's queue forever. Any other error is considered transient and propagates (the push
 * fails and the device retries later).
 */
async function runMutation(
  tx: Queryable,
  clientId: string,
  envelope: MutationEnvelope,
  version: number,
): Promise<boolean> {
  const parsed = mutationSchema.safeParse(envelope);
  if (!parsed.success) {
    logRejection(clientId, envelope, `invalid mutation: ${summarizeIssues(parsed.error)}`);
    return false;
  }
  const mutation: Mutation = parsed.data;
  const serverTx = new ServerTx(tx, version);
  await tx.query("SAVEPOINT mutation");
  try {
    await applyMutation(serverTx, mutation);
    return serverTx.changed;
  } catch (error) {
    if (!isPermanentFailure(error)) throw error;
    await tx.query("ROLLBACK TO SAVEPOINT mutation");
    logRejection(clientId, envelope, error.message);
    return false;
  }
}

function logRejection(clientId: string, envelope: MutationEnvelope, reason: string): void {
  logger.warn("Mutation rejected", {
    clientId,
    mutationId: envelope.id,
    name: envelope.name,
    reason,
  });
}

/** Where and why, never the values themselves (they are user data). */
function summarizeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
}

/**
 * A mutator rejection, or a database error of SQLSTATE class 22 (data exception) or 23 (integrity
 * constraint violation): replaying the same mutation would fail the same way.
 */
function isPermanentFailure(error: unknown): error is Error {
  if (error instanceof MutationRejectedError) return true;
  const code = error instanceof Error && "code" in error ? error.code : undefined;
  return typeof code === "string" && /^2[23][0-9A-Z]{3}$/.test(code);
}
