import type { Snapshot } from "@repo/shared";
import { useCallback, useId, useState } from "react";

import { DeletedRow, deletedDetails, NothingDeleted } from "@/components/deleted-row";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
  useHeldWhileClosing,
} from "@/components/ui/drawer";
import { quote, toastRestored, useSafeMutate } from "@/features/use-safe-mutate";
import { plural } from "@/lib/suggestions";
import { useView } from "@/sync";
import { type DeletedLevel, type DeletedSpace, selectDeletedStructure } from "@/sync/selectors";

/**
 * « Éléments supprimés »: the way back to a logement's deleted levels and rooms once the undo toast
 * is gone. Deleting a level leaves its rooms as they were, hidden with it: restoring it brings
 * them back, and only the rooms of levels still there are listed on their own.
 */
export function DeletedItemsSheet({
  propertyId,
  open,
  onOpenChange,
}: {
  propertyId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle>Éléments supprimés</DrawerTitle>
          <DrawerDescription>Un niveau restauré revient avec ses pièces.</DrawerDescription>
        </DrawerHeader>
        <DeletedItems propertyId={propertyId} open={open} onRestore={() => onOpenChange(false)} />
      </DrawerContent>
    </Drawer>
  );
}

// Mounted while the sheet is open (or closing) only: it reads the data and the time then.
function DeletedItems({
  propertyId,
  open,
  onRestore,
}: {
  propertyId: string;
  open: boolean;
  onRestore: () => void;
}) {
  const selectDeleted = useCallback(
    (view: Snapshot) => selectDeletedStructure(view, propertyId),
    [propertyId],
  );
  const { levels, spaces } = useHeldWhileClosing(useView(selectDeleted), open);
  const [now] = useState(Date.now);
  const safeMutate = useSafeMutate();
  const levelsTitle = useId();
  const spacesTitle = useId();

  async function restoreLevel({ level, spaceCount }: DeletedLevel) {
    onRestore();
    if (await safeMutate("restoreLevel", { id: level.id })) {
      toastRestored(`Niveau ${quote(level.name)} restauré${withRooms(spaceCount)}`, level.id);
    }
  }

  async function restoreSpace({ space }: DeletedSpace) {
    onRestore();
    if (await safeMutate("restoreSpace", { id: space.id })) {
      toastRestored(`Pièce ${quote(space.name)} restaurée`, space.id);
    }
  }

  if (levels.length === 0 && spaces.length === 0) {
    return <NothingDeleted>Aucun élément supprimé</NothingDeleted>;
  }
  return (
    <div className="flex min-h-0 flex-col gap-5 overflow-y-auto px-4 pb-4">
      {levels.length > 0 ? (
        <section aria-labelledby={levelsTitle}>
          <h3 id={levelsTitle} className="border-b border-rule pb-1 text-sm font-semibold">
            Niveaux
          </h3>
          <ul>
            {levels.map((entry) => (
              <DeletedRow
                key={entry.level.id}
                name={entry.level.name}
                details={deletedDetails(rooms(entry.spaceCount), "supprimé", entry.deletedAt, now)}
                label={`Restaurer le niveau ${entry.level.name}`}
                onRestore={() => void restoreLevel(entry)}
              />
            ))}
          </ul>
        </section>
      ) : null}
      {spaces.length > 0 ? (
        <section aria-labelledby={spacesTitle}>
          <h3 id={spacesTitle} className="border-b border-rule pb-1 text-sm font-semibold">
            Pièces
          </h3>
          <ul>
            {spaces.map((entry) => (
              <DeletedRow
                key={entry.space.id}
                name={entry.space.name}
                details={deletedDetails(
                  `Niveau ${entry.level.name}`,
                  "supprimée",
                  entry.deletedAt,
                  now,
                )}
                label={`Restaurer la pièce ${entry.space.name}`}
                onRestore={() => void restoreSpace(entry)}
              />
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

/** The rooms a deleted level hides: « 3 pièces », « 1 pièce », « Aucune pièce ». */
function rooms(count: number): string {
  return count === 0 ? "Aucune pièce" : plural(count, "pièce", "pièces");
}

/** « avec ses 3 pièces », « avec sa pièce », or nothing, as the toast of its deletion said. */
function withRooms(count: number): string {
  if (count === 0) return "";
  return count === 1 ? " avec sa pièce" : ` avec ses ${count} pièces`;
}
