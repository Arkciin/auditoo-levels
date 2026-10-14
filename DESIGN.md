# Relevé: design

Relevé (French for an on-site survey) is the levels-and-rooms module of a housing inspection app.
A diagnostician creates a *logement*, describes its levels (Sous-sol, RDC, R+1…) and their rooms,
renames, deletes and reorders them by drag and drop: on a phone, with or without network. It was
built for Auditoo's take-home exercise as if it were going to production.

Three constraints drove every decision:

| Constraint | What it changed |
| --- | --- |
| **Offline for hours.** Basements, thick walls, rural dead zones: no network is the normal case. | The device is the source of truth for the UI. Screens render the local copy and never wait for the network; the server is reached in the background. |
| **Never lose data.** A typed room must survive crashes, reloads, lost responses, retries, other devices, even a replaced server database. | A change is written to a durable outbox before the UI shows it, pushes are idempotent, and a mutation leaves the outbox only once a pull proves the server has it. |
| **Fast with one thumb.** Standing in a corridor, phone in one hand. | Main actions in a bottom bar, one gesture per intent, one-tap suggestions, undo instead of confirmation dialogs. |

## Architecture

```mermaid
flowchart LR
  subgraph device["Device: phone or tablet, works offline"]
    direction TB
    sw["Service worker (Serwist)<br/>precached app shell"]
    ui["React UI<br/>TanStack Router, dnd-kit, shadcn/ui"]
    client["SyncClient<br/>view = base + pending"]
    idb[("IndexedDB<br/>outbox + server snapshot")]
    sw -.->|"serves the app offline"| ui
    ui -->|"mutate()"| client
    client -->|"state"| ui
    client <-->|"atomic transactions"| idb
  end
  shared{{"packages/shared<br/>schemas, mutators, positions, protocol"}}
  subgraph server["Server: one Node process"]
    direction TB
    api["Hono<br/>push, pull, SSE events<br/>+ the built PWA"]
    pg[("PostgreSQL<br/>PGlite in dev and tests")]
    api -->|"one transaction per mutation"| pg
  end
  client -->|"push: ordered mutations"| api
  client -->|"pull: rows changed since cursor"| api
  api -.->|"SSE poke"| client
  shared -.->|"same mutators"| client
  shared -.->|"same mutators"| api
```

Three pnpm workspaces, served from one origin (no CORS, one deploy, one service worker scope):

| Workspace | Role | Start reading at |
| --- | --- | --- |
| `packages/shared` | Domain code run verbatim on both sides: Zod schemas, mutators, fractional positions, wire protocol, in-memory snapshot | `src/mutators.ts`, `src/protocol.ts` |
| `apps/web` | React 19 PWA: sync engine (`src/sync/`), screens (`src/features/`), service worker (`src/sw.ts`) | `src/sync/sync-client.ts` |
| `apps/server` | Hono on Node 22: sync API, PostgreSQL access, static hosting of the built PWA | `src/sync/push.ts`, `src/sync/pull.ts` |

### Life of a mutation

```mermaid
sequenceDiagram
  autonumber
  actor U as Inspector
  participant UI as React UI
  participant C as SyncClient
  participant DB as IndexedDB
  participant S as Hono server
  participant PG as PostgreSQL
  participant O as Other devices
  U->>UI: taps the "Cuisine" suggestion
  UI->>C: mutate("createSpace", args)
  C->>C: validate args (Zod), dry-run the mutator on the view
  C->>DB: append to the outbox (strict durability), gets id 42
  C-->>UI: view = base + pending, rendered at once
  C->>S: POST /api/push with mutations 42 and later
  S->>PG: per mutation, lock the version row, skip if seen, validate, run the mutator
  S-->>C: lastMutationId 42
  S--)O: SSE poke
  C->>S: POST /api/pull with its cursor
  S->>PG: one REPEATABLE READ snapshot, rows above the cursor and lastMutationId
  S-->>C: changed rows, new cursor, lastMutationId 42
  C->>DB: one transaction, merge rows, store cursor, drop outbox entries up to 42
  C-->>UI: rebase, view = new base + remaining pending
```

## Data model

Logement → levels → rooms. Code and schema say *property* and *space*; the UI says *logement*,
*niveau* and *pièce*.

| Table | Synced fields (shared shape) | Notes |
| --- | --- | --- |
| `properties` | `id`, `name`, `createdAt`, `deletedAt` | Listed newest first |
| `levels` | `id`, `propertyId`, `name`, `position`, `deletedAt` | Ordered by `position` within a property |
| `spaces` | `id`, `levelId`, `name`, `position`, `deletedAt` | Ordered by `position` within a level |
| `server_meta` | Singleton: `version` (global, the pull cursor), `epoch` (database identity) | Server only |
| `clients` | Per device: `last_mutation_id` | Server only, makes pushes idempotent |
| `rejected_mutations` | Per device and mutation id: the reason it was rejected | Server only, lets a retried push report its rejections again |

