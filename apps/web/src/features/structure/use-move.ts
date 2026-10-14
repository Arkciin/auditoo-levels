import { type Level, positionAtEnd, positionAtIndex, type Space } from "@repo/shared";
import { useCallback } from "react";

import { quote, toastUndo, useSafeMutate } from "@/features/use-safe-mutate";
import { haptic } from "@/lib/haptics";
import { selectStructure, useSyncClient } from "@/sync";

/**
 * Moves a room (a drop, « Déplacer vers… ») to `index` among the other rooms of `target`, or to
 * its end, then offers to undo: the room goes back to its level, at its index there. Resolves to
 * whether it moved.
 */
export function useMoveSpace(propertyId: string) {
  const client = useSyncClient();
  const safeMutate = useSafeMutate();
  return useCallback(
    async (space: Space, target: Level, index?: number): Promise<boolean> => {
      // The freshest state, not the last render, here and on undo: other changes may land.
      const structure = () => selectStructure(client.getState().view, propertyId);
      /** The rooms of a level, in order, without the one moving. */
      const siblings = (levelId: string) =>
        (structure().find((group) => group.level.id === levelId)?.spaces ?? []).filter(
          (sibling) => sibling.id !== space.id,
        );
      const origin = structure().find((group) => group.spaces.some((s) => s.id === space.id));
      const from = origin?.level.id ?? space.levelId;
      const fromIndex = origin?.spaces.findIndex((sibling) => sibling.id === space.id) ?? -1;

      const others = siblings(target.id);
      const position = index === undefined ? positionAtEnd(others) : positionAtIndex(others, index);
      if (!(await safeMutate("moveSpace", { id: space.id, levelId: target.id, position }))) {
        return false;
      }
      haptic(8);
      const where = target.id === from ? "" : ` vers ${quote(target.name)}`;
      toastUndo(`Pièce ${quote(space.name)} déplacée${where}`, () => {
        const back = siblings(from);
        const at = fromIndex < 0 ? back.length : Math.min(fromIndex, back.length);
        void safeMutate("moveSpace", {
          id: space.id,
          levelId: from,
          position: positionAtIndex(back, at),
        });
      });
      return true;
    },
    [client, propertyId, safeMutate],
  );
}

/**
 * Moves a level to `index` among the other levels, then offers to undo: it goes back to its
 * index. Resolves to whether it moved.
 */
export function useMoveLevel(propertyId: string) {
  const client = useSyncClient();
  const safeMutate = useSafeMutate();
  return useCallback(
    async (level: Level, index: number): Promise<boolean> => {
      // The freshest state, not the last render, here and on undo.
      const levels = () =>
        selectStructure(client.getState().view, propertyId).map((group) => group.level);
      const others = () => levels().filter((other) => other.id !== level.id);
      const fromIndex = levels().findIndex((other) => other.id === level.id);

      const position = positionAtIndex(others(), index);
      if (!(await safeMutate("moveLevel", { id: level.id, position }))) return false;
      haptic(8);
      toastUndo(`Niveau ${quote(level.name)} déplacé`, () => {
        const back = others();
        const at = fromIndex < 0 ? back.length : Math.min(fromIndex, back.length);
        void safeMutate("moveLevel", { id: level.id, position: positionAtIndex(back, at) });
      });
      return true;
    },
    [client, propertyId, safeMutate],
  );
}
