import type { Page } from "@playwright/test";
import {
  addLevel,
  createProperty,
  expect,
  expectLevels,
  expectRooms,
  levelAction,
  propertyRow,
  reloadOnceSynced,
  roomAction,
  structureSummary,
  test,
  toast,
  typeRooms,
  uniqueName,
} from "./support";

// Deletes are soft: once the undo toast is gone, the sheets of deleted items still bring them back.

/** Past the undo toast's 6 seconds: then only the sheets of deleted items can restore. */
async function waitForToastToGo(page: Page, message: string): Promise<void> {
  await expect(toast(page, message)).toBeHidden({ timeout: 10_000 });
}

test("a deleted logement comes back from « Logements supprimés » once its toast is gone", async ({
  page,
}) => {
  const name = uniqueName("Maison");
  await createProperty(page, name);
  await addLevel(page, "RDC");
  await typeRooms(page, "RDC", ["Cuisine"]);

  await page.getByRole("button", { name: "Actions du logement", exact: true }).tap();
  await page.getByRole("menuitem", { name: "Supprimer le logement", exact: true }).tap();
  const deleted = `Logement « ${name} » supprimé`;
  await expect(toast(page, deleted)).toBeVisible();
  await waitForToastToGo(page, deleted);
  await expect(propertyRow(page, name)).toHaveCount(0);

  await test.step("the home screen's menu lists it, with what it holds", async () => {
    await page.getByRole("button", { name: "Plus d’actions", exact: true }).tap();
    await page.getByRole("menuitem", { name: "Logements supprimés", exact: true }).tap();
    const sheet = page.getByRole("dialog", { name: "Logements supprimés" });
    const entry = sheet.getByRole("listitem").filter({ hasText: name });
    await expect(entry).toContainText("1 niveau, 1 pièce · supprimé à l’instant");

    await entry.getByRole("button", { name: `Restaurer le logement ${name}`, exact: true }).tap();
    await expect(sheet).toBeHidden();
    await expect(toast(page, `Logement « ${name} » restauré`)).toBeVisible();
    await expect(propertyRow(page, name)).toContainText("1 niveau, 1 pièce");
  });

  await test.step("it is restored for good", async () => {
    await reloadOnceSynced(page);
    await expect(propertyRow(page, name)).toContainText("1 niveau, 1 pièce");
  });
});

test("a deleted room and level come back from « Éléments supprimés » once their toasts are gone", async ({
  page,
}) => {
  await createProperty(page, uniqueName("Maison"));
  await addLevel(page, "RDC");
  await typeRooms(page, "RDC", ["Entrée", "Cuisine"]);
  await addLevel(page, "R+1");
  await typeRooms(page, "R+1", ["Chambre 1"]);

  await roomAction(page, "Cuisine", "Supprimer la pièce");
  await levelAction(page, "R+1", "Supprimer le niveau");
  await waitForToastToGo(page, "Pièce « Cuisine » supprimée");
  await waitForToastToGo(page, "Niveau « R+1 » supprimé avec sa pièce");
  await expect(structureSummary(page)).toHaveText("1 niveau, 1 pièce");

  const sheet = page.getByRole("dialog", { name: "Éléments supprimés" });
  async function openSheet(): Promise<void> {
    await page.getByRole("button", { name: "Actions du logement", exact: true }).tap();
    await page.getByRole("menuitem", { name: "Éléments supprimés", exact: true }).tap();
    await expect(sheet).toBeVisible();
  }

  await test.step("the logement's menu lists both, each with where it was", async () => {
    await openSheet();
    await expect(sheet.getByRole("region", { name: "Niveaux" }).getByRole("listitem")).toHaveText([
      /^R\+1\s*1\s+pièce · supprimé à l’instant/,
    ]);
    await expect(sheet.getByRole("region", { name: "Pièces" }).getByRole("listitem")).toHaveText([
      /^Cuisine\s*Niveau RDC · supprimée à l’instant/,
    ]);
  });

  await test.step("a room comes back to its level", async () => {
    await sheet.getByRole("button", { name: "Restaurer la pièce Cuisine", exact: true }).tap();
    await expect(sheet).toBeHidden();
    await expect(toast(page, "Pièce « Cuisine » restaurée")).toBeVisible();
    await expectRooms(page, "RDC", ["Entrée", "Cuisine"]);
  });

  await test.step("a level comes back with its room", async () => {
    await openSheet();
    await sheet.getByRole("button", { name: "Restaurer le niveau R+1", exact: true }).tap();
    await expect(sheet).toBeHidden();
    await expect(toast(page, "Niveau « R+1 » restauré avec sa pièce")).toBeVisible();
    await expectLevels(page, ["RDC", "R+1"]);
    await expectRooms(page, "R+1", ["Chambre 1"]);

    await openSheet();
    await expect(sheet.getByText("Aucun élément supprimé", { exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
  });

  await test.step("both are restored for good", async () => {
    await reloadOnceSynced(page);
    await expectLevels(page, ["RDC", "R+1"]);
    await expectRooms(page, "RDC", ["Entrée", "Cuisine"]);
    await expectRooms(page, "R+1", ["Chambre 1"]);
  });
});
