import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "server",
    environment: "node",
    // PGlite (PostgreSQL in WASM) takes seconds to create a database, several times more on a
    // busy machine (CI, parallel runs): the default 5 s / 10 s made a file's first tests time out.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
