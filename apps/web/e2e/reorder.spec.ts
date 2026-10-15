import type { Page } from "@playwright/test";

import {
  addLevel,
  createProperty,
  dragAnnouncement,
  dragTo,
  expect,
  expectLevels,
  expectRooms,
  expectSynced,
  flick,
  levelHandle,
  levelName,
  nextFrames,
  reloadOnceSynced,
  roomHandle,
  rooms,
  savedOnServer,
  test,
  toast,
  typeRooms,
  undo,
  uniqueName,
} from "./support";

/** RDC [Entrée, Séjour, Cuisine], R+1 [Chambre 1, Bureau], then Mezzanine (empty). */
async function createHouse(page: Page): Promise<void> {
  await createProperty(page, uniqueName("Maison"));
  await addLevel(page, "RDC");
  await typeRooms(page, "RDC", ["Entrée", "Séjour", "Cuisine"]);
  await addLevel(page, "R+1");
  await typeRooms(page, "R+1", ["Chambre 1", "Bureau"]);
  await addLevel(page, "Mezzanine", { typed: true }); // a name the app cannot place: at the end
  await expectRooms(page, "R+1", ["Chambre 1", "Bureau"]);
  // Freshly loaded, the room fields are closed: the whole house fits on the screen.
  await reloadOnceSynced(page);
  await expectLevels(page, ["RDC", "R+1", "Mezzanine"]);
}

test("reorder rooms and levels with their drag handles", async ({ page }) => {
  await createHouse(page);

  await test.step("move a room up within its level", async () => {
    await savedOnServer(page, () =>
      dragTo(roomHandle(page, "Cuisine"), {
        item: "Cuisine",
        position: "position 1 sur 3 dans « RDC »",
        direction: "up",
      }),
    );
    await expectRooms(page, "RDC", ["Cuisine", "Entrée", "Séjour"]);

    await page.reload();
    await expectRooms(page, "RDC", ["Cuisine", "Entrée", "Séjour"]);
  });

  await test.step("move a room to another level", async () => {
    // Bureau leaves R+1 for RDC, listed above it: it enters RDC at its end, then travels up the
    // list to Entrée's place.
    await savedOnServer(page, () =>
      dragTo(roomHandle(page, "Bureau"), {
        item: "Bureau",
        position: "position 2 sur 4 dans « RDC »",
        direction: "up",
      }),
    );
    await expectRooms(page, "RDC", ["Cuisine", "Bureau", "Entrée", "Séjour"]);
    await expectRooms(page, "R+1", ["Chambre 1"]);

    await page.reload();
    await expectRooms(page, "RDC", ["Cuisine", "Bureau", "Entrée", "Séjour"]);
    await expectRooms(page, "R+1", ["Chambre 1"]);
  });

  await test.step("move a level between two others", async () => {
    await savedOnServer(page, () =>
      dragTo(levelHandle(page, "Mezzanine"), {
        item: "Mezzanine",
        position: "position 2 sur 3 parmi les niveaux",
        direction: "up",
      }),
    );
    await expectLevels(page, ["RDC", "Mezzanine", "R+1"]);

    await page.reload();
    await expectLevels(page, ["RDC", "Mezzanine", "R+1"]);
    // Levels move with their rooms.
    await expectRooms(page, "RDC", ["Cuisine", "Bureau", "Entrée", "Séjour"]);
    await expectRooms(page, "Mezzanine", []);
    await expectRooms(page, "R+1", ["Chambre 1"]);
  });
});

test("with the keyboard, a room is announced in French where it would land", async ({ page }) => {
  await createHouse(page);
  // Headings are named by the level alone: renaming is the description of the name inside.
  await expect(page.getByRole("heading", { level: 2, name: "RDC", exact: true })).toBeVisible();
  await expect(levelName(page, "RDC")).toHaveAccessibleDescription("Renommer");
  const handle = roomHandle(page, "Bureau");
  await expect(handle).toHaveAttribute("aria-roledescription", "poignée de déplacement");

  await handle.focus();
  await page.keyboard.press("Space");
  await expect
    .poll(() => dragAnnouncement(page))
    .toMatch(/^« Bureau »( saisi)?, position 2 sur 2 dans « R\+1 »\.$/);

  // Up, room by room, into RDC above: each step says where Bureau would land, never « près de ».
  let said = "";
  for (let press = 0; press < 8 && !said.includes("« RDC »"); press++) {
    await page.keyboard.press("ArrowUp");
    await nextFrames(page);
    said = await dragAnnouncement(page);
    expect(said).toMatch(/^« Bureau », position \d sur \d dans « (R\+1|RDC) »\.$/);
  }
  const landing = /^« Bureau », (position (\d) sur 4 dans « RDC »)\.$/.exec(said);
  if (!landing?.[1] || !landing[2]) throw new Error(`Bureau never entered RDC (last: "${said}")`);

  await page.keyboard.press("Space");
  await expect.poll(() => dragAnnouncement(page)).toBe(`« Bureau » déposé, ${landing[1]}.`);
  await expect(rooms(page, "RDC").nth(Number(landing[2]) - 1)).toHaveText("Bureau");
  await expectRooms(page, "R+1", ["Chambre 1"]);
});

