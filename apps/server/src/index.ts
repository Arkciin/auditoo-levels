import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { createApp } from "./app";
import { migrate } from "./db/migrate";
import { createPgClient, createPgliteClient, type SqlClient } from "./db/sql";
import { env } from "./env";
import { logger } from "./logger";

const SHUTDOWN_TIMEOUT_MS = 10_000;

async function openDatabase(): Promise<SqlClient> {
  if (env.DATABASE_URL) {
    logger.info("Using PostgreSQL");
    return createPgClient(env.DATABASE_URL);
  }
  const dataDir = env.PGLITE_DATA_DIR;
  if (!dataDir.startsWith("memory://")) await mkdir(dataDir, { recursive: true });
  logger.info("Using embedded PGlite", { dataDir });
  return createPgliteClient(dataDir);
}

async function main(): Promise<void> {
  const db = await openDatabase();
  await migrate(db);

  if (existsSync(join(env.STATIC_DIR, "index.html"))) {
    logger.info("Serving the web app", { staticDir: env.STATIC_DIR });
  } else {
    logger.warn("No web app build found, serving the API only", { staticDir: env.STATIC_DIR });
  }

  const shutdown = new AbortController();
  const app = createApp({ db, staticDir: env.STATIC_DIR, signal: shutdown.signal });
  const server = serve({ fetch: app.fetch, port: env.PORT, hostname: env.HOST }, ({ port }) => {
    const host = env.HOST === "0.0.0.0" || env.HOST === "::" ? "localhost" : env.HOST;
    logger.info(`Listening on http://${host}:${port}`);
  });
  server.on("error", (error) => {
    logger.error("HTTP server error", { error });
    process.exit(1);
  });

  // Render (like most platforms) sends SIGTERM before replacing the instance on a deploy.
  let stopping = false;
  const stop = async (signal: NodeJS.Signals) => {
    if (stopping) return;
    stopping = true;
    logger.info("Shutting down", { signal });
    setTimeout(() => {
      logger.error("Graceful shutdown timed out, forcing exit");
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS).unref();
    try {
      // Stop accepting connections; resolves once the open ones are done.
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      shutdown.abort(); // ends the event streams, which would otherwise never finish
      await closed;
      await db.close();
      logger.info("Stopped");
      process.exit(0);
    } catch (error) {
      logger.error("Shutdown failed", { error });
      process.exit(1);
    }
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

main().catch((error: unknown) => {
  logger.error("Startup failed", { error });
  process.exit(1);
});
