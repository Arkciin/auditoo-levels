const relativeTime = new Intl.RelativeTimeFormat("fr", { numeric: "auto" });

/**
 * How long ago `timestamp` was, in French: « à l’instant », « il y a 5 minutes », « hier »…
 * A timestamp after `now` reads « à l’instant »: a clock that ticks can lag behind a sync that
 * just ended, and must never announce it « dans 1 minute ».
 */
export function formatSince(timestamp: number, now: number): string {
  const seconds = Math.round((Math.min(timestamp, now) - now) / 1000);
  if (Math.abs(seconds) < 45) return "à l’instant";
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return format(hours, "hour");
  return format(Math.round(hours / 24), "day");
}

/** A number and its unit stay on one line (U+00A0): « il y a 2 / minutes » would not do. */
function format(value: number, unit: Intl.RelativeTimeFormatUnit): string {
  return relativeTime.format(value, unit).replace(/(\d) /g, "$1\u00a0");
}
