import {
  addLevel,
  createProperty,
  expect,
  expectRooms,
  expectSynced,
  offlineBanner,
  renameInPlace,
  roomName,
  syncPill,
  test,
  toast,
  typeRooms,
  uniqueName,
} from "./support";

test("the app says it works offline once installed, and only then", async ({ page }) => {
  const message = "Relevé fonctionne maintenant sans réseau.";
  // Every test starts in a new browser context: this is the first visit, which installs the worker.
  await page.goto("/");
  await expect(toast(page, message)).toBeVisible({ timeout: 15_000 });

  // The worker was already active when this page loaded: nothing new to announce.
  await page.reload();
  await page.waitForLoadState("load");
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForTimeout(1_500);
  await expect(toast(page, message)).toHaveCount(0);
});

test("edits made offline survive a reload and sync once back online", async ({
  page,
  context,
  secondDevice,
}) => {
  await createProperty(page, uniqueName("Maison"));
  const url = page.url();
  await addLevel(page, "RDC");
  await expectSynced(page); // from now on, only what is done offline is pending

  await test.step("the service worker controls the page", async () => {
    // It claims the page once installed, that is once it has precached the whole app shell.
    await expect
      .poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null), {
        timeout: 15_000,
      })
      .toBe(true);
  });

  await test.step("offline, the banner and the pill say so", async () => {
    await context.setOffline(true);
    await expect(offlineBanner(page)).toHaveText(
      "Hors ligne. Vos modifications restent sur cet appareil et partiront au retour du réseau.",
    );
    await expect(syncPill(page)).toHaveAccessibleName("Hors ligne. Voir le détail");
  });

  await test.step("rooms added offline wait on the device", async () => {
    await typeRooms(page, "RDC", ["Cuisine", "Séjour", "WC"]);
    await expectRooms(page, "RDC", ["Cuisine", "Séjour", "WC"]);
    await expect(syncPill(page)).toHaveAccessibleName(
      "Hors ligne, 3 modifications en attente. Voir le détail",
    );
  });

  await test.step("reload offline: app shell from the service worker, data from IndexedDB", async () => {
    await page.reload();
    await expectRooms(page, "RDC", ["Cuisine", "Séjour", "WC"]);
    await expect(offlineBanner(page)).toBeVisible();
    await expect(syncPill(page)).toHaveAccessibleName(
      "Hors ligne, 3 modifications en attente. Voir le détail",
    );
    // The pill's badge, for sighted users.
    await expect(syncPill(page).getByText("3", { exact: true })).toBeVisible();
  });

  await test.step("back online, the pending edits are sent", async () => {
    await context.setOffline(false);
    await expectSynced(page);
    await expect(syncPill(page)).toHaveText("À jour");
    await expect(offlineBanner(page)).toBeHidden();
  });

  await test.step("another device gets them", async () => {
    await secondDevice.goto(url);
    await expectRooms(secondDevice, "RDC", ["Cuisine", "Séjour", "WC"]);
  });
});

test("a phone with a network the server does not answer on says so, not « Hors ligne »", async ({
  page,
}) => {
  await createProperty(page, uniqueName("Maison"));
  await expectSynced(page);

  // The phone has a network (`navigator.onLine`), but requests fail: a network too weak, or a
  // server waking up.
  await page.route(/\/api\/(push|pull)$/, (route) => route.abort("connectionfailed"));
  await addLevel(page, "RDC");
  await expect(syncPill(page)).toHaveAccessibleName(
    "Serveur injoignable, 1 modification en attente. Voir le détail",
  );
  // The banner would send the user looking for a network they have.
  await expect(offlineBanner(page)).toBeHidden();

  await syncPill(page).tap();
  const sheet = page.getByRole("dialog", { name: "Serveur injoignable" });
  await expect(
    sheet.getByText(/^Nouvel essai (automatique dans \d+\s+s\.|en cours…)$/),
  ).toBeVisible();

  await page.unrouteAll();
  await sheet.getByRole("button", { name: "Synchroniser maintenant" }).tap();
  await expect(page.getByRole("dialog", { name: "Tout est à jour" })).toBeVisible();
});

test("a rename on one device shows up on another without a reload", async ({
  page,
  secondDevice,
}) => {
  await createProperty(page, uniqueName("Maison"));
  await addLevel(page, "RDC");
  await typeRooms(page, "RDC", ["Cuisine"]);
  await expectRooms(page, "RDC", ["Cuisine"]);
  await expectSynced(page);

  await secondDevice.goto(page.url());
  await expectRooms(secondDevice, "RDC", ["Cuisine"]);
  // A mark on this very document: a reload would wipe it.
  await secondDevice.evaluate(() => Object.assign(window, { e2eSameDocument: true }));

  await renameInPlace(
    roomName(page, "Cuisine"),
    page.getByRole("textbox", { name: "Nom de la pièce", exact: true }),
    "Cuisine ouverte",
  );

  // The server pokes the other device over server-sent events and it pulls at once. Its periodic
  // pull only comes every 30 s, past this timeout.
  await expectRooms(secondDevice, "RDC", ["Cuisine ouverte"], { timeout: 10_000 });
  expect(await secondDevice.evaluate(() => "e2eSameDocument" in window)).toBe(true);
});
