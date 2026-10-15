# Sub-agent briefs

The lead agent wrote these briefs before delegating. Each states the context, the contract to
respect (the shared package, written first by the lead), the boundaries (files it may touch, no git),
how to verify, and the report expected back. They are reproduced as sent, minus repetition.

Pattern that worked: **write the contract first, then parallelise around it**. The shared package
(schemas, mutators, protocol) existed before any agent started, so three agents could build the
server, the client engine and the app shell at the same time without stepping on each other.

---

## 1. Server (18:15, ~34 min)

> Build the backend in `apps/server`. Read `packages/shared/src/*.ts` first. Production-grade,
> small, readable, strongly typed; senior engineers will review it. Work only inside apps/server; no
> new dependencies unless necessary; no git. Check real APIs in node_modules (several packages are
> newer than you may know).
>
> 1. `env.ts` (zod): PORT, HOST, DATABASE_URL (PostgreSQL) or PGlite when absent, PGLITE_DATA_DIR,
>    STATIC_DIR resolving to the built web app for both `tsx` and the bundle.
> 2. A tiny structured logger: JSON lines in production, silent in tests.
> 3. `db/sql.ts`: one `SqlClient` interface (query, transaction with isolation level, close) for
>    node-postgres and PGlite; int8 as numbers; PGlite loaded dynamically.
> 4. Embedded, append-only SQL migrations with an advisory lock. Exact initial schema given
>    (server_meta version row, clients, properties, levels, spaces; epoch-ms bigints;
>    `position text COLLATE "C"`; soft deletes), with the reasons to put in comments.
> 5. `ServerTx` implementing the shared `MutatorTx` over SQL, stamping writes with a version.
> 6. `processPush`: one transaction per mutation; `SELECT … FOR UPDATE` on the version row so
>    versions follow commit order (explain the sequence pitfall in a comment); skip already
>    processed ids; `SAVEPOINT` around the mutator; rejected mutations (and SQLSTATE 22/23) are
>    acknowledged so a queue never blocks; other errors are transient.
> 7. `processPull`: one REPEATABLE READ, READ ONLY transaction; `reset` when the cursor is ahead.
> 8. In-process pokes (comment: LISTEN/NOTIFY with several instances).
> 9. Hono app: health, push, pull, SSE with heartbeat, 404 JSON, `no-store`, static SPA with
>    immutable assets and an index fallback, secure headers, compression except SSE, no stack traces.
> 10. Bootstrap with graceful shutdown on SIGTERM. 11. esbuild bundle (pg and PGlite external).
> 12. Tests on in-memory PGlite: idempotent migrations, round trip parsed with the shared schema,
>     idempotent pushes, rejected mutations acknowledged, edit wins over delete, reset, concurrent
>     pushes without version gaps, HTTP behaviour.
>
> Final report: files, deviations and why, suggestions for shared, commands run and results.

## 2. Client sync engine (18:15, ~50 min)

> Implement `apps/web/src/sync/`: framework-agnostic engine plus thin React bindings. The heart of
> the exercise. Build on the shared package: device state = `applyMutations(base, pending)`,
> `applyPull`, isomorphic mutators.
>
> 1. `storage.ts` (idb): meta, base rows, an autoIncrement outbox (ids increase per device, across
>    tabs); `commitPull` in ONE transaction (a crash never leaves half a pull).
> 2. `transport.ts`: JSON POST, validated responses, typed `NetworkError` / `HttpError` /
>    `ProtocolError`, a `Transport` interface for tests.
> 3. `SyncClient`: one immutable state object for `useSyncExternalStore`; `mutate()` validates,
>    dry-runs the mutator (refuses stale actions), persists BEFORE showing; serialized state
>    transitions; coalescing push-then-pull cycles; Web Locks across tabs; exponential backoff;
>    triggers (mutation, online, visibility, 30 s, SSE poke); BroadcastChannel; nothing ever
>    dropped because a request failed.
> 4. Memoized selectors. 5. French descriptions of pending mutations. 6. React bindings.
> 7. Browser factory.
>
> Tests with fake-indexeddb and an in-memory reference server implementing the exact protocol,
> plus THE showcase test: three devices, seeded PRNG, random actions, network toggles and syncs;
> at the end every device must equal the server, no pending left, invariants hold.

## 3. Web foundation and PWA (18:15, ~38 min)

> Everything except the screens and the sync engine. Design direction decided by the lead, to
> implement as tokens: Auditoo's forest green `#033527`, paper background, one accent, hairline
> rules as structure, no gradients or shadows except the dragged item; the architectural datum
> marker as signature; Atkinson Hyperlegible Next only; type scale 13/14/16/18/22/28; 44 px
> targets, 16 px inputs; automatic dark mode; safe areas.
>
> index.html, Vite config (router plugin before React, Tailwind, Serwist, `/api` proxy that works
> for SSE), `sw.ts` (precache, navigation fallback except `/api`, no API caching, prompt-to-update),
> `pwa.ts`, manifest, generated icons, shadcn/ui components written by hand (registry unreachable),
> file-based routing skeleton with French error screens, a Playwright config for later.
> Verify in a real browser: screenshots in light and dark, service worker active, offline reload.

## 4. End-to-end tests and CI (20:00, ~35 min)

