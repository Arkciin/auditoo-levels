/**
 * Colour contrast of the design tokens (styles.css), in both themes, for every pairing the UI
 * paints. WCAG 2.2 AA: 4.5:1 for text (1.4.3), 3:1 for field outlines, focus rings and icons
 * (1.4.11). The end-to-end accessibility scans check rendered screens; this checks the palette
 * itself, states that are hard to reach in a scan included (a highlighted menu item).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const TEXT = 4.5;
const NON_TEXT = 3;

type Theme = Record<string, string>;
type Rgb = readonly [number, number, number];
/** A token, or a token at some opacity over another (Tailwind's `bg-destructive/10`). */
type Surface = string | { readonly tint: string; readonly alpha: number; readonly over: string };

interface Pairing {
  readonly where: string;
  readonly fg: string;
  readonly bg: Surface;
  readonly min: number;
}

const PAIRINGS: readonly Pairing[] = [
  { where: "body text", fg: "foreground", bg: "background", min: TEXT },
  { where: "text in sheets, fields and chips", fg: "foreground", bg: "card", min: TEXT },
  { where: "pressed and highlighted rows", fg: "foreground", bg: "muted", min: TEXT },
  { where: "secondary buttons", fg: "secondary-foreground", bg: "secondary", min: TEXT },
  { where: "counts and hints", fg: "muted-foreground", bg: "background", min: TEXT },
  { where: "sheet descriptions, placeholders", fg: "muted-foreground", bg: "card", min: TEXT },
  { where: "icons of a highlighted menu item", fg: "muted-foreground", bg: "muted", min: NON_TEXT },
  { where: "main buttons, toast actions", fg: "primary-foreground", bg: "primary", min: TEXT },
  { where: "« Ajouter une pièce », links", fg: "primary", bg: "background", min: TEXT },
  {
    where: "the strip behind a swiped row",
    fg: "destructive-foreground",
    bg: "destructive",
    min: TEXT,
  },
  { where: "« Supprimer » menu items", fg: "destructive", bg: "popover", min: TEXT },
  {
    where: "« Supprimer » menu items, highlighted",
    fg: "destructive",
    bg: { tint: "destructive", alpha: 0.1, over: "popover" },
    min: TEXT,
  },
  {
    where: "the « Erreur » sync pill",
    fg: "destructive",
    bg: { tint: "destructive", alpha: 0.1, over: "background" },
    min: TEXT,
  },
  { where: "the offline banner and pill", fg: "warning-foreground", bg: "warning", min: TEXT },
  { where: "the « À jour » sync pill", fg: "success", bg: "background", min: TEXT },
  { where: "the pending changes badge", fg: "background", bg: "foreground", min: TEXT },
  { where: "selected text", fg: "accent-foreground", bg: "accent", min: TEXT },
  { where: "field and chip outlines", fg: "input", bg: "background", min: NON_TEXT },
  { where: "field outlines in sheets", fg: "input", bg: "card", min: NON_TEXT },
  { where: "the focus ring", fg: "ring", bg: "background", min: NON_TEXT },
  { where: "the focus ring in sheets and menus", fg: "ring", bg: "card", min: NON_TEXT },
];

const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

/** The hex colour custom properties of the `{…}` block that follows `marker`. */
function tokensAfter(marker: string, from = 0): Theme {
  const start = css.indexOf(marker, from);
  if (start < 0) throw new Error(`styles.css has no ${marker}`);
  const open = css.indexOf("{", start + marker.length - 1);
  const body = css.slice(open + 1, css.indexOf("}", open));
  return Object.fromEntries(
    [...body.matchAll(/--([\w-]+):\s*(#[\da-f]{6})\b/gi)].map(([, name, hex]) => [name, hex]),
  );
}

const light = tokensAfter(":root {");
const dark = tokensAfter(":root {", css.indexOf("@media (prefers-color-scheme: dark) {"));
const THEMES = { light, dark: { ...light, ...dark } } as const;

function rgb(theme: Theme, token: string): Rgb {
  const hex = theme[token];
  if (!hex) throw new Error(`Unknown token --${token}`);
  const channel = (at: number) => Number.parseInt(hex.slice(at, at + 2), 16);
  return [channel(1), channel(3), channel(5)];
}

/** Alpha compositing in sRGB, as browsers paint a translucent background. */
function paint(theme: Theme, surface: Surface): Rgb {
  if (typeof surface === "string") return rgb(theme, surface);
  const top = rgb(theme, surface.tint);
  const under = rgb(theme, surface.over);
  const mix = (i: 0 | 1 | 2) => surface.alpha * top[i] + (1 - surface.alpha) * under[i];
  return [mix(0), mix(1), mix(2)];
}

/** WCAG 2.x relative luminance and contrast ratio. */
function luminance([r, g, b]: Rgb): number {
  const linear = (channel: number) => {
    const c = channel / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

function contrast(a: Rgb, b: Rgb): number {
  const [la, lb] = [luminance(a), luminance(b)];
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

const describeSurface = (surface: Surface) =>
  typeof surface === "string"
    ? surface
    : `${surface.tint}/${surface.alpha * 100} on ${surface.over}`;

for (const [name, theme] of Object.entries(THEMES)) {
  describe(`${name} theme`, () => {
    for (const { where, fg, bg, min } of PAIRINGS) {
      const pair = `${fg} on ${describeSurface(bg)}`;
      const ratio = contrast(rgb(theme, fg), paint(theme, bg));
      // The ratio is in the test name: `vitest --reporter=verbose` prints the whole palette.
      it(`${where}: ${pair}, ${ratio.toFixed(2)}:1 (minimum ${min}:1)`, () => {
        expect(ratio, pair).toBeGreaterThanOrEqual(min);
      });
    }
  });
}

it("dark mode redefines every colour token", () => {
  expect(Object.keys(dark).sort()).toEqual(Object.keys(light).sort());
});
