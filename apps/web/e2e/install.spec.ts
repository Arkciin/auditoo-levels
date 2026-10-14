import { devices, type Page } from "@playwright/test";

import { expect, test } from "./support";

const INSTALL = "Installer l’application";

function overflowMenu(page: Page) {
  return page.getByRole("button", { name: "Plus d’actions", exact: true });
}

test("install from the home screen's menu once the browser offers it", async ({ page }) => {
  await page.goto("/");
  await overflowMenu(page).tap();
  await expect(page.getByRole("menuitem", { name: "Ajouter un logement d’exemple" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: INSTALL })).toHaveCount(0);
  await page.keyboard.press("Escape");

  // What Chrome does once the app is installable (headless Chromium never does it by itself).
  await page.evaluate(() => {
    const offer = new Event("beforeinstallprompt", { cancelable: true });
    Object.assign(offer, {
      prompt: () => {
        Object.assign(window, { e2ePrompted: true });
        return Promise.resolve();
      },
      userChoice: Promise.resolve({ outcome: "accepted" }),
    });
    window.dispatchEvent(offer);
  });
  await overflowMenu(page).tap();
  await page.getByRole("menuitem", { name: INSTALL }).tap();
  await expect.poll(() => page.evaluate(() => "e2ePrompted" in window)).toBe(true);

  // The browser offers installation once: the item is gone.
  await overflowMenu(page).tap();
  await expect(page.getByRole("menuitem", { name: "Ajouter un logement d’exemple" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: INSTALL })).toHaveCount(0);
});

test.describe("on an iPhone", () => {
  // Safari's user agent is all the app looks at (iOS has no install prompt to detect).
  test.use({ userAgent: devices["iPhone 15"].userAgent });

  test("the menu explains how to install from Safari's Share menu, and why", async ({ page }) => {
    await page.goto("/");
    await overflowMenu(page).tap();
    await page.getByRole("menuitem", { name: INSTALL }).tap();

    const sheet = page.getByRole("dialog", { name: "Installer Relevé" });
    await expect(sheet.getByRole("listitem").first()).toContainText("Partager");
    await expect(sheet).toContainText("Sur l’écran d’accueil");
    await expect(sheet).toContainText("iOS conserve les données des applications installées");

    await sheet.getByRole("button", { name: "Compris", exact: true }).tap();
    await expect(sheet).toBeHidden();
  });
});
