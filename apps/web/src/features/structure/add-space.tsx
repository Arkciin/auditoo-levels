import { type Level, NAME_MAX_LENGTH, newId, positionAtEnd, type Space } from "@repo/shared";
import { Plus } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useSafeMutate } from "@/features/use-safe-mutate";
import { haptic } from "@/lib/haptics";
import { keepInSight } from "@/lib/keep-in-sight";
import { nextSpaceName, suggestSpaceNames, typedSpaceName } from "@/lib/suggestions";
import { selectStructure, useSyncClient } from "@/sync";
import { useHighlight } from "./highlight";

/**
 * Rapid room entry at the end of a level: type and press Enter to chain rooms, or tap a
 * suggestion ("Chambre", tapped or typed, becomes "Chambre 3" when two bedrooms already exist).
 */
export function AddSpace({
  propertyId,
  level,
  spaces,
  open,
  onOpenChange,
}: {
  propertyId: string;
  level: Level;
  spaces: readonly Space[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const client = useSyncClient();
  const safeMutate = useSafeMutate();
  const highlight = useHighlight();
  const [draft, setDraft] = useState("");
  const [typing, setTyping] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const entryRef = useRef<HTMLDivElement>(null);
  const spacerRef = useRef<HTMLDivElement>(null);
  const reopenRef = useRef<HTMLButtonElement>(null);
  /** The entry closed with the focus in it (see `close`): « Ajouter une pièce » takes it. */
  const refocus = useRef(false);
  useEffect(() => {
    if (open || !refocus.current) return;
    refocus.current = false;
    reopenRef.current?.focus();
  }, [open]);
  /**
   * Where the entry was on screen when suggestions were tapped, and the rooms they add that are
   * not drawn yet: each one pushes the chips down a row, under a thumb about to tap again.
   */
  const anchor = useRef<{ top: number; ids: Set<string> } | null>(null);

  // The field stays within reach: each room typed pushes it down a row, and the keyboard covers
  // what lies under it.
  const keepEntryInSight = useCallback(() => {
    requestAnimationFrame(() => {
      if (entryRef.current) keepInSight(entryRef.current);
    });
  }, []);
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!typing || !viewport) return;
    viewport.addEventListener("resize", keepEntryInSight);
    return () => viewport.removeEventListener("resize", keepEntryInSight);
  }, [typing, keepEntryInSight]);

  // Rooms added from the chips are drawn above them: the page scrolls by as much as they pushed
  // the entry, before the browser paints, so that the chips stay under the thumb (four quick taps
  // on « Chambre » make four bedrooms, not one and a tap on whatever slid under the finger).
  // Typed rooms move the field instead: the thumb is on the keyboard, and the level's name above
  // stays in sight.
  useLayoutEffect(() => {
    const pending = anchor.current;
    if (!pending) return;
    const entry = entryRef.current;
    if (!entry) {
      anchor.current = null; // closed
      return;
    }
    let arrived = false;
    for (const space of spaces) arrived = pending.ids.delete(space.id) || arrived;
    if (!arrived) return;
    if (pending.ids.size === 0) anchor.current = null;
    const moved = entry.getBoundingClientRect().top - pending.top;
    if (moved === 0) return;
    // A short page cannot scroll that far: lengthen it, at its very end, while the entry is open.
    const page = document.documentElement;
    const target = window.scrollY + moved;
    const spacer = spacerRef.current;
    if (spacer && page.scrollHeight - page.clientHeight < target) {
      const spacerTop = spacer.getBoundingClientRect().top + window.scrollY;
      const height = Math.max(spacer.offsetHeight, target + page.clientHeight - spacerTop);
      spacer.style.height = `${height}px`;
    }
    window.scrollBy({ top: moved, behavior: "instant" });
  }, [spaces]);

  // Adds run one after the other so that each one sees the rooms added just before it.
  const queue = useRef<Promise<void>>(Promise.resolve());
  const suggestions = useMemo(
    () =>
      suggestSpaceNames(
        level.name,
        spaces.map((space) => space.name),
      ),
    [level.name, spaces],
  );

  /** Adds the room typed in the field, if any, and empties the field. */
  function addTyped() {
    const name = draft.trim();
    if (!name) return;
    setDraft("");
    add((names) => typedSpaceName(name, names), { tapped: false });
  }

  function add(
    nameFor: (propertySpaceNames: readonly string[]) => string,
    { tapped }: { tapped: boolean },
  ) {
    // The id now, so that the entry knows the room when it is drawn (see the layout effect).
    const id = newId();
    const entry = entryRef.current;
    if (tapped && entry) {
      anchor.current ??= { top: entry.getBoundingClientRect().top, ids: new Set() };
      anchor.current.ids.add(id);
    }
    queue.current = queue.current.then(async () => {
      // The freshest state, not the last render: several taps can land before React re-renders.
      const structure = selectStructure(client.getState().view, propertyId);
      const siblings = structure.find((group) => group.level.id === level.id)?.spaces ?? [];
      const names = structure.flatMap((group) => group.spaces.map((space) => space.name));
      const saved = await safeMutate("createSpace", {
        id,
        levelId: level.id,
        name: nameFor(names),
        position: positionAtEnd(siblings),
      });
      if (!saved) {
        anchor.current?.ids.delete(id);
        if (anchor.current?.ids.size === 0) anchor.current = null;
        return;
      }
      haptic(6);
      highlight(id);
      if (!tapped) keepEntryInSight();
    });
  }

  /** Closes the entry; the focus goes to the button that takes its place, not to the page body. */
  function close() {
    const focused = document.activeElement;
    refocus.current =
      focused === null || focused === document.body || !!entryRef.current?.contains(focused);
    onOpenChange(false);
  }

  if (!open) {
    return (
      <button
        ref={reopenRef}
        type="button"
        data-add-space="button"
        onClick={() => onOpenChange(true)}
        className="flex h-12 w-full items-center gap-2 pl-10 font-semibold text-primary"
      >
        <Plus aria-hidden="true" className="size-5" />
        Ajouter une pièce
      </button>
    );
  }

  return (
    <>
      <div ref={entryRef} className="flex flex-col gap-2 pt-2 pr-2 pb-3 pl-10">
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            addTyped();
            inputRef.current?.focus();
          }}
        >
          <Input
            ref={inputRef}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") close();
            }}
            onFocus={() => {
              setTyping(true);
              keepEntryInSight();
            }}
            onBlur={() => setTyping(false)}
            aria-label={`Nouvelle pièce au niveau ${level.name}`}
            placeholder="Nom de la pièce"
            autoComplete="off"
            enterKeyHint="send"
            maxLength={NAME_MAX_LENGTH}
            data-no-swipe
            data-add-space="field"
            autoFocus
          />
          <Button
            type="submit"
            size="icon"
            aria-label="Ajouter la pièce"
            disabled={!draft.trim()}
            onPointerDown={keepFieldFocused}
            onMouseDown={keepFieldFocused}
          >
            <Plus />
          </Button>
        </form>
        <fieldset className="-mr-2 flex min-w-0 gap-2 overflow-x-auto pr-2 pb-1 [scrollbar-width:none]">
          <legend className="sr-only">Suggestions de pièces</legend>
          {suggestions.map((suggestion) => (
            <button
              key={suggestion}
              type="button"
              className="relative h-9 shrink-0 rounded-full border border-input bg-card px-3.5 text-sm font-semibold transition-colors after:absolute after:inset-x-0 after:-inset-y-1 active:bg-muted"
              onPointerDown={keepFieldFocused}
              onMouseDown={keepFieldFocused}
              onClick={() => add((names) => nextSpaceName(suggestion, names), { tapped: true })}
            >
              {suggestion}
            </button>
          ))}
        </fieldset>
        {/* The last room is often typed, then « Terminé » tapped instead of Enter: keep it. */}
        <Button
          variant="ghost"
          size="sm"
          className="self-start"
          onClick={() => {
            addTyped();
            close();
          }}
        >
          Terminé
        </Button>
      </div>
      {/* Lets a short page scroll as far as rooms push the entry down (see the layout effect):
          at the end of the document, out of sight, rather than as a gap under the entry. */}
      {createPortal(<div ref={spacerRef} aria-hidden="true" />, document.body)}
    </>
  );
}

/**
 * Leaves the focus in the room field when a chip or the add button is pressed: on a phone, a
 * field that loses it takes the keyboard down, and the page jumps under the thumb. Keyboard use
 * is unaffected: it sends no pointer or mouse down.
 */
function keepFieldFocused(event: React.PointerEvent | React.MouseEvent) {
  event.preventDefault();
}
