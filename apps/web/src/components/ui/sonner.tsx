import {
  CircleCheckIcon,
  InfoIcon,
  LoaderCircleIcon,
  OctagonXIcon,
  TriangleAlertIcon,
} from "lucide-react";
import type * as React from "react";
import { useEffect, useSyncExternalStore } from "react";
import { Toaster as Sonner, type ToasterProps, toast } from "sonner";

// Toasts sit in the thumb zone, just above the bottom action bar and the home indicator.
const bottomOffset = "calc(var(--action-bar-height) + env(safe-area-inset-bottom) + 0.75rem)";
// While a sheet is open, they sit at the top instead, under the status bar.
const topOffset = "calc(env(safe-area-inset-top) + 0.75rem)";

/*
 * Toasts and sheets. Sonner draws toasts above everything, sheets included, while a modal sheet
 * makes the rest of the page inert (`pointer-events: none` on body), toasts with it: a toast hid
 * what the sheet showed under it, and a tap on its « Annuler » went through to that (a room then
 * moved to the level under the toast). The rule:
 * - Opening a sheet dismisses the toasts on screen: they are about the screen the sheet now
 *   covers. Only the update offer stays (`KEPT_UNDER_SHEETS`): nothing else would offer it again.
 * - While a sheet is open, toasts (an error, the update offer) show at the top of the screen,
 *   above its backdrop and clear of the sheet, and take taps themselves (styles.css); a tap on
 *   one leaves the sheet open (`DrawerContent`).
 * - One toast per entity: an undo toast given the deleted entity's id (`toastUndo`) and the
 *   « restauré » toast that follows (`toastRestored`) share it, so the one replaces the other.
 */

/** The toasts that opening a sheet leaves on screen: the update offer (main.tsx). */
const KEPT_UNDER_SHEETS: ReadonlySet<string | number> = new Set(["app-update"]);

let openSheets = 0;
const openSheetsListeners = new Set<() => void>();

function countOpenSheet(change: 1 | -1): void {
  openSheets += change;
  for (const listener of openSheetsListeners) listener();
}

/** For the shared `Drawer`: its sheet is `open`, and toasts make way for it (see above). */
export function useToastsMakeWay(open: boolean): void {
  useEffect(() => {
    if (!open) return;
    for (const shown of toast.getToasts()) {
      if (!KEPT_UNDER_SHEETS.has(shown.id)) toast.dismiss(shown.id);
    }
    countOpenSheet(1);
    return () => countOpenSheet(-1);
  }, [open]);
}

function subscribeToOpenSheets(listener: () => void): () => void {
  openSheetsListeners.add(listener);
  return () => {
    openSheetsListeners.delete(listener);
  };
}

function useSheetOpen(): boolean {
  return useSyncExternalStore(
    subscribeToOpenSheets,
    () => openSheets > 0,
    () => false,
  );
}

/**
 * Themed with the design tokens (colours follow light/dark automatically). Further overrides
 * of Sonner's own stylesheet (font, no shadow, sizes, focus ring) live in styles.css.
 */
function Toaster({ ...props }: ToasterProps) {
  const sheetOpen = useSheetOpen();
  return (
    <Sonner
      theme="system"
      position={sheetOpen ? "top-center" : "bottom-center"}
      offset={{ top: topOffset, bottom: bottomOffset }}
      mobileOffset={{ top: topOffset, bottom: bottomOffset, left: "1rem", right: "1rem" }}
      containerAriaLabel="Notifications"
      className="toaster group"
      icons={{
        success: <CircleCheckIcon className="size-5 text-success" />,
        info: <InfoIcon className="size-5" />,
        warning: <TriangleAlertIcon className="size-5 text-warning-foreground" />,
        error: <OctagonXIcon className="size-5 text-destructive" />,
        loading: <LoaderCircleIcon className="size-5 animate-spin" />,
      }}
      toastOptions={{ closeButtonAriaLabel: "Fermer la notification" }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--radius)",
        } as React.CSSProperties
      }
      {...props}
    />
  );
}

export { Toaster };
