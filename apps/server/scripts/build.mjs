// Bundles the server (and the shared package, which is TypeScript source) into dist/index.js.
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

await build({
  absWorkingDir: fileURLToPath(new URL("..", import.meta.url)),
  entryPoints: ["src/index.ts"],
  outfile: "dist/index.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: true,
  // Loaded from node_modules at runtime: pg optionally requires the native pg-native binding,
  // and PGlite locates its WASM and data files next to its own modules.
  external: ["pg", "pg-native", "@electric-sql/pglite"],
  // `require` does not exist in an ES module; bundled CommonJS code may still call it.
  banner: {
    js: [
      'import { createRequire } from "node:module";',
      "const require = createRequire(import.meta.url);",
    ].join("\n"),
  },
  logLevel: "info",
});
