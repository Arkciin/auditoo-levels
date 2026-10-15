/**
 * Shared vocabulary of the end-to-end tests: locators by role and accessible name (in French, like
 * the UI) and the gestures of a phone user (tap, swipe, drag by a handle).
 *
 * Every test runs against the same server, hence the same dataset, and tests run in parallel: a
 * test only touches the logement it created, under a name no other test uses (`uniqueName`), and
 * never assumes the list of logements is empty or stable.
 *
 * Text matching: the UI puts non-breaking spaces between a number and its noun ("3 pièces") and
 * inside French quotes (« Cuisine »). Playwright normalizes whitespace when matching strings, not
 * regular expressions: regular expressions here use `\s`.
 */
import { test as base, type CDPSession, expect, type Locator, type Page } from "@playwright/test";

export { expect };

export const test = base.extend<{
  secondDevice: Page;
  noUncaughtErrors: undefined;
  cspViolations: string[];
}>({
  /**
   * Another phone: a separate browser context, so its own IndexedDB and sync client id. Contexts
   * created in a test inherit the project's options (device emulation, base URL).
   */
  secondDevice: async ({ browser }, use) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors = uncaughtErrors(page);
    const violations = await reportCspViolations(page);
    await use(page);
    await context.close();
    expect(errors, "uncaught exceptions on the second device").toEqual([]);
    expect(violations, "Content Security Policy violations on the second device").toEqual([]);
  },

  /** Fails the test if the page throws an uncaught exception, even when the screen looks right. */
  noUncaughtErrors: [
    async ({ page }, use) => {
      const errors = uncaughtErrors(page);
      await use(undefined);
      expect(errors, "uncaught exceptions in the page").toEqual([]);
    },
    { auto: true },
  ],

  /**
   * Fails the test if the server's Content Security Policy blocks anything in the page: the app
   * must work under it. A test that provokes a violation on purpose checks it here, then clears it.
   */
  cspViolations: [
    async ({ page }, use) => {
      const violations = await reportCspViolations(page);
      await use(violations);
      expect(violations, "Content Security Policy violations").toEqual([]);
    },
    { auto: true },
  ],
});

/** The uncaught exceptions `page` throws from now on. */
function uncaughtErrors(page: Page): Error[] {
  const errors: Error[] = [];
  page.on("pageerror", (error) => errors.push(error));
  return errors;
}

/** Exposed to the page, which calls it for each `securitypolicyviolation` event. */
type CspProbe = { e2eReportCspViolation?: (violation: string) => void };

/** The Content Security Policy violations of every document `page` loads from now on. */
async function reportCspViolations(page: Page): Promise<string[]> {
  const violations: string[] = [];
  await page.exposeFunction("e2eReportCspViolation", (violation: string) => {
    violations.push(violation);
  });
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (event) => {
      // blockedURI: a URL, or "inline" or "eval".
      const source = event.sourceFile ? ` at ${event.sourceFile}:${event.lineNumber}` : "";
      (window as CspProbe).e2eReportCspViolation?.(
        `${event.effectiveDirective} blocked ${event.blockedURI}${source}: ${event.sample}`,
      );
    });
  });
  return violations;
}

/** A name no other test, worker or retry uses. */
export function uniqueName(prefix: string): string {
  return `${prefix} ${crypto.randomUUID().slice(0, 8)}`;
}

// --- Sync status ---------------------------------------------------------------------------------

/**
 * The header pill. Its accessible name starts with what it shows, then spells out the pending
 * count: « Hors ligne, 3 modifications en attente. Voir le détail ».
 */
export function syncPill(page: Page): Locator {
  return page.getByRole("button", { name: /Voir le détail$/ });
}

/**
 * Nothing is waiting for the server: every change this device made is saved there. It says
 * nothing of pulls: the pill stays « À jour » while one runs.
 *
 * Only meaningful once the last change is on screen (its mutation is then queued): before that,
 * the pill may still show the state from before the change.
 */
export async function expectSynced(page: Page): Promise<void> {
  await expect(syncPill(page)).toHaveAccessibleName("À jour. Voir le détail");
}

/**
 * Makes a change, then waits until the server has saved it: its push answered, nothing pending.
 * For changes drawn before the app has even queued them (a room dragged into another level shows
 * there during the drag), where `expectSynced` alone could see the pill's previous state.
 */
