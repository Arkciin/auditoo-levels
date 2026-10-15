/**
 * Which entries of the browser's history this document added. A reload keeps the history, and
 * the router numbers its entries on from the index stored there (`__TSR_index`): an entry before
 * the one the document was loaded at belongs to an earlier document, and going back to it loads
 * the app again, losing what only lives in memory, such as an undo toast.
 */

/** The router's index of the entry this document was loaded at (0 on a first visit). */
let firstIndex = 0;

/** Call once at startup, before the router reads or writes the history. */
export function markDocumentStart(): void {
  const state: unknown = window.history.state;
  const index =
    typeof state === "object" && state !== null && "__TSR_index" in state
      ? state.__TSR_index
      : undefined;
  firstIndex = typeof index === "number" ? index : 0;
}

/** Whether the entry before the one at `index` (the router's `__TSR_index`) is this document's. */
export function previousEntryInDocument(index: number): boolean {
  return index > firstIndex;
}
