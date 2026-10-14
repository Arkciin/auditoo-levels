import { type Level, newId, positionAtEnd, type Space } from "@repo/shared";
import { Plus } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useSafeMutate } from "@/features/use-safe-mutate";
import { haptic } from "@/lib/haptics";
import { keepInSight } from "@/lib/keep-in-sight";
import { nextSpaceName, suggestSpaceNames } from "@/lib/suggestions";
import { selectStructure, useSyncClient } from "@/sync";
import { useHighlight } from "./highlight";

/**
 * Rapid room entry at the end of a level: type and press Enter to chain rooms, or tap a
 * suggestion ("Chambre" becomes "Chambre 3" when two bedrooms already exist).
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

  // The field and its suggestions stay within reach: each new room pushes them down a row, and
  // the keyboard covers what lies under the field.
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
    add(() => name);
  }

  function add(nameFor: (propertySpaceNames: readonly string[]) => string) {
    queue.current = queue.current.then(async () => {
      // The freshest state, not the last render: several taps can land before React re-renders.
      const structure = selectStructure(client.getState().view, propertyId);
      const siblings = structure.find((group) => group.level.id === level.id)?.spaces ?? [];
      const names = structure.flatMap((group) => group.spaces.map((space) => space.name));
      const id = newId();
      const saved = await safeMutate("createSpace", {
        id,
        levelId: level.id,
        name: nameFor(names),
        position: positionAtEnd(siblings),
      });
      if (!saved) return;
      haptic(6);
      highlight(id);
      keepEntryInSight();
    });
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => onOpenChange(true)}
        className="flex h-12 w-full items-center gap-2 pl-10 font-semibold text-primary"
      >
        <Plus aria-hidden="true" className="size-5" />
        Ajouter une pièce
      </button>
    );
  }

  return (
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
            if (event.key === "Escape") onOpenChange(false);
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
          maxLength={80}
          data-no-swipe
          autoFocus
        />
        <Button type="submit" size="icon" aria-label="Ajouter la pièce" disabled={!draft.trim()}>
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
            onClick={() => add((names) => nextSpaceName(suggestion, names))}
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
          onOpenChange(false);
        }}
      >
        Terminé
      </Button>
    </div>
  );
}
