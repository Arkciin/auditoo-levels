/**
 * Installing Relevé on the device, offered from the home screen's menu.
 *
 * - Chrome, Edge and Samsung Internet (Android, desktop) fire `beforeinstallprompt` once the app
 *   is installable: the event is kept, and its `prompt()` opens the browser's install dialog.
 * - iOS has no such event: installing goes through Safari's Share menu, which the app explains.
 *   It matters more there: iOS keeps the data of installed apps, while Safari may erase that of
 *   a site left unused for a few days, unsent changes included.
 * - Once installed, or opened as the installed app, nothing is offered.
 */
import { useSyncExternalStore } from "react";

/** What the menu offers: the browser's prompt, the iOS instructions, or nothing. */
export type InstallOffer = "prompt" | "ios" | null;

export interface InstallEnvironment {
  /** Opened as an installed app (`display-mode: standalone`, or `navigator.standalone` on iOS). */
  readonly standalone: boolean;
  /** `appinstalled` fired in this page. */
  readonly installed: boolean;
  /** A `beforeinstallprompt` event is kept, unused. */
  readonly canPrompt: boolean;
  readonly userAgent: string;
  readonly maxTouchPoints: number;
}

export function installOffer(environment: InstallEnvironment): InstallOffer {
  if (environment.standalone || environment.installed) return null;
  if (isIos(environment)) return "ios";
  return environment.canPrompt ? "prompt" : null;
}

function isIos({ userAgent, maxTouchPoints }: InstallEnvironment): boolean {
  // iPadOS presents itself as a Mac: a Mac with a touch screen is an iPad.
  return /iPhone|iPad|iPod/.test(userAgent) || (/Macintosh/.test(userAgent) && maxTouchPoints > 1);
}

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  readonly userChoice: Promise<{ readonly outcome: "accepted" | "dismissed" }>;
}

let deferredPrompt: BeforeInstallPromptEvent | null = null;
let installed = false;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

/**
 * Starts listening for the install events. Call it before rendering: `beforeinstallprompt` may
 * fire right after the page loads, and only once.
 */
export function captureInstallPrompt(): void {
  window.addEventListener("beforeinstallprompt", (event) => {
    // The menu offers it, rather than the browser's own banner at a moment it picks.
    event.preventDefault();
    deferredPrompt = event as BeforeInstallPromptEvent;
    notify();
  });
  window.addEventListener("appinstalled", () => {
    deferredPrompt = null;
    installed = true;
    notify();
  });
}

/** Opens the browser's install dialog. Resolves to whether the user accepted. */
export async function promptInstall(): Promise<boolean> {
  const event = deferredPrompt;
  if (!event) return false;
  // An event prompts once: the menu item goes, whatever the answer.
  deferredPrompt = null;
  notify();
  try {
    await event.prompt();
    return (await event.userChoice).outcome === "accepted";
  } catch (error) {
    // Refused by the browser (no user gesture to answer, say): the browser's own menu remains.
    console.warn("The install prompt could not open", error);
    return false;
  }
}

const STANDALONE = "(display-mode: standalone)";

function currentOffer(): InstallOffer {
  const iosStandalone = (navigator as Navigator & { standalone?: boolean }).standalone === true;
  return installOffer({
    standalone: iosStandalone || window.matchMedia(STANDALONE).matches,
    installed,
    canPrompt: deferredPrompt !== null,
    userAgent: navigator.userAgent,
    maxTouchPoints: navigator.maxTouchPoints,
  });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const standalone = window.matchMedia(STANDALONE);
  standalone.addEventListener("change", listener);
  return () => {
    listeners.delete(listener);
    standalone.removeEventListener("change", listener);
  };
}

/** What to offer right now; updates when the browser's offer comes or goes. */
export function useInstallOffer(): InstallOffer {
  return useSyncExternalStore(subscribe, currentOffer, () => null);
}
