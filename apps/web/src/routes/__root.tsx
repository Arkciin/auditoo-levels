import {
  createRootRoute,
  type ErrorComponentProps,
  Link,
  Outlet,
  useRouter,
} from "@tanstack/react-router";
import type * as React from "react";

import { Button } from "@/components/ui/button";
import { Toaster } from "@/components/ui/sonner";
import { RejectionToasts } from "@/features/sync-status/rejection-toasts";

export const Route = createRootRoute({
  component: RootLayout,
  notFoundComponent: NotFound,
  errorComponent: RootError,
});

/** The app column: mobile-first, centred on larger screens, clear of landscape notches. */
// `overflow-x-clip` (unlike `hidden`) keeps sticky headers working: a safety net, since any
// horizontal overflow makes mobile browsers zoom out the whole page.
const appColumn = "mx-auto flex min-h-dvh w-full max-w-app flex-col overflow-x-clip px-safe";

function RootLayout() {
  return (
    <>
      <div className={appColumn}>
        <Outlet />
      </div>
      <Toaster />
      <RejectionToasts />
    </>
  );
}

// Rendered inside RootLayout's <Outlet /> for any URL that matches no route.
function NotFound() {
  return (
    <StatusScreen
      title="Page introuvable"
      description="Cette adresse ne correspond à aucun écran de Relevé."
    >
      <Button asChild size="lg">
        <Link to="/">Retour aux logements</Link>
      </Button>
    </StatusScreen>
  );
}

// Replaces the whole shell (errors bubble up to the root route), so it brings its own column.
function RootError({ error }: ErrorComponentProps) {
  const router = useRouter();

  return (
    <div className={appColumn}>
      <StatusScreen
        title="Une erreur est survenue"
        description="Relevé n’a pas pu afficher cet écran. Réessayez, ou revenez à la liste des logements."
        detail={import.meta.env.DEV ? String(error) : undefined}
      >
        <Button size="lg" onClick={() => void router.invalidate()}>
          Réessayer
        </Button>
        <Button asChild size="lg" variant="outline">
          {/* Full reload: the surest way out of an unexpected state. */}
          <Link to="/" reloadDocument>
            Retour aux logements
          </Link>
        </Button>
      </StatusScreen>
    </div>
  );
}

function StatusScreen({
  title,
  description,
  detail,
  children,
}: {
  title: string;
  description: string;
  detail?: string | undefined;
  children: React.ReactNode;
}) {
  return (
    <main className="flex flex-1 flex-col justify-center gap-8 px-4 py-10">
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-bold">{title}</h1>
        <p className="text-muted-foreground">{description}</p>
        {detail ? <p className="text-sm break-words text-muted-foreground">{detail}</p> : null}
      </div>
      <div className="flex flex-col gap-3">{children}</div>
    </main>
  );
}