test("a drop can be taken back from its toast", async ({ page }) => {
  await createHouse(page);

  await test.step("a room dropped in another level goes back to its level and place", async () => {
    const message = "Pièce « Bureau » déplacée vers « RDC »";
    await dragTo(roomHandle(page, "Bureau"), {
      item: "Bureau",
      position: "position 2 sur 4 dans « RDC »",
      direction: "up",
    });
    await expect(toast(page, message)).toBeVisible();
    await expectRooms(page, "RDC", ["Entrée", "Bureau", "Séjour", "Cuisine"]);

    await undo(page, message);
    await expectRooms(page, "RDC", ["Entrée", "Séjour", "Cuisine"]);
    await expectRooms(page, "R+1", ["Chambre 1", "Bureau"]);
  });

  await test.step("a room dropped within its level goes back to its place", async () => {
    const message = "Pièce « Cuisine » déplacée";
    await dragTo(roomHandle(page, "Cuisine"), {
      item: "Cuisine",
      position: "position 1 sur 3 dans « RDC »",
      direction: "up",
    });
    await expect(toast(page, message)).toBeVisible();
    await expectRooms(page, "RDC", ["Cuisine", "Entrée", "Séjour"]);

    await undo(page, message);
    await expectRooms(page, "RDC", ["Entrée", "Séjour", "Cuisine"]);
  });

  await test.step("a level goes back to its place", async () => {
    const message = "Niveau « Mezzanine » déplacé";
    await dragTo(levelHandle(page, "Mezzanine"), {
      item: "Mezzanine",
      position: "position 2 sur 3 parmi les niveaux",
      direction: "up",
    });
    await expect(toast(page, message)).toBeVisible();
    await expectLevels(page, ["RDC", "Mezzanine", "R+1"]);

    await undo(page, message);
    await expectLevels(page, ["RDC", "R+1", "Mezzanine"]);
  });

  await reloadOnceSynced(page);
  await expectLevels(page, ["RDC", "R+1", "Mezzanine"]);
  await expectRooms(page, "RDC", ["Entrée", "Séjour", "Cuisine"]);
  await expectRooms(page, "R+1", ["Chambre 1", "Bureau"]);
});

test("with a finger, a row follows once its handle is held: within a level, to another level", async ({
  page,
}) => {
  await createHouse(page);

  await test.step("hold Cuisine's handle, then move it up within its level", async () => {
    await savedOnServer(page, () =>
      dragTo(roomHandle(page, "Cuisine"), {
        item: "Cuisine",
        position: "position 1 sur 3 dans « RDC »",
        direction: "up",
        input: "touch",
      }),
    );
    await expectRooms(page, "RDC", ["Cuisine", "Entrée", "Séjour"]);
  });

  await test.step("hold Bureau's handle, then move it to another level", async () => {
    await savedOnServer(page, () =>
      dragTo(roomHandle(page, "Bureau"), {
        item: "Bureau",
        position: "position 2 sur 4 dans « RDC »",
        direction: "up",
        input: "touch",
      }),
    );
    await expectRooms(page, "RDC", ["Cuisine", "Bureau", "Entrée", "Séjour"]);
    await expectRooms(page, "R+1", ["Chambre 1"]);
  });

  await page.reload();
  await expectRooms(page, "RDC", ["Cuisine", "Bureau", "Entrée", "Séjour"]);
  await expectRooms(page, "R+1", ["Chambre 1"]);
});

test("a flick that starts on a drag handle scrolls the page and moves nothing", async ({
  page,
}) => {
  // The example house is taller than the screen: four levels, fifteen rooms.
  await page.goto("/");
  await expectSynced(page);
  await page.getByRole("button", { name: "Plus d’actions", exact: true }).tap();
  await page.getByRole("menuitem", { name: "Ajouter un logement d’exemple", exact: true }).tap();
  await expect(page).toHaveURL(/\/logements\/[\da-f-]{36}$/);
  const basement = ["Cave", "Chaufferie", "Garage"];
  const groundFloor = ["Entrée", "Séjour", "Cuisine", "WC", "Cellier"];
  await expectRooms(page, "RDC", groundFloor);
  await expectSynced(page);
  const scrollY = () => page.evaluate(() => window.scrollY);
  expect(await scrollY()).toBe(0);

  // The thumb lands on the handles at the right edge as often as anywhere else.
  await flick(roomHandle(page, "Séjour"), -150);

  await expect.poll(scrollY).toBeGreaterThan(50);
  await nextFrames(page, 5);
  expect(await dragAnnouncement(page), "no drag started").toBe("");
  await expectRooms(page, "Sous-sol", basement);
  await expectRooms(page, "RDC", groundFloor);
  await expectSynced(page);
});

// Steers by the finger (the test above steers by the announced drop target).
test("a level dropped with the finger on another level takes its place", async ({ page }) => {
  await createHouse(page);
  const grip = levelHandle(page, "Mezzanine");
  await grip.hover();
  const start = await grip.boundingBox();
  if (!start) throw new Error("Mezzanine's drag handle is not visible");
  const x = start.x + start.width / 2;
  let y = start.y + start.height / 2;
  await page.mouse.down();
  y -= 8; // past dnd-kit's 4 px threshold: the drag starts
  await page.mouse.move(x, y);

  // The finger goes to R+1's header.
  const r1 = await levelHandle(page, "R+1").boundingBox();
  if (!r1) throw new Error("R+1's drag handle is not visible");
  const goal = r1.y + r1.height / 2;
  while (y > goal) {
    y = Math.max(goal, y - 8);
    await page.mouse.move(x, y);
    await nextFrames(page);
  }
  await page.mouse.up();
  await expectLevels(page, ["RDC", "Mezzanine", "R+1"]);
});
