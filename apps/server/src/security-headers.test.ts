import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app";
import type { SqlClient } from "./db/sql";
import { createTestDb } from "./testing";

/** "a 'x'; b 'y' 'z'" → { a: ["'x'"], b: ["'y'", "'z'"] } */
function directives(header: string | null): Record<string, string[]> {
  if (!header) throw new Error("Missing header");
  return Object.fromEntries(
    header.split(";").map((directive) => {
      const [name = "", ...values] = directive.trim().split(/\s+/);
      return [name, values];
    }),
  );
}

let db: SqlClient;
let staticDir: string;
let app: Hono;

// Read-only requests: one database for the whole file.
beforeAll(async () => {
  staticDir = await mkdtemp(join(tmpdir(), "auditoo-web-"));
  await writeFile(join(staticDir, "index.html"), "<!doctype html><title>Relevé</title>");
  db = await createTestDb();
  app = createApp({ db, staticDir });
});
afterAll(async () => {
  await db.close();
  await rm(staticDir, { recursive: true, force: true });
});

describe("security headers", () => {
  it("serve the app under a same-origin Content Security Policy", async () => {
    const response = await app.request("/logements/123");

    expect(directives(response.headers.get("content-security-policy"))).toEqual({
      "default-src": ["'self'"],
      "script-src": ["'self'"],
      "style-src": ["'self'", "'unsafe-inline'"],
      "style-src-attr": ["'none'"],
      "img-src": ["'self'"],
      "font-src": ["'self'"],
      "connect-src": ["'self'"],
      "worker-src": ["'self'"],
      "manifest-src": ["'self'"],
      "object-src": ["'none'"],
      "base-uri": ["'none'"],
      "form-action": ["'none'"],
      "frame-ancestors": ["'none'"],
    });
  });

  it("never let scripts run inline or through eval", async () => {
    const csp = directives((await app.request("/")).headers.get("content-security-policy"));

    for (const directive of ["default-src", "script-src"]) {
      expect(csp[directive]).not.toContain("'unsafe-inline'");
      expect(csp[directive]).not.toContain("'unsafe-eval'");
      expect(csp[directive]).not.toContain("*");
    }
  });

  it("deny the powerful features the app does not use", async () => {
    const policy = (await app.request("/")).headers.get("permissions-policy") ?? "";
    const features = Object.fromEntries(
      policy.split(",").map((entry) => {
        const [feature = "", allowlist = ""] = entry.trim().split("=");
        return [feature, allowlist];
      }),
    );

    expect(features).toMatchObject({
      camera: "()",
      microphone: "()",
      geolocation: "()",
      payment: "()",
      usb: "()",
      "browsing-topics": "()",
    });
    expect(new Set(Object.values(features))).toEqual(new Set(["()"]));
  });

  it("keep URLs out of Referer, the app out of frames and responses unsniffed", async () => {
    const { headers } = await app.request("/");

    expect(headers.get("referrer-policy")).toBe("no-referrer");
    expect(headers.get("x-frame-options")).toBe("DENY");
    expect(headers.get("x-content-type-options")).toBe("nosniff");
    expect(headers.get("cross-origin-opener-policy")).toBe("same-origin");
    expect(headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(headers.get("strict-transport-security")).toMatch(/^max-age=\d+; includeSubDomains$/);
  });

  it("apply to the API and to errors as well", async () => {
    for (const response of [await app.request("/api/health"), await app.request("/api/nope")]) {
      expect(response.headers.get("content-security-policy")).toContain("default-src 'self'");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    }
  });
});
