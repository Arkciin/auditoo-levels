import { expectAccessible, expectAccessibleMenu } from "./accessibility";
import {
  addLevel,
  backToList,
  createProperty,
  expect,
  expectSynced,
  offlineBanner,
  propertyRow,
  room,
  roomName,
  swipeLeft,
  syncPill,
  test,
  toast,
  typeRooms,
  uniqueName,
} from "./support";

// Every screen and every sheet, menu, field and banner it can show, scanned in both themes.

test("logements: the empty list, its menu and the « Nouveau logement » sheet", async ({ page }) => {
  // Tests share one server: this device is shown an empty one.
  await page.route("**/api/pull", (route) =>
    route.fulfill({
      json: {
        epoch: "00000000-0000-4000-8000-000000000000",
        cursor: 0,
        lastMutationId: 0,
        reset: false,
        changes: { properties: [], levels: [], spaces: [] },
      },
    }),
  );
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Aucun logement pour l’instant" })).toBeVisible();
  await expectSynced(page);
  await expectAccessible(page, "empty list of logements");

  await page.getByRole("button", { name: "Plus d’actions" }).tap();
  await expectAccessibleMenu(page, "menu of the list");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toBeHidden();

  await page.getByRole("button", { name: "Nouveau logement", exact: true }).last().tap();
  await expect(page.getByRole("dialog", { name: "Nouveau logement" })).toBeVisible();
  await expectAccessible(page, "« Nouveau logement » sheet");
});

test("logements: the list", async ({ page }) => {
  const name = uniqueName("Maison");
  await createProperty(page, name);
  await addLevel(page, "RDC");
  await typeRooms(page, "RDC", ["Cuisine"]);
  await backToList(page);
  await expect(propertyRow(page, name)).toContainText("1 niveau, 1 pièce");

  await expectAccessible(page, "list of logements");
});

test("structure: levels, rooms, renaming, menus and the undo toast", async ({ page }) => {
  await createProperty(page, uniqueName("Maison"));
  await expect(page.getByRole("heading", { name: "Aucun niveau pour l’instant" })).toBeVisible();
  await expectAccessible(page, "logement without levels");

  await page.getByRole("button", { name: "Ajouter un niveau", exact: true }).tap();
  const levelSheet = page.getByRole("dialog", { name: "Ajouter un niveau" });
  await expect(levelSheet).toBeVisible();
  await expectAccessible(page, "« Ajouter un niveau » sheet");
  await levelSheet.getByRole("button", { name: "RDC", exact: true }).tap();
  await expect(levelSheet).toBeHidden();

  await typeRooms(page, "RDC", ["Entrée", "Cuisine", "Séjour"]);
  await expectAccessible(page, "levels and rooms, room entry open");

  await roomName(page, "Cuisine").tap();
  const renameField = page.getByRole("textbox", { name: "Nom de la pièce", exact: true });
  await expect(renameField).toBeFocused();
  await expectAccessible(page, "a room being renamed");
  await expect(renameField, "still renaming after both scans").toBeFocused();
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "Actions du niveau RDC", exact: true }).tap();
  await expectAccessibleMenu(page, "menu of a level");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toBeHidden();

  await page.getByRole("button", { name: "Actions du logement", exact: true }).tap();
  await expectAccessibleMenu(page, "menu of the logement");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toBeHidden();

  await swipeLeft(room(page, "RDC", "Séjour"));
  await expect(toast(page, "Pièce « Séjour » supprimée")).toBeVisible();
  await expectAccessible(page, "undo toast");
});

test("sync status: the details sheet, offline banner and pending changes", async ({
  page,
  context,
}) => {
  await createProperty(page, uniqueName("Maison"));
  await addLevel(page, "RDC");
  await expectSynced(page);

  await syncPill(page).tap();
  const synced = page.getByRole("dialog", { name: "Tout est à jour" });
  await expect(synced).toBeVisible();
  await expectAccessible(page, "sync sheet, everything saved");
  await page.keyboard.press("Escape");
  await expect(synced).toBeHidden();

  await context.setOffline(true);
  await expect(offlineBanner(page)).toBeVisible();
  // A long offline stretch: more pending changes than the sheet shows without scrolling.
  await typeRooms(
    page,
    "RDC",
    Array.from({ length: 14 }, (_, index) => `Pièce ${index + 1}`),
  );
  await expectAccessible(page, "offline banner");

  await syncPill(page).tap();
  const sheet = page.getByRole("dialog", { name: "Hors ligne" });
  await expect(sheet).toBeVisible();
  const details = sheet.getByRole("region", { name: "Détail des modifications" });
  await expect(
    details.getByRole("heading", { name: /modifications sur cet appareil$/ }),
  ).toBeVisible();
  const scrolled = () => details.evaluate((element) => element.scrollTop);
  expect(await details.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(
    true,
  );
  await expectAccessible(page, "sync sheet, offline with pending changes");

  // The details scroll and may hold nothing focusable: they take the focus themselves, so keys
  // scroll them.
  await details.focus();
  await page.keyboard.press("PageDown");
  await expect.poll(scrolled).toBeGreaterThan(0);
});

test("an unknown address", async ({ page }) => {
  await page.goto("/nulle-part");
  await expect(page.getByRole("heading", { name: "Page introuvable" })).toBeVisible();

  await expectAccessible(page, "unknown address");
});

test("a browser that blocks storage", async ({ page }) => {
  // As some private modes do: opening IndexedDB fails.
  await page.addInitScript(() => {
    IDBFactory.prototype.open = () => {
      throw new DOMException("Storage is blocked", "SecurityError");
    };
  });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Stockage indisponible" })).toBeVisible();

  await expectAccessible(page, "storage unavailable");
});
