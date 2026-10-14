import { Trash } from "lucide-react";
import { type ReactNode, useRef, useState } from "react";

import { haptic } from "@/lib/haptics";
import { cn } from "@/lib/utils";

/** Share of the row width past which releasing deletes. */
const DELETE_THRESHOLD = 0.4;
/** A fast flick deletes even before the threshold (px/ms). */
const FLICK_VELOCITY = 0.6;
/** Movement needed before we decide between a horizontal swipe and a vertical scroll (px). */
const AXIS_LOCK_DISTANCE = 8;
const EXIT_DURATION_MS = 160;

interface Gesture {
  pointerId: number;
  startX: number;
  startY: number;
  axis: "x" | "y" | null;
  lastX: number;
  lastTime: number;
  velocity: number;
}

/**
 * Swipe a row to the left to delete it, the gesture people know from mail apps.
 *
 * Vertical scrolling stays native (`touch-action: pan-y`): we only take over once the finger
 * clearly moves sideways. Elements marked `data-no-swipe` (drag handles, inputs) never start a
 * swipe. A click that ends a swipe is swallowed so it does not also trigger the row's tap action.
 * Swiping is a shortcut, not the only way: callers keep an accessible delete action elsewhere.
 */
export function SwipeToDelete({
  onDelete,
  disabled = false,
  className,
  children,
}: {
  onDelete: () => void;
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

  const width = () => containerRef.current?.offsetWidth ?? 1;

  function reset() {
    gesture.current = null;
    setDragging(false);
    setArmed(false);
    setOffset(0);
  }

  function onPointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (disabled || removing || !event.isPrimary || event.button !== 0) return;
    if ((event.target as Element).closest("[data-no-swipe]")) return;
    suppressClick.current = false;
    gesture.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
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

    const next = Math.min(0, dx);
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
    if (current.axis !== "x") {
      gesture.current = null;
      return;
    }
    suppressClick.current = true;
    const distance = event.clientX - current.startX;
    const flicked = current.velocity < -FLICK_VELOCITY && distance < -40;
    if (-distance > width() * DELETE_THRESHOLD || flicked) {
      gesture.current = null;
      setDragging(false);
      setRemoving(true);
      setOffset(-width());
      window.setTimeout(onDelete, EXIT_DURATION_MS);
    } else {
      reset();
    }
  }

  return (
    <div ref={containerRef} className={cn("relative overflow-hidden", className)}>
      {offset < 0 || removing ? (
        <div
          aria-hidden="true"
          className="absolute inset-0 flex items-center justify-end gap-2 bg-destructive px-5 font-semibold text-destructive-foreground"
        >
          <Trash
            className={cn("size-5 transition-transform", armed || removing ? "scale-125" : "")}
          />
          Supprimer
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
          if (!suppressClick.current) return;
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