export async function savedOnServer(page: Page, change: () => Promise<void>): Promise<void> {
  await Promise.all([
    page.waitForResponse((response) => new URL(response.url()).pathname === "/api/push"),
    change(),
  ]);
  await expectSynced(page);
}

/** Reloads once the server has every change, so that what comes back is what was saved. */
export async function reloadOnceSynced(page: Page): Promise<void> {
  await expectSynced(page);
  await page.reload();
}

/** The strip shown under the header while offline. */
export function offlineBanner(page: Page): Locator {
  return page.getByRole("status").filter({ hasText: "Hors ligne" });
}

// --- Toasts --------------------------------------------------------------------------------------

/** The notification showing `message`, e.g. the undo toast of a deletion. */
export function toast(page: Page, message: string): Locator {
  return page
    .getByRole("region", { name: /^Notifications/ })
    .getByRole("listitem")
    .filter({ hasText: message });
}

/** Takes a deletion back with the "Annuler" action of its toast. */
export async function undo(page: Page, message: string): Promise<void> {
  const notification = toast(page, message);
  await notification.getByRole("button", { name: "Annuler", exact: true }).tap();
  await expect(notification).toBeHidden();
}

// --- Logements -----------------------------------------------------------------------------------

/** A logement of the home screen's list. */
export function propertyRow(page: Page, name: string): Locator {
  return page
    .getByRole("list", { name: "Logements", exact: true })
    .getByRole("listitem")
    .filter({ has: page.getByText(name, { exact: true }) });
}

/**
 * The logement's name in the header of its screen: a button that turns into a field. Like the
 * names of levels and rooms, it is named by its text, and described « Renommer ».
 */
export function propertyTitle(page: Page, name: string): Locator {
  return page.getByRole("heading", { level: 1 }).getByRole("button", { name, exact: true });
}

export function backToList(page: Page): Promise<void> {
  return page.getByRole("link", { name: "Retour aux logements", exact: true }).tap();
}

/** Creates a logement with the "Nouveau logement" sheet; ends on its (empty) structure screen. */
export async function createProperty(page: Page, name: string): Promise<void> {
  const firstPull = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/api/pull",
  );
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "Logements" })).toBeVisible();
  // The first sync may swap the empty state (it has its own "Nouveau logement" button) for the
  // list. Afterwards the screen only changes when another test adds a logement. (The pill stays
  // « À jour » during a pull: its answer tells when.)
  await firstPull;
  await expectSynced(page);
  await page.getByRole("button", { name: "Nouveau logement", exact: true }).last().tap();
  const sheet = page.getByRole("dialog", { name: "Nouveau logement" });
  await sheet.getByRole("textbox", { name: "Adresse ou nom du logement" }).fill(name);
  await sheet.getByRole("button", { name: "Créer le logement", exact: true }).tap();
  await expect(page).toHaveURL(/\/logements\/[\da-f-]{36}$/);
  await expect(propertyTitle(page, name)).toBeVisible();
}

// --- Structure -----------------------------------------------------------------------------------

/**
 * "3 niveaux, 5 pièces" or "1 niveau, aucune pièce", under the name of a logement on its screen;
 * absent while it has no level (its empty state says so).
 */
export function structureSummary(page: Page): Locator {
  return page.getByRole("main").getByText(/^\d+\s+niveaux?,\s+(?:\d+\s+pièces?|aucune\s+pièce)$/);
}

export function level(page: Page, name: string): Locator {
  return page.getByRole("region", { name: `Niveau ${name}`, exact: true });
}

/** A level's name, in its heading: a button that turns into a field. */
export function levelName(page: Page, name: string): Locator {
  return level(page, name).getByRole("heading", { level: 2 }).getByRole("button");
}

/** A level's header, the row that swipes: its name, room count, menu and drag handle. */
export function levelHeader(page: Page, name: string): Locator {
  return level(page, name)
    .locator('[data-slot="swipe-to-delete"]')
    .filter({ has: page.getByRole("heading", { level: 2 }) });
}

/**
 * The « Supprimer » button a swipe reveals on a level or a logement, named after what it deletes:
 * `deleteButton(page, "le niveau « R+1 »")`.
 */
export function deleteButton(page: Page, what: string): Locator {
  return page.getByRole("button", { name: `Supprimer ${what}`, exact: true });
}

/** Levels are listed lowest first, each titled by a level-2 heading. */
export async function expectLevels(page: Page, names: string[]): Promise<void> {
  await expect(page.getByRole("main").getByRole("heading", { level: 2 })).toHaveText(names);
}

