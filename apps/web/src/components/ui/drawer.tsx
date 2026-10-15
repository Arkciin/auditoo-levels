import type * as React from "react";
import { useRef, useState } from "react";
import { Drawer as DrawerPrimitive } from "vaul";

import { useToastsMakeWay } from "@/components/ui/sonner";
import { cn } from "@/lib/utils";

function Drawer({
  open,
  defaultOpen,
  onOpenChange,
  ...props
}: React.ComponentProps<typeof DrawerPrimitive.Root>) {
  // A sheet without `open` (uncontrolled) is followed through `onOpenChange`.
  const [openedHere, setOpenedHere] = useState(defaultOpen ?? false);
  useToastsMakeWay(open ?? openedHere);
  return (
    <DrawerPrimitive.Root
      data-slot="drawer"
      open={open}
      defaultOpen={defaultOpen}
      onOpenChange={(next) => {
        setOpenedHere(next);
        onOpenChange?.(next);
      }}
      {...props}
    />
  );
}

/**
 * Whether a sheet opened from outside (`open` prop) belongs in the tree yet: only from its first
 * opening, so that a screen's first render does no work for sheets it may never open (a vaul
 * drawer sets up its state, effects and listeners, and reads the window's size, as it mounts),
 * and still once closed, so that it slides out rather than vanishing.
 *
 * ```tsx
 * const mounted = useOpenedOnce(open);
 * {mounted ? <SomeSheet open={open} onOpenChange={setOpen} /> : null}
 * ```
 */
function useOpenedOnce(open: boolean): boolean {
  const [opened, setOpened] = useState(open);
  if (open && !opened) setOpened(true);
  return opened || open;
}

/**
 * `value` while the sheet is open, and as it last was then while it closes: an action that closes
 * the sheet and changes its content (a restored item leaving a list) must not reshape it as it
 * slides out.
 */
function useHeldWhileClosing<T>(value: T, open: boolean): T {
  const [held, setHeld] = useState(value);
  if (open && held !== value) setHeld(value);
  return open ? value : held;
}

function DrawerTrigger({ ...props }: React.ComponentProps<typeof DrawerPrimitive.Trigger>) {
  return <DrawerPrimitive.Trigger data-slot="drawer-trigger" {...props} />;
}

function DrawerPortal({ ...props }: React.ComponentProps<typeof DrawerPrimitive.Portal>) {
  return <DrawerPrimitive.Portal data-slot="drawer-portal" {...props} />;
}

function DrawerClose({ ...props }: React.ComponentProps<typeof DrawerPrimitive.Close>) {
  return <DrawerPrimitive.Close data-slot="drawer-close" {...props} />;
}

function DrawerOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DrawerPrimitive.Overlay>) {
  return (
    <DrawerPrimitive.Overlay
      data-slot="drawer-overlay"
      className={cn(
        "fixed inset-0 z-50 bg-black/50 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
        className,
      )}
      {...props}
    />
  );
}

