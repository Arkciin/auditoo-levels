import { NAME_MAX_LENGTH } from "@repo/shared";
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { cn } from "@/lib/utils";

/**
 * Text that turns into an input when tapped: the fastest way to rename on a phone.
 * Enter or leaving the field saves, and so may its unmount (`canSaveOnUnmount`); Escape cancels;
 * an empty or unchanged value is ignored. `editing` can be driven from outside (e.g. a
 * "Renommer" menu item).
 */
export function EditableText({
  value,
  onSave,
  canSaveOnUnmount,
  label,
  editing: controlledEditing,
  onEditingChange,
  className,
  inputClassName,
}: {
  value: string;
  /** Called with the trimmed new value. May reject: the field then stays open. */
  onSave: (next: string) => Promise<void> | void;
  /**
   * Whether a value typed but not saved yet is saved when the open field goes away with its
   * screen (the back button) or its row: an unmount does not blur. Saving revives what it renames
   * and its parents (edit wins over delete): answer false once one of them is deleted. Without
   * it, the value is dropped.
   */
  canSaveOnUnmount?: () => boolean;
  /** Accessible name of the field, e.g. "Nom de la pièce". */
  label: string;
  editing?: boolean;
  onEditingChange?: (editing: boolean) => void;
  className?: string;
  inputClassName?: string;
}) {
  const [localEditing, setLocalEditing] = useState(false);
  const editing = controlledEditing ?? localEditing;
  const inputRef = useRef<HTMLInputElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const committing = useRef(false);
  const wasEditing = useRef(editing);
  const hintId = useId();
  /** What the open field holds once typed in; null while it is closed or untouched. */
  const draft = useRef<string | null>(null);
  /** The latest props, for the cleanup on unmount: its closure holds the first render's. */
  const latest = useRef({ value, onSave, canSaveOnUnmount });
  useEffect(() => {
    latest.current = { value, onSave, canSaveOnUnmount };
  });

  useEffect(
    () => () => {
      const next = draft.current?.trim();
      const { value, onSave, canSaveOnUnmount } = latest.current;
      // Saving already (Enter), or nothing worth saving, or no longer allowed to.
      if (committing.current || !next || next === value || !canSaveOnUnmount?.()) return;
      // A refusal has nobody left to fix it: the caller reports it, as it does for Enter.
      (async () => onSave(next))().catch(() => {});
    },
    [],
  );

  function setEditing(next: boolean) {
    if (!next) draft.current = null;
    setLocalEditing(next);
    onEditingChange?.(next);
  }

  useEffect(() => {
    const closed = wasEditing.current && !editing;
    wasEditing.current = editing;
    if (!editing) draft.current = null; // closed from outside too
    if (editing) {
      const input = inputRef.current;
      input?.focus();
      input?.select();
    } else if (closed) {
      // The field is gone, and the focus with it to the page body, where keyboard and screen
      // reader users lose their place: back to the name. Unless they took it elsewhere (Tab).
      const focused = document.activeElement;
      if (focused === null || focused === document.body) buttonRef.current?.focus();
    }
  }, [editing]);

  async function commit() {
    if (committing.current) return;
    const next = inputRef.current?.value.trim() ?? "";
    if (!next || next === value) {
      setEditing(false);
      return;
    }
    committing.current = true;
    try {
      await onSave(next);
      setEditing(false);
    } catch {
      inputRef.current?.focus(); // the caller reported the problem; let the user fix it
    } finally {
      committing.current = false;
    }
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        defaultValue={value}
        aria-label={label}
        maxLength={NAME_MAX_LENGTH}
        enterKeyHint="done"
        autoComplete="off"
        data-no-swipe
        className={cn(
          "h-10 w-full min-w-0 rounded-md border border-input bg-card px-2 text-base outline-offset-0",
          inputClassName,
        )}
        onChange={(event) => {
          draft.current = event.target.value;
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            void commit();
          } else if (event.key === "Escape") {
            event.preventDefault();
            setEditing(false);
          }
        }}
        onBlur={() => void commit()}
      />
    );
  }

  // Named by the text alone: a heading around it (a level, the logement) takes its name from it,
  // and must read « RDC », not « RDC, renommer ». What a tap does is its description, kept out
  // of the page, where it would add to the text of the heading or the row.
  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        data-slot="editable-text"
        className={cn("min-w-0 truncate text-left", className)}
        aria-describedby={hintId}
        onClick={() => setEditing(true)}
      >
        {value}
      </button>
      {createPortal(
        <span id={hintId} hidden>
          {RENAME_HINT}
        </span>,
        document.body,
      )}
    </>
  );
}

/** The accessible description of a name that turns into a field. */
const RENAME_HINT = "Renommer";
