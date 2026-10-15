import {
  addLevel,
  createProperty,
  deleteButton,
  expect,
  expectLevels,
  expectRooms,
  level,
  levelAction,
  levelHeader,
  moveRoomTo,
  newRoomInput,
  nextFrames,
  reloadOnceSynced,
  renameInPlace,
  room,
  roomAction,
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

  await test.step("« Terminé » keeps the room being typed", async () => {
    await newRoomInput(page, "RDC").fill("Buanderie");
    await level(page, "RDC").getByRole("button", { name: "Terminé", exact: true }).tap();
    await expect(newRoomInput(page, "RDC")).toBeHidden();
    await expectRooms(page, "RDC", ["Entrée", "Séjour", "Cuisine", "Buanderie"]);
  });

  await test.step("everything is saved", async () => {
    await reloadOnceSynced(page);
    await expectLevels(page, ["Sous-sol", "RDC", "R+1"]);
    await expectRooms(page, "Sous-sol", []);
    await expectRooms(page, "RDC", ["Entrée", "Séjour", "Cuisine", "Buanderie"]);
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

  await test.step("swipe a level: it only reveals a button, which a tap elsewhere hides", async () => {
    await swipeLeft(levelHeader(page, "R+1"));
    const remove = deleteButton(page, "le niveau « R+1 »");
    await expect(remove).toBeVisible();
    await expectLevels(page, ["RDC", "R+1"]);

    await structureSummary(page).tap();
    await expect(remove).toBeHidden();
    await expectLevels(page, ["RDC", "R+1"]);
    await expect(structureSummary(page)).toHaveText("2 niveaux, 5 pièces");
  });

  await test.step("swipe a level, tap « Supprimer », then undo", async () => {
    const message = "Niveau « R+1 » supprimé avec ses 2 pièces";
    await swipeLeft(levelHeader(page, "R+1"));
    await deleteButton(page, "le niveau « R+1 »").tap();
    await expect(toast(page, message)).toBeVisible();
    await expectLevels(page, ["RDC"]);

    await undo(page, message);
    await expectLevels(page, ["RDC", "R+1"]);
    await expectRooms(page, "R+1", ["Chambre 1", "Chambre 2"]);
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

test("the room suggestions stay within reach as rooms pile up above them", async ({ page }) => {
  await createProperty(page, uniqueName("Immeuble"));
  await addLevel(page, "R+1");
  const chip = roomSuggestion(page, "R+1", "Chambre");
  const actionBar = page.getByRole("button", { name: "Ajouter un niveau", exact: true });

  const names: string[] = [];
  for (let n = 1; n <= 14; n++) {
    // Where a thumb would find it, without scrolling: never under the bottom bar.
    const [chipBox, barBox] = await Promise.all([chip.boundingBox(), actionBar.boundingBox()]);
    if (!chipBox || !barBox) throw new Error("The suggestion and the bar should be visible");
    expect(chipBox.y + chipBox.height).toBeLessThanOrEqual(barBox.y);
    await chip.tap();
    names.push(`Chambre ${n}`);
    await expectRooms(page, "R+1", names);
    await nextFrames(page);
  }
});

test("act on a room from its menu: move it to another level, rename it, delete it", async ({
  page,
}) => {
  await createProperty(page, uniqueName("Maison"));
  await addLevel(page, "RDC");
  await typeRooms(page, "RDC", ["Entrée", "Bureau", "Cuisine"]);

  await test.step("with a single level, there is nowhere to move a room to", async () => {
    await page.getByRole("button", { name: "Actions de la pièce Bureau", exact: true }).tap();
    await expect(page.getByRole("menuitem", { name: "Déplacer vers…" })).toBeDisabled();
    await page.keyboard.press("Escape");
  });

  await addLevel(page, "R+1");
  await typeRooms(page, "R+1", ["Chambre 1"]);
  const moved = "Pièce « Bureau » déplacée vers « R+1 »";

  await test.step("« Déplacer vers… » sends the room to the end of the level picked", async () => {
    await moveRoomTo(page, "Bureau", "R+1");
    await expect(toast(page, moved)).toBeVisible();
    await expectRooms(page, "RDC", ["Entrée", "Cuisine"]);
    await expectRooms(page, "R+1", ["Chambre 1", "Bureau"]);
  });

  await test.step("undo puts it back where it was", async () => {
    await undo(page, moved);
    await expectRooms(page, "RDC", ["Entrée", "Bureau", "Cuisine"]);
    await expectRooms(page, "R+1", ["Chambre 1"]);
  });

  await test.step("rename and delete from the menu too", async () => {
    await roomAction(page, "Cuisine", "Renommer");
    const field = page.getByRole("textbox", { name: "Nom de la pièce", exact: true });
    await expect(field).toBeFocused();
    await field.fill("Cuisine ouverte");
    await field.press("Enter");
    await expectRooms(page, "RDC", ["Entrée", "Bureau", "Cuisine ouverte"]);

    await roomAction(page, "Entrée", "Supprimer la pièce");
    await expect(toast(page, "Pièce « Entrée » supprimée")).toBeVisible();
    await expectRooms(page, "RDC", ["Bureau", "Cuisine ouverte"]);
  });

  await test.step("a move is saved like any change", async () => {
    await moveRoomTo(page, "Bureau", "R+1");
    await expectRooms(page, "R+1", ["Chambre 1", "Bureau"]);
    await reloadOnceSynced(page);
    await expectRooms(page, "RDC", ["Cuisine ouverte"]);
    await expectRooms(page, "R+1", ["Chambre 1", "Bureau"]);
  });
});

test("duplicate a level with its rooms, then undo a copy", async ({ page }) => {
  await createProperty(page, uniqueName("Immeuble"));
  await addLevel(page, "RDC");
  await typeRooms(page, "RDC", ["Entrée", "Séjour"]);
  await addLevel(page, "R+1");
  await typeRooms(page, "R+1", ["Chambre 1", "Chambre 2", "Salle de bain"]);
  await expect(structureSummary(page)).toHaveText("2 niveaux, 5 pièces");

  await test.step("a floor becomes the next floor, its bedrooms numbered after the others", async () => {
    await levelAction(page, "R+1", "Dupliquer le niveau");
    await expect(toast(page, "Niveau « R+1 » dupliqué en « R+2 » avec ses 3 pièces")).toBeVisible();
    await expectLevels(page, ["RDC", "R+1", "R+2"]);
    await expectRooms(page, "R+2", ["Chambre 3", "Chambre 4", "Salle de bain"]);
    await expect(structureSummary(page)).toHaveText("3 niveaux, 8 pièces");
  });

  await test.step("another level is copied right after it; undo takes the copy back", async () => {
    const message = "Niveau « RDC » dupliqué en « RDC (copie) » avec ses 2 pièces";
    await levelAction(page, "RDC", "Dupliquer le niveau");
    await expectLevels(page, ["RDC", "RDC (copie)", "R+1", "R+2"]);
    await expectRooms(page, "RDC (copie)", ["Entrée", "Séjour"]);

    await undo(page, message);
    await expectLevels(page, ["RDC", "R+1", "R+2"]);
    await expect(structureSummary(page)).toHaveText("3 niveaux, 8 pièces");
  });

  await test.step("everything is saved", async () => {
    await reloadOnceSynced(page);
    await expectLevels(page, ["RDC", "R+1", "R+2"]);
    await expectRooms(page, "R+1", ["Chambre 1", "Chambre 2", "Salle de bain"]);
    await expectRooms(page, "R+2", ["Chambre 3", "Chambre 4", "Salle de bain"]);
  });
});
