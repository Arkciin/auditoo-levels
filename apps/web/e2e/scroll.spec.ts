import type { Page } from "@playwright/test";
import {
  addLevel,
  createProperty,
  expect,
  expectSynced,
  offlineBanner,
  roomName,
  syncPill,
  test,
  typeRooms,
  uniqueName,
} from "./support";

// What scrolls the page, and what must not: the bars stay put, and what the keyboard reaches
// shows clear of them.

/** A logement with a level of `count` rooms: taller than the screen. */
async function longLogement(page: Page, count: number): Promise<void> {
  await createProperty(page, uniqueName("Maison"));
  await addLevel(page, "RDC");
  await typeRooms(
    page,
    "RDC",
    Array.from({ length: count }, (_, index) => `Pièce ${index + 1}`),
  );
  await expectSynced(page);
}

const scrollY = (page: Page) => page.evaluate(() => window.scrollY);

test("a tap in the header or the bottom bar leaves the page where it is", async ({ page }) => {
  await longLogement(page, 16);
  await page.evaluate(() => window.scrollTo({ top: 400, behavior: "instant" }));
  const scrolled = await scrollY(page);
  expect(scrolled).toBeGreaterThan(300);

  for (const button of [
    syncPill(page),
    page.getByRole("button", { name: "Actions du logement", exact: true }),
    page.getByRole("button", { name: "Ajouter un niveau", exact: true }),
  ]) {
    // A finger where the button shows: `tap()` would first scroll it into view, as the browser
    // reveals it, which is what is under test. Each opens a sheet or a menu, which Escape closes,
    // and the focus comes back to the button: that too must leave the page where it is.
    const box = await button.boundingBox();
    if (!box) throw new Error(`${button} is not on screen`);
    await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
    const opened = page.getByRole("dialog").or(page.getByRole("menu"));
    await expect(opened).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(opened).toBeHidden();
    await expect(button).toBeFocused();
    expect(await scrollY(page), `scrolled after a tap on ${button}`).toBe(scrolled);
  }
});

test("a row reached with Tab shows clear of the header, offline banner included", async ({
  page,
  context,
}) => {
  await longLogement(page, 20);
  const header = page.getByRole("banner");
  const name = roomName(page, "Pièce 5");
  const menuButton = page.getByRole("button", { name: "Actions de la pièce Pièce 5", exact: true });

  async function shiftTabToRowUnderHeader(): Promise<void> {
    // The row's top just under the header's top edge, its ⋮ focused without scrolling: Shift+Tab
    // then reaches its name, which the browser scrolls into view.
    await name.evaluate((element) =>
      window.scrollBy({ top: element.getBoundingClientRect().top - 10, behavior: "instant" }),
    );
    const headerBox = await header.boundingBox();
    if (!headerBox) throw new Error("No header");
    const headerBottom = headerBox.y + headerBox.height;
    expect((await name.boundingBox())?.y).toBeLessThan(headerBottom);
    await menuButton.evaluate((element) => (element as HTMLElement).focus({ preventScroll: true }));

    await page.keyboard.press("Shift+Tab");
    await expect(name).toBeFocused();
    await expect
      .poll(async () => (await name.boundingBox())?.y ?? 0, {
        message: "the name clears the header",
      })
      .toBeGreaterThanOrEqual(headerBottom - 0.5);
  }

  await shiftTabToRowUnderHeader();

  await context.setOffline(true);
  await expect(offlineBanner(page)).toBeVisible();
  await shiftTabToRowUnderHeader();
});
