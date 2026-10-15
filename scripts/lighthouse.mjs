// Audits a running production build with Lighthouse the way a phone first loads it: mobile
// emulation (Moto G Power, simulated slow 4G, 4x CPU slowdown) and empty storage, so no service
// worker yet. Of a few runs, prints the scores of the four categories and the metrics of the
// one with the median performance score, and keeps that run's HTML report in .lighthouse/.
//
//   pnpm build && pnpm start              # or audit any deployed URL
//   pnpm lighthouse [url] [--runs=3] [--min=95]
//
// The URL defaults to http://localhost:3000; CHROME_PATH picks the browser. With --min, the
// script fails when a category of that run scores below it.
//
// Lighthouse runs through `pnpm dlx` rather than as a dependency: its hundred packages would sit
// in every install for an occasional audit, and its optional OpenTelemetry peer would split
// Vitest into two copies (and the types of the component tests with it).
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, readFile, rm } from "node:fs/promises";
import { parseArgs } from "node:util";

const LIGHTHOUSE = "lighthouse@13.5.0";
const CATEGORIES = ["performance", "accessibility", "best-practices", "seo"];
const METRICS = {
  "first-contentful-paint": "First Contentful Paint",
  "largest-contentful-paint": "Largest Contentful Paint",
  "total-blocking-time": "Total Blocking Time",
  "cumulative-layout-shift": "Cumulative Layout Shift",
  "speed-index": "Speed Index",
};
const REPORT_DIR = new URL("../.lighthouse/", import.meta.url);

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { runs: { type: "string", default: "3" }, min: { type: "string" } },
});
const url = positionals[0] ?? process.env.LIGHTHOUSE_URL ?? "http://localhost:3000";
const runs = Number(values.runs);
const min = values.min === undefined ? undefined : Number(values.min);

const score = (lhr, category) => Math.round((lhr.categories[category]?.score ?? 0) * 100);

const chromeFlags = [
  "--headless=new",
  // Chrome refuses to start sandboxed as root (containers, some CI images).
  ...(process.getuid?.() === 0 ? ["--no-sandbox"] : []),
];

await rm(REPORT_DIR, { recursive: true, force: true });
await mkdir(REPORT_DIR, { recursive: true });

/** One Lighthouse run; its reports are written next to `output`. */
function audit(output) {
  const { status } = spawnSync(
    "pnpm",
    [
      "dlx",
      LIGHTHOUSE,
      url,
      "--quiet",
      `--only-categories=${CATEGORIES.join(",")}`,
      `--chrome-flags=${chromeFlags.join(" ")}`,
      "--output=json",
      "--output=html",
      `--output-path=${output}`,
    ],
    { stdio: "inherit" },
  );
  return status === 0;
}

const results = [];
for (let run = 1; run <= runs; run++) {
  const output = new URL(`run-${run}`, REPORT_DIR).pathname;
  // Lighthouse occasionally fails to record a trace (NO_NAVSTART…): one more try.
  if (!audit(output) && !audit(output)) throw new Error(`Lighthouse failed twice (run ${run})`);
  const lhr = JSON.parse(await readFile(`${output}.report.json`, "utf8"));
  if (lhr.runtimeError) throw new Error(`${lhr.runtimeError.code}: ${lhr.runtimeError.message}`);
  for (const warning of lhr.runWarnings) console.warn(`Warning: ${warning}`);
  console.log(`Run ${run}/${runs}: ${CATEGORIES.map((c) => `${c} ${score(lhr, c)}`).join(", ")}`);
  results.push({ lhr, html: `${output}.report.html` });
}

// The run with the median performance score, as Lighthouse recommends for a noisy metric.
results.sort((a, b) => score(a.lhr, "performance") - score(b.lhr, "performance"));
const median = results[Math.floor(results.length / 2)];
const { lhr } = median;

console.log(
  `\nLighthouse ${lhr.lighthouseVersion}, ${url}, mobile: the median run by performance, of ${runs}`,
);
console.table(
  Object.fromEntries(CATEGORIES.map((category) => [category, { score: score(lhr, category) }])),
);
console.table(
  Object.fromEntries(
    Object.entries(METRICS).map(([id, name]) => [name, { value: lhr.audits[id]?.displayValue }]),
  ),
);

const report = new URL("report.html", REPORT_DIR).pathname;
await copyFile(median.html, report);
console.log(`Report of the median run: ${report}`);

const failing = CATEGORIES.filter((category) => min !== undefined && score(lhr, category) < min);
if (failing.length > 0) {
  console.error(`Below ${min}: ${failing.join(", ")}`);
  process.exitCode = 1;
}
