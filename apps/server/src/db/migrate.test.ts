import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "./migrate";
import { createPgliteClient, onlyRow, type SqlClient } from "./sql";

async function epochOf(db: SqlClient): Promise<string> {
  return onlyRow(await db.query<{ epoch: string }>("SELECT epoch FROM server_meta")).epoch;
}

describe("migrate", () => {
  let db: SqlClient;
  beforeEach(async () => {
    db = await createPgliteClient("memory://");
  });
  afterEach(() => db.close());

  it("applies pending migrations once", async () => {
    const all = ["001_init", "002_server_epoch", "003_rejected_mutations"];
    expect(await migrate(db)).toEqual(all);
    expect(await migrate(db)).toEqual([]);

    expect(await db.query("SELECT name FROM schema_migrations ORDER BY name")).toEqual(
      all.map((name) => ({ name })),
    );
    expect(await db.query("SELECT id, version FROM server_meta")).toEqual([{ id: 1, version: 0 }]);
  });

  it("draws a new epoch for every database", async () => {
    await migrate(db);
    const other = await createPgliteClient("memory://");
    try {
      await migrate(other);
      expect(await epochOf(db)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-/);
      expect(await epochOf(other)).not.toBe(await epochOf(db));
    } finally {
      await other.close();
    }
  });

  it("orders positions by code unit", async () => {
    await migrate(db);
    const columns = await db.query(
      `SELECT table_name AS "table", collation_name AS "collation"
       FROM information_schema.columns WHERE column_name = 'position' ORDER BY table_name`,
    );
    expect(columns).toEqual([
      { table: "levels", collation: "C" },
      { table: "spaces", collation: "C" },
    ]);
  });
});
