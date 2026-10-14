import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseEnv } from "./env";

describe("parseEnv", () => {
  it("applies defaults, treating blank variables as unset", () => {
    const env = parseEnv({ PORT: "", DATABASE_URL: "" });

    expect(env).toMatchObject({
      NODE_ENV: "development",
      LOG_LEVEL: "info",
      PORT: 3000,
      HOST: "0.0.0.0",
      PGLITE_DATA_DIR: resolve(".data/pglite"),
    });
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.STATIC_DIR.endsWith(join("apps", "web", "dist"))).toBe(true);
  });

  it("resolves paths, but keeps an in-memory PGlite as is", () => {
    const env = parseEnv({ PORT: "8080", PGLITE_DATA_DIR: "memory://", STATIC_DIR: "public" });

    expect(env).toMatchObject({
      PORT: 8080,
      PGLITE_DATA_DIR: "memory://",
      STATIC_DIR: resolve("public"),
    });
  });

  it("rejects invalid values with a readable message", () => {
    expect(() => parseEnv({ PORT: "eighty", LOG_LEVEL: "verbose" })).toThrow(
      /PORT[\s\S]*LOG_LEVEL|LOG_LEVEL[\s\S]*PORT/,
    );
  });
});
