import { NavigationRoute, type PrecacheEntry, Serwist, type SerwistGlobalConfig } from "serwist";

declare global {
  interface WorkerGlobalScope extends SerwistGlobalConfig {
    /** Replaced at build time by @serwist/vite with the list of files to precache. */
    __SW_MANIFEST: (PrecacheEntry | string)[] | undefined;
  }
}

declare const self: ServiceWorkerGlobalScope;

const serwist = new Serwist({
  // The whole app shell (HTML, JS, CSS, fonts, icons, manifest), versioned by the build.
  precacheEntries: self.__SW_MANIFEST,
  // "Prompt" update strategy: a new version stays waiting until the UI applies it. With
  // `skipWaiting: false`, Serwist activates on a `{ type: "SKIP_WAITING" }` message, which
  // `messageSkipWaiting()` from @serwist/window sends (see src/pwa.ts).
  skipWaiting: false,
  // The first install takes control of the open page right away, so it works offline without
  // a reload. On updates this only happens once the UI has sent SKIP_WAITING.
  clientsClaim: true,
  // Off on purpose: every navigation is answered from the precache (app shell below), so a
  // preload request would hit the network on each launch only to be discarded.
  navigationPreload: false,
  // No runtime caching: /api/* always goes to the network. Data lives in IndexedDB and is
  // owned by the sync engine, never by HTTP caches.
});

// App shell: every navigation is answered with the precached index.html (the router then
// renders the right screen), so reloading or opening a deep link with no network still shows
// the app. Navigations to the API are left to the network.
serwist.registerRoute(
  new NavigationRoute(serwist.createHandlerBoundToUrl("/index.html"), {
    denylist: [/^\/api(?:\/|$)/],
  }),
);

serwist.addEventListeners();
