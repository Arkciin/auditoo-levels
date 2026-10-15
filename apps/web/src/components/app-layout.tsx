import { type ReactNode, type Ref, useEffect, useState } from "react";

import { OfflineBanner } from "@/features/sync-status/offline-banner";
import { SyncIndicator } from "@/features/sync-status/sync-indicator";
import { cn } from "@/lib/utils";

/** Sticky top bar: optional back button, a title, actions, and the sync status on the right. */
export function AppHeader({
  ref,
  leading,
  title,
  actions,
}: {
  ref?: Ref<HTMLElement>;
  leading?: ReactNode;
  title: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header ref={ref} className="sticky top-0 z-20 bg-background pt-safe">
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

/**
 * A large title at the top of a screen's body, as on iOS, for names too long for the header: the
 * header shows a compact copy of it only once the large one has scrolled under it.
 *
 * ```tsx
 * const { headerRef, titleRef, titleUnderHeader } = useLargeTitle();
 * <AppHeader ref={headerRef} title={<CompactTitle shown={titleUnderHeader}>{name}</CompactTitle>} />
 * <ScreenBody><h1 ref={titleRef}>{name}</h1>…</ScreenBody>
 * ```
 */
export function useLargeTitle() {
  // Elements in state (callback refs): a screen may render its title later, once it has its data.
  const [header, headerRef] = useState<HTMLElement | null>(null);
  const [title, titleRef] = useState<HTMLHeadingElement | null>(null);
  const [titleUnderHeader, setTitleUnderHeader] = useState(false);

  useEffect(() => {
    if (!header || !title) return;
    let titleObserver: IntersectionObserver | undefined;
    // The title is out of sight once it has left the part of the viewport below the header, whose
    // height varies (safe area, offline banner): measured again whenever it changes.
    const watchTitle = () => {
      titleObserver?.disconnect();
      titleObserver = new IntersectionObserver(
        ([entry]) => {
          if (!entry) return;
          const top = entry.rootBounds?.top ?? 0;
          setTitleUnderHeader(!entry.isIntersecting && entry.boundingClientRect.top < top);
        },
        { rootMargin: `-${header.offsetHeight}px 0px 0px 0px` },
      );
      titleObserver.observe(title);
    };
    const headerObserver = new ResizeObserver(watchTitle);
    headerObserver.observe(header);
    return () => {
      headerObserver.disconnect();
      titleObserver?.disconnect();
    };
  }, [header, title]);

  return { headerRef, titleRef, titleUnderHeader };
}

/**
 * The header's copy of a large title, shown once the large one is out of sight. Hidden from
 * assistive technologies, which have the large title, the screen's heading, wherever it scrolled.
 */
export function CompactTitle({ shown, children }: { shown: boolean; children: ReactNode }) {
  return (
    <p
      aria-hidden="true"
      className={cn(
        "min-w-0 flex-1 truncate text-lg font-bold transition-opacity duration-150",
        shown ? "opacity-100" : "opacity-0",
      )}
    >
      {children}
    </p>
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
