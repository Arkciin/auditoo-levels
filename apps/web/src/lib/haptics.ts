/**
 * Short vibration feedback for touch interactions (e.g. picking up or dropping an item while
 * reordering). Does nothing where the Vibration API is missing (iOS Safari, desktop) or before
 * the first user gesture, when browsers block it.
 *
 * @param pattern Duration in ms, or an alternating vibrate/pause pattern. Defaults to a light tick.
 */
export function haptic(pattern: number | number[] = 10): void {
  if (typeof navigator === "undefined" || typeof navigator.vibrate !== "function") return;
  if (navigator.userActivation && !navigator.userActivation.hasBeenActive) return;
  try {
    navigator.vibrate(pattern);
  } catch {
    // Some embedded browsers throw instead of returning false: haptics are best-effort.
  }
}
