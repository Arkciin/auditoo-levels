import { openSyncStorage } from "./storage";
import { SyncClient } from "./sync-client";
import { createHttpTransport } from "./transport";

/**
 * Creates and starts the app's sync client: IndexedDB storage, same-origin HTTP transport and
 * server pokes from `/api/events`. Rejects when IndexedDB is unavailable.
 */
export async function createBrowserSyncClient(): Promise<SyncClient> {
  // Ask the browser not to evict our data under storage pressure: the outbox can hold hours of
  // offline work that exists nowhere else. Best effort: browsers grant it on their own terms
  // (Firefox asks the user, Chromium and Safari decide silently, older engines lack the API).
  void navigator.storage?.persist?.().catch(() => false);
  const storage = await openSyncStorage();
  const client = await SyncClient.create({
    storage,
    transport: createHttpTransport(),
    eventsUrl: "/api/events",
  });
  client.start();
  return client;
}
