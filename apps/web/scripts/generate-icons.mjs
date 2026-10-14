// Renders the PNG app icons from their SVG sources (public/icons/*.svg).
// Run after editing an SVG: `pnpm --filter @repo/web icons`. The PNGs are committed.
import { readFile, writeFile } from "node:fs/promises";
import { Resvg } from "@resvg/resvg-js";

const iconsDir = new URL("../public/icons/", import.meta.url);

const targets = [
  { source: "icon.svg", output: "icon-192.png", size: 192 },
  { source: "icon.svg", output: "icon-512.png", size: 512 },
  { source: "maskable.svg", output: "maskable-512.png", size: 512 },
  // iOS draws its own rounded mask and ignores transparency: start from the full-bleed variant.
  { source: "maskable.svg", output: "apple-touch-icon.png", size: 180 },
];

for (const { source, output, size } of targets) {
  const svg = await readFile(new URL(source, iconsDir), "utf8");
  const png = new Resvg(svg, {
    fitTo: { mode: "width", value: size },
    font: { loadSystemFonts: false },
  })
    .render()
    .asPng();
  await writeFile(new URL(output, iconsDir), png);
  console.log(`public/icons/${output} (${size}×${size})`);
}
