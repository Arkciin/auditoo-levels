import {
  addLevel,
  createProperty,
  expect,
  expectRooms,
  expectSynced,
  syncPill,
  test,
  toast,
  typeRooms,
  uniqueName,
} from "./support";

interface SentPush {
  mutations: Array<{ name: string; args: { name?: string } }>;
}

test("a change the server rejects is announced, then listed in the sync sheet", async ({
  page,
}) => {
  await createProperty(page, uniqueName("Maison"));
  await addLevel(page, "RDC");
  await expectSynced(page);

  // Stands for another version of the app, whose input rules differ: the name the server receives
  // for this room breaks its rules, so it rejects the room (and acknowledges it all the same).
  await page.route("**/api/push", async (route) => {
    const push = route.request().postDataJSON() as SentPush;
    for (const mutation of push.mutations) {
      if (mutation.name === "createSpace" && mutation.args.name === "Cuisine") {
        mutation.args.name = "";
      }
    }
    await route.continue({ postData: JSON.stringify(push) });
  });
  await typeRooms(page, "RDC", ["Cuisine", "Salon"]);

  const message =
    "La pièce « Cuisine » n'a pas pu être ajoutée : le serveur a jugé la modification invalide.";
  await expect(toast(page, message)).toBeVisible();
  await expectRooms(page, "RDC", ["Salon"]);
  await expectSynced(page);

  await syncPill(page).tap();
  const sheet = page.getByRole("dialog", { name: "Tout est à jour" });
  const rejection = sheet
    .getByRole("region", { name: "1 modification non appliquée" })
    .getByRole("listitem");
  await expect(rejection).toHaveCount(1);
  await expect(rejection).toContainText(message);
  await expect(rejection).toContainText("à l’instant");
  await expect(toast(page, message)).toBeHidden(); // The sheet says it now: no toast over it.
});

test("the sync sheet keeps its times current while it is open", async ({ page, context }) => {
  await page.clock.install();
  await createProperty(page, uniqueName("Maison"));
  await expectSynced(page);
  await context.setOffline(true); // No sync can happen: the last one only grows older.

  await syncPill(page).tap();
  const sheet = page.getByRole("dialog", { name: "Hors ligne" });
  await expect(sheet.getByText("Dernière synchronisation à l’instant.")).toBeVisible();

  await page.clock.fastForward("02:00");
  await expect(sheet.getByText("Dernière synchronisation il y a 2 minutes.")).toBeVisible();
});
