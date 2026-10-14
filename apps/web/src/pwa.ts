/** Must match `swDest` in vite.config.ts (the worker is emitted at the root of the build). */
const SERVICE_WORKER_URL = "/sw.js";

/**
 * Registers the service worker (production builds only: in dev, Vite serves fresh modules).
 *
 * Updates follow a "prompt" strategy: when a new version has been installed and is waiting,
 * `onUpdateReady` receives `apply`. Calling `apply` tells the waiting worker to take over, then
 * reloads the page once it controls it, so the whole app switches version at once.
 */
export async function registerServiceWorker(
  onUpdateReady: (apply: () => void) => void,
): Promise<void> {
  if (!import.meta.env.PROD || !("serviceWorker" in navigator)) return;

  const { Serwist } = await import("@serwist/window");
  const serwist = new Serwist(SERVICE_WORKER_URL, { scope: "/", type: "classic" });

  let reloading = false;
  const apply = () => {
    serwist.addEventListener("controlling", () => {
      if (reloading) return;
      reloading = true;
      window.location.reload();
    });
    serwist.messageSkipWaiting();
  };

  // Fired when an update has installed, and on startup if one was already waiting.
  serwist.addEventListener("waiting", () => onUpdateReady(apply));

  try {
    await serwist.register();
  } catch (error) {
    // The app keeps working online without a worker (e.g. insecure origin, private mode).
    console.warn("Service worker registration failed", error);
  }
}

/**
 * Asks the browser to keep this origin's storage (IndexedDB holds edits that may not be synced
 * yet) instead of evicting it under storage pressure. Resolves to whether storage is persisted.
 * Chrome and Safari decide silently; Firefox shows a permission prompt.
 */
export async function requestPersistentStorage(): Promise<boolean> {
  const storage = navigator.storage as StorageManager | undefined;
  if (typeof storage?.persist !== "function") return false;
  try {
    return (await storage.persisted()) || (await storage.persist());
  } catch {
    return false;
  }
}
