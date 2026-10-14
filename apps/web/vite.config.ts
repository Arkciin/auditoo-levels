import { fileURLToPath } from "node:url";
import { serwist } from "@serwist/vite";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const srcDir = fileURLToPath(new URL("./src", import.meta.url));
const outDir = fileURLToPath(new URL("./dist", import.meta.url));

export default defineConfig({
  plugins: [
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
