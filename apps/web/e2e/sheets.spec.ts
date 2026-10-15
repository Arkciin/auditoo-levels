import type { Locator } from "@playwright/test";
import {
  addLevel,
  backToList,
  createProperty,
  expect,
  expectRooms,
  expectSynced,
  moveRoomTo,
  roomAction,
  syncPill,
  test,
  toast,
  typeRooms,
  uniqueName,
} from "./support";

// Sheets: the focus goes into them and comes back out to what opened them; a toast never covers
// one, and no tap goes through a toast to it.

/** Opens a sheet as a keyboard does: the focus on its trigger, then Enter. */
async function openWithKeyboard(trigger: Locator): Promise<void> {
  await trigger.focus();
  await trigger.press("Enter");
}

/** Picks `item` in the menu of `menuButton` (⋮) with the keyboard. */
async function pickWithKeyboard(menuButton: Locator, item: string): Promise<void> {
  await openWithKeyboard(menuButton);
  await menuButton.page().getByRole("menuitem", { name: item, exact: true }).press("Enter");
}

/** The focus is in `sheet`, and stays there as Tab goes round. */
async function expectFocusKept(sheet: Locator): Promise<void> {
  const page = sheet.page();
  const focusInSheet = () => sheet.evaluate((element) => element.contains(document.activeElement));
  for (const key of ["Tab", "Tab", "Shift+Tab", "Shift+Tab", "Shift+Tab"]) {
    await page.keyboard.press(key);
    expect(await focusInSheet(), `the focus is still in the sheet after ${key}`).toBe(true);
  }
}

async function closeWithEscape(sheet: Locator): Promise<void> {
  await sheet.page().keyboard.press("Escape");
  await expect(sheet).toBeHidden();
}

test("each sheet takes the focus as it opens, and gives it back to what opened it", async ({
  page,
}) => {
  await createProperty(page, uniqueName("Maison"));
  await addLevel(page, "RDC");
  await typeRooms(page, "RDC", ["Entrée"]);
  await addLevel(page, "R+1");

  await test.step("« Ajouter un niveau »: the sheet, not its field (no keyboard over the suggestions)", async () => {
    const trigger = page.getByRole("button", { name: "Ajouter un niveau", exact: true });
    const sheet = page.getByRole("dialog", { name: "Ajouter un niveau" });
    await openWithKeyboard(trigger);
    await expect(sheet).toBeFocused();
    await expectFocusKept(sheet);
    await closeWithEscape(sheet);
    await expect(trigger).toBeFocused();
  });

  await test.step("« Éléments supprimés », from the logement's menu, and back to its ⋮", async () => {
    const menuButton = page.getByRole("button", { name: "Actions du logement", exact: true });
    const sheet = page.getByRole("dialog", { name: "Éléments supprimés" });
    await pickWithKeyboard(menuButton, "Éléments supprimés");
    await expect(sheet).toBeFocused();
    await closeWithEscape(sheet);
    await expect(menuButton).toBeFocused();
  });

  await test.step("« Déplacer vers… », from a room's menu, and back to its ⋮", async () => {
    const menuButton = page.getByRole("button", {
      name: "Actions de la pièce Entrée",
      exact: true,
    });
    const sheet = page.getByRole("dialog", { name: "Déplacer « Entrée »" });
    await pickWithKeyboard(menuButton, "Déplacer vers…");
    await expect(sheet).toBeFocused();
    await expectFocusKept(sheet);
    await closeWithEscape(sheet);
    await expect(menuButton).toBeFocused();
  });

  await backToList(page);

  await test.step("« Nouveau logement »: its field, ready for typing", async () => {
    const trigger = page.getByRole("button", { name: "Nouveau logement", exact: true }).last();
    const sheet = page.getByRole("dialog", { name: "Nouveau logement" });
    await openWithKeyboard(trigger);
    await expect(sheet.getByRole("textbox", { name: "Adresse ou nom du logement" })).toBeFocused();
    await expectFocusKept(sheet);
    await closeWithEscape(sheet);
    await expect(trigger).toBeFocused();
  });

  await test.step("« Logements supprimés », from the home screen's menu, and back to its ⋮", async () => {
    const menuButton = page.getByRole("button", { name: "Plus d’actions", exact: true });
    const sheet = page.getByRole("dialog", { name: "Logements supprimés" });
    await pickWithKeyboard(menuButton, "Logements supprimés");
    await expect(sheet).toBeFocused();
    await closeWithEscape(sheet);
    await expect(menuButton).toBeFocused();
  });

  await test.step("the sync sheet, and back to the pill", async () => {
    const sheet = page.getByRole("dialog", { name: "Tout est à jour" });
    await openWithKeyboard(syncPill(page));
    await expect(sheet).toBeFocused();
    await expectFocusKept(sheet);
    await closeWithEscape(sheet);
    await expect(syncPill(page)).toBeFocused();
  });
});

