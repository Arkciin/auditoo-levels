import { existsSync } from "node:fs";
import { join } from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import { type PushResponse, pullRequestSchema, pushRequestSchema } from "@repo/shared";
import { type Context, Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { except } from "hono/combine";
import { compress } from "hono/compress";
import { HTTPException } from "hono/http-exception";
import { streamSSE } from "hono/streaming";
import type { z } from "zod";
import { onlyRow, type SqlClient } from "./db/sql";
import { logger } from "./logger";
import { securityHeaders } from "./security-headers";
import { Pokes } from "./sync/pokes";
import { processPull } from "./sync/pull";
import { processPush } from "./sync/push";

export interface AppOptions {
  db: SqlClient;
  /** Directory of the built SPA, served when it contains an index.html. */
  staticDir?: string | undefined;
  /** Aborted on shutdown, to end the long-lived event streams. */
  signal?: AbortSignal | undefined;
}

const MAX_BODY_BYTES = 1024 * 1024;
// Below the idle timeout of common proxies and load balancers (30 to 60 seconds).
const HEARTBEAT_INTERVAL_MS = 25_000;
const IMMUTABLE = "public, max-age=31536000, immutable";
// Entry points of the SPA: always revalidated, so that a new deploy reaches devices.
const REVALIDATED_PATHS = new Set(["/", "/index.html", "/sw.js", "/manifest.webmanifest"]);

export function createApp({ db, staticDir, signal }: AppOptions): Hono {
  const app = new Hono();
  const pokes = new Pokes();

  app.use(securityHeaders());
  app.use(logRequests);
  // Compressing the event stream would buffer pokes.
  app.use(except("/api/events", compress()));

  app.use("/api/*", async (c, next) => {
    await next();
    // Sync data must never come from a cache; a route with its own policy (SSE) keeps it.
    if (!c.res.headers.has("Cache-Control")) c.header("Cache-Control", "no-store");
  });
  app.use(
    "/api/*",
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: (c) => c.json({ error: "payload_too_large" }, 413),
    }),
  );

  app.get("/api/health", async (c) => {
    try {
      const rows = await db.query<{ version: number }>(
        "SELECT version FROM server_meta WHERE id = 1",
      );
      return c.json({ status: "ok", version: onlyRow(rows).version });
    } catch (error) {
      logger.error("Health check failed", { error });
      return c.json({ status: "error" }, 503);
    }
  });

  app.post("/api/push", async (c) => {
    const request = pushRequestSchema.safeParse(await readJson(c));
    if (!request.success) return invalidRequest(c, request.error);
    const { lastMutationId, epoch, changed, version } = await processPush(db, request.data);
    if (changed) pokes.publish(version);
    return c.json({ lastMutationId, epoch } satisfies PushResponse);
  });

  app.post("/api/pull", async (c) => {
    const request = pullRequestSchema.safeParse(await readJson(c));
    if (!request.success) return invalidRequest(c, request.error);
    return c.json(await processPull(db, request.data));
  });

  app.get("/api/events", (c) => {
    // Disables response buffering in nginx-like proxies, which would hold pokes back.
    c.header("X-Accel-Buffering", "no");
    return streamSSE(c, async (stream) => {
      const unsubscribe = pokes.subscribe((version) => {
        void stream.writeSSE({ event: "poke", data: JSON.stringify({ version }) });
      });
      // An SSE comment: ignored by EventSource, but keeps proxies from closing an idle stream.
      const heartbeat = setInterval(
        () => void stream.write(": heartbeat\n\n"),
        HEARTBEAT_INTERVAL_MS,
      );
      const end = () => stream.abort();
      signal?.addEventListener("abort", end);
      try {
        if (!signal?.aborted) await new Promise<void>((resolve) => stream.onAbort(resolve));
      } finally {
        signal?.removeEventListener("abort", end);
        clearInterval(heartbeat);
        unsubscribe();
      }
    });
  });

  app.all("/api/*", (c) => c.json({ error: "not_found" }, 404));

  if (staticDir && existsSync(join(staticDir, "index.html"))) serveSpa(app, staticDir);

  app.notFound((c) => c.json({ error: "not_found" }, 404));
  app.onError((error, c) => {
    if (error instanceof HTTPException) return error.getResponse();
    logger.error("Unhandled error", { method: c.req.method, path: c.req.path, error });
    return c.json({ error: "internal_error" }, 500);
  });

  return app;
}

/**
 * Serves the built SPA: hashed assets are cached forever, entry points are revalidated, and any
 * other GET falls back to index.html so that client-side routes survive a reload.
 */
function serveSpa(app: Hono, root: string): void {
  // The build writes a Brotli copy of each text file (.br): sent as is to browsers that accept it.
  const serve = (options: { path?: string } = {}) =>
    serveStatic({ root, precompressed: true, ...options });
  app.use("/assets/*", cacheControl(IMMUTABLE), serve());
  // A missing hashed asset is a genuine 404 (typically a stale client asking for a chunk of a
  // previous deploy): the SPA fallback would answer with HTML where JavaScript is expected.
  app.get("/assets/*", (c) => c.notFound());
  app.use(
    "*",
    cacheControl("no-cache", (c) => REVALIDATED_PATHS.has(c.req.path)),
    serve(),
  );
  app.get("*", cacheControl("no-cache"), serve({ path: "index.html" }));
}

/** Sets Cache-Control on the successful responses of the handlers that follow. */
function cacheControl(value: string, applies: (c: Context) => boolean = () => true) {
  const middleware: MiddlewareHandler = async (c, next) => {
    await next();
    if (c.res.ok && applies(c)) c.header("Cache-Control", value);
  };
  return middleware;
}

const logRequests: MiddlewareHandler = async (c, next) => {
  // Health checks come every few seconds from the platform: logging them would drown the rest.
  if (c.req.path === "/api/health") return next();
  const start = performance.now();
  await next();
  logger.info("request", {
    method: c.req.method,
    path: c.req.path,
    status: c.res.status,
    durationMs: Math.round(performance.now() - start),
  });
};

/** The JSON body, or undefined when it is not JSON (the schema then reports it). */
async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json<unknown>();
  } catch {
    return undefined;
  }
}

function invalidRequest(c: Context, error: z.ZodError) {
  return c.json({ error: "invalid_request", issues: error.issues }, 400);
}
