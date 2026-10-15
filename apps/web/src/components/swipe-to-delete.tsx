import { Trash } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";

import { haptic } from "@/lib/haptics";
import { cn } from "@/lib/utils";

/** Share of the row width past which releasing deletes (or reveals the delete button). */
const DELETE_THRESHOLD = 0.4;
/** A fast flick counts too (px/ms)… */
const FLICK_VELOCITY = 0.6;
/** …once it has gone past this share of the row width: shorter, it is a twitch, not an intent. */
const FLICK_MIN_SHARE = 0.25;
/** Movement needed before we decide between a horizontal swipe and a vertical scroll (px). */
const AXIS_LOCK_DISTANCE = 8;
const EXIT_DURATION_MS = 160;
const RESTORE_DELAY_MS = 1500;
/** Width of the revealed delete button (its `w-32`), the row's offset while it shows (px). */
const REVEAL_WIDTH_PX = 128;

interface Gesture {
  pointerId: number;
  startX: number;
  startY: number;
  /** The row's offset when the finger landed: 0, or the button's width when it was revealed. */
  base: number;
  axis: "x" | "y" | null;
  lastX: number;
  lastTime: number;
  velocity: number;
}

/**
 * Swipe a row to the left to delete it, the gesture people know from mail apps.
 *
 * Rows that delete a lot at once (a level and its rooms, a logement) pass `confirmLabel`: the
 * swipe then only reveals a « Supprimer » button, named `confirmLabel`, which deletes on a tap.
 * It hides again on a tap elsewhere, a scroll or a swipe back.
 *
 * Vertical scrolling stays native (`touch-action: pan-y`): we only take over once the finger
 * clearly moves sideways. Elements marked `data-no-swipe` (drag handles, inputs) never start a
 * swipe. The click that ends a swipe is swallowed so that it does not also trigger the row's tap
 * action. Swiping is a shortcut, not the only way: callers keep an accessible delete action
 * elsewhere.
 */
