import {
  applyMutation,
  type MutationEnvelope,
  MutationRejectedError,
  mutationSchema,
  type PushResponse,
  type ReceivedPushRequest,
  type RejectionReason,
} from "@repo/shared";
import type { z } from "zod";
import { onlyRow, type Queryable, type SqlClient } from "../db/sql";
import { logger } from "../logger";
import { readSyncState, type SyncState } from "./queries";
import { ServerTx } from "./server-tx";

/**
 * A mutation the server rejected for good, as push responses report it. Its reason is a
 * `RejectionReason`, or any code a record written by another version of the server holds.
 */
export type RejectedMutation = PushResponse["rejected"][number];

export interface PushResult extends SyncState {
  /** Whether any row changed, i.e. whether connected devices should be poked. */
  changed: boolean;
  /** The mutations of the request rejected, by this push or an earlier one, in id order. */
  rejected: RejectedMutation[];
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
  const rejected: RejectedMutation[] = [];
  const alreadyProcessed: number[] = [];
  for (const mutation of mutations.toSorted((a, b) => a.id - b.id)) {
    const outcome = await db.transaction((tx) => processMutation(tx, clientId, epoch, mutation));
    if (!outcome) break;
    if (outcome.alreadyProcessed) alreadyProcessed.push(mutation.id);
    if (outcome.rejected) rejected.push({ id: mutation.id, reason: outcome.rejected });
    changed ||= outcome.changed;
    state = outcome.state;
  }
  state ??= await readSyncState(db, clientId);
  // A retry, typically after a lost response: the device may never have heard of the rejections
  // among the mutations it sends again. Read after their transactions committed, so all are seen.
  if (alreadyProcessed.length > 0) {
    rejected.push(...(await readRejections(db, clientId, alreadyProcessed)));
    rejected.sort((a, b) => a.id - b.id);
  }
  return { ...state, changed, rejected };
}

interface MutationOutcome {
  /** The sync state once the mutation is processed. */
  state: SyncState;
  changed: boolean;
  /** Processed by an earlier push: skipped, nothing done. */
  alreadyProcessed: boolean;
  /** Why this push rejected it, if it did. */
  rejected: RejectionReason | undefined;
}

/** Returns undefined, having done nothing, when the device must start over first. */
async function processMutation(
  tx: Queryable,
  clientId: string,
  deviceEpoch: string | undefined,
  mutation: MutationEnvelope,
): Promise<MutationOutcome | undefined> {
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
  if (mutation.id <= lastMutationId) {
    const state = { version, epoch, lastMutationId };
    return { state, changed: false, alreadyProcessed: true, rejected: undefined };
  }

  const { changed, rejected } = await runMutation(tx, clientId, mutation, version + 1);
  if (changed) await tx.query("UPDATE server_meta SET version = version + 1 WHERE id = 1");
  await tx.query(
    `INSERT INTO clients (id, last_mutation_id) VALUES ($1, $2)
     ON CONFLICT (id) DO UPDATE
     SET last_mutation_id = excluded.last_mutation_id, last_seen_at = now()`,
    [clientId, mutation.id],
  );
  // In the acknowledgement's transaction: a retry finds both, or neither and processes it anew.
  if (rejected) {
    await tx.query(
      `INSERT INTO rejected_mutations (client_id, mutation_id, reason) VALUES ($1, $2, $3)
       ON CONFLICT (client_id, mutation_id) DO UPDATE
       SET reason = excluded.reason, rejected_at = now()`,
      [clientId, mutation.id, rejected],
    );
  }
  const state = { version: changed ? version + 1 : version, epoch, lastMutationId: mutation.id };
  return { state, changed, alreadyProcessed: false, rejected };
}

/**
 * Validates the mutation, then runs its mutator in a savepoint, stamping its writes with
 * `version`. Returns whether it wrote anything, or why it was rejected.
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
): Promise<{ changed: boolean; rejected: RejectionReason | undefined }> {
  const parsed = mutationSchema.safeParse(envelope);
  if (!parsed.success) {
    logRejection(clientId, envelope, "invalid", summarizeIssues(parsed.error));
    return { changed: false, rejected: "invalid" };
  }
  const serverTx = new ServerTx(tx, version);
  await tx.query("SAVEPOINT mutation");
  try {
    await applyMutation(serverTx, parsed.data);
    return { changed: serverTx.changed, rejected: undefined };
  } catch (error) {
    const reason = permanentFailure(error);
    if (reason === undefined) throw error;
    await tx.query("ROLLBACK TO SAVEPOINT mutation");
    logRejection(clientId, envelope, reason, error instanceof Error ? error.message : "");
    return { changed: false, rejected: reason };
  }
}

/** The rejections recorded for these mutations of the device (a subset of `ids`). */
async function readRejections(
  db: Queryable,
  clientId: string,
  ids: readonly number[],
): Promise<RejectedMutation[]> {
  return db.query<RejectedMutation>(
    `SELECT mutation_id AS id, reason FROM rejected_mutations
     WHERE client_id = $1 AND mutation_id = ANY($2::bigint[])`,
    [clientId, ids],
  );
}

function logRejection(
  clientId: string,
  envelope: MutationEnvelope,
  reason: RejectionReason,
  detail: string,
): void {
  logger.warn("Mutation rejected", {
    clientId,
    mutationId: envelope.id,
    name: envelope.name,
    reason,
    detail,
  });
}

/** Where and why, never the values themselves (they are user data). */
function summarizeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
}

/**
 * Why replaying the same mutation would fail the same way, if it would: a mutator rejection, or a
 * database error of SQLSTATE class 22 (data exception) or 23 (integrity constraint violation).
 * Undefined for any other error, considered transient.
 */
function permanentFailure(error: unknown): RejectionReason | undefined {
  if (error instanceof MutationRejectedError) return "not_applicable";
  const code = error instanceof Error && "code" in error ? error.code : undefined;
  return typeof code === "string" && /^2[23][0-9A-Z]{3}$/.test(code)
    ? "refused_by_database"
    : undefined;
}
