import { useState } from "react";

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
import { levelsAndRooms } from "@/lib/suggestions";
import { useView } from "@/sync";
import { type DeletedPropertySummary, selectDeletedProperties } from "@/sync/selectors";

/**
 * « Logements supprimés »: the way back once the undo toast is gone. Deletes are soft and leave a
 * logement's levels and rooms as they were, so a restored logement comes back whole.
 */
export function DeletedPropertiesSheet({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle>Logements supprimés</DrawerTitle>
          <DrawerDescription>
            Un logement restauré revient avec ses niveaux et ses pièces.
          </DrawerDescription>
        </DrawerHeader>
        <DeletedProperties open={open} onRestore={() => onOpenChange(false)} />
      </DrawerContent>
    </Drawer>
  );
}

// Mounted while the sheet is open (or closing) only: it reads the data and the time then.
function DeletedProperties({ open, onRestore }: { open: boolean; onRestore: () => void }) {
  const deleted = useHeldWhileClosing(useView(selectDeletedProperties), open);
  const [now] = useState(Date.now);
  const safeMutate = useSafeMutate();

  async function restore({ property }: DeletedPropertySummary) {
    onRestore();
    if (await safeMutate("restoreProperty", { id: property.id })) {
      toastRestored(`Logement ${quote(property.name)} restauré`, property.id);
    }
  }

  if (deleted.length === 0) return <NothingDeleted>Aucun logement supprimé</NothingDeleted>;
  return (
    <ul className="min-h-0 overflow-y-auto px-4 pb-4">
      {deleted.map((entry) => (
        <DeletedRow
          key={entry.property.id}
          name={entry.property.name}
          details={deletedDetails(
            levelsAndRooms(entry.levelCount, entry.spaceCount),
            "supprimé",
            entry.deletedAt,
            now,
          )}
          label={`Restaurer le logement ${entry.property.name}`}
          onRestore={() => void restore(entry)}
        />
      ))}
    </ul>
  );
}
