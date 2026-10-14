import { newId, positionAtIndex } from "@repo/shared";
import { useCallback } from "react";

import { useSafeMutate } from "@/features/use-safe-mutate";
import { levelInsertIndex } from "@/lib/suggestions";
import { selectStructure, useSyncClient } from "@/sync";

/**
 * Adds a level where it naturally belongs ("Sous-sol" below "RDC", "R+2" above "R+1").
 * Resolves to the new level's id, or null when it could not be saved.
 */
export function useAddLevel(propertyId: string) {
  const client = useSyncClient();
  const safeMutate = useSafeMutate();
  return useCallback(
    async (name: string): Promise<string | null> => {
      // Read the freshest state rather than the last render: taps can outpace React.
      const levels = selectStructure(client.getState().view, propertyId).map(
        (group) => group.level,
      );
      const id = newId();
      const position = positionAtIndex(levels, levelInsertIndex(levels, name));
      return (await safeMutate("createLevel", { id, propertyId, name, position })) ? id : null;
    },
    [client, propertyId, safeMutate],
  );
}