Synced tables also carry `version` (the global version that last wrote the row) and `updated_at`.
SQL: `apps/server/src/db/migrations.ts`; shapes: `packages/shared/src/schemas.ts`.

| Decision | Why |
| --- | --- |
| **Properties above levels** | An inspector handles several dwellings a day. It also gives the router a real job: `/` lists logements, `/logements/$propertyId` shows one. |
| **UUIDv7 ids generated on the device** | Entities are created offline and referenced at once (a room in a level created a second ago, both still queued). Time-ordered ids keep index inserts local and give a stable "newest first" tie-break. |
| **Soft deletes** (`deletedAt`) | A delete is a row change like any other, so it syncs through the same cursor, and undo is just a `restore*` mutation. Deleting a level hides its rooms without touching them; restoring it brings them all back. |
| **Epoch-ms `bigint` timestamps, taken from the mutation** | Mutators are deterministic, so server rows are identical to what the device computed optimistically and the next pull changes nothing on screen (asserted in `apps/server/src/sync/sync.test.ts`). The price: `createdAt` and `deletedAt` come from device clocks, which only drive display order. |
| **`position text COLLATE "C"`** | Fractional keys compare by code unit (see [Ordering](#ordering-with-fractional-indexes)). |
| **Names: 1 to 80 characters, no control characters** | Validated on input by `nameSchema` (French messages); the length is also a SQL `CHECK`. Rows read back use a looser schema: if input rules tighten later, a row stored under the old rules must never make a pull fail and block a device. |
| **Foreign keys** `levels → properties`, `spaces → levels` | The database guards the tree, even against a buggy mutator. |

## Sync strategy

The model is Replicache's (push, pull, rebase), written as plain, readable TypeScript.

```text
POST /api/push  { clientId, epoch?, mutations: [{ id, name, args, timestamp }] }  →  { lastMutationId, epoch, rejected: [{ id, reason }] }
POST /api/pull  { clientId, cursor }  →  { epoch, cursor, lastMutationId, reset, changes: { properties, levels, spaces } }
GET  /api/events    server-sent events: "poke" { version } after each push that changed data
```

### Isomorphic mutators

`packages/shared/src/mutators.ts` defines what each of the 15 user actions does, once: create,
rename, delete and restore for each entity, plus `moveLevel`, `moveSpace` (which can change level)
and `duplicateLevel`. A mutator is an async function over a tiny transaction interface
(`MutatorTx`: get and put per entity), implemented by `SnapshotTx` (copy-on-write maps) on the
device and by `ServerTx` (SQL upserts stamped with the new version,
`apps/server/src/sync/server-tx.ts`) on the server.

Mutators are deterministic: they read only the transaction, their arguments and the mutation
timestamp; ids and positions are computed by the caller and travel as arguments. The optimistic
view can only differ from the server when another device changed the same data, and the next pull
reconciles it. Mutations are intents ("move this room there"), not row states: the server re-runs
them on its current rows, so a rename and a concurrent move of the same room both survive.

**A level copy carries its rooms.** `duplicateLevel` is `{ id, sourceId, name, position, spaces:
[{ id, name, position }] }` (at most 100 rooms), not "copy level X": re-run on the server, "copy X"
would copy rooms the user never saw, and the copies would need ids derived on the server. The
device names the copy and numbers its bedrooms, so the server creates exactly what the user saw;
the mutator only reads the source (copying is not editing: a source deleted meanwhile stays
deleted). It is one mutation, so one transaction (a room the database refuses rolls the whole copy
back) and one undo, which deletes the copy. A dedicated name rather than `spaces` on `createLevel`:
Zod strips unknown keys, so a server predating the field (after a rollback) would create an empty
level and acknowledge it, while an unknown mutation name is rejected whole.

### On the device: base, outbox, view

`SyncClient` (`apps/web/src/sync/sync-client.ts`) holds three things:

- `base`: the last snapshot confirmed by the server, in IndexedDB (`properties`, `levels`, `spaces`,
  and `meta` for client id, cursor and epoch);
- `pending`: the outbox, local mutations the server has not confirmed;
- `view = applyMutations(base, pending)`: what React renders, through `useSyncExternalStore`.

`mutate()` validates and normalizes the arguments (names trimmed, as the server will see them),
dry-runs the mutator on the view (an action on stale state is refused before anything is stored),
appends to the outbox, then publishes the new view. A mutation is **durable before it is visible**,
and leaves the outbox only when a pull shows the server processed it, never on a push
acknowledgement alone. State transitions are serialized: none can lose or double-apply a mutation.

### Push: ordered, idempotent, never blocked

The device sends its outbox oldest first, in batches of up to 100. The server accepts bodies up to
8 MiB, which the largest valid push fits (100 copies of 100-room levels with the costliest names,
about 6.5 MiB, checked by `apps/server/src/app.test.ts`): a push refused for its size would be
retried as it is, forever. `apps/server/src/sync/push.ts` gives **each mutation its own
transaction**:

1. `SELECT version, epoch FROM server_meta … FOR UPDATE`: take the version lock, check the epoch.
2. Skip the mutation if `id ≤ clients.last_mutation_id`: retries are no-ops; ids may have gaps.
3. Validate it with `mutationSchema`, per mutation (the request itself only checks envelopes).
4. Run the mutator inside `SAVEPOINT mutation`, stamping written rows with `version + 1`; bump the
   version only if something was written.
5. Record `last_mutation_id` and commit.

A mutation that can never apply is **rejected but acknowledged**: invalid (sent by another app
version, under rules that changed since), refused by its mutator (`MutationRejectedError`, e.g. an
unknown entity) or by the database (SQLSTATE class 22 or 23). The savepoint discards its partial
writes while the acknowledgement commits, so one bad mutation never blocks a device's queue. Any
other error is transient: earlier mutations stay committed, the request fails, the device retries.

The response lists the request's rejected mutations by id, with a reason code: `invalid`,
`not_applicable` or `refused_by_database`, never user data. Each rejection is written with its
acknowledgement (`rejected_mutations`), so a push retried after a lost response, or after failing
half-way, reports it again. The field is optional on the wire: installed apps ignore it, a device
reads an older server's response as rejecting nothing, and reads reasons as any string, so that a
code a newer server adds cannot make its pushes fail to parse.

### Gapless versions: a row lock, not a sequence

The pull cursor means "I have every row up to this version", so versions must become visible in
order. With a Postgres `SEQUENCE`, transaction A takes version 5, B takes 6 and commits first; a
device pulling in between moves its cursor to 6 and never receives A's rows. Locking the
`server_meta` row serializes writers, so versions follow commit order. The cost, one writer at a
time for a few milliseconds per mutation, is irrelevant at this scale, and pulls never wait for it.

### Pull and rebase

`apps/server/src/sync/pull.ts` reads everything in one `REPEATABLE READ, READ ONLY` transaction:
version, epoch, this device's `last_mutation_id` and every row with `version > cursor`, deleted ones
included. Under `READ COMMITTED`, a push committing between two statements could show in the rows
but not in `lastMutationId`, and the device would replay that mutation on top of its own effects.

The device then rebases: it merges the rows into `base`, drops pending mutations up to
`lastMutationId`, replays the rest, and commits rows, cursor, epoch and outbox pruning in **one
IndexedDB transaction** before publishing. If anything fails, memory and storage still agree.

### No change disappears without a word

A change leaves the view without being applied in two ways: the server rejects it, or a replay
finds it no longer applies to newer server data (its level was lost with a replaced database,
say), after a pull, a reload from another tab, or at startup. The device reports either, once per
mutation, in `SyncState.rejections` (the latest 20, newest first, listed in the sync sheet) and to
`onRejected` listeners (a toast). `describeRejection` names the change as the user saw it and says
why, finding the missing entity in the state the change was refused on: « La pièce « Cuisine » n'a
pas pu être déplacée vers « R+1 » : le niveau n'existe plus. ».

- **Announced as it disappears.** A rejection a push reports is worded at once, while the queue
  still holds the mutation, but announced when the pull that confirms it takes the change off the
  screen. A replaced database voids such verdicts: the new one judges the mutations again.
- **Other tabs** only see the mutation leave the outbox: the tab that reports a rejection tells
  them over the BroadcastChannel.
- **At startup**, queued changes that no longer apply are listed but not announced: old news.
- **Mutations of unknown kinds**, which a newer version of the app may have left in the outbox
  (then rolled back, or in another tab), are refused like any other instead of failing the replay.

### Replaced databases: reset and epoch

- **Reset.** A cursor ahead of the server means the database went back in time: the pull returns
  the full dataset with `reset: true` and the device replaces its base, keeping its outbox.
- **Epoch.** Each database draws a random UUID when created (migration `002_server_epoch`), which
  devices store and send with every push. Another epoch means another database (recreated, or
  restored from a backup): the server processes nothing from that device, which starts over with a
  full pull and pushes its whole outbox again. Otherwise a device still holding mutations the old
  database had acknowledged would push later ones first, and the new database would skip the
  earlier ones forever.

### When sync runs

| Trigger | Behaviour |
| --- | --- |
| A local mutation | Sync now; while a retry is scheduled, wait for it: the mutation is safe in the outbox, and says nothing about the network |
| An SSE `poke`, every (re)connection of the stream (pokes sent meanwhile are lost), the page becoming visible | Sync now, even while backing off: the server just proved reachable, or the user is back |
| `online` event, "Synchroniser maintenant" button | Sync now and reset the backoff |
| Every 30 s while the page is visible | Sync, unless a retry is already scheduled; reopen the event stream if it gave up |
| A failed cycle | Retry after 1 s, doubling up to 30 s, ±20 % jitter so devices cut off together do not retry in lockstep |

A cycle is push then pull, each request bounded by a 15 s timeout (weak mobile networks hang rather
than fail). A `NetworkError` means offline, a normal state; HTTP and protocol errors show as errors.

### Several tabs and durability

- **Web Locks** allow one push/pull cycle at a time per device; through a **BroadcastChannel**, a
  tab that wrote tells the others to reload from IndexedDB, the single source of truth (and passes
  on the rejections it reports, which the storage cannot show).
- **Mutation ids** come from the outbox's `autoIncrement` key generator: increasing across tabs,
  never reused. Push reads the outbox from storage, so no tab sends a mutation before an older one.
- **Strict durability** on outbox writes (Chrome defaults to relaxed, which can lose the last writes
  on power loss), and `navigator.storage.persist()` to ask the browser not to evict the data.
- **Lost connections** (`apps/web/src/sync/storage.ts`): when the browser closes IndexedDB under the
  app (iOS in the background), the storage reopens it and retries the operation, which wrote
  nothing. If the data was erased, or a newer app version took over, the page asks to be reloaded.

### Conflict policy

| Situation | Outcome | Why |
| --- | --- | --- |
| Two devices rename the same room | The last rename to reach the server wins | Predictable, and enough for short names |
| Two devices reorder the same list | Both moves apply (the same item: the last move wins) | A move rewrites only the moved item's key |
| Two offline devices append to the same level | Distinct keys | A random 4-character base62 suffix on every key; equal keys still sort by id, identically everywhere |
| Edit vs delete: rename, move into or add to a deleted item | **Edit wins**: the item and its parents are revived | No input is ever silently discarded; the worst case is an item reappearing, which can be deleted again |
| Delete a level | Its rooms are hidden with it; undo restores them all | One row write, nothing to remember about which rooms went together |
| Duplicate a level another device deleted or changed meanwhile | The copy is what the user saw; the source stays as the other device left it | The rooms travel in the mutation; a copy reads its source, it does not edit it |
| Delete an already deleted item | No-op, no version bump | Idempotent |
| Move a room to another logement | Rejected | A room belongs to one dwelling; drag and drop never offers it |
| Mutation on an entity the server does not know | Rejected, acknowledged, reported to the user (toast, sync sheet), dropped at the next pull | Only after a database wipe, or from a buggy client |

## Ordering with fractional indexes

`packages/shared/src/positions.ts` wraps rocicorp's `fractional-indexing`:

- A drop becomes **one** `moveSpace` or `moveLevel` whose `position` is a key strictly between the
  new neighbours (`positionAtIndex`); appends use `positionAtEnd`. Nothing else is renumbered, and
  keys are validated at the boundary (`isValidPosition`) so a malformed one cannot poison a list.
- **Jitter.** The algorithm is deterministic, so two offline devices appending to the same list
  would compute the same key. A random 4-character base62 suffix (never ending in `0`, which the
  format forbids) makes that about 1 in 14 million.
- **Tie-break by id** (`compareByPosition`): should two keys still be equal, every device renders
  the same order, and an insert between equal keys lands right after them.
- **The `localeCompare` trap.** Keys mix cases: in code-unit order `"Zz" < "a0"`. `localeCompare`,
  like a locale-aware database collation, interleaves cases and silently scrambles the list.
  Devices compare with `<` (`comparePositions`); position columns use `COLLATE "C"` (asserted in
  `apps/server/src/db/migrate.test.ts`), so a server-side `ORDER BY` agrees with every device.

A fast-check property test inserts at random indexes (300 runs, up to 200 inserts each) and checks
that the list stays strictly ordered with valid keys; 500 appends keep keys at 8 characters or less.

## Offline and PWA

- **Precache.** Serwist (`apps/web/src/sw.ts`, built by `@serwist/vite`) precaches the whole app
  shell at install: HTML, every JS chunk (the lazily loaded route included), CSS, icons, manifest
  and the self-hosted fonts, about 300 kB compressed. The app starts, and deep links open, offline.
- **Navigation fallback** to the precached `index.html`, except `/api/*`. `navigationPreload` is
  off: navigations are answered from the precache, so a preload request would be wasted traffic.
- **No runtime caching of the API.** Data lives in IndexedDB and belongs to the sync engine; the
  server marks `/api/*` `no-store`. One cache, one truth.
- **Ready offline, said once** (`apps/web/src/pwa.ts`): when the first install completes, a toast
  says « Relevé fonctionne maintenant sans réseau. »; not on updates, nor after a Shift+reload
  (an active worker existed before both).
- **Install offer** (`apps/web/src/install.ts`): the home screen's menu offers « Installer
  l'application » when the browser fired `beforeinstallprompt` (kept from before the first render:
  it fires early, once), and on iPhone and iPad a sheet with Safari's steps and why (iOS keeps the
  data of installed apps). Nothing once installed or opened standalone.
