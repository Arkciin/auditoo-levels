import "./styles.css";

import { createRouter, RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { toast } from "sonner";

import { registerServiceWorker, requestPersistentStorage } from "./pwa";
import { routeTree } from "./routeTree.gen";

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

createRoot(rootElement).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);

void registerServiceWorker((apply) => {
  toast("Une nouvelle version de Relevé est disponible.", {
    id: "app-update",
    duration: Number.POSITIVE_INFINITY,
    action: { label: "Mettre à jour", onClick: apply },
  });
});

void requestPersistentStorage();
