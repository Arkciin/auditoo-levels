import { logger } from "../logger";
import { migrations } from "./migrations";
import type { Queryable, SqlClient } from "./sql";

// Arbitrary, but must be the same for every instance of the server.
const MIGRATION_LOCK_KEY = 4_242_001;

/**
 * Applies the pending migrations, each in its own transaction, and returns their names.
 * Idempotent, and safe when several instances boot at once (e.g. during a deploy).
 */
export async function migrate(db: SqlClient): Promise<string[]> {
  await db.transaction(async (tx) => {
    await lockMigrations(tx);
    await tx.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
  });

  const applied: string[] = [];
  for (const migration of migrations) {
    const isNew = await db.transaction(async (tx) => {
      await lockMigrations(tx);
      // Checked under the lock: another instance may have applied it while we were waiting.
      const done = await tx.query("SELECT 1 FROM schema_migrations WHERE name = $1", [
        migration.name,
      ]);
      if (done.length > 0) return false;
      await tx.exec(migration.sql);
      await tx.query("INSERT INTO schema_migrations (name) VALUES ($1)", [migration.name]);
      return true;
    });
    if (isNew) {
      logger.info("Applied migration", { name: migration.name });
      applied.push(migration.name);
    }
  }
  return applied;
}

/**
 * Serializes migrations across instances. A transaction-level advisory lock is released at
 * commit or rollback, so it cannot leak on a pooled connection. Harmless on PGlite, which has a
 * single connection anyway.
 */
async function lockMigrations(tx: Queryable): Promise<void> {
  await tx.query("SELECT pg_advisory_xact_lock($1)", [MIGRATION_LOCK_KEY]);
}