- **Prompt to update** (`apps/web/src/pwa.ts`): a new version waits until the user taps "Mettre à
  jour" in a toast, so code is never swapped under someone typing; the first install takes control
  at once (`clientsClaim`).
- **Data before first paint.** `apps/web/src/main.tsx` opens IndexedDB before rendering: no loading
  state. Without IndexedDB (some private modes), a screen says so instead of half-working.
- **HTTP caching** (`apps/server/src/app.ts`): hashed `/assets/*` immutable for a year, entry points
  (`/`, `index.html`, `sw.js`, manifest) revalidated, a missing asset a real 404 rather than HTML.
- **First load.** `index.html` preloads the home screen's code and its typeface, which the router
  would otherwise only request once the app runs; the build writes Brotli copies of its text
  files, sent to browsers that accept them; the first render is a React transition, so it runs in
  short slices rather than one long task. CI keeps the bundle within a budget (`pnpm size`).

## Security headers

`apps/server/src/security-headers.ts`, on every response:

- **Content Security Policy**: everything from the app's origin (`default-src 'self'`); scripts
  only from its files, never inline or through `eval` (Zod's compiler, which uses `new Function`,
  is off in browsers: `packages/shared/src/zod-config.ts`); no plugins, no `<base>`, no native
  form submission, never framed. Styles allow inline `<style>` elements: vaul, Sonner and Radix's
  scroll lock insert some at runtime, the latter with computed content, so no hash fits, and a
  static, precached `index.html` cannot carry per-response nonces. Style attributes in markup stay
  forbidden (`style-src-attr 'none'`): React sets styles through the CSSOM. Every end-to-end test
  fails on a violation.
