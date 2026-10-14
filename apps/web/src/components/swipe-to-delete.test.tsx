import { act, createEvent, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SwipeToDelete } from "./swipe-to-delete";

/** Wide enough for round numbers: deleting takes a swipe past 40 % of it, i.e. 120 px. */
const ROW_WIDTH = 300;
/** The row slides out for this long before `onDelete` runs. */
const EXIT_MS = 160;
/** A row still there this long after `onDelete` ran comes back: its deletion failed. */
const RESTORE_MS = 1500;
/** Real fingers move a few pixels per frame; 4 px every 16 ms stays well below a flick. */
const SLOW = { step: 4, frameMs: 16 };
const FAST = { step: 30, frameMs: 16 };

type PointerType = "pointerDown" | "pointerMove" | "pointerUp" | "pointerCancel";

/**
 * One pointer event as a finger on a touch screen produces it. happy-dom stamps events with the
 * real clock; tests give each event its own time instead, so velocities are deterministic.
 */
function pointer(
  type: PointerType,
  target: Element,
  { x, y, t }: { x: number; y: number; t: number },
  init: PointerEventInit = {},
): void {
  const event = createEvent[type](target, {
    pointerId: 1,
    pointerType: "touch",
    isPrimary: true,
    button: type === "pointerDown" ? 0 : -1,
    clientX: x,
    clientY: y,
    ...init,
  });
  Object.defineProperty(event, "timeStamp", { value: t });
  fireEvent(target, event);
}

/**
 * Puts a finger down on `target`, moves it horizontally from `fromX` to `toX` at the given speed,
 * then lifts it, unless `release` is false.
 */
function swipe(
  target: Element,
  {
    fromX = 280,
    toX,
    y = 20,
    speed = SLOW,
    release = true,
  }: {
    fromX?: number;
    toX: number;
    y?: number;
    speed?: { step: number; frameMs: number };
    release?: boolean;
  },
): void {
  let t = 1_000;
  let x = fromX;
  pointer("pointerDown", target, { x, y, t });
  const direction = Math.sign(toX - fromX);
  while (x !== toX) {
    x = direction < 0 ? Math.max(toX, x - speed.step) : Math.min(toX, x + speed.step);
    t += speed.frameMs;
    pointer("pointerMove", target, { x, y, t });
  }
  if (release) pointer("pointerUp", target, { x, y, t: t + speed.frameMs });
}

/** The red "Supprimer" strip, uncovered behind a row while it is swiped or removed. */
const deleteHint = () => screen.queryByText("Supprimer");