// A sheet: surface colour, 0.75rem radius, hairline edge, no shadow. Bottom sheets keep their
// content clear of the home indicator (safe-area inset).
//
// The focus goes into the sheet as it opens (vaul leaves it outside by default, on a page then
// hidden from assistive technologies, and Tab would leave the sheet), and back to what had it
// once the sheet has closed: the trigger, or a menu's ⋮ for a sheet opened from a menu.
function DrawerContent({
  className,
  children,
  initialFocus,
  onOpenAutoFocus,
  onCloseAutoFocus,
  onPointerDownOutside,
  ...props
}: React.ComponentProps<typeof DrawerPrimitive.Content> & {
  /**
   * What takes the focus as the sheet opens: a field, when typing is the point of the sheet.
   * By default the sheet itself, which screen readers announce with its title and description,
   * and from which Tab goes on to its first control: neither a field whose keyboard would pop up
   * over the choices, nor a button that the Enter still held down on the trigger would press.
   */
  initialFocus?: React.RefObject<HTMLElement | null>;
}) {
  /** What had the focus when the sheet opened. */
  const opener = useRef<HTMLElement | null>(null);
  return (
    <DrawerPortal data-slot="drawer-portal">
      <DrawerOverlay />
      <DrawerPrimitive.Content
        data-slot="drawer-content"
        onOpenAutoFocus={(event) => {
          onOpenAutoFocus?.(event);
          if (event.defaultPrevented) return;
          event.preventDefault();
          const focused = document.activeElement;
          opener.current =
            focused instanceof HTMLElement && focused !== document.body ? focused : null;
          const sheet = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
          (initialFocus?.current ?? sheet)?.focus({ preventScroll: true });
        }}
        onCloseAutoFocus={(event) => {
          onCloseAutoFocus?.(event);
          if (event.defaultPrevented) return;
          const target = opener.current;
          opener.current = null;
          // What the sheet's action gave the focus to (a new level's room field) keeps it.
          if (document.activeElement !== null && document.activeElement !== document.body) {
            event.preventDefault();
            return;
          }
          // Otherwise Radix gives it to the sheet's DrawerTrigger, if it has one.
          if (!target?.isConnected) return;
          event.preventDefault();
          target.focus({ preventScroll: true });
        }}
        onPointerDownOutside={(event) => {
          onPointerDownOutside?.(event);
          // A toast shows over the backdrop while a sheet is open (see sonner.tsx): a tap on it
          // is for the toast, not a tap beside the sheet that closes it.
          if (event.target instanceof Element && event.target.closest("[data-sonner-toaster]")) {
            event.preventDefault();
          }
        }}
        className={cn(
          // Focused itself as it opens: the sheet sliding in shows where the focus is, and a ring
          // around it would only draw its frame.
          "group/drawer-content fixed z-50 flex h-auto flex-col bg-card text-card-foreground focus-visible:outline-hidden",
          "data-[vaul-drawer-direction=top]:inset-x-0 data-[vaul-drawer-direction=top]:top-0 data-[vaul-drawer-direction=top]:mb-24 data-[vaul-drawer-direction=top]:max-h-[85dvh] data-[vaul-drawer-direction=top]:rounded-b-xl data-[vaul-drawer-direction=top]:border-b data-[vaul-drawer-direction=top]:pt-safe",
          "data-[vaul-drawer-direction=bottom]:inset-x-0 data-[vaul-drawer-direction=bottom]:bottom-0 data-[vaul-drawer-direction=bottom]:mt-24 data-[vaul-drawer-direction=bottom]:max-h-[85dvh] data-[vaul-drawer-direction=bottom]:rounded-t-xl data-[vaul-drawer-direction=bottom]:border-t data-[vaul-drawer-direction=bottom]:pb-safe",
          "data-[vaul-drawer-direction=right]:inset-y-0 data-[vaul-drawer-direction=right]:right-0 data-[vaul-drawer-direction=right]:w-3/4 data-[vaul-drawer-direction=right]:border-l data-[vaul-drawer-direction=right]:sm:max-w-sm",
          "data-[vaul-drawer-direction=left]:inset-y-0 data-[vaul-drawer-direction=left]:left-0 data-[vaul-drawer-direction=left]:w-3/4 data-[vaul-drawer-direction=left]:border-r data-[vaul-drawer-direction=left]:sm:max-w-sm",
          // Bottom sheets stay within the app column on wide screens.
          "data-[vaul-drawer-direction=bottom]:mx-auto data-[vaul-drawer-direction=bottom]:max-w-app",
          className,
        )}
        {...props}
      >
        <div className="mx-auto mt-3 hidden h-1.5 w-12 shrink-0 rounded-full bg-rule group-data-[vaul-drawer-direction=bottom]/drawer-content:block" />
        {children}
      </DrawerPrimitive.Content>
    </DrawerPortal>
  );
}

function DrawerHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="drawer-header"
      className={cn(
        "flex flex-col gap-1 p-4 group-data-[vaul-drawer-direction=bottom]/drawer-content:text-center group-data-[vaul-drawer-direction=top]/drawer-content:text-center md:text-left",
        className,
      )}
      {...props}
    />
  );
}

function DrawerFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="drawer-footer"
      className={cn("mt-auto flex flex-col gap-2 p-4", className)}
      {...props}
    />
  );
}

function DrawerTitle({ className, ...props }: React.ComponentProps<typeof DrawerPrimitive.Title>) {
  return (
    <DrawerPrimitive.Title
      data-slot="drawer-title"
      className={cn("text-lg font-semibold text-foreground", className)}
      {...props}
    />
  );
}

function DrawerDescription({
  className,
  ...props
}: React.ComponentProps<typeof DrawerPrimitive.Description>) {
  return (
    <DrawerPrimitive.Description
      data-slot="drawer-description"
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  );
}

export {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerOverlay,
  DrawerPortal,
  DrawerTitle,
  DrawerTrigger,
  useHeldWhileClosing,
  useOpenedOnce,
};