- **Permissions-Policy** denies 21 powerful features the app does not use (camera, geolocation,
  payment, USB…); `Referrer-Policy: no-referrer`, HSTS, `nosniff`, `X-Frame-Options: DENY`,
  same-origin COOP and CORP.

## UX decisions

| Decision | Detail |
| --- | --- |
| **French UI** | The users are French diagnosticians: trade vocabulary (logement, niveau, pièce, RDC, R+1, Combles), French typography (non-breaking spaces in « quotes » and "3 pièces"), French plural rules. Code stays in English. |
| **Signature: the level datum marker ▽** | Borrowed from building section drawings: a half-filled inverted triangle whose apex rests on the floor line. Every level header is drawn as a floor line carrying it (`apps/web/src/components/datum-marker.tsx`). |
| **Thumb zone** | The screen's main action ("Nouveau logement", "Ajouter un niveau") sits in a fixed bottom bar; toasts appear just above it; sheets slide up from the bottom. |
| **One gesture per intent** | Tap a name to rename it in place, swipe a row left to delete it, drag only by the grip handle. They never compete: a swipe locks to the horizontal axis after 8 px and leaves vertical scroll native, and handles and inputs never start a swipe. A mouse drags 4 px into a handle; a finger must first rest on it for 250 ms (the copy then lifts, with a vibration), because a thumb scrolling the page often starts on a handle: a flick from one scrolls (`touch-action: manipulation`). |
| **Other ways than gestures** | A ⋮ menu on every logement, level and room: rename, delete, and for a room « Déplacer vers… », a sheet of the other levels (the room goes to the end of the one picked, with undo). Drag and drop works with the keyboard too (Space, arrows, Escape), announced in French to screen readers. |
| **Menus open on a tap** | Radix opens a menu on pointerdown, so a finger starting a scroll on a ⋮ (one per room) opened it and blocked the scroll. Touch and pen open on the tap; mouse and keyboard are unchanged (`components/ui/dropdown-menu.tsx`). |
| **Identical floors in one tap** | « Dupliquer le niveau » copies a level with its rooms: a floor becomes the next free floor in the source's spelling (R+1 → R+2, 1er étage → 2e étage), anything else « RDC (copie) »; bedrooms take the logement's next numbers, other rooms keep their names. |
| **Show where things land** | A level copied, a room moved by menu or just added is tinted for a moment (a static tint with reduced motion), and scrolled into view when it may be out of sight. The room field and its suggestions stay clear of the action bar and the keyboard as rooms pile up above them. |
| **Rapid room entry** | After Enter the room field stays focused and empty, so rooms are typed in a row. Chips suggest rooms that fit the level: Cave or Chaufferie in a basement, Chambre upstairs. |
| **Smart numbering** | "Chambre" is always numbered (Chambre 1, Chambre 2…); other rooms only when they repeat (Cuisine, then Cuisine 2), counted across the whole logement (`apps/web/src/lib/suggestions.ts`). |
| **Levels go where they belong** | French level names are ranked (Sous-sol below RDC, R+n or "2e étage" above, Combles on top), so a Sous-sol added after the RDC is inserted below it; unknown names go last. The sheet offers the likely next levels in one tap. |
| **Undo instead of "Are you sure?"** | Deletes are soft, so each one shows a 6 s toast with "Annuler", which queues a `restore*` mutation (offline too). A confirmation dialog would tax every delete to protect the rare mistake. |
| **Sync status always in view** | A header pill (À jour, En attente with a count, Envoi…, Hors ligne, Erreur) opens a sheet listing pending changes in plain French, with a "Synchroniser maintenant" button; a banner says what happens to work done offline. |
| **No silent rejection** | A change the server refuses, or that no longer applies, gets an error toast saying which and why, and stays listed in the sync sheet ("modifications non appliquées"), whose relative times keep ticking while it is open. |
| **Legibility on site** | Atkinson Hyperlegible Next, designed by the Braille Institute for low-vision readers, for dim basements and glare; 16 px body text; one brand colour (forest `#033527`) and one accent; field outlines at 3:1 contrast. |
| **Touch hygiene and comfort** | 44 px minimum targets; 16 px inputs (iOS zooms into smaller ones); safe-area padding; no pull-to-refresh to fight a drag; light haptics where the Vibration API exists. Dark mode follows the OS; with `prefers-reduced-motion`, animations are shortened rather than removed, so components waiting for `animationend` still close. |

