/**
 * Minimal structured logger: one JSON object per line in production (what log collectors parse),
 * a readable line in development, nothing in tests.
 */
import { env, type LogLevel } from "./env";

export type LogFields = Record<string, unknown>;

const SEVERITY: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const silent = env.NODE_ENV === "test" || process.env.VITEST !== undefined;
const minSeverity = SEVERITY[env.LOG_LEVEL];
const format = env.NODE_ENV === "production" ? formatJson : formatPretty;

function log(level: LogLevel, message: string, fields: LogFields = {}): void {
  if (silent || SEVERITY[level] < minSeverity) return;
  const output = SEVERITY[level] >= SEVERITY.warn ? process.stderr : process.stdout;
  output.write(`${format(level, message, fields)}\n`);
}

export const logger = {
  debug: (message: string, fields?: LogFields) => log("debug", message, fields),
  info: (message: string, fields?: LogFields) => log("info", message, fields),
  warn: (message: string, fields?: LogFields) => log("warn", message, fields),
  error: (message: string, fields?: LogFields) => log("error", message, fields),
};

function formatJson(level: LogLevel, message: string, fields: LogFields): string {
  return toJson({ time: new Date().toISOString(), level, msg: message, ...fields });
}

/** `12:34:56.789 INFO  message key=value …`, followed by the stack of any error field. */
function formatPretty(level: LogLevel, message: string, fields: LogFields): string {
  const time = new Date().toISOString().slice(11, 23);
  let line = `${time} ${level.toUpperCase().padEnd(5)} ${message}`;
  const stacks: string[] = [];
  for (const [key, value] of Object.entries(fields)) {
    if (value instanceof Error) {
      line += ` ${key}=${JSON.stringify(value.message)}`;
      if (value.stack) stacks.push(value.stack);
    } else {
      line += ` ${key}=${typeof value === "string" ? value : toJson(value)}`;
    }
  }
  return [line, ...stacks].join("\n");
}

function toJson(value: unknown): string {
  return JSON.stringify(value, (_key, nested: unknown) => serialize(nested));
}

/** Makes errors (whose fields are non-enumerable) and bigints JSON-serializable. */
function serialize(value: unknown): unknown {
  if (value instanceof Error) {
    // An allowlist, not a spread: libraries attach arbitrary objects to errors (pg-pool attaches
    // the whole client, connection details and socket state included).
    const { name, message, stack, cause } = value;
    const code = "code" in value ? value.code : undefined; // e.g. a SQLSTATE
    return {
      name,
      message,
      ...(code === undefined ? {} : { code }),
      stack,
      ...(cause === undefined ? {} : { cause }),
    };
  }
  return typeof value === "bigint" ? value.toString() : value;
}
