import { config } from "zod";

// Zod compiles a fast path for object schemas with `new Function`, after probing that eval is
// allowed. The web app's Content Security Policy forbids eval: in browsers, skip the compiler and
// its probe, which the browser would report as a violation although Zod catches the error. Must
// run before any schema is built, hence first in index.ts.
if ("document" in globalThis) config({ jitless: true });
