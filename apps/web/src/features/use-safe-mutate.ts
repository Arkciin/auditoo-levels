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

/** Confirms a deletion with a way back: deletes are soft, so undoing is just a restore. */
export function toastUndo(message: string, undo: () => void) {
  toast(message, {
    duration: 6000,
    action: { label: "Annuler", onClick: undo },
  });
}

/** French quotes with non-breaking spaces: « Cuisine ». */
export function quote(name: string): string {
  return `« ${name} »`;
}
