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
  if (Math.abs(minutes) < 60) return relativeTime.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return relativeTime.format(hours, "hour");
  return relativeTime.format(Math.round(hours / 24), "day");
}