## Database choice

- **PostgreSQL in production.** Everything the sync relies on is built in: transactions, row locks,
  savepoints, `REPEATABLE READ` snapshots, `COLLATE "C"`, constraints. Managed hosting is a click.
- **PGlite for development and tests.** Postgres compiled to WebAssembly, embedded in the Node
  process: `pnpm dev` and `pnpm test` need no Docker, yet run the same SQL with real Postgres
  semantics, behind one small interface (`SqlClient`, `apps/server/src/db/sql.ts`).
- **Migrations** are embedded SQL, append-only, applied at boot, each in its own transaction under
  `pg_advisory_xact_lock`, so instances booting together during a deploy do not race.
- **Not SQLite or a JSON file**: free hosts have ephemeral disks; a redeploy would wipe the data.

## Deployment

`render.yaml` is a Render Blueprint:

- **One web service** `releve` (Node 22, free plan, Frankfurt): Vite builds the PWA, esbuild bundles
  the server into one file. At boot the server migrates, then serves API and PWA; `/api/health`
  checks the database; logs are JSON lines; `SIGTERM` ends the SSE streams and drains requests.
- **One PostgreSQL** `releve-db` (free plan, Frankfurt, the closest region to France), reachable
  only from Render's private network; `DATABASE_URL` is injected.
