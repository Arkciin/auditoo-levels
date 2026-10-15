import { ArchiveRestore } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { formatSince } from "@/lib/relative-time";

/**
 * The details of a deleted item: what it holds or where it was, then when it went, e.g.
 * « 2 niveaux, 5 pièces · supprimé hier ».
 */
export function deletedDetails(
  about: string,
  deleted: "supprimé" | "supprimée",
  deletedAt: number,
  now: number,
): string {
  return `${about} · ${deleted} ${formatSince(deletedAt, now)}`;
}

/**
 * A deleted logement, level or room in a sheet of deleted items: its name in full (several may
 * look alike), what it holds and when it went, and the way back. `label` names the button for
 * screen readers, e.g. « Restaurer le niveau R+1 ».
 */
export function DeletedRow({
  name,
  details,
  label,
  onRestore,
}: {
  name: string;
  details: string;
  label: string;
  onRestore: () => void;
}) {
  return (
    <li className="flex min-h-16 items-center gap-3 border-b border-rule py-2">
      <div className="min-w-0 flex-1">
        <p className="font-semibold break-words">{name}</p>
        <p className="text-sm text-muted-foreground">{details}</p>
      </div>
      <Button variant="outline" aria-label={label} onClick={onRestore}>
        <ArchiveRestore aria-hidden="true" />
        Restaurer
      </Button>
    </li>
  );
}

/** What a sheet of deleted items shows when there are none. */
export function NothingDeleted({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 px-4 pt-2 pb-8 text-center text-muted-foreground">
      <ArchiveRestore aria-hidden="true" className="size-8" />
      <p>{children}</p>
    </div>
  );
}