/**
 * Adds a level with the "Ajouter un niveau" sheet: one of its suggestions, or a typed name.
 * The new level opens its room field and focuses it, ready for typing.
 */
export async function addLevel(
  page: Page,
  name: string,
  { typed = false }: { typed?: boolean } = {},
): Promise<void> {
  await page.getByRole("button", { name: "Ajouter un niveau", exact: true }).tap();
  const sheet = page.getByRole("dialog", { name: "Ajouter un niveau" });
  if (typed) {
    await sheet.getByRole("textbox", { name: "Nom du niveau" }).fill(name);
    await sheet.getByRole("button", { name: "Ajouter", exact: true }).tap();
  } else {
    await sheet.getByRole("button", { name, exact: true }).tap();
  }
  await expect(sheet).toBeHidden();
  await expect(newRoomInput(page, name)).toBeFocused();
}

/** The rooms of a level, in display order. */
export function rooms(page: Page, levelName: string): Locator {
  return page
    .getByRole("list", { name: `Pièces du niveau ${levelName}`, exact: true })
    .getByRole("listitem");
}

export function room(page: Page, levelName: string, name: string): Locator {
  // The name, not the menu (« Actions de la pièce … ») nor the handle (« Déplacer … »).
  return rooms(page, levelName).filter({ has: page.getByRole("button", { name, exact: true }) });
}

/**
 * A room's name: a button that turns into a field, in a level's list of rooms (a suggestion chip
 * can bear the same name).
 */
export function roomName(page: Page, name: string): Locator {
  return page
    .getByRole("list", { name: /^Pièces du niveau / })
    .getByRole("button", { name, exact: true });
}

export async function expectRooms(
  page: Page,
  levelName: string,
  names: string[],
  options?: { timeout?: number },
): Promise<void> {
  await expect(rooms(page, levelName)).toHaveText(names, options);
}

export function newRoomInput(page: Page, levelName: string): Locator {
  return page.getByRole("textbox", { name: `Nouvelle pièce au niveau ${levelName}`, exact: true });
}

/** A chip under a level's open room field. */
export function roomSuggestion(page: Page, levelName: string, name: string): Locator {
  return level(page, levelName)
    .getByRole("group", { name: "Suggestions de pièces" })
    .getByRole("button", { name, exact: true });
}

/**
 * Types rooms in a level's open room field, Enter after each, without waiting for them to appear:
 * the field empties and keeps the focus at once, and the app saves the rooms in order.
 */
export async function typeRooms(page: Page, levelName: string, names: string[]): Promise<void> {
  const input = newRoomInput(page, levelName);
  for (const name of names) {
    await input.fill(name);
    await input.press("Enter");
    await expect(input).toHaveValue("");
    await expect(input).toBeFocused();
  }
}

/** Picks `action` in the ⋮ menu of a level ("Dupliquer le niveau"…). */
export async function levelAction(page: Page, levelName: string, action: string): Promise<void> {
  await page.getByRole("button", { name: `Actions du niveau ${levelName}`, exact: true }).tap();
  await page.getByRole("menuitem", { name: action, exact: true }).tap();
}

/** Picks `action` in the ⋮ menu of a room ("Renommer", "Déplacer vers…"…). */
export async function roomAction(page: Page, roomName: string, action: string): Promise<void> {
  await page.getByRole("button", { name: `Actions de la pièce ${roomName}`, exact: true }).tap();
  await page.getByRole("menuitem", { name: action, exact: true }).tap();
}

/** Moves a room with its menu's « Déplacer vers… » sheet: to the end of `levelName`. */
export async function moveRoomTo(page: Page, roomName: string, levelName: string): Promise<void> {
  await roomAction(page, roomName, "Déplacer vers…");
  const sheet = page.getByRole("dialog", { name: `Déplacer « ${roomName} »` });
  // Each level is named with its room count: "R+1, 3 pièces".
  const level = new RegExp(`^${levelName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")},`);
  await sheet.getByRole("button", { name: level }).tap();
  await expect(sheet).toBeHidden();
}

/** Renames by tapping a name (of a logement, level or room), typing, then Enter. */
export async function renameInPlace(name: Locator, field: Locator, newName: string): Promise<void> {
  await name.tap();
  await expect(field).toBeFocused();
  await field.fill(newName);
  await field.press("Enter");
  await expect(field).toBeHidden();
}

// --- Gestures ------------------------------------------------------------------------------------