- **Cold starts.** Free instances sleep after 15 idle minutes and take up to a minute to wake.
  Offline-first absorbs it: the app opens from the service worker and IndexedDB and syncs later.
  `.github/workflows/keep-warm.yml` pings `/api/health` every 10 minutes once `APP_URL` is set.
- **Restoring a backup** replaces the database: draw a new epoch right after
  (`UPDATE server_meta SET epoch = gen_random_uuid();`) so that devices start over from it.

## Testing strategy

`pnpm test` runs 304 Vitest tests in about a minute, with no database to install.

| Suite | Tests | Covers |
| --- | --- | --- |
| `packages/shared` | 56 | Mutators (edit wins, rejections without partial writes, determinism, level copies and their arguments), positions (fast-check property test), name validation, protocol envelopes (one per mutation), push responses old and new, unknown mutation kinds refused |
| `apps/server`, on in-memory PGlite | 41 | Idempotent retries, rejected and invalid mutations acknowledged and reported with their reason (again to retries, racing or not, and after a push failed half-way), database refusals as permanent (a level copy rolled back whole), sparse ids, no-op mutations, epochs, reset, gapless versions under concurrent pushes; HTTP validation, the largest valid push, cache headers, Brotli copies, SSE pokes, SPA fallback; every security header; migrations |
| `apps/web`, on fake-indexeddb | 166 | `SyncClient` against `MemoryServer`, an in-memory reference implementation of the protocol: rejections reported once (lost responses, replays, startup, other tabs), backoff per trigger; storage (id allocation, atomic pulls, reopened connections), transport errors, React bindings, selectors, French descriptions, naming suggestions and level copies, the install offer, relative times; the convergence simulation (12 tests, below); the contrast of every colour pairing the UI paints, in both themes (WCAG AA) |
| `apps/web` components, on happy-dom | 41 | Driven by role and accessible name (Testing Library): swipe to delete (40 % threshold, flicks, axis lock against vertical scroll, the swallowed click, a failed deletion sliding back), rename in place (Enter, blur, Escape, a rejected save), rapid room entry (taps faster than saves keep order and numbering), the sync indicator's wording and accessible name |
| Playwright, mobile Chromium | 24 | Create, rename, swipe and undo; levels and rooms entry, suggestions kept within reach; level duplication; the room menu (move to another level, rename, delete); drag within and across levels; offline reload then resync, the ready-offline toast; the install offer (Android prompt, iOS steps); a rename reaching a second device through SSE; a change the server rejects, announced and listed in the sync sheet; axe scans of every screen, sheet, menu and banner in both themes; the browser enforcing the Content Security Policy and the Permissions-Policy |

