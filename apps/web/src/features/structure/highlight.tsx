/**
 * Draws the eye to a level or room that just appeared or moved (a copy, a room moved to another
 * level, a room just added): a brief tint, and for items possibly out of sight, a scroll to them.
 */
import {
  createContext,
  type ReactNode,
  use,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { cn } from "@/lib/utils";

/** How long an item stays tinted before fading out. */
const HIGHLIGHT_MS = 1600;

interface Highlight {
  readonly highlightedId: string | null;
  /**
   * Tints the level or room `id` (which carries `data-highlight-id`) for a moment. With `reveal`,
   * also scrolls it into view (aligned as `scrollIntoView`'s `block`), once rendered: it may have
   * just been created.
   */
  readonly highlight: (id: string, options?: { reveal?: ScrollLogicalPosition }) => void;
}

const HighlightContext = createContext<Highlight>({ highlightedId: null, highlight: () => {} });

export function HighlightProvider({ children }: { children: ReactNode }) {
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const timer = useRef<number | undefined>(undefined);

  const highlight = useCallback<Highlight["highlight"]>((id, { reveal } = {}) => {
    setHighlightedId(id);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setHighlightedId(null), HIGHLIGHT_MS);
    if (reveal === undefined) return;
    requestAnimationFrame(() => {
      document
        .querySelector(`[data-highlight-id="${id}"]`)
        ?.scrollIntoView({ block: reveal, behavior: scrollBehavior() });
    });
  }, []);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const value = useMemo(() => ({ highlightedId, highlight }), [highlightedId, highlight]);
  return <HighlightContext value={value}>{children}</HighlightContext>;
}

export function useHighlight(): Highlight["highlight"] {
  return use(HighlightContext).highlight;
}

/**
 * The tint, over its positioned parent. It fades out slowly; with reduced motion it simply goes
 * (styles.css shortens every transition), after the same delay.
 */
export function HighlightTint({ id, className }: { id: string; className?: string }) {
  const active = use(HighlightContext).highlightedId === id;
  return (
    <span
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute inset-0 bg-accent/15 transition-opacity",
        active ? "opacity-100 duration-150" : "opacity-0 duration-1000",
        className,
      )}
    />
  );
}

/** Smooth scrolling, unless the user asked for reduced motion. */
export function scrollBehavior(): ScrollBehavior {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
}
