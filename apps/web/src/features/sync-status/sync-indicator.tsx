import {
  CloudCheck,
  CloudOff,
  CloudUpload,
  type LucideIcon,
  RefreshCw,
  TriangleAlert,
} from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from "@/components/ui/drawer";
import { rejectionToastId } from "@/features/sync-status/rejection-toasts";
import { formatSince } from "@/lib/relative-time";
import { plural } from "@/lib/suggestions";
import { cn } from "@/lib/utils";
import {
  describePendingMutations,
  type SyncStatus,
  useSyncClient,
  useSyncState,
  useSyncStatus,
} from "@/sync";

type Tone = "synced" | "pending" | "syncing" | "offline" | "error";

interface StatusPresentation {
  tone: Tone;
  icon: LucideIcon;
  /** Shown in the pill. */
  short: string;
  /** Sheet title. */
  title: string;
  /** Sheet explanation. */
  explanation: string;
}

/** One place that turns the engine status into words, so pill, sheet and banner agree. */
export function presentStatus(status: SyncStatus): StatusPresentation {
  if (status.connection === "offline") {
    return {
      tone: "offline",
      icon: CloudOff,
      short: "Hors ligne",
      title: "Hors ligne",
      explanation:
        "Vos modifications sont enregistrées sur cet appareil. Elles seront envoyées automatiquement au retour du réseau.",
    };
  }
  if (status.phase === "error") {
    const message = status.lastError ?? "Le serveur n’a pas accepté la requête.";
    // Some errors already tell the user what to do (reload the page): don't promise a retry.
    const followUp = /recharg/i.test(message)
      ? ""
      : " Vos modifications restent sur cet appareil et Relevé réessaie automatiquement.";
    return {
      tone: "error",
      icon: TriangleAlert,
      short: "Erreur",
      title: "La synchronisation a échoué",
      explanation: `${message}${followUp}`,
    };
  }
  if (status.phase === "syncing") {
    return {
      tone: "syncing",
      icon: RefreshCw,
      short: "Envoi…",
      title: "Synchronisation en cours",
      explanation: "Envoi de vos modifications et récupération de celles des autres appareils.",
    };
  }
  if (status.pendingCount > 0) {
    return {
      tone: "pending",
      icon: CloudUpload,
      short: "En attente",
      title: "Modifications en attente",
      explanation: "Elles seront envoyées dans quelques instants.",
    };
  }
  return {
    tone: "synced",
    icon: CloudCheck,
    short: "À jour",
    title: "Tout est à jour",
    explanation: "Vos données sont enregistrées sur le serveur.",
  };
}

const toneClasses: Record<Tone, string> = {
  synced: "text-success",
  pending: "text-muted-foreground",
  syncing: "text-muted-foreground",
  offline: "bg-warning text-warning-foreground",
  error: "bg-destructive/10 text-destructive",
};

/** Header pill showing the sync health; opens a sheet listing what is still on the device. */
export function SyncIndicator() {
  const status = useSyncStatus();
  const [open, setOpen] = useState(false);
  const presentation = presentStatus(status);
  const Icon = presentation.icon;
  const pending =
    status.pendingCount > 0
      ? `, ${plural(status.pendingCount, "modification en attente", "modifications en attente")}`
      : "";

  return (
    <Drawer open={open} onOpenChange={setOpen}>
      <DrawerTrigger asChild>
        <button
          type="button"
          aria-label={`${presentation.title}${pending}. Voir le détail`}
          className={cn(
            "relative flex h-9 shrink-0 items-center gap-1.5 rounded-full px-3 text-sm font-semibold transition-colors after:absolute after:inset-x-0 after:-inset-y-1",
            toneClasses[presentation.tone],
          )}
        >
          <Icon
            aria-hidden="true"
            className={cn("size-4", presentation.tone === "syncing" && "motion-safe:animate-spin")}
          />
          <span>{presentation.short}</span>
          {status.pendingCount > 0 ? (
            <span className="min-w-5 rounded-full bg-foreground px-1.5 text-center text-xs leading-5 text-background tabular-nums">
              {status.pendingCount}
            </span>
          ) : null}
        </button>
      </DrawerTrigger>
      <DrawerContent>
        <SyncDetails />
      </DrawerContent>
    </Drawer>
  );
}

