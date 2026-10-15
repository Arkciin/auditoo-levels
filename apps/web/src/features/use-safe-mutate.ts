import type { MutationArgs, MutationName } from "@repo/shared";
import { useCallback } from "react";
import { toast } from "sonner";

import { describeMutationError, useMutate } from "@/sync";

/**
 * `mutate` for event handlers: reports failures with a toast in plain French and resolves to
 * whether the change was saved, instead of throwing into React.
 */
export function useSafeMutate() {
  const mutate = useMutate();
  return useCallback(
    async <N extends MutationName>(name: N, args: MutationArgs<N>): Promise<boolean> => {
      try {
        await mutate(name, args);
        return true;
      } catch (error) {
        toast.error(describeMutationError(error));
        return false;
      }
    },
    [mutate],
  );
}

/**
 * Confirms a deletion with a way back: deletes are soft, so undoing is just a restore. With the
 * deleted entity's `id`, its toast is the entity's one toast, which `toastRestored` replaces.
 */
export function toastUndo(message: string, undo: () => void, id?: string) {
  toast(message, {
    id: id === undefined ? undefined : entityToastId(id),
    duration: 6000,
    action: { label: "Annuler", onClick: undo },
  });
}

/**
 * Confirms that the entity `id` was restored, in place of its undo toast if that is still on
 * screen: never « … supprimé · Annuler » next to « … restauré ».
 */
export function toastRestored(message: string, id: string) {
  // Sonner merges an update into the toast it replaces: drop the undo toast's action and length.
  toast.success(message, { id: entityToastId(id), action: undefined, duration: undefined });
}

/** One toast per logement, level or room (see the rule in components/ui/sonner.tsx). */
function entityToastId(id: string): string {
  return `entity-${id}`;
}

// Next to the other helpers of the screens' toasts; defined with the sync layer's French texts.
export { quote } from "@/sync";
