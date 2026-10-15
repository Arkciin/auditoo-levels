import {
  addLevel,
  createProperty,
  expect,
  expectRooms,
  expectSynced,
  moveRoomTo,
  roomAction,
  test,
  toast,
  typeRooms,
  uniqueName,
} from "./support";

// Sheets and toasts: a toast never covers a sheet, and no tap goes through one to it.

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
