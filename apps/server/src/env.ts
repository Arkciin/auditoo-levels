import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

// `src/env.ts` (run by tsx) and the bundled `dist/index.js` both sit one level below apps/server,
// so the same relative URL reaches the web build in both cases.
const DEFAULT_STATIC_DIR = fileURLToPath(new URL("../../web/dist", import.meta.url));

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  LOG_LEVEL: z.enum(LOG_LEVELS).default("info"),
  PORT: z.coerce.number().int().min(0).max(65_535).default(3000),
  HOST: z.string().default("0.0.0.0"),
  /** PostgreSQL connection string. Without it, the server uses an embedded PGlite database. */
  DATABASE_URL: z.string().optional(),
  /** PGlite storage: a directory (relative to the working directory) or `memory://`. */
  PGLITE_DATA_DIR: z
    .string()
    .default(".data/pglite")
    .transform((dir) => (dir.startsWith("memory://") ? dir : resolve(dir))),
  /** Directory of the built SPA, served only if it contains an index.html. */
  STATIC_DIR: z
    .string()
    .default(DEFAULT_STATIC_DIR)
    .transform((dir) => resolve(dir)),
});

export type Env = z.infer<typeof envSchema>;

export function parseEnv(source: NodeJS.ProcessEnv): Env {
  // Blank variables (common in hosting dashboards) mean "unset", not "empty string".
  const defined = Object.fromEntries(Object.entries(source).filter(([, value]) => value !== ""));
  const result = envSchema.safeParse(defined);
  if (!result.success) {
    throw new Error(`Invalid environment variables:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

export const env = parseEnv(process.env);
