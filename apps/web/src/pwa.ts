/** Must match `swDest` in vite.config.ts (the worker is emitted at the root of the build). */
const SERVICE_WORKER_URL = "/sw.js";

export interface ServiceWorkerCallbacks {
  /**
   * A new version is installed and waiting. Calling `apply` tells it to take over, then reloads
   * the page once it controls it, so the whole app switches version at once ("prompt" strategy).
   */
  readonly onUpdateReady: (apply: () => void) => void;
  /** The first install is complete: from now on the app opens and works without network. */
  readonly onOfflineReady: () => void;
}

/** Registers the service worker (production builds only: in dev, Vite serves fresh modules). */
export async function registerServiceWorker({
  onUpdateReady,
  onOfflineReady,
}: ServiceWorkerCallbacks): Promise<void> {
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

  // Whether this visit is the one that makes the app work offline. Not an update, nor a reload
  // that bypassed the cache (Shift+reload): an active worker existed before either.
  const firstInstall = !(await navigator.serviceWorker.getRegistration())?.active;
  try {
    await serwist.register();
  } catch (error) {
    // The app keeps working online without a worker (e.g. insecure origin, private mode).
    console.warn("Service worker registration failed", error);
    return;
  }
  if (!firstInstall) return;
  // Resolves once a worker is active, so once the app shell is precached: never, if the install
  // failed, and then nothing must be promised.
  await navigator.serviceWorker.ready;
  onOfflineReady();
}
