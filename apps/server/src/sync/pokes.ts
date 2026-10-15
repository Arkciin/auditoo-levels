import type { Poke } from "@repo/shared";

export type PokeListener = (poke: Poke) => void;

/**
 * In-process pub/sub telling connected devices that the server version changed, so that they
 * pull right away instead of waiting for their next poll.
 *
 * Single instance only: with several server instances, a push handled by one must also reach the
 * devices connected to the others, and this becomes Postgres LISTEN/NOTIFY.
 */
export class Pokes {
  private readonly listeners = new Set<PokeListener>();

  /** Returns the unsubscribe function. */
  subscribe(listener: PokeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  publish(poke: Poke): void {
    for (const listener of this.listeners) listener(poke);
  }
}