**The convergence simulation** (`apps/web/src/sync/convergence.test.ts`) is the sync engine's
safety net. Three devices share a `MemoryServer` for 300 random steps, over 8 seeds. At each step a
device acts on what it shows (often stale), switches its network between online, offline and lossy,
syncs, keeps working while a sync is in flight, or restarts and loses its memory. After every step,
memory must equal storage and the view must equal base plus pending. At the end every device must
hold exactly the server's state with an empty outbox, no mutation may be lost or rejected, and no
device may have reported a change as not applying; invariants must hold (parents exist, positions
valid, no room left its logement), and all 15 mutation kinds must have run. Four more seeds also
wipe the server's database twice: there, every mutation the final database rejected must have
been reported to its device, lost responses and restarts included.

The server was also checked by hand against PostgreSQL 16: concurrent migrations, 12 devices × 25
mutations racing two server instances, gapless versions; and the whole end-to-end suite passes
against the production build backed by PostgreSQL 16, as deployed. End-to-end tests (`apps/web/e2e/`) drive an
emulated Pixel 7 against the production build: real touch swipes, a second device as a second
browser context, `context.setOffline`. Two gates run across the whole suite: a test fails on any
Content Security Policy violation, and the accessibility spec fails on any serious or critical axe
violation. CI (`.github/workflows/ci.yml`) runs Biome, typecheck, unit tests, the bundle size
budget and end-to-end tests on every push.

## Tradeoffs considered and rejected

