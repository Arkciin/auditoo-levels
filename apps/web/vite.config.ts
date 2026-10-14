import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, constants } from "node:zlib";
import { serwist } from "@serwist/vite";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type HtmlTagDescriptor, type Plugin } from "vite";

const srcDir = fileURLToPath(new URL("./src", import.meta.url));
const outDir = fileURLToPath(new URL("./dist", import.meta.url));

/**
 * The router splits each screen from the entry and requests it once the app runs, that is after
 * the entry has loaded and IndexedDB has opened. `modulepreload` the home screen and the chunks it
 * imports (layout, sheets and menus, shared by every screen) next to the entry instead: on a slow
 * connection, that takes a round trip and a download off the first render.
 */
function preloadHomeScreen(): Plugin {
  return {
    name: "releve:preload-home-screen",
    apply: "build",
    transformIndexHtml: {
      order: "post",
      handler(html, { bundle }) {
        const chunks = Object.values(bundle ?? {}).filter((output) => output.type === "chunk");
        const home = chunks.find((chunk) =>
          chunk.facadeModuleId?.endsWith("/src/routes/index.tsx?tsr-split=component"),
        );
        if (!home) throw new Error("No chunk for the home screen (src/routes/index.tsx)");
        const scripts = [home.fileName, ...home.imports]
          .filter((file) => !html.includes(`/${file}"`))
          .map(
            (file): HtmlTagDescriptor => ({
              tag: "link",
              attrs: { rel: "modulepreload", crossorigin: true, href: `/${file}` },
              injectTo: "head",
            }),
          );
        // The typeface's Latin subset, which every French screen uses: otherwise only requested
        // once the stylesheet has loaded and text is laid out, and the text then swaps fonts.
        const font = Object.keys(bundle ?? {}).find((file) =>
          /atkinson-hyperlegible-next-latin-wght-normal-[\w-]+\.woff2$/.test(file),
        );
        if (!font) throw new Error("No Latin subset of Atkinson Hyperlegible Next in the build");
        const fontTag: HtmlTagDescriptor = {
          tag: "link",
          attrs: {
            rel: "preload",
            as: "font",
            type: "font/woff2",
            crossorigin: true,
            href: `/${font}`,
          },
          injectTo: "head",
        };
        return [...scripts, fontTag];
      },
    },
  };
}

/**
 * Writes a Brotli copy next to each text file of the build, compressed once at the highest level:
 * the server sends it to browsers that accept it (apps/server/src/app.ts). JavaScript comes out
 * about 13 % smaller than the gzip the server would otherwise compress on the fly for each request.
 */
function brotli(): Plugin {
  return {
    name: "releve:brotli",
    apply: "build",
    async writeBundle({ dir }, bundle) {
      if (!dir) return;
      const files = Object.keys(bundle).filter((file) => /\.(?:js|css|html|svg)$/.test(file));
      for (const file of files) {
        const path = join(dir, file);
        const content = await readFile(path);
        if (content.length < 1024) continue; // not worth a second file
        const compressed = brotliCompressSync(content, {
          params: {
            [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY,
            [constants.BROTLI_PARAM_SIZE_HINT]: content.length,
          },
        });
        await writeFile(`${path}.br`, compressed);
      }
    },
  };
}

export default defineConfig({
  plugins: [
    preloadHomeScreen(),
    brotli(),
    // Must run before react(): generates src/routeTree.gen.ts and splits each route into its
    // own chunk.
    tanstackRouter({ target: "react", autoCodeSplitting: true }),
    react(),
    tailwindcss(),
    // Builds src/sw.ts into dist/sw.js after the app bundle, injecting the precache manifest
    // (every file of the build matching globPatterns) in place of `self.__SW_MANIFEST`.
    serwist({
      swSrc: "src/sw.ts",
      swDest: "sw.js", // relative to build.outDir; registered as /sw.js by src/pwa.ts
      globDirectory: outDir,
      globPatterns: ["**/*.{html,js,css,woff2,png,svg,webmanifest}"],
      // The worker itself is written after the manifest is computed: never precache it.
      globIgnores: ["sw.js", "**/node_modules/**/*"],
      // A classic (non-module) worker script: registered with the default `type: "classic"`.
      rollupFormat: "iife",
    }),
  ],
  resolve: {
    alias: { "@": srcDir },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      // REST endpoints and the SSE stream (/api/events): http-proxy pipes the response body
      // through as it arrives, so server-sent events are not buffered.
      "/api": { target: "http://localhost:3000" },
    },
  },
  build: {
    outDir,
    target: "es2022",
  },
});