export function SwipeToDelete({
  onDelete,
  confirmLabel,
  disabled = false,
  className,
  children,
}: {
  onDelete: () => void;
  /** Accessible name of the revealed button, e.g. « Supprimer le niveau « R+1 » ». */
  confirmLabel?: string;
  disabled?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const suppressClick = useRef(false);
  const [offset, setOffset] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [armed, setArmed] = useState(false);
  const [removing, setRemoving] = useState(false);
  /** The delete button is revealed (with `confirmLabel` only). */
  const [revealed, setRevealed] = useState(false);

  const width = () => containerRef.current?.offsetWidth ?? 1;

  function reset() {
    gesture.current = null;
    setDragging(false);
    setArmed(false);
    setRevealed(false);
    setOffset(0);
  }

  function reveal() {
    gesture.current = null;
    setDragging(false);
    setArmed(false);
    setRevealed(true);
    setOffset(-REVEAL_WIDTH_PX);
  }

  function remove() {
    gesture.current = null;
    setDragging(false);
    setRevealed(false);
    setRemoving(true);
    setOffset(-width());
    window.setTimeout(() => {
      onDelete();
      // A deleted row unmounts. If it is still here a moment later, the deletion failed (the
      // caller reported why): slide the row back instead of leaving a hole in the list.
      window.setTimeout(() => {
        setRemoving(false);
        reset();
      }, RESTORE_DELAY_MS);
    }, EXIT_DURATION_MS);
  }

  /**
   * Swallows the click that ends a gesture, which the browser sends at once, if at all (a finger
   * that moved sends none): the flag must not outlive it, or it would eat the next tap.
   */
  function swallowNextClick() {
    suppressClick.current = true;
    requestAnimationFrame(() => {
      suppressClick.current = false;
    });
  }

  // A revealed button hides on a tap anywhere else or a scroll, as in mail apps; and while the
  // row is being renamed.
  useEffect(() => {
    if (!revealed) return;
    const hide = () => {
      setRevealed(false);
      setOffset(0);
    };
    if (disabled) {
      hide();
      return;
    }
    const container = containerRef.current;
    const hideOnTapElsewhere = (event: PointerEvent) => {
      // On the row itself, its own gestures decide (a tap on it hides the button too).
      if (!container?.contains(event.target as Node)) hide();
    };
    document.addEventListener("pointerdown", hideOnTapElsewhere, true);
    window.addEventListener("scroll", hide, { passive: true });
    return () => {
      document.removeEventListener("pointerdown", hideOnTapElsewhere, true);
      window.removeEventListener("scroll", hide);
    };
  }, [revealed, disabled]);

  function onPointerDown(event: React.PointerEvent<HTMLDivElement>) {
    // Whatever this pointer does, the click of an earlier gesture is not coming any more.
    suppressClick.current = false;
    if (disabled || removing || !event.isPrimary || event.button !== 0) return;
    if ((event.target as Element).closest("[data-no-swipe]")) return;
    gesture.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      base: revealed ? -REVEAL_WIDTH_PX : 0,
      axis: null,
      lastX: event.clientX,
      lastTime: event.timeStamp,
      velocity: 0,
    };
  }

  function onPointerMove(event: React.PointerEvent<HTMLDivElement>) {
    const current = gesture.current;
    if (!current || current.pointerId !== event.pointerId) return;
    const dx = event.clientX - current.startX;
    const dy = event.clientY - current.startY;

    if (current.axis === null) {
      if (Math.abs(dx) > AXIS_LOCK_DISTANCE && Math.abs(dx) > Math.abs(dy) * 1.2) {
        current.axis = "x";
        event.currentTarget.setPointerCapture(event.pointerId);
        setDragging(true);
      } else if (Math.abs(dy) > AXIS_LOCK_DISTANCE) {
        gesture.current = null; // a scroll: leave it to the browser
        return;
      } else {
        return;
      }
    }

    const elapsed = Math.max(1, event.timeStamp - current.lastTime);
    current.velocity = (event.clientX - current.lastX) / elapsed;
    current.lastX = event.clientX;
    current.lastTime = event.timeStamp;

    const next = Math.min(0, current.base + dx);
    setOffset(next);
    const isArmed = -next > width() * DELETE_THRESHOLD;
    if (isArmed !== armed) {
      setArmed(isArmed);
      if (isArmed) haptic(12);
    }
  }

  function onPointerUp(event: React.PointerEvent<HTMLDivElement>) {
    const current = gesture.current;
    if (!current || current.pointerId !== event.pointerId) return;
    gesture.current = null;
    if (current.axis !== "x") {
      // A tap on a row whose button shows only hides the button: it must not also rename.
      if (revealed) {
        swallowNextClick();
        reset();
      }
      return;
    }
    swallowNextClick();
    const distance = event.clientX - current.startX;
    /** How far left the row is. */
    const shift = -(current.base + distance);
    const flicked = current.velocity < -FLICK_VELOCITY && -distance > width() * FLICK_MIN_SHARE;
    const far = shift > width() * DELETE_THRESHOLD || flicked;
    if (confirmLabel !== undefined) {
      // Swiped far enough, or still showing most of the button once swiped back a little.
      if (far || (revealed && shift > REVEAL_WIDTH_PX / 2)) reveal();
      else reset();
    } else if (far) {
      remove();
    } else {
      reset();
    }
  }

  return (
    <div
      ref={containerRef}
      data-slot="swipe-to-delete"
      className={cn("relative overflow-hidden", className)}
    >
      {offset < 0 || removing ? (
        <div className="absolute inset-0 flex items-center justify-end bg-destructive font-semibold text-destructive-foreground">
          {revealed ? (
            <button
              type="button"
              aria-label={confirmLabel}
              className="flex h-full w-32 items-center justify-center gap-2 outline-offset-[-4px] focus-visible:outline-destructive-foreground"
              onClick={remove}
              onKeyDown={(event) => {
                if (event.key === "Escape") reset();
              }}
            >
              <Trash aria-hidden="true" className="size-5" />
              Supprimer
            </button>
          ) : (
            <div aria-hidden="true" className="flex items-center gap-2 px-5">
              <Trash
                className={cn("size-5 transition-transform", armed || removing ? "scale-125" : "")}
              />
              Supprimer
            </div>
          )}
        </div>
      ) : null}
      <div
        className="relative touch-pan-y bg-background"
        style={{
          transform: offset ? `translate3d(${offset}px, 0, 0)` : undefined,
          transition: dragging ? "none" : `transform ${EXIT_DURATION_MS}ms ease-out`,
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={reset}
        onClickCapture={(event) => {
          // Never a click from the keyboard or a screen reader (detail 0): only a pointer's.
          if (!suppressClick.current || event.detail === 0) return;
          suppressClick.current = false;
          event.preventDefault();
          event.stopPropagation();
        }}
      >
        {children}
      </div>
    </div>
  );
}
