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

const relativeTime = new Intl.RelativeTimeFormat("fr", { numeric: "auto" });

function formatSince(timestamp: number, now: number): string {
  const seconds = Math.round((timestamp - now) / 1000);
  if (Math.abs(seconds) < 45) return "à l’instant";
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return relativeTime.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return relativeTime.format(hours, "hour");
  return relativeTime.format(Math.round(hours / 24), "day");
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
      <div className="flex min-h-0 flex-col gap-4 overflow-y-auto px-4">
        <section aria-labelledby="pending-title">
          <h3 id="pending-title" className="pb-1 text-sm font-semibold">
            {descriptions.length === 0
              ? "Aucune modification en attente"
              : `${plural(descriptions.length, "modification", "modifications")} sur cet appareil`}
          </h3>
          {descriptions.length > 0 ? (
            <ol className="border-t border-rule">
              {descriptions.map((description, index) => (
                <li
                  // Descriptions are not unique and the list is append-only: the index is stable.
                  // biome-ignore lint/suspicious/noArrayIndexKey: see above
                  key={index}
                  className="border-b border-rule py-2.5 text-sm"
                >
                  {description}
                </li>
              ))}
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
      </div>
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
