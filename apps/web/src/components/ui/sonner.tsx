import {
  CircleCheckIcon,
  InfoIcon,
  LoaderCircleIcon,
  OctagonXIcon,
  TriangleAlertIcon,
} from "lucide-react";
import type * as React from "react";
import { Toaster as Sonner, type ToasterProps } from "sonner";

// Toasts sit in the thumb zone, just above the bottom action bar and the home indicator.
const bottomOffset = "calc(var(--action-bar-height) + env(safe-area-inset-bottom) + 0.75rem)";

/**
 * Themed with the design tokens (colours follow light/dark automatically). Further overrides
 * of Sonner's own stylesheet (font, no shadow, sizes, focus ring) live in styles.css.
 */
function Toaster({ ...props }: ToasterProps) {
  return (
    <Sonner
      theme="system"
      position="bottom-center"
      offset={{ bottom: bottomOffset }}
      mobileOffset={{ bottom: bottomOffset, left: "1rem", right: "1rem" }}
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
