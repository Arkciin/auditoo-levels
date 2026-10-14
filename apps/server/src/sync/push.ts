import {
  applyMutation,
  type Mutation,
  MutationRejectedError,
  type PushRequest,
} from "@repo/shared";
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
 * transiently, the ones before it stay committed, and the device's retry skips them.
 */
export async function processPush(
  db: SqlClient,
  { clientId, mutations }: PushRequest,
): Promise<PushResult> {
  let changed = false;
  let state: SyncState | undefined;
  for (const mutation of mutations.toSorted((a, b) => a.id - b.id)) {
    const outcome = await db.transaction((tx) => processMutation(tx, clientId, mutation));
    changed ||= outcome.changed;
    state = outcome;
  }
  state ??= await readSyncState(db, clientId);
  return { ...state, changed };
}

async function processMutation(
  tx: Queryable,
  clientId: string,
  mutation: Mutation,
): Promise<PushResult> {
  // Lock the server_meta row first. This serializes writers, so versions are assigned in commit
  // order, which is what makes the pull cursor safe. With a plain sequence, a transaction could
  // commit version N after another one committed N + 1: a device pulling in between would move
  // its cursor to N + 1 and never receive the rows of N.
  const { version } = onlyRow(
    await tx.query<{ version: number }>("SELECT version FROM server_meta WHERE id = 1 FOR UPDATE"),
  );

  // A separate statement, run once the lock is held: under READ COMMITTED it sees whatever a
  // concurrent push of the same mutations (a retry) committed while we were waiting.
  const [client] = await tx.query<{ lastMutationId: number }>(
    `SELECT last_mutation_id AS "lastMutationId" FROM clients WHERE id = $1`,
    [clientId],
  );
  const lastMutationId = client?.lastMutationId ?? 0;
  if (mutation.id <= lastMutationId) return { version, lastMutationId, changed: false };

  const changed = await runMutator(tx, clientId, mutation, version + 1);
  if (changed) await tx.query("UPDATE server_meta SET version = version + 1 WHERE id = 1");
  await tx.query(
    `INSERT INTO clients (id, last_mutation_id) VALUES ($1, $2)
     ON CONFLICT (id) DO UPDATE
     SET last_mutation_id = excluded.last_mutation_id, last_seen_at = now()`,
    [clientId, mutation.id],
  );
  return { version: changed ? version + 1 : version, lastMutationId: mutation.id, changed };
}

/**
 * Runs the mutator in a savepoint, stamping its writes with `version`. Returns whether it wrote
 * anything. A mutation that can never apply is rolled back and still counts as processed: a bad
 * mutation must not block a device's queue forever. Any other error is considered transient and
 * propagates (the push fails and the device retries later).
 */
async function runMutator(
  tx: Queryable,
  clientId: string,
  mutation: Mutation,
  version: number,
): Promise<boolean> {
  const serverTx = new ServerTx(tx, version);
  await tx.query("SAVEPOINT mutation");
  try {
    await applyMutation(serverTx, mutation);
    return serverTx.changed;
  } catch (error) {
    if (!isPermanentFailure(error)) throw error;
    await tx.query("ROLLBACK TO SAVEPOINT mutation");
    logger.warn("Mutation rejected", {
      clientId,
      mutationId: mutation.id,
      name: mutation.name,
      reason: error.message,
    });
    return false;
  }
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
