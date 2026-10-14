import type { Page } from "@playwright/test";

import {
  addLevel,
  createProperty,
  dragAnnouncement,
  dragOnto,
  expect,
  expectLevels,
  expectRooms,
  expectSynced,
  flick,
  levelHandle,
  nextFrames,
  reloadOnceSynced,
  roomHandle,
  savedOnServer,
  test,
  typeRooms,
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
      dragOnto(roomHandle(page, "Cuisine"), { item: "Cuisine", target: "Entrée", direction: "up" }),
    );
    await expectRooms(page, "RDC", ["Cuisine", "Entrée", "Séjour"]);

    await page.reload();
    await expectRooms(page, "RDC", ["Cuisine", "Entrée", "Séjour"]);
  });

  await test.step("move a room to another level", async () => {
    // Bureau leaves R+1 for RDC, listed above it: it enters RDC at its end, then travels up the
    // list to Entrée's place.
    await savedOnServer(page, () =>
      dragOnto(roomHandle(page, "Bureau"), { item: "Bureau", target: "Entrée", direction: "up" }),
    );
    await expectRooms(page, "RDC", ["Cuisine", "Bureau", "Entrée", "Séjour"]);
    await expectRooms(page, "R+1", ["Chambre 1"]);

    await page.reload();
    await expectRooms(page, "RDC", ["Cuisine", "Bureau", "Entrée", "Séjour"]);
    await expectRooms(page, "R+1", ["Chambre 1"]);
  });

  await test.step("move a level between two others", async () => {
    await savedOnServer(page, () =>
      dragOnto(levelHandle(page, "Mezzanine"), {
        item: "Mezzanine",
        target: "R+1",
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

test("with a finger, a row follows once its handle is held: within a level, to another level", async ({
  page,
}) => {
  await createHouse(page);

  await test.step("hold Cuisine's handle, then move it up within its level", async () => {
    await savedOnServer(page, () =>
      dragOnto(roomHandle(page, "Cuisine"), {
        item: "Cuisine",
        target: "Entrée",
        direction: "up",
        input: "touch",
      }),
    );
    await expectRooms(page, "RDC", ["Cuisine", "Entrée", "Séjour"]);
  });

  await test.step("hold Bureau's handle, then move it to another level", async () => {
    await savedOnServer(page, () =>
      dragOnto(roomHandle(page, "Bureau"), {
        item: "Bureau",
        target: "Entrée",
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
