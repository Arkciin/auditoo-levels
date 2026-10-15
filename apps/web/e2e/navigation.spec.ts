import {
  addLevel,
  backToList,
  createProperty,
  expect,
  expectRooms,
  expectSynced,
  newRoomInput,
  propertyRow,
  propertyTitle,
  roomName,
  test,
  toast,
  typeRooms,
  uniqueName,
} from "./support";

// The system back button (`page.goBack()`): after leaving a logement, it must never lead back to
// it; on a logement's screen, it must not lose what is being typed.

test("the back arrow goes back to the list, so the system back button then leaves it", async ({
  page,
}) => {
  const name = uniqueName("Maison");
  await createProperty(page, name); // opened from the list, on top of it

  await backToList(page);
  await expect(page).toHaveURL("/");
  await expect(propertyRow(page, name)).toContainText("Aucun niveau");

  await page.goBack();
  await expect(page).not.toHaveURL(/\/logements\//);
});

test("a logement opened from a link leaves for the list in its place", async ({
  page,
  secondDevice,
}) => {
  const name = uniqueName("Maison");
  await createProperty(page, name);
  await expectSynced(page);

  // The link is the first page this phone opens: there is no list behind the logement.
  await secondDevice.goto(page.url());
  await expect(propertyTitle(secondDevice, name)).toBeVisible();
  await backToList(secondDevice);
  await expect(secondDevice).toHaveURL("/");
  await expect(propertyRow(secondDevice, name)).toBeVisible();

  await secondDevice.goBack();
  await expect(secondDevice).not.toHaveURL(/\/logements\//);
});

/** Set by the page once « Logement introuvable » has been on screen, if only for a frame. */
type MissingProbe = { e2eSawMissing?: boolean };

test("a logement deleted from its screen is left for good, without « Logement introuvable »", async ({
  page,
}) => {
  const name = uniqueName("Maison");
  await createProperty(page, name);
  await page.evaluate(() => {
    new MutationObserver(() => {
      if (document.body.textContent?.includes("Logement introuvable")) {
        (window as MissingProbe).e2eSawMissing = true;
      }
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
  });

  await page.getByRole("button", { name: "Actions du logement", exact: true }).tap();
  await page.getByRole("menuitem", { name: "Supprimer le logement", exact: true }).tap();
  await expect(toast(page, `Logement « ${name} » supprimé`)).toBeVisible();
  await expect(page).toHaveURL("/");
  await expect(propertyRow(page, name)).toHaveCount(0);
  expect(await page.evaluate(() => (window as MissingProbe).e2eSawMissing ?? false)).toBe(false);

  await page.goBack();
  await expect(page).not.toHaveURL(/\/logements\//);
  await expect(page.getByText("Logement introuvable")).toHaveCount(0);
});

test("the system back button keeps what was being typed: a room, a new name", async ({ page }) => {
  const name = uniqueName("Maison");
  await createProperty(page, name);
  await addLevel(page, "RDC");
  await typeRooms(page, "RDC", ["Cuisine"]);

  await newRoomInput(page, "RDC").fill("Salon"); // no Enter, no « Terminé »
  await page.goBack();
  await expect(propertyRow(page, name)).toBeVisible();
  await page.goForward();
  await expectRooms(page, "RDC", ["Cuisine", "Salon"]);

  await roomName(page, "Cuisine").tap();
  await page.getByRole("textbox", { name: "Nom de la pièce" }).fill("Cuisine ouverte");
  await page.goBack();
  await expect(propertyRow(page, name)).toBeVisible();
  await page.goForward();
  await expectRooms(page, "RDC", ["Cuisine ouverte", "Salon"]);
});
