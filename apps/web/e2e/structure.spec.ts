import {
  addLevel,
  createProperty,
  expect,
  expectLevels,
  expectRooms,
  reloadOnceSynced,
  renameInPlace,
  room,
  roomName,
  roomSuggestion,
  structureSummary,
  swipeLeft,
  test,
  toast,
  typeRooms,
  undo,
  uniqueName,
} from "./support";

test("add levels from the sheet and rooms by typing or from suggestions", async ({ page }) => {
  await createProperty(page, uniqueName("Maison"));

  await test.step("levels picked in the sheet are placed by floor", async () => {
    await addLevel(page, "RDC");
    await addLevel(page, "R+1");
    await expectLevels(page, ["RDC", "R+1"]);
    // Levels are listed lowest first: a basement goes before the ground floor.
    await addLevel(page, "Sous-sol");
    await expectLevels(page, ["Sous-sol", "RDC", "R+1"]);
  });

  await test.step("rooms typed one after the other, Enter after each", async () => {
    await typeRooms(page, "RDC", ["Entrée", "Séjour", "Cuisine"]);
    await expectRooms(page, "RDC", ["Entrée", "Séjour", "Cuisine"]);
  });

  await test.step("a suggestion chip numbers the rooms it adds", async () => {
    const chambre = roomSuggestion(page, "R+1", "Chambre");
    await chambre.tap();
    await expectRooms(page, "R+1", ["Chambre 1"]);
    await chambre.tap();
    await expectRooms(page, "R+1", ["Chambre 1", "Chambre 2"]);
    await expect(structureSummary(page)).toHaveText("3 niveaux, 5 pièces");
  });

  await test.step("everything is saved", async () => {
    await reloadOnceSynced(page);
    await expectLevels(page, ["Sous-sol", "RDC", "R+1"]);
    await expectRooms(page, "Sous-sol", []);
    await expectRooms(page, "RDC", ["Entrée", "Séjour", "Cuisine"]);
    await expectRooms(page, "R+1", ["Chambre 1", "Chambre 2"]);
  });
});

test("rename a room in place, undo the deletion of a room or a level", async ({ page }) => {
  await createProperty(page, uniqueName("Maison"));
  await addLevel(page, "RDC");
  await typeRooms(page, "RDC", ["Entrée", "Séjour", "Cuisine"]);
  await addLevel(page, "R+1");
  await typeRooms(page, "R+1", ["Chambre 1", "Chambre 2"]);
  await expect(structureSummary(page)).toHaveText("2 niveaux, 5 pièces");

  await test.step("tap a room's name, type, Enter", async () => {
    await renameInPlace(
      roomName(page, "Séjour"),
      page.getByRole("textbox", { name: "Nom de la pièce", exact: true }),
      "Salon",
    );
    await expectRooms(page, "RDC", ["Entrée", "Salon", "Cuisine"]);
  });

  await test.step("swipe a room away, then undo", async () => {
    const message = "Pièce « Cuisine » supprimée";
    await swipeLeft(room(page, "RDC", "Cuisine"));
    await expect(toast(page, message)).toBeVisible();
    await expectRooms(page, "RDC", ["Entrée", "Salon"]);

    await undo(page, message);
    await expectRooms(page, "RDC", ["Entrée", "Salon", "Cuisine"]);
  });

  await test.step("delete a level from its menu, then undo", async () => {
    const message = "Niveau « R+1 » supprimé avec ses 2 pièces";
    await page.getByRole("button", { name: "Actions du niveau R+1", exact: true }).tap();
    await page.getByRole("menuitem", { name: "Supprimer le niveau" }).tap();
    await expect(toast(page, message)).toBeVisible();
    await expectLevels(page, ["RDC"]);
    await expect(structureSummary(page)).toHaveText("1 niveau, 3 pièces");

    await undo(page, message);
    await expectLevels(page, ["RDC", "R+1"]);
    await expectRooms(page, "R+1", ["Chambre 1", "Chambre 2"]);
    await expect(structureSummary(page)).toHaveText("2 niveaux, 5 pièces");
  });

  await test.step("everything is saved", async () => {
    await reloadOnceSynced(page);
    await expectLevels(page, ["RDC", "R+1"]);
    await expectRooms(page, "RDC", ["Entrée", "Salon", "Cuisine"]);
    await expectRooms(page, "R+1", ["Chambre 1", "Chambre 2"]);
  });
});