/** How often relative times refresh while on screen: the minute is their finest unit. */
const CLOCK_TICK_MS = 15_000;

/** The current time (epoch ms), refreshed every `intervalMs` while the component is mounted. */
function useNow(intervalMs: number): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

// The drawer mounts its content only while the sheet is open (or closing): the full-state
// subscription and the clock cost nothing otherwise.
function SyncDetails() {
  const client = useSyncClient();
  const { base, pending, status, rejections } = useSyncState();
  const now = useNow(CLOCK_TICK_MS);
  const presentation = presentStatus(status);
  const descriptions = describePendingMutations(base, pending);
  const notApplied = new Set(rejections.map((rejection) => rejection.mutationId));

  // The sheet lists them: their toasts would only cover the list.
  useEffect(() => {
    for (const rejection of rejections) toast.dismiss(rejectionToastId(rejection.mutationId));
  }, [rejections]);

  return (
    <>
      <DrawerHeader>
        <DrawerTitle>{presentation.title}</DrawerTitle>
        <DrawerDescription>{presentation.explanation}</DrawerDescription>
      </DrawerHeader>
      <section
        // biome-ignore lint/a11y/noNoninteractiveTabindex: it scrolls and may hold nothing focusable: without a tab stop, a keyboard could not scroll it (WCAG 2.1.1)
        tabIndex={0}
        aria-label="Détail des modifications"
        className="flex min-h-0 flex-col gap-4 overflow-y-auto px-4"
      >
        <section aria-labelledby="pending-title">
          <h3 id="pending-title" className="pb-1 text-sm font-semibold">
            {descriptions.length === 0
              ? "Aucune modification en attente"
              : `${plural(descriptions.length, "modification", "modifications")} sur cet appareil`}
          </h3>
          {descriptions.length > 0 ? (
            <ol className="border-t border-rule">
              {pending.map((mutation, index) => {
                // Still queued, for the server to settle, but listed below as not applied.
                const stale = notApplied.has(mutation.id);
                return (
                  <li
                    key={mutation.id}
                    className={cn(
                      "border-b border-rule py-2.5 text-sm",
                      stale && "text-muted-foreground",
                    )}
                  >
                    {descriptions[index]}
                    {stale ? "\u00a0— ne s’applique plus" : null}
                  </li>
                );
              })}
            </ol>
          ) : null}
        </section>
        {rejections.length > 0 ? (
          <section aria-labelledby="rejections-title">
            <h3 id="rejections-title" className="pb-1 text-sm font-semibold">
              {plural(
                rejections.length,
                "modification non appliquée",
                "modifications non appliquées",
              )}
            </h3>
            <ol className="border-t border-rule">
              {rejections.map((rejection) => (
                <li key={rejection.mutationId} className="flex gap-2 border-b border-rule py-2.5">
                  <TriangleAlert
                    aria-hidden="true"
                    className="mt-0.5 size-4 shrink-0 text-destructive"
                  />
                  <div className="min-w-0">
                    <p className="text-sm">{rejection.message}</p>
                    <time
                      dateTime={new Date(rejection.at).toISOString()}
                      className="block text-xs text-muted-foreground first-letter:uppercase"
                    >
                      {formatSince(rejection.at, now)}
                    </time>
                  </div>
                </li>
              ))}
            </ol>
          </section>
        ) : null}
      </section>
      <DrawerFooter>
        <Button
          size="lg"
          disabled={status.phase === "syncing"}
          onClick={() => void client.syncNow()}
        >
          <RefreshCw aria-hidden="true" />
          Synchroniser maintenant
        </Button>
        <p className="text-center text-xs text-muted-foreground">
          {status.lastSyncedAt === null
            ? "Pas encore synchronisé sur cet appareil."
            : `Dernière synchronisation ${formatSince(status.lastSyncedAt, now)}.`}
        </p>
      </DrawerFooter>
    </>
  );
}
