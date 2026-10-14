/** Test helpers (never imported by the server itself). */
import type { Mutation } from "@repo/shared";
import { migrate } from "./db/migrate";
import { createPgliteClient, type SqlClient } from "./db/sql";

// initdb and the migrations take seconds in WASM: run them once per test file, then start every
// test from its own copy of the result.
let template: Promise<Blob> | undefined;

async function migratedDump(): Promise<Blob> {
  const db = await createPgliteClient("memory://");
  try {
    await migrate(db);
    return await db.dump();
  } finally {
    await db.close();
  }
}

/** A fresh, migrated, in-memory database. */
export async function createTestDb(): Promise<SqlClient> {
  template ??= migratedDump();
  return createPgliteClient("memory://", await template);
}

type MutationDraft = {
  [N in Mutation["name"]]: { name: N; args: Extract<Mutation, { name: N }>["args"] };
}[Mutation["name"]];

/** A mutation envelope; the timestamp is fixed unless given, to keep rows predictable. */
export function mutation(id: number, draft: MutationDraft, timestamp = 1_000): Mutation {
  return { id, timestamp, ...draft };
}