> A previous attempt was interrupted: review its files critically, keep what is good, finish.
> Role-based locators (French accessible names listed); every test creates its own logement.
> Specs: logements (create, rename, swipe then undo), structure (levels from suggestions with
> Sous-sol landing before RDC, rooms by Enter and by chips with numbering, rename, deletes with
> undo), reorder (within a level, across levels, levels; reload after each drop), offline (reload
> without network, pending count, resync, a second device sees the data; a rename reaching another
> device without reload). If the app has a bug, do not fix it: report it and mark the test fixme.
> Web-first assertions, three consecutive runs. CI workflow and a keep-warm workflow.

## 5. Sync hardening (20:00, follow-up to agent 2, with its context)

> Implement your own suggestions; you may now touch shared, server and sync. Keep the tree
> compiling (others are running builds).
>
> 1. One invalid mutation must not reject the whole push: loose envelope at the boundary,
>    per-mutation validation on the server, invalid ones acknowledged as rejected.
> 2. Names refuse control characters (Postgres refuses NUL).
> 3. A server epoch to detect a replaced database; think through `lastMutationId` on a fresh server;
>    tests where the new server's version already passed the device's cursor.
> 4. Prove the server accepts gaps in mutation ids.
> 5. Survive IndexedDB being closed under the app.

## 6. Documentation (20:00, ~27 min)

> Write DESIGN.md (≤ 500 lines, the brief's required sections), README.md and CLAUDE.md. Crisp,
> opinionated, every decision with its why, file paths so a reviewer can jump to the code. Verify
> every claim against the code, run the tests for real counts, and report any inconsistency found.

---

# The night of 14 to 15 October

Same pattern, at a larger scale: the lead ran agents in waves of three or four, each in its own git
worktree and branch, with ports and scratch directories of its own so that their test servers
never collided, and merged each wave before starting the next. Two rules were added to every
brief: **tests that fail without the fix** (agents ran their new tests against the old build), and
**stay in your files** (each brief named what the parallel agents owned, so merges stayed small).
Briefs are condensed below; each ended with the same report format: branch, commits, what changed
and why, test results, files touched outside the agent's scope, risks.

## Wave 1 (23:35, ~1 h 30)

### 7. Independent review (read-only)

> Fresh eyes on the whole repository before submission: find what a demanding reviewer would
> criticise, ranked by severity, with concrete evidence. Do not modify anything. Look hardest at
> the UI written last (rapid taps, pending promises, unmounts during async work, iOS keyboard,
> StrictMode, accessibility, touch targets, offline), then the sync engine and server, then
> docs that overclaim. Verify suspicions on the production build with Playwright on a Pixel 7.

### 8. Product UX

> Duplicate a level with its rooms in **one atomic mutation** (justify its shape), smart names
> (R+n → next free floor, bedrooms renumbered), undoable; a ⋮ menu per room (Renommer, Déplacer
> vers…, Supprimer) as the gesture-free path; installable PWA made obvious (Android prompt, iOS
> instructions); a toast when the app first works offline.

### 9. Sync feedback

> No silent rejections: the push response lists rejected mutation ids with reason codes (no user
> data echoed), backward compatible; the device announces them in French, naming the change and
> why; the sync sheet lists them. Make the backoff comment true. One `quote()`. Derive
> `mutationSchema` from the mutators, or make a missing envelope fail typecheck.

### 10. Quality

> Component tests of the gesture-heavy components (behaviour through the DOM, not internals); an
> axe gate on every screen and sheet in both themes; Lighthouse scripted and its scores in the
> README; a strict Content Security Policy proven by an e2e test; a bundle budget in CI.

## Wave 2 (01:35, ~1 h 30): fixing the review

### 11. Touch safety

> « Terminé » must keep the room being typed. A finger drags only after holding a handle (a flick
> on a handle must scroll), proven with real touch events. Undo for moves. Swipes sized to what
> they delete: a level or a logement only reveals a button. Chips keep the focus and stay under
> the thumb. Focus after every action. French screen-reader wording.

### 12. Navigation and recovery

> Back goes back (no loops, no « Logement introuvable » flash). Deleted things can come back
> after the toast: sheets listing them with « Restaurer ». Long addresses as large titles. Sheets
> mounted on first opening, Lighthouse re-measured. Manifest colours. Docs that contradict the
> screen.

### 13. Sync: calm, honest, robust

> « Envoi… » only while sending; no pull for one's own poke; « Serveur injoignable » rather than
> « Hors ligne » on a connected phone; creates refuse existing ids; no queued change may ever
> lock a device out after an update; pushes capped in bytes; names refuse lone surrogates; the
> pill's accessible name starts with its visible text.

## Wave 3 (03:50, ~1 h): last look

### 14. Final review (read-only)

> Same as 7, on the merged result, looking hardest at interactions between the night's features:
> merges are where bugs hide. Check every claim of the README's feature list on a phone.

### 15. Screenshots and demo GIF

> Honest images of the real app with realistic French data, a 25-second demo GIF; write only
> images; report anything that looked wrong while doing it (that part matters).

### 16. Documentation

> One coherent pass over DESIGN.md (at most 480 lines), README, CLAUDE.md and this folder; every
> claim verified against the code; real test counts.

## Wave 4 (04:45, ~50 min): the last findings

### 17. Sheets, toasts, focus, scroll

> Toasts over sheets took taps meant for them; focus never entered a sheet; a tap in the header
> scrolled the page to the top; history after deleting a logement; the add-level sheet changing
> under the finger; addresses cut before the postcode.

### 18. Small fixes and code quality

> « Serveur injoignable » after the network came back; text being typed lost on the system back
> button (committed on unmount, but only into what is still alive: edits revive deleted parents);
> one `withRooms`; one hidden « Renommer » description; French for every message a user can see;
> one DevTools session per page in e2e, so that offline stays offline.