const SWIPE_STEPS = 10;
const SWIPE_ATTEMPTS = 3;

const touchSessions = new WeakMap<Page, Promise<CDPSession>>();

/**
 * The page's DevTools protocol session for touch input, opened once and kept: detaching one
 * silently undoes `context.setOffline(true)`, so a gesture that opened and detached its own would
 * bring a test that went offline back online.
 */
function touchSession(page: Page): Promise<CDPSession> {
  let session = touchSessions.get(page);
  if (!session) {
    session = page.context().newCDPSession(page);
    touchSessions.set(page, session);
  }
  return session;
}

/** Set by the page when the finger of a swipe lands: on the row to swipe or not. */
type SwipeProbe = { e2eFingerOnRow?: boolean };

/**
 * Swipes `row` to the left with one finger, well past the 40 % of its width that deletes it (a
 * room), or reveals its « Supprimer » button (a level, a logement: see `deleteButton`).
 *
 * Real touch input through the DevTools protocol, as a phone produces it: pointer events of type
 * "touch", with the browser's own hit testing, implicit pointer capture and `touch-action`
 * (Playwright's touchscreen only taps). A mouse drag is no substitute: on a link (a logement's
 * row), it starts the browser's native drag and drop, which cancels the pointer.
 */
export async function swipeLeft(row: Locator): Promise<void> {
  const page = row.page();
  const cdp = await touchSession(page);
  const touch = (type: "touchStart" | "touchMove", x: number, y: number) =>
    cdp.send("Input.dispatchTouchEvent", { type, touchPoints: [{ x, y }] });
  for (let attempt = 1; ; attempt++) {
    // Clear of the sticky header and of the bottom bar.
    await row.evaluate((element) =>
      element.scrollIntoView({ block: "center", behavior: "instant" }),
    );
    const box = await row.boundingBox();
    if (!box) throw new Error("The row to swipe is not visible");
    const y = box.y + box.height / 2;
    // On the name, clear of the buttons at the right (menu, drag handle): they never swipe.
    const fromX = box.x + box.width * 0.6;
    const toX = box.x + box.width * 0.1;

    // The row may move between measuring it and touching it: the list of logements changes
    // whenever another test adds one. Lift the finger if it landed elsewhere, and try again.
    await row.evaluate((element) => {
      const probe = window as SwipeProbe;
      delete probe.e2eFingerOnRow;
      const record = (event: Event) => {
        probe.e2eFingerOnRow = element.contains(event.target as Node);
      };
      document.addEventListener("pointerdown", record, { once: true, capture: true });
    });
    await touch("touchStart", fromX, y);
    await page.waitForFunction(() => "e2eFingerOnRow" in window);
    if (!(await page.evaluate(() => (window as SwipeProbe).e2eFingerOnRow))) {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] });
      if (attempt < SWIPE_ATTEMPTS) continue;
      throw new Error("The finger kept landing outside the row to swipe");
    }

    // One move per frame, as a finger does. Moves sent back to back make a swipe of several
    // pixels per millisecond: the browser then takes the next tap (on a revealed « Supprimer »)
    // for one that stops a fling, and sends no click.
    for (let step = 1; step <= SWIPE_STEPS; step++) {
      await touch("touchMove", fromX + ((toX - fromX) * step) / SWIPE_STEPS, y);
      await nextFrames(page, 1);
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    return;
  }
}

/** A room's drag handle. */
export function roomHandle(page: Page, name: string): Locator {
  return page.getByRole("button", { name: `Déplacer ${name}`, exact: true });
}

/** A level's drag handle. */
export function levelHandle(page: Page, name: string): Locator {
  return page.getByRole("button", { name: `Déplacer le niveau ${name}`, exact: true });
}

/** Lets the page render: dnd-kit measures and detects collisions frame by frame. */
export async function nextFrames(page: Page, count = 2): Promise<void> {
  await page.evaluate(async (frames) => {
    for (let frame = 0; frame < frames; frame++) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
  }, count);
}

/**
 * The latest drag and drop announcement for screen readers (dnd-kit's live region), or an empty
 * string if no drag started yet.
 */
export async function dragAnnouncement(page: Page): Promise<string> {
  // Not a waiting locator: the live region stays empty until a drag starts. Other role="status"
  // elements may exist (the offline banner): the announcement is the one with French quotes.
  const texts = await page.getByRole("status").allTextContents();
  return (texts.find((text) => text.includes("«")) ?? "").replace(/\s+/g, " ").trim();
}

