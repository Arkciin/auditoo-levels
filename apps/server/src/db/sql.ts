/**
 * Minimal SQL layer: the same code runs on PostgreSQL in production (node-postgres) and on PGlite,
 * an embedded WASM build of Postgres, for local development and tests.
 */
import type { PGlite, Transaction } from "@electric-sql/pglite";
import { Pool, type PoolClient, TypeOverrides } from "pg";
import { logger } from "../logger";

export interface Queryable {
  /** Runs one statement. Rows are plain objects; int8 columns come back as numbers. */
  query<Row>(text: string, params?: readonly unknown[]): Promise<Row[]>;
  /** Runs a parameterless script of one or more statements (e.g. a migration). */
  exec(script: string): Promise<void>;
}

export type IsolationLevel = "read committed" | "repeatable read" | "serializable";

export interface TransactionOptions {
  isolation?: IsolationLevel;
  readOnly?: boolean;
}

export interface SqlClient extends Queryable {
  /** Runs `fn` in a transaction, committed if it resolves and rolled back if it throws. */
  transaction<T>(fn: (tx: Queryable) => Promise<T>, options?: TransactionOptions): Promise<T>;
  close(): Promise<void>;
}

const INT8_OID = 20;

// Both drivers would otherwise return int8 as a string (pg) or as number | bigint (PGlite). Ours
// (versions, mutation ids, epoch-ms timestamps) stay far below 2^53, so a number is exact.
const parseInt8 = (value: string): number => Number(value);

/** Modes for `BEGIN` / `SET TRANSACTION`, built from a closed set of values only. */
function transactionModes({ isolation, readOnly }: TransactionOptions = {}): string {
  const modes: string[] = [];
  if (isolation) modes.push(`ISOLATION LEVEL ${isolation.toUpperCase()}`);
  if (readOnly) modes.push("READ ONLY");
  return modes.join(", ");
}

/** The single row of a result that must contain exactly one (e.g. a singleton table). */
export function onlyRow<Row>(rows: readonly Row[]): Row {
  const [row] = rows;
  if (row === undefined || rows.length > 1) {
    throw new Error(`Expected exactly one row, got ${rows.length}`);
  }
  return row;
}

export function createPgClient(connectionString: string): SqlClient {
  const types = new TypeOverrides();
  types.setTypeParser(INT8_OID, parseInt8);
  // By default node-postgres waits forever for a connection: fail fast instead, so that requests
  // and health checks report an unreachable database rather than hang.
  const pool = new Pool({ connectionString, max: 10, connectionTimeoutMillis: 5_000, types });
  // An idle pooled connection can fail (e.g. the database restarts). Without a listener, that
  // error would crash the process; the pool already discards the broken connection.
  pool.on("error", (error) => logger.error("Idle PostgreSQL connection failed", { error }));

  return {
    ...pgQueryable(pool),
    async transaction(fn, options) {
      const client = await pool.connect();
      let broken = false;
      try {
        await client.query(`BEGIN ${transactionModes(options)}`);
        const result = await fn(pgQueryable(client));
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {
          // The connection is unusable: destroy it rather than hand it to the next caller.
          broken = true;
        });
        throw error;
      } finally {
        client.release(broken);
      }
    },
    close: () => pool.end(),
  };
}

function pgQueryable(target: Pool | PoolClient): Queryable {
  return {
    async query<Row>(text: string, params?: readonly unknown[]) {
      const result = await target.query(text, params && [...params]);
      return result.rows as Row[];
    },
    async exec(script) {
      // Without parameters, node-postgres uses the simple query protocol, which accepts several
      // statements at once.
      await target.query(script);
    },
  };
}

export interface PgliteClient extends SqlClient {
  /** A copy of the whole database, from which `createPgliteClient` can start a new one. */
  dump(): Promise<Blob>;
}

/**
 * `dataDir` is a directory, or `memory://` for a throwaway in-memory database. Starting from
 * `initialData` (a dump) skips initdb, which takes seconds in WASM: tests rely on it.
 */
export async function createPgliteClient(
  dataDir: string,
  initialData?: Blob,
): Promise<PgliteClient> {
  // Imported on demand so that production, on PostgreSQL, never loads the WASM build.
  const { PGlite } = await import("@electric-sql/pglite");
  const db = await PGlite.create(dataDir, {
    parsers: { [INT8_OID]: parseInt8 },
    loadDataDir: initialData,
  });

  return {
    ...pgliteQueryable(db),
    transaction(fn, options) {
      // PGlite is single-connection: its transactions run one at a time, which trivially
      // satisfies any isolation level. The modes are still applied so that, for example, a write
      // in a read-only transaction fails here as it would on PostgreSQL.
      return db.transaction(async (tx) => {
        const modes = transactionModes(options);
        if (modes) await tx.query(`SET TRANSACTION ${modes}`);
        return fn(pgliteQueryable(tx));
      });
    },
    close: () => db.close(),
    dump: () => db.dumpDataDir("none"),
  };
}

function pgliteQueryable(target: PGlite | Transaction): Queryable {
  return {
    async query<Row>(text: string, params?: readonly unknown[]) {
      const result = await target.query<Row>(text, params && [...params]);
      return result.rows;
    },
    async exec(script) {
      await target.exec(script);
    },
  };
}
