import { expect, expectSynced, propertyTitle, renameInPlace, test, uniqueName } from "./support";

test("a logement's name shows in full, then in the header once scrolled under it", async ({
  page,
}) => {
  // An address about as long as names go, on a logement tall enough to scroll.
  const name = `${uniqueName("Résidence")}, bâtiment C, 145 avenue du Général-de-Gaulle, Lyon`;
  await page.goto("/");
  await expectSynced(page);
  await page.getByRole("button", { name: "Plus d’actions", exact: true }).tap();
  await page.getByRole("menuitem", { name: "Ajouter un logement d’exemple", exact: true }).tap();
  await expect(page).toHaveURL(/\/logements\//);
  const field = page.getByRole("textbox", { name: "Nom du logement", exact: true });
  await renameInPlace(propertyTitle(page, "Maison exemple, 8 rue des Tilleuls"), field, name);

  const title = propertyTitle(page, name);
  // Not a heading, nor in the accessibility tree: a visual copy of the title.
  const headerCopy = page.getByRole("banner").getByText(name, { exact: true });

  await test.step("at the top: the whole name, over several lines, and not in the header", async () => {
    await expect(title).toBeVisible();
    const box = await title.evaluate((element) => ({
      truncated: element.scrollWidth > element.clientWidth,
      height: element.clientHeight,
      lineHeight: Number.parseFloat(getComputedStyle(element).lineHeight),
    }));
    expect(box.truncated).toBe(false);
    expect(box.height).toBeGreaterThan(box.lineHeight * 1.5);
    await expect(headerCopy).toHaveCSS("opacity", "0");
  });

  await test.step("scrolled under the header, the name shows there", async () => {
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await expect(headerCopy).toHaveCSS("opacity", "1");
    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
  });

  await test.step("renamed from the menu, the field comes into view with the focus", async () => {
    const newName = uniqueName("Maison");
    await page.getByRole("button", { name: "Actions du logement", exact: true }).tap();
    await page.getByRole("menuitem", { name: "Renommer le logement", exact: true }).tap();
    await expect(field).toBeFocused();
    await expect(field).toBeInViewport();
    await field.fill(newName);
    await field.press("Enter");
    await expect(propertyTitle(page, newName)).toBeVisible();
    await expect(page.getByRole("banner").getByText(newName, { exact: true })).toHaveCSS(
      "opacity",
      "0",
    );
  });
});