/** One finger on the touch screen, as `swipeLeft` drives it (DevTools protocol touch input). */
interface Finger {
  down(x: number, y: number): Promise<void>;
  move(x: number, y: number): Promise<void>;
  up(): Promise<void>;
}

async function withFinger<T>(page: Page, use: (finger: Finger) => Promise<T>): Promise<T> {
  const cdp = await touchSession(page);
  const touch = async (type: "touchStart" | "touchMove", x: number, y: number) => {
    await cdp.send("Input.dispatchTouchEvent", { type, touchPoints: [{ x, y }] });
  };
  return use({
    down: (x, y) => touch("touchStart", x, y),
    move: (x, y) => touch("touchMove", x, y),
    up: async () => {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    },
  });
}

/** The middle of a visible element, in the viewport's coordinates. */
async function centre(element: Locator): Promise<{ x: number; y: number }> {
  await element.hover({ trial: true }); // waits until it is visible, stable and not covered
  const box = await element.boundingBox();
  if (!box) throw new Error("The element is not visible");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/**
 * A thumb flicking the page from `element`: down, a quick `dy` vertical move (negative is up,
 * which scrolls down), up. No hold: what a scroll looks like.
 */
export async function flick(element: Locator, dy: number): Promise<void> {
  const page = element.page();
  const { x, y } = await centre(element);
  await withFinger(page, async (finger) => {
    await finger.down(x, y);
    for (let step = 1; step <= FLICK_STEPS; step++) {
      await finger.move(x, y + (dy * step) / FLICK_STEPS);
    }
    await finger.up();
  });
}

const FLICK_STEPS = 10;
const DRAG_STEP_PX = 8;
const MAX_DRAG_PX = 800;

/**
 * Drags an item by its handle, a few pixels at a time with a couple of frames in between, until
 * dnd-kit announces that dropped now, `item` would land at `position` ("position 2 sur 4 dans
 * « RDC »", "position 1 sur 3 parmi les niveaux"), then drops it there. With the mouse (dnd-kit
 * starts after 4 px), or with a finger, which first holds the handle still until the drag starts.
 *
 * Steering by the announcement, the feedback the app gives screen reader users, rather than by
 * coordinates computed beforehand keeps this independent of the layout, which changes during a
 * drag: a room entering another level pushes its new neighbours.
 */
export async function dragTo(
  handle: Locator,
  {
    item,
    position,
    direction,
    input = "mouse",
  }: { item: string; position: string; direction: "up" | "down"; input?: "mouse" | "touch" },
): Promise<void> {
  const page = handle.page();
  const over = `« ${item} », ${position}.`;
  const start = await centre(handle);
  const drag = async (pointer: Finger) => {
    const { x } = start;
    let y = start.y;
    const step = direction === "up" ? -DRAG_STEP_PX : DRAG_STEP_PX;
    await pointer.down(x, y);
    if (input === "touch") {
      // The hold: the row follows the finger only once dnd-kit has picked it up and says so (the
      // live region may still hold the end of a previous drag).
      await expect
        .poll(async () => {
          const said = await dragAnnouncement(page);
          return said.startsWith(`« ${item} »`) && !said.includes("déposé");
        })
        .toBe(true);
    }
    let reached = false;
    for (let travelled = 0; !reached && travelled < MAX_DRAG_PX; travelled += DRAG_STEP_PX) {
      y += step;
      await pointer.move(x, y);
      await nextFrames(page);
      if ((await dragAnnouncement(page)) !== over) continue;
      // Still over the target a few frames later: not a transient state while the layout shifts.
      await nextFrames(page);
      reached = (await dragAnnouncement(page)) === over;
    }
    if (!reached) {
      const last = await dragAnnouncement(page);
      await page.keyboard.press("Escape"); // cancels the drag rather than dropping anywhere
      await pointer.up();
      throw new Error(`dnd-kit never announced "${over}" (last: "${last}")`);
    }
    await pointer.up();
  };
  if (input === "touch") {
    await withFinger(page, drag);
  } else {
    await drag({
      down: async (x, y) => {
        await page.mouse.move(x, y);
        await page.mouse.down();
      },
      move: (x, y) => page.mouse.move(x, y),
      up: () => page.mouse.up(),
    });
  }
  await expect.poll(() => dragAnnouncement(page)).toBe(`« ${item} » déposé, ${position}.`);
}
