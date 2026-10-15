import type { Level, Space } from "@repo/shared";

import { DatumMarker } from "@/components/datum-marker";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import { quote } from "@/features/use-safe-mutate";
import { plural } from "@/lib/suggestions";
import { selectStructure, useView } from "@/sync";
import { useHighlight } from "./highlight";
import { useMoveSpace } from "./use-move";

/**
 * « Déplacer vers… »: the other levels of the logement, and the room goes to the end of the one
 * picked. The way to move a room without dragging it: keyboard, screen reader, one thumb.
 */
export function MoveSpaceDrawer({
  propertyId,
  space,
  open,
  onOpenChange,
}: {
  propertyId: string;
  /** The room to move; kept while the sheet closes. */
  space: Space | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const structure = useView((view) => selectStructure(view, propertyId));
  const moveSpace = useMoveSpace(propertyId);
  const highlight = useHighlight();
  // From the room as it was when the sheet opened, so that the list holds still as it closes.
  const origin = structure.find((group) => group.level.id === space?.levelId)?.level;
  const targets = structure.filter((group) => group.level.id !== space?.levelId);

  async function moveTo(level: Level) {
    if (!space) return;
    // Centred: at the bottom of the screen, the undo toast would cover it.
    if (await moveSpace(space, level)) highlight(space.id, { reveal: "center" });
  }

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent
        onCloseAutoFocus={(event) => {
          // Back to the room's menu button, wherever the room now is (its row may be new).
          const trigger = document.querySelector<HTMLElement>(
            `[data-highlight-id="${space?.id}"] [data-slot="dropdown-menu-trigger"]`,
          );
          if (!trigger) return;
          event.preventDefault();
          trigger.focus({ preventScroll: true });
        }}
      >
        <DrawerHeader>
          <DrawerTitle>Déplacer {quote(space?.name ?? "la pièce")}</DrawerTitle>
          <DrawerDescription>
            {origin ? `Actuellement au niveau ${quote(origin.name)}. ` : null}
            Elle ira à la fin du niveau choisi.
          </DrawerDescription>
        </DrawerHeader>
        <ul aria-label="Niveaux" className="max-h-[50dvh] overflow-y-auto px-4 pb-4">
          {targets.map(({ level, spaces }) => {
            const rooms = plural(spaces.length, "pièce", "pièces");
            return (
              <li key={level.id}>
                <button
                  type="button"
                  aria-label={`${level.name}, ${rooms}`}
                  className="flex h-14 w-full items-center gap-3 border-b border-rule px-2 text-left active:bg-muted"
                  onClick={() => {
                    onOpenChange(false);
                    void moveTo(level);
                  }}
                >
                  <DatumMarker />
                  <span className="min-w-0 flex-1 truncate text-lg font-bold">{level.name}</span>
                  <span className="shrink-0 text-sm text-muted-foreground tabular-nums">
                    {rooms}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </DrawerContent>
    </Drawer>
  );
}
