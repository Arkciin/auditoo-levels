import { useEffect } from "react";
import { toast } from "sonner";

import { useSyncClient } from "@/sync";

/** Long enough to read a whole sentence; the sync sheet lists them afterwards. */
const REJECTION_TOAST_MS = 10_000;

/** One toast per change, even if it were announced twice. */
export function rejectionToastId(mutationId: number): string {
  return `rejection-${mutationId}`;
}

/**
 * Tells the user, with a toast, about each change of theirs that did not apply: refused by the
 * server, or overtaken by changes made elsewhere. Renders nothing itself.
 */
export function RejectionToasts() {
  const client = useSyncClient();
  useEffect(
    () =>
      client.onRejected((rejection) => {
        toast.error(rejection.message, {
          id: rejectionToastId(rejection.mutationId),
          duration: REJECTION_TOAST_MS,
        });
      }),
    [client],
  );
  return null;
}
