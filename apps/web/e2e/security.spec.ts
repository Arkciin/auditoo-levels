import { expect, test } from "./support";

// Every test fails on a Content Security Policy violation (support.ts): the app works under the
// policy. These show that the browser does enforce it, and understands the Permissions-Policy.

test("the browser blocks scripts the Content Security Policy does not allow", async ({
  page,
  cspViolations,
}) => {
  const response = await page.goto("/");
  expect(response?.headers()["content-security-policy"]).toContain("script-src 'self'");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

  await page.evaluate(() => {
    // As an injection would: an inline script, and code compiled from a string (a string timer
    // runs in the page, where `new Function` called from here would be exempt as DevTools code).
    const script = document.createElement("script");
    script.textContent = "window.e2eInline = true";
    document.head.append(script);
    (window.setTimeout as unknown as (code: string) => number)("window.e2eEvaluated = true");
  });

  await expect
    .poll(() => cspViolations.map((violation) => violation.split(":")[0]).sort())
    .toEqual(["script-src blocked eval", "script-src-elem blocked inline"]);
  expect(
    await page.evaluate(() => ["e2eInline", "e2eEvaluated"].filter((key) => key in window)),
  ).toEqual([]);
  cspViolations.splice(0); // provoked on purpose
});

test("the browser applies the Permissions-Policy and recognises all of it", async ({ page }) => {
  const complaints: string[] = [];
  page.on("console", (message) => {
    if (/Permissions-Policy/i.test(message.text())) complaints.push(message.text());
  });
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

  const allowed = await page.evaluate(() => {
    // Chromium's API, missing from TypeScript's DOM library.
    const { featurePolicy } = document as { featurePolicy?: { allowsFeature(f: string): boolean } };
    return ["camera", "geolocation", "microphone", "payment", "usb"].filter(
      (feature) => featurePolicy?.allowsFeature(feature) ?? true,
    );
  });

  expect(allowed).toEqual([]);
  expect(complaints, "unrecognised or malformed features").toEqual([]);
});