| Option | Why not |
| --- | --- |
| **CRDTs** (Yjs, Automerge) | Built for collaborative text; this is a small tree with business rules. Opaque updates are hard to validate on the server ("a room cannot change logement"), and the libraries and their metadata are heavier. |
| **Replicache, Zero, ElectricSQL, PowerSync** | Excellent, but they bring heavy infrastructure or a black box to a one-day exercise. This engine borrows Replicache's push/pull/rebase model in code a reviewer can read. |
| **TanStack Query offline mutations** | Paused mutations can be persisted, but there is no durable local view to rebase onto: optimistic state is hand-written cache surgery per query, and a refetch can make pending edits flicker or vanish. |
| **State-based last-write-wins with timestamps** | Device clocks skew, and sending whole rows clobbers unrelated fields (a move erasing a concurrent rename). Re-running intents on the server avoids both. |
| **Integer positions** | A reorder renumbers N rows: N mutations, and a conflict with every concurrent reorder. |
| **Background Sync API** | Not available in iOS Safari. Sync runs while the app is open, which is when inspectors work. |
| **Full-snapshot sync** | Simple, but every sync resends everything. The version cursor sends only what changed. |
| **WebSockets** | Pokes are one-way and data already travels over push and pull: SSE is enough, goes through proxies, and reconnects by itself. |
| **SQLite or a JSON file** | Ephemeral disks on free hosts: a redeploy loses the data. |
| **Sequence-assigned versions** | Commit order differs from sequence order, so an incremental pull can skip rows (see [Gapless versions](#gapless-versions-a-row-lock-not-a-sequence)). |
| **Caching `/api` in the service worker** | Two copies of the data with different freshness rules. IndexedDB is the only data cache. |
| **`@dnd-kit/react` 0.x** | Pre-1.0. The stable `@dnd-kit/core` and `@dnd-kit/sortable` cover sortable lists across containers, keyboard included. |
| **Long-press anywhere on a row to drag** | Conflicts with renaming, swipe-to-delete and scrolling. Only the handle drags, after a short hold for a finger, so that a flick starting on it still scrolls. |

## Known limitations and next steps

- **No authentication or tenant scoping**: every device pulls everything. Next: accounts, pulls
  scoped to an organisation, permission checks in the server's mutator transaction.
- **Tombstones are never collected**: deleted rows, old `clients` rows and `rejected_mutations`
  stay forever. Next: purge rows deleted long ago and send `reset` to devices whose cursor predates
  the purge. Rejections need more care: a device announces one only once a pull confirms it, so a
  record may only go once its device is known to have pulled past it.
- **SSE pokes are in-process**: several instances would need Postgres `LISTEN/NOTIFY`.
- **Concurrent renames are whole-field last-write-wins**, with no merge and no conflict UI.
- **Rejection notices live in memory**: a restart empties the sync sheet's list (each one was
  announced), and a rejection whose confirming pull had not come yet is announced again after it.
- **A change reported as no longer applying may still reach the server**: after a database
  replacement, if another device pushes again the entity it needed. It then reappears; rare, and
  nothing is lost. No conflict UI beyond the message: re-doing the change is up to the user.
- **Pushes are capped in count, not in bytes**: the body limit holds for today's largest mutation
  (tested). Next: the device also caps each push in bytes, so that no future mutation can outgrow it.
- **A level copy takes one SQL statement per room**, all while holding the version lock: a push of
  a 100-room copy takes about 60 ms on PGlite (measured over HTTP), more with network round trips
  to PostgreSQL. Next, if levels grow: a batched `putSpaces` on `ServerTx`.
- **Long levels are dragged whole**: an earlier version collapsed every level during a level drag,
  but the layout shift moved dnd-kit's measured rect and the floating copy drifted away from the
  finger (caught by an e2e test). Collapsing again needs a modifier that re-anchors the overlay.
- **iOS storage eviction**: Safari may erase the storage of a web app left unused for a while unless
  it is installed to the home screen. Only pending changes are at risk; synced data comes back. The
  install sheet explains it, but only to those who open it. Next: suggest installing when changes
  wait on an iPhone that runs Relevé in Safari.
- **A wiped database loses confirmed data**: devices re-push only what was still pending. Backups
  are the server's job; the free Render database is for demos.

## Libraries and resources

| Library | Used for |
| --- | --- |
| [React 19](https://react.dev) | UI; `useSyncExternalStore` binds the sync engine |
| [TanStack Router](https://tanstack.com/router) | File-based SPA routes, typed params, code splitting |
| [Tailwind CSS v4](https://tailwindcss.com) | Design tokens declared in CSS (`@theme`), dark mode |
| [shadcn/ui](https://ui.shadcn.com) on [Radix](https://www.radix-ui.com/primitives) | Button, input, dropdown menu, drawer, as owned source in `apps/web/src/components/ui` |
| [lucide](https://lucide.dev) | Icons |
| [vaul](https://vaul.emilkowal.ski) and [Sonner](https://sonner.emilkowal.ski) | Bottom sheets; toasts (undo, update prompt) |
| [dnd-kit](https://github.com/clauderic/dnd-kit) | Drag and drop by pointer, touch and keyboard |
| [Serwist](https://serwist.pages.dev) | Service worker: precache, navigation fallback, update flow |
| [idb](https://github.com/jakearchibald/idb) | Promise wrapper over IndexedDB |
| [fractional-indexing](https://github.com/rocicorp/fractional-indexing) | Order keys |
| [Zod](https://zod.dev) | Schemas shared by device and server; environment validation |
| [uuid](https://github.com/uuidjs/uuid) | UUIDv7 ids |
| [Hono](https://hono.dev) | HTTP API, SSE, static files, secure headers |
| [node-postgres](https://node-postgres.com) and [PGlite](https://pglite.dev) | PostgreSQL in production; Postgres in WASM for dev and tests |
| [Vitest](https://vitest.dev), [fast-check](https://fast-check.dev), [fake-indexeddb](https://github.com/dumbmatter/fakeIndexedDB) | Unit and integration tests, property-based tests, IndexedDB in Node |
| [Testing Library](https://testing-library.com) and [happy-dom](https://github.com/capricorn86/happy-dom) | Component tests, by role and accessible name |
| [Playwright](https://playwright.dev) | End-to-end tests on mobile Chromium |
| [axe-core](https://github.com/dequelabs/axe-core) and [Lighthouse](https://developer.chrome.com/docs/lighthouse) | Accessibility scans in the end-to-end suite; audits of the built app |
| [Biome](https://biomejs.dev) | Lint and format |
| [Atkinson Hyperlegible Next](https://fontsource.org/fonts/atkinson-hyperlegible-next) | The only typeface, self-hosted through Fontsource |

- Evan Wallace, [Realtime editing of ordered sequences](https://www.figma.com/blog/realtime-editing-of-ordered-sequences/) (Figma blog): fractional indexing for collaborative ordering.
- Replicache, [How it works](https://doc.replicache.dev/concepts/how-it-works): the push, pull and rebase model this engine follows.
- PostgreSQL, [transaction isolation](https://www.postgresql.org/docs/current/transaction-iso.html); Render, [Blueprint specification](https://render.com/docs/blueprint-spec).
- MDN: [Web Locks](https://developer.mozilla.org/en-US/docs/Web/API/Web_Locks_API), [BroadcastChannel](https://developer.mozilla.org/en-US/docs/Web/API/BroadcastChannel), [IndexedDB durability](https://developer.mozilla.org/en-US/docs/Web/API/IDBTransaction/durability), [StorageManager.persist()](https://developer.mozilla.org/en-US/docs/Web/API/StorageManager/persist), [server-sent events](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events).
