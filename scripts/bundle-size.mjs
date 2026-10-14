// Sizes of the built web app (apps/web/dist), compressed as they travel, against a budget:
// fails when the code a phone downloads before the first screen grows past it. Run after
// `pnpm build`: `pnpm size`.
//
// Budgets are in gzip kB (the server sends Brotli, smaller still, to browsers that accept it),
// with some headroom over the current sizes: raise one on purpose, in the commit that needs it.
import { readdir, readFile } from "node:fs/promises";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";

const BUDGETS_KB = {
  /** The entry chunk: React, the router, the app shell. */
  entry: 80,
  /** Everything the home screen needs before it renders: the entry and what index.html preloads. */
  initial: 220,
  /** All the JavaScript, lazily loaded screens included (the service worker precaches it all). */
  total: 260,
  /** The stylesheet. */
  css: 10,
};

const dist = new URL("../apps/web/dist/", import.meta.url);
const html = await readFile(new URL("index.html", dist), "utf8").catch(() => {
  throw new Error("No apps/web/dist/index.html: run `pnpm build` first");
});
const entry = html.match(/<script type="module" crossorigin src="\/(assets\/[^"]+\.js)"/)?.[1];
if (!entry) throw new Error("No entry script in apps/web/dist/index.html");
const preloaded = new Set(
  [...html.matchAll(/<link rel="modulepreload" crossorigin href="\/(assets\/[^"]+\.js)"/g)].map(
    (match) => match[1],
  ),
);

const kB = (bytes) => Math.round(bytes / 100) / 10;
/** When the browser downloads the file. */
function kindOf(path) {
  if (path.endsWith(".css")) return "css";
  if (path === entry) return "entry";
  return preloaded.has(path) ? "initial" : "lazy";
}

const files = [];
for (const name of await readdir(new URL("assets/", dist))) {
  if (!/\.(?:js|css)$/.test(name)) continue;
  const path = `assets/${name}`;
  const content = await readFile(new URL(path, dist));
  files.push({
    path,
    kind: kindOf(path),
    raw: content.length,
    gzip: gzipSync(content, { level: 9 }).length,
    brotli: brotliCompressSync(content, {
      params: { [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY },
    }).length,
  });
}
files.sort((a, b) => b.gzip - a.gzip);

console.table(
  Object.fromEntries(
    files.map(({ path, kind, raw, gzip, brotli }) => [
      path,
      { loaded: kind, "raw kB": kB(raw), "gzip kB": kB(gzip), "brotli kB": kB(brotli) },
    ]),
  ),
);

const scripts = files.filter((file) => file.path.endsWith(".js"));
const groups = {
  entry: scripts.filter((file) => file.kind === "entry"),
  initial: scripts.filter((file) => file.kind === "entry" || file.kind === "initial"),
  total: scripts,
  css: files.filter((file) => file.kind === "css"),
};
const sum = (group, encoding) => kB(group.reduce((total, file) => total + file[encoding], 0));

let failed = false;
for (const [name, budget] of Object.entries(BUDGETS_KB)) {
  const gzip = sum(groups[name], "gzip");
  const ok = gzip <= budget;
  failed ||= !ok;
  console.log(
    `${ok ? "ok  " : "OVER"} ${name.padEnd(8)} ${gzip.toFixed(1).padStart(6)} kB gzip ` +
      `(${sum(groups[name], "brotli").toFixed(1)} kB Brotli), budget ${budget} kB`,
  );
}
if (failed) {
  console.error(
    "Over budget: shrink the bundle, or raise the budget on purpose (scripts/bundle-size.mjs).",
  );
  process.exitCode = 1;
}
