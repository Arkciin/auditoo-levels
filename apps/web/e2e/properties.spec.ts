import {
  addLevel,
  backToList,
  createProperty,
  expect,
  expectSynced,
  propertyRow,
  propertyTitle,
  renameInPlace,
  structureSummary,
  swipeLeft,
  test,
  toast,
  typeRooms,
  undo,
  uniqueName,
} from "./support";

test("create a logement, rename it, swipe it away and undo", async ({ page, secondDevice }) => {
  const name = uniqueName("Maison");
  const newName = uniqueName("Appartement");

  await test.step("create it from the « Nouveau logement » sheet: its screen opens", async () => {
    await createProperty(page, name);
    await expect(structureSummary(page)).toHaveText("0 niveau, 0 pièce");
    await expect(page.getByRole("heading", { name: "Aucun niveau pour l’instant" })).toBeVisible();

    // Something to count on the list.
    await addLevel(page, "RDC");
    await typeRooms(page, "RDC", ["Cuisine", "Séjour"]);
    await expect(structureSummary(page)).toHaveText("1 niveau, 2 pièces");
  });

  await test.step("back on the list, it shows its counts", async () => {
    await backToList(page);
    await expect(page).toHaveURL("/");
    await expect(propertyRow(page, name)).toContainText("1 niveau, 2 pièces");
  });

  await test.step("rename it from the header of its screen", async () => {
    await propertyRow(page, name).getByRole("link").tap();
    await renameInPlace(
      propertyTitle(page, name),
      page.getByRole("textbox", { name: "Nom du logement", exact: true }),
      newName,
    );
    await expect(propertyTitle(page, newName)).toBeVisible();

    await backToList(page);
    await expect(propertyRow(page, newName)).toContainText("1 niveau, 2 pièces");
    await expect(propertyRow(page, name)).toHaveCount(0);
  });

  await test.step("swipe its row to the left, then undo from the toast", async () => {
    const message = `Logement « ${newName} » supprimé`;
    await swipeLeft(propertyRow(page, newName));
    await expect(toast(page, message)).toBeVisible();
    await expect(propertyRow(page, newName)).toHaveCount(0);

    await undo(page, message);
    await expect(propertyRow(page, newName)).toContainText("1 niveau, 2 pièces");
  });

  await test.step("the server has it: another device lists it, renamed", async () => {
    await expectSynced(page);
    await secondDevice.goto("/");
    await expect(propertyRow(secondDevice, newName)).toContainText("1 niveau, 2 pièces");
    await expect(propertyRow(secondDevice, name)).toHaveCount(0);
  });
});
