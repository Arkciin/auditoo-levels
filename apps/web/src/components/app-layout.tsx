import type { ReactNode } from "react";

import { OfflineBanner } from "@/features/sync-status/offline-banner";
import { SyncIndicator } from "@/features/sync-status/sync-indicator";
import { cn } from "@/lib/utils";

/** Sticky top bar: optional back button, a title, actions, and the sync status on the right. */
export function AppHeader({
  leading,
  title,
  actions,
}: {
  leading?: ReactNode;
  title: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="sticky top-0 z-20 bg-background pt-safe">
      <div className="flex h-14 items-center gap-1 border-b border-rule pr-2 pl-1">
        {leading}
        <div className={cn("flex min-w-0 flex-1 items-center", leading ? "" : "pl-3")}>{title}</div>
        {actions}
        <SyncIndicator />
      </div>
      <OfflineBanner />
    </header>
  );
}

/** Bottom bar in the thumb zone for the screen's main action, clear of the home indicator. */
export function ActionBar({ children }: { children: ReactNode }) {
  return (
    <div className="fixed inset-x-0 bottom-0 z-20 border-t border-rule bg-background pb-safe">
      <div className="mx-auto flex h-action-bar max-w-app items-center gap-3 px-4">{children}</div>
    </div>
  );
}

/** Page body leaving room for the action bar. */
export function ScreenBody({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <main
      className={cn(
        "flex-1 pb-[calc(var(--action-bar-height)+env(safe-area-inset-bottom)+1.5rem)]",
        className,
      )}
    >
      {children}
    </main>
  );
}