interface SentPush {
  mutations: Array<{ name: string; args: { name?: string } }>;
}

test("opening a sheet dismisses the toasts on screen: none hides it or takes its taps", async ({
  page,
}) => {
  await createProperty(page, uniqueName("Maison"));
  await addLevel(page, "RDC");
  await typeRooms(page, "RDC", ["Entrée", "Cuisine"]);
  await addLevel(page, "R+1");
  await typeRooms(page, "R+1", ["Chambre 1"]);

  const moved = "Pièce « Cuisine » déplacée vers « R+1 »";
  await moveRoomTo(page, "Cuisine", "R+1");
  await expect(toast(page, moved)).toBeVisible();

  // Within the toast's 6 seconds, the next room's « Déplacer vers… »: its levels lie where the
  // toast was, and a tap on the toast's « Annuler » used to move the room to the one under it.
  await roomAction(page, "Entrée", "Déplacer vers…");
  const sheet = page.getByRole("dialog", { name: "Déplacer « Entrée »" });
  await expect(sheet).toBeVisible();
  await expect(toast(page, moved)).toBeHidden({ timeout: 1_500 });

  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
  await expectRooms(page, "RDC", ["Entrée"]);
  await expectRooms(page, "R+1", ["Chambre 1", "Cuisine"]);
});

test("a toast raised while a sheet is open shows above the sheet, and takes its own taps", async ({
  page,
}) => {
  await createProperty(page, uniqueName("Maison"));
  await addLevel(page, "RDC");
  await expectSynced(page);

  // The server rejects the next room (see sync-sheet.spec.ts), and answers once a sheet is open.
  let sheetIsOpen = () => {};
  const sheetOpened = new Promise<void>((resolve) => {
    sheetIsOpen = resolve;
  });
  await page.route("**/api/push", async (route) => {
    const push = route.request().postDataJSON() as SentPush;
    const room = push.mutations.find(
      (mutation) => mutation.name === "createSpace" && mutation.args.name === "Cuisine",
    );
    if (room) {
      room.args.name = "";
      await sheetOpened;
    }
    await route.continue({ postData: JSON.stringify(push) });
  });
  await typeRooms(page, "RDC", ["Cuisine"]);
  await page.getByRole("button", { name: "Ajouter un niveau", exact: true }).tap();
  const sheet = page.getByRole("dialog", { name: "Ajouter un niveau" });
  await expect(sheet).toBeVisible();
  sheetIsOpen();

  const rejected = toast(page, "La pièce « Cuisine » n'a pas pu être ajoutée");
  await expect(rejected).toBeVisible();
  const [toastBox, sheetBox] = await Promise.all([rejected.boundingBox(), sheet.boundingBox()]);
  if (!toastBox || !sheetBox) throw new Error("The toast or the sheet is not on screen");
  expect(toastBox.y + toastBox.height, "the toast ends above the sheet").toBeLessThan(sheetBox.y);

  // Playwright taps only once the toast itself would receive the tap, not what lies under it.
  await rejected.tap();
  await page.waitForTimeout(600); // a sheet closing would be gone by now
  await expect(sheet).toBeVisible();
  await expect(sheet).toHaveAttribute("data-state", "open");
});
