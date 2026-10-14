import type { Level, Property, PullRequest, PullResponse, Space } from "@repo/shared";
import type { SqlClient } from "../db/sql";
import { readSyncState, SELECT_LEVELS, SELECT_PROPERTIES, SELECT_SPACES } from "./queries";

/** Returns every row that changed since `cursor`, soft-deleted ones included. */
export function processPull(
  db: SqlClient,
  { clientId, cursor }: PullRequest,
): Promise<PullResponse> {
  // The device keeps these rows as confirmed state, drops its mutations up to lastMutationId and
  // replays the others on top. That is only correct if every read sees the same state, hence a
  // single REPEATABLE READ snapshot. Under READ COMMITTED, a push committing between two
  // statements could show up in the rows but not in lastMutationId: the device would then replay
  // that mutation over its own effects.
  return db.transaction(
    async (tx) => {
      const { version, lastMutationId } = await readSyncState(tx, clientId);
      // A cursor ahead of the server means the database was reset or restored: send everything
      // and tell the device to replace its data instead of merging into it.
      const reset = cursor > version;
      const since = reset ? 0 : cursor;
      return {
        cursor: version,
        lastMutationId,
        reset,
        changes: {
          properties: await tx.query<Property>(`${SELECT_PROPERTIES} WHERE version > $1`, [since]),
          levels: await tx.query<Level>(`${SELECT_LEVELS} WHERE version > $1`, [since]),
          spaces: await tx.query<Space>(`${SELECT_SPACES} WHERE version > $1`, [since]),
        },
      };
    },
    { isolation: "repeatable read", readOnly: true },
  );
}
