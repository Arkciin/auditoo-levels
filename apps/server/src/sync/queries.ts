/** SQL shared by push, pull and the server-side mutator transaction. */
import { onlyRow, type Queryable } from "../db/sql";

// Rows selected straight into the shared entity shapes (the quoted aliases keep the camelCase).
// The mutators and pull both use them, so devices receive exactly what the mutators read.
export const SELECT_PROPERTIES = `
  SELECT id, name, created_at AS "createdAt", deleted_at AS "deletedAt"
  FROM properties`;
export const SELECT_LEVELS = `
  SELECT id, property_id AS "propertyId", name, position, deleted_at AS "deletedAt"
  FROM levels`;
export const SELECT_SPACES = `
  SELECT id, level_id AS "levelId", name, position, deleted_at AS "deletedAt"
  FROM spaces`;

export interface SyncState {
  /** Global server version (the pull cursor). */
  version: number;
  /** Last mutation processed for the client, 0 if it never pushed. */
  lastMutationId: number;
}

export async function readSyncState(sql: Queryable, clientId: string): Promise<SyncState> {
  const rows = await sql.query<SyncState>(
    `SELECT
       version,
       COALESCE((SELECT last_mutation_id FROM clients WHERE id = $1), 0) AS "lastMutationId"
     FROM server_meta WHERE id = 1`,
    [clientId],
  );
  return onlyRow(rows);
}
