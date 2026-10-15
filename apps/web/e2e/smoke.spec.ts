import { expect, expectSynced, test } from "./support";

// Like every spec, through ./support's `test`: an uncaught exception or a Content Security Policy
// violation fails it. It lasts until the first sync is over, so that startup is covered whole.
test("the app shell loads", async ({ page }) => {
  await page.goto("/");

  await expect(page).toHaveTitle("Relevé");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expectSynced(page);
});
