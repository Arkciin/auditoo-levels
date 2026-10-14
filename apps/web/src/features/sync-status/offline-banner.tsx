import { CloudOff } from "lucide-react";

import { useSyncStatus } from "@/sync";

/** Thin strip under the header while offline: says what happens to the user's work. */
export function OfflineBanner() {
  const { connection } = useSyncStatus();
  if (connection !== "offline") return null;

  return (
    <div
      role="status"
      className="flex items-start gap-2 border-b border-rule bg-warning px-4 py-2 text-sm text-warning-foreground"
    >
      <CloudOff aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      <p>
        Hors ligne. Vos modifications restent sur cet appareil et partiront au retour du réseau.
      </p>
    </div>
  );
}
