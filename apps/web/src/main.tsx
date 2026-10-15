import "./styles.css";

import { createRouter, RouterProvider } from "@tanstack/react-router";
import { StrictMode, startTransition } from "react";
import { createRoot } from "react-dom/client";
import { toast } from "sonner";

import { StorageUnavailable } from "./components/storage-unavailable";
import { captureInstallPrompt } from "./install";
import { markDocumentStart } from "./lib/document-history";
import { registerServiceWorker } from "./pwa";
import { routeTree } from "./routeTree.gen";
import { createBrowserSyncClient, SyncProvider } from "./sync";

// Before anything is awaited: the browser offers installation once, possibly very early.
captureInstallPrompt();

markDocumentStart();
const router = createRouter({
  routeTree,
  defaultPreload: "intent",
  scrollRestoration: true,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("Missing #root element in index.html");
const root = createRoot(rootElement);

// The local database is the app's source of truth: open it before the first render, so screens
// render the device's data right away (no loading state, even offline).
try {
  const client = await createBrowserSyncClient();
  // As a transition, the first render runs in short slices that let the browser breathe in
  // between, rather than as one long task: on a slow phone, a tap during startup is not held up.
  startTransition(() => {
    root.render(
      <StrictMode>
        <SyncProvider client={client}>
          <RouterProvider router={router} />
        </SyncProvider>
      </StrictMode>,
    );
  });
} catch (error) {
  console.error(error);
  root.render(<StorageUnavailable />);
}

void registerServiceWorker({
  onUpdateReady: (apply) => {
    toast("Une nouvelle version de Relevé est disponible.", {
      id: "app-update",
      duration: Number.POSITIVE_INFINITY,
      action: { label: "Mettre à jour", onClick: apply },
    });
  },
  onOfflineReady: () => {
    toast.success("Relevé fonctionne maintenant sans réseau.", { id: "offline-ready" });
  },
});