function advance(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

function renderRow({ disabled = false } = {}) {
  const onDelete = vi.fn();
  const onOpen = vi.fn();
  const onHandle = vi.fn();
  render(
    <SwipeToDelete onDelete={onDelete} disabled={disabled}>
      <div>
        <button type="button" onClick={onOpen}>
          Cuisine
        </button>
        <button type="button" aria-label="Déplacer Cuisine" data-no-swipe onClick={onHandle} />
      </div>
    </SwipeToDelete>,
  );
  return {
    onDelete,
    onOpen,
    onHandle,
    name: screen.getByRole("button", { name: "Cuisine" }),
    handle: screen.getByRole("button", { name: "Déplacer Cuisine" }),
  };
}

/** A click as a pointer produces it (`detail` counts the taps); the keyboard's has `detail` 0. */
const tap = (target: Element) => fireEvent.click(target, { detail: 1 });
const pressEnter = (target: Element) => fireEvent.click(target, { detail: 0 });

beforeEach(() => {
  vi.useFakeTimers();
  // happy-dom has no layout: give rows a width, which sets the deletion threshold.
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(ROW_WIDTH);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("SwipeToDelete", () => {
  it("deletes a row swiped past 40 % of its width, once it has slid away", () => {
    const { name, onDelete } = renderRow();

    swipe(name, { toX: 280 - 121 });
    expect(deleteHint()).toBeInTheDocument();
    expect(onDelete).not.toHaveBeenCalled(); // the row slides out first

    advance(EXIT_MS);
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it("springs back when released before the threshold", () => {
    const { name, onDelete } = renderRow();

    swipe(name, { toX: 280 - 119, release: false });
    expect(deleteHint()).toBeInTheDocument();
    pointer("pointerUp", name, { x: 280 - 119, y: 20, t: 5_000 });

    expect(deleteHint()).not.toBeInTheDocument();
    advance(RESTORE_MS * 2);
    expect(onDelete).not.toHaveBeenCalled();
  });

  it("deletes on a quick flick, before the threshold", () => {
    const { name, onDelete } = renderRow();

    swipe(name, { toX: 280 - 60, speed: FAST });
    advance(EXIT_MS);

    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it("does not take a short twitch for a flick", () => {
    const { name, onDelete } = renderRow();

    swipe(name, { toX: 280 - 30, speed: FAST });
    advance(RESTORE_MS * 2);

    expect(onDelete).not.toHaveBeenCalled();
    expect(deleteHint()).not.toBeInTheDocument();
  });

  it("leaves a vertical move to the browser's scroll, even if the finger then goes sideways", () => {
    const { name, onDelete } = renderRow();

    pointer("pointerDown", name, { x: 200, y: 100, t: 0 });
    pointer("pointerMove", name, { x: 197, y: 112, t: 16 }); // scrolling down the list
    pointer("pointerMove", name, { x: 40, y: 115, t: 200 });
    expect(deleteHint()).not.toBeInTheDocument();
    pointer("pointerUp", name, { x: 40, y: 115, t: 216 });
    advance(RESTORE_MS * 2);

    expect(onDelete).not.toHaveBeenCalled();
  });

  it("treats a diagonal move as a scroll: a swipe must be clearly horizontal", () => {
    const { name, onDelete } = renderRow();

    pointer("pointerDown", name, { x: 200, y: 100, t: 0 });
    pointer("pointerMove", name, { x: 190, y: 109, t: 16 }); // 10 px across, 9 px down
    pointer("pointerMove", name, { x: 40, y: 109, t: 300 });
    pointer("pointerUp", name, { x: 40, y: 109, t: 316 });
    advance(RESTORE_MS * 2);

    expect(onDelete).not.toHaveBeenCalled();
  });

  it("waits for 8 px of movement before choosing between swipe and scroll", () => {
    const { name } = renderRow();

    pointer("pointerDown", name, { x: 200, y: 100, t: 0 });
    pointer("pointerMove", name, { x: 194, y: 104, t: 16 }); // jitter: undecided
    expect(deleteHint()).not.toBeInTheDocument();
    pointer("pointerMove", name, { x: 180, y: 104, t: 48 }); // now clearly sideways

    expect(deleteHint()).toBeInTheDocument();
  });

  it("swallows the click that ends a swipe, and only that one", () => {
    const { name, onOpen } = renderRow();

    swipe(name, { toX: 200 });
    tap(name); // the browser's click at the end of the gesture
    expect(onOpen).not.toHaveBeenCalled();

    pressEnter(name); // a click without a pointer: keyboard or screen reader
    expect(onOpen).toHaveBeenCalledTimes(1);

    pointer("pointerDown", name, { x: 100, y: 20, t: 10_000 });
    pointer("pointerUp", name, { x: 100, y: 20, t: 10_080 });
    tap(name);
    expect(onOpen).toHaveBeenCalledTimes(2);
  });

  it("never swallows a keyboard or screen reader activation after a half swipe", () => {
    const { name, onOpen } = renderRow();

    // A finger that moved: the browser sends no click at the end of this swipe.
    swipe(name, { toX: 200 });
    pressEnter(name);

    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("forgets the click to swallow when the next gesture starts, even on a drag handle", () => {
    const { name, handle, onHandle } = renderRow();

    swipe(name, { toX: 200 }); // no click follows
    pointer("pointerDown", handle, { x: 290, y: 20, t: 10_000 });
    pointer("pointerUp", handle, { x: 290, y: 20, t: 10_080 });
    tap(handle);

    expect(onHandle).toHaveBeenCalledTimes(1);
  });

  it("forgets the click to swallow a frame after the swipe", () => {
    const { name, onOpen } = renderRow();

    swipe(name, { toX: 200 }); // no click follows
    advance(20);
    tap(name); // e.g. a screen reader activating the name, with no pointer events

    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("never starts a swipe on an element marked data-no-swipe, such as a drag handle", () => {
    const { handle, onDelete } = renderRow();

    swipe(handle, { toX: 20 });
    advance(RESTORE_MS * 2);

    expect(deleteHint()).not.toBeInTheDocument();
    expect(onDelete).not.toHaveBeenCalled();
  });

  it("ignores a second finger", () => {
    const { name, onDelete } = renderRow();

    pointer("pointerDown", name, { x: 280, y: 20, t: 0 }, { pointerId: 2, isPrimary: false });
    pointer("pointerMove", name, { x: 100, y: 20, t: 400 }, { pointerId: 2, isPrimary: false });
    pointer("pointerUp", name, { x: 100, y: 20, t: 416 }, { pointerId: 2, isPrimary: false });
    advance(RESTORE_MS * 2);

    expect(onDelete).not.toHaveBeenCalled();
  });

  it("does not swipe while disabled, e.g. during a rename", () => {
    const { name, onDelete } = renderRow({ disabled: true });

    swipe(name, { toX: 20 });
    advance(RESTORE_MS * 2);

    expect(deleteHint()).not.toBeInTheDocument();
    expect(onDelete).not.toHaveBeenCalled();
  });

  it("springs back when the browser cancels the gesture", () => {
    const { name, onDelete } = renderRow();

    swipe(name, { toX: 100, release: false });
    pointer("pointerCancel", name, { x: 100, y: 20, t: 5_000 });
    expect(deleteHint()).not.toBeInTheDocument();
    pointer("pointerUp", name, { x: 100, y: 20, t: 5_016 });
    advance(RESTORE_MS * 2);

    expect(onDelete).not.toHaveBeenCalled();
  });

  it("slides a row back when its deletion failed, and lets it be swiped again", () => {
    // The caller could not delete (it reported why): the row stays mounted.
    const { name, onDelete } = renderRow();

    swipe(name, { toX: 20 });
    advance(EXIT_MS);
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(deleteHint()).toBeInTheDocument(); // still sliding out: no new gesture meanwhile
    swipe(name, { toX: 20 });
    advance(EXIT_MS);
    expect(onDelete).toHaveBeenCalledTimes(1);

    advance(RESTORE_MS);
    expect(deleteHint()).not.toBeInTheDocument();

    swipe(name, { toX: 20 });
    advance(EXIT_MS);
    expect(onDelete).toHaveBeenCalledTimes(2);
  });
});
