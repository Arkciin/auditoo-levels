import {
  type MutationArgs,
  newId,
  type Positioned,
  positionAtEnd,
  positionAtIndex,
} from "@repo/shared";
import { useCallback } from "react";

import { useSafeMutate } from "@/features/use-safe-mutate";
import { duplicateLevelIndex, duplicateLevelName, duplicateSpaceNames } from "@/lib/suggestions";
import { type LevelStructure, selectStructure, useSyncClient } from "@/sync";

export type LevelCopy = MutationArgs<"duplicateLevel">;

/**
 * The copy of a level as the device shows it: named as the next floor or as a copy, placed where
 * it belongs, its rooms in the same order with bedrooms renumbered. `undefined` when the level is
 * not in `structure`.
 */
export function planDuplicate(
  structure: readonly LevelStructure[],
  sourceId: string,
  createId: () => string = newId,
): LevelCopy | undefined {
  const sourceIndex = structure.findIndex((group) => group.level.id === sourceId);
  const source = structure[sourceIndex];
  if (!source) return undefined;
  const levels = structure.map((group) => group.level);
  const name = duplicateLevelName(
    source.level.name,
    levels.map((level) => level.name),
  );
  const position = positionAtIndex(levels, duplicateLevelIndex(levels, sourceIndex, name));
  const names = duplicateSpaceNames(
    source.spaces.map((space) => space.name),
    structure.flatMap((group) => group.spaces.map((space) => space.name)),
  );
  const spaces: (Positioned & { name: string })[] = [];
  for (const spaceName of names) {
    spaces.push({ id: createId(), name: spaceName, position: positionAtEnd(spaces) });
  }
  return { id: createId(), sourceId, name, position, spaces };
}

/**
 * Duplicates a level with its rooms, in one mutation. Resolves to the copy, or null when it could
 * not be saved (the user has been told why).
 */
export function useDuplicateLevel(propertyId: string) {
  const client = useSyncClient();
  const safeMutate = useSafeMutate();
  return useCallback(
    async (sourceId: string): Promise<LevelCopy | null> => {
      // Read the freshest state rather than the last render: taps can outpace React.
      const copy = planDuplicate(selectStructure(client.getState().view, propertyId), sourceId);
      if (!copy) return null;
      return (await safeMutate("duplicateLevel", copy)) ? copy : null;
    },
    [client, propertyId, safeMutate],
  );
}
