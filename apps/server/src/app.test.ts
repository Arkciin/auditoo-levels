import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliCompressSync, brotliDecompressSync, gunzipSync } from "node:zlib";
import { pullResponseSchema, pushResponseSchema } from "@repo/shared";
import type { Hono } from "hono";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app";
import type { SqlClient } from "./db/sql";
import { createTestDb, mutation } from "./testing";

const DEVICE = "0199f0a0-0000-7000-8000-0000000000a1";
const PROPERTY = "0199f0a0-0000-7000-8000-000000000001";
const createProperty = mutation(1, {
  name: "createProperty",
  args: { id: PROPERTY, name: "Maison" },
});

async function post(app: Hono, path: string, body: unknown): Promise<Response> {
  return app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function readText(response: Response): ReadableStreamDefaultReader<string> {
  if (!response.body) throw new Error("Expected a response body");
  return response.body.pipeThrough(new TextDecoderStream()).getReader();
}

let db: SqlClient;
beforeEach(async () => {
  db = await createTestDb();
});
afterEach(() => db.close());

describe("API", () => {
  it("reports health, with security headers", async () => {
    const response = await createApp({ db }).request("/api/health");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok", version: 0 });
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("reports an unreachable database as unhealthy", async () => {
    const down: SqlClient = { ...db, query: () => Promise.reject(new Error("connection refused")) };
    const response = await createApp({ db: down }).request("/api/health");

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: "error" });
  });

  it("syncs through push and pull, without caching", async () => {
    const app = createApp({ db });

    const push = await post(app, "/api/push", { clientId: DEVICE, mutations: [createProperty] });
    expect(push.status).toBe(200);
    expect(push.headers.get("cache-control")).toBe("no-store");
    const pushed = pushResponseSchema.parse(await push.json());
    expect(pushed).toEqual({ lastMutationId: 1, epoch: expect.any(String) });

    const pull = await post(app, "/api/pull", { clientId: DEVICE, cursor: 0 });
    expect(pull.status).toBe(200);
    expect(pull.headers.get("cache-control")).toBe("no-store");
    expect(pullResponseSchema.parse(await pull.json())).toEqual({
      epoch: pushed.epoch,
      cursor: 1,
      lastMutationId: 1,
      reset: false,
      changes: {
        properties: [{ id: PROPERTY, name: "Maison", createdAt: 1_000, deletedAt: null }],
        levels: [],
        spaces: [],
      },
    });
  });

  it("rejects invalid requests", async () => {
    const app = createApp({ db });

    const notJson = await app.request("/api/push", { method: "POST", body: "{" });
    expect(notJson.status).toBe(400);
    expect(await notJson.json()).toMatchObject({ error: "invalid_request" });

    const invalid = await post(app, "/api/pull", { clientId: "device-1", cursor: -1 });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({
      error: "invalid_request",
      issues: [
        expect.objectContaining({ path: ["clientId"] }),
        expect.objectContaining({ path: ["cursor"] }),
      ],
    });

    const tooLarge = await app.request("/api/push", {
      method: "POST",
      body: "x".repeat(1024 * 1024 + 1),
    });
    expect(tooLarge.status).toBe(413);
  });

  it("acknowledges a push with an invalid mutation instead of refusing all of it", async () => {
    const app = createApp({ db });
    const invalid = { id: 2, name: "renameProperty", args: { id: PROPERTY }, timestamp: 1_000 };
    const rename = mutation(3, { name: "renameProperty", args: { id: PROPERTY, name: "Villa" } });

    const push = await post(app, "/api/push", {
      clientId: DEVICE,
      mutations: [createProperty, invalid, rename],
    });
    expect(push.status).toBe(200);
    expect(pushResponseSchema.parse(await push.json())).toMatchObject({ lastMutationId: 3 });

    // Only a malformed envelope fails the request: without a usable id, nothing can be tracked.
    const malformed = await post(app, "/api/push", {
      clientId: DEVICE,
      mutations: [{ ...invalid, id: 0 }],
    });
    expect(malformed.status).toBe(400);
  });

  it("answers unknown API routes with a JSON 404", async () => {
    const response = await createApp({ db }).request("/api/nope", { method: "POST" });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
  });

  it("pokes connected devices when a push changes data, and ends streams on shutdown", async () => {
    const shutdown = new AbortController();
    const app = createApp({ db, signal: shutdown.signal });

    const events = await app.request("/api/events");
    expect(events.headers.get("content-type")).toBe("text/event-stream");
    expect(events.headers.get("cache-control")).toBe("no-cache");
    const stream = readText(events);

    await post(app, "/api/push", { clientId: DEVICE, mutations: [createProperty] });
    expect((await stream.read()).value).toBe('event: poke\ndata: {"version":1}\n\n');

    // A retry changes nothing: no poke for it, so the next one is for version 2.
    await post(app, "/api/push", { clientId: DEVICE, mutations: [createProperty] });
    const rename = mutation(2, { name: "renameProperty", args: { id: PROPERTY, name: "Villa" } });
    await post(app, "/api/push", { clientId: DEVICE, mutations: [rename] });
    expect((await stream.read()).value).toBe('event: poke\ndata: {"version":2}\n\n');

    shutdown.abort();
    expect((await stream.read()).done).toBe(true);
  });
});

describe("web app", () => {
  let staticDir: string;
  beforeAll(async () => {
    staticDir = await mkdtemp(join(tmpdir(), "auditoo-web-"));
    await mkdir(join(staticDir, "assets"));
    await writeFile(join(staticDir, "index.html"), "<!doctype html><title>Auditoo</title>");
    await writeFile(join(staticDir, "sw.js"), "self.skipWaiting();");
    await writeFile(join(staticDir, "assets", "index-B4x9.js"), "console.log('app');");
  });
  afterAll(() => rm(staticDir, { recursive: true, force: true }));

  it("serves index.html for client-side routes, revalidated on every load", async () => {
    const response = await createApp({ db, staticDir }).request("/logements/123");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/^text\/html/);
    expect(response.headers.get("cache-control")).toBe("no-cache");
    expect(await response.text()).toContain("<title>Auditoo</title>");
  });

  it("caches hashed assets forever and revalidates the service worker", async () => {
    const app = createApp({ db, staticDir });

    const asset = await app.request("/assets/index-B4x9.js");
    expect(asset.status).toBe(200);
    expect(asset.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");

    const worker = await app.request("/sw.js");
    expect(worker.status).toBe(200);
    expect(worker.headers.get("cache-control")).toBe("no-cache");
  });

  it("answers a missing asset or API route with a 404, not with index.html", async () => {
    const app = createApp({ db, staticDir });

    expect((await app.request("/assets/index-old.js")).status).toBe(404);
    const api = await app.request("/api/nope");
    expect(api.status).toBe(404);
    expect(await api.json()).toEqual({ error: "not_found" });
  });

  it("sends the build's Brotli copies to browsers that accept them", async () => {
    const script = "console.log('app');".repeat(100);
    await writeFile(join(staticDir, "assets", "app-C3x1.js"), script);
    await writeFile(join(staticDir, "assets", "app-C3x1.js.br"), brotliCompressSync(script));
    const app = createApp({ db, staticDir });

    const brotli = await app.request("/assets/app-C3x1.js", {
      headers: { "Accept-Encoding": "gzip, deflate, br" },
    });
    expect(brotli.headers.get("content-encoding")).toBe("br");
    expect(brotli.headers.get("content-type")).toMatch(/^text\/javascript/);
    expect(brotli.headers.get("vary")).toMatch(/Accept-Encoding/);
    expect(brotli.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(brotliDecompressSync(await brotli.arrayBuffer()).toString()).toBe(script);

    // Without Brotli, the response is compressed on the fly.
    const gzip = await app.request("/assets/app-C3x1.js", {
      headers: { "Accept-Encoding": "gzip" },
    });
    expect(gzip.headers.get("content-encoding")).toBe("gzip");
    expect(gunzipSync(await gzip.arrayBuffer()).toString()).toBe(script);
  });
});
