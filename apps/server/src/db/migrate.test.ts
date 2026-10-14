import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "./migrate";
import { createPgliteClient, type SqlClient } from "./sql";

describe("migrate", () => {
  let db: SqlClient;
  beforeEach(async () => {
    db = await createPgliteClient("memory://");
  });
  afterEach(() => db.close());

  it("applies pending migrations once", async () => {
    expect(await migrate(db)).toEqual(["001_init"]);
    expect(await migrate(db)).toEqual([]);

    expect(await db.query("SELECT name FROM schema_migrations")).toEqual([{ name: "001_init" }]);
    expect(await db.query("SELECT id, version FROM server_meta")).toEqual([{ id: 1, version: 0 }]);
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
