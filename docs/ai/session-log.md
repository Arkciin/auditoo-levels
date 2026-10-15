# Session log

One Claude Code cloud session, linked to my computer, on 14 and 15 October 2026 (Paris time).
"Lead" is the main Claude agent; "agent" is a sub-agent it launched with a written brief
([`agent-briefs.md`](agent-briefs.md)).

## Morning: understanding the brief

- **09:34** I paste the exercise and ask (in French) what I have to do. The lead explains the
  domain (diagnosticians describing a dwelling on site), the real difficulties (offline sync,
  fractional indexes, gestures that compete on a phone, Serwist caching the app but not the data),
  the deliverables, and warns about traps: `localeCompare` on fractional keys, ephemeral disks on
  free hosts, HTTPS needed for a service worker, the pair-programming session that follows.

## Evening: building it

- **17:28** "I want to start now, the best code quality possible, go the extra mile. Tokens are not
  a constraint, time is: I want to send it tomorrow at noon, and I go to bed at midnight."
- **17:35** The lead proposes the plan and its decisions, to be vetoed within ten minutes:
  TypeScript backend (Hono + PostgreSQL) so domain code is shared; a Replicache-style sync engine
  (outbox, push, pull, rebase); a *logement* layer above levels (several dwellings a day); French
  UI, English code. It asks me for a GitHub repository, my identity and a Render account, and
  shares a timeline.
- **17:40** Toolchain check: Node 22, pnpm 10, npm registry reachable, **shadcn registry blocked**
  (components will be written by hand), GitHub CLI not authenticated. TypeScript pinned to 5.9:
  7.0 had just shipped and tooling compatibility mattered more than novelty.
- **18:03** Monorepo scaffold: pnpm workspaces, strict TypeScript, Biome, Vitest projects.
- **18:07** The lead writes `packages/shared` itself, because everything depends on it: Zod schemas,
  jittered fractional positions, the 14 isomorphic mutators with the "edit wins over delete"
  policy, the snapshot and rebase. 21 tests, one of them property-based (fast-check).
- **18:10** Design direction (frontend-design pass): Auditoo's own forest green, read from their
  site (`#033527`); the architectural level datum marker as the signature; Atkinson Hyperlegible
  Next for legibility in dim basements; deliberately away from generic AI looks.
- **18:15 → 19:05** Three agents in parallel:
  - **Server** (34 min): Hono, PostgreSQL / PGlite, migrations, idempotent push, snapshot pull,
    SSE. Went beyond the brief: verified against a real PostgreSQL 16 (concurrent migrations,
    12 devices × 25 mutations racing two instances, gapless versions) and fixed a log leak.
  - **Sync engine** (50 min): IndexedDB storage, transport, `SyncClient`, React bindings, French
    descriptions, and the convergence simulation. Injected 6 bugs on purpose to prove the tests
    catch them; deviated from the brief where it was wrong (pushes read the outbox from IndexedDB).
  - **Web foundation** (38 min): Vite, router, tokens, hand-written shadcn/ui, Serwist, icons,
    Playwright config; checked offline reloads and the update prompt in a real browser.
  - Merge: 120 tests green, 5 commits.
- **19:10** Checkpoint sent to me.
- **19:10 → 19:40** The lead builds the screens: logements list, structure editor, dnd-kit board
  (rooms within and across levels, levels), swipe-to-delete, rename in place, level-aware
  suggestions and numbering, sync pill, offline banner, pending-changes sheet, example house.
  Visual QA on an emulated Pixel 7 from the production build. **Correction:** the sync sheet
  opened onto a zoomed-out page; a screenshot and a measurement (`scrollWidth` 583 px on a 412 px
  screen) traced it to a `<fieldset>` that kept its `min-content` width. Screenshots sent to me.
- **19:43** I send my GitHub identity; the lead rewrites the author of every commit and keeps the
  original dates. My messages interrupted the parallel agents twice; the lead relaunched them.
- **19:50 → 19:58** The GitHub connector cannot be linked from this session. **Plan B:** the lead
  bundles the repository, copies it into my folder through the desktop bridge (after asking me for
  delete permission, which git needs for its lock files), and I push from my PC.
- **20:00 → 21:45** Three more agents in parallel:
  - **E2E + CI**: 8 Playwright tests on mobile Chromium (swipes, drags, offline reload, two
    devices), GitHub Actions CI, a keep-warm workflow. It found a **real bug**: a dragged level's
    floating copy drifted ~350 px from the finger.
  - **Sync hardening** (the sync agent again, with its context): per-mutation validation,
    control characters refused, server epoch (it showed that pull-side detection alone would lose
    data, so pushes carry the epoch), IndexedDB reopening.
  - **Docs**: DESIGN.md, README and CLAUDE.md, every claim checked against the code. It reported
    8 inconsistencies, among them a flaky test (birthday bound) and dead components.
- **21:50** The lead fixes the drag bug (levels no longer collapse during a drag), adds a
  non-swipe way to delete a room, seeds the flaky test, removes dead code, updates DESIGN.md.
  185 unit tests and 8 end-to-end tests green; 15 commits.
- **22:12** A swiped row slides back when its deletion fails; DESIGN.md notes an end-to-end run
  against PostgreSQL 16, done by hand.
- **23:08** The live demo is up: its URL goes into the README. **23:13** `E2E_PORT`, so that two
  checkouts can run their end-to-end suites side by side.

## Night of 14 to 15 October: review, then hardening

- **23:30** I ask whether I can put my PC to sleep: yes, the session runs in the cloud. My
  messages do interrupt running agents, though: it happened three times.
- **23:35 → 01:05** Four agents in parallel, each on its own branch:
  - **Independent reviewer** (read-only): 1 critical and 4 major bugs, all in the touch UI.
    « Terminé » discarded the room being typed; a flick starting on a drag handle moved a room
    instead of scrolling; a 45 px flick deleted a whole house; quick taps on a suggestion chip
    landed on the text field; back navigation looped.
  - **Product UX**: level duplication, a ⋮ menu per room with « Déplacer vers… », the install
    offer, the offline-ready toast. It found that ⋮ menus opened on touch-down, so a scroll
    starting on one opened it, and that the 1 MiB body limit could block a queue forever.
  - **Sync feedback**: changes the server rejects reported to their user (push response, toasts,
    sync sheet). It found a startup crash on unknown mutation kinds.
  - **Quality**: 41 component tests, 43 contrast tests, an axe gate in both themes, a Content
    Security Policy (Zod's eval probe violated it), Lighthouse performance from 80 to 90, a bundle
    budget.
- **01:05 → 01:30** The lead merges the three branches: the derived `mutationSchema` replaces a
  hand-written envelope list, and with it the line the level copy had added there; TypeScript's
  exhaustive switches force French rejection wording for the new mutation; the merged tests expect
  the new push response; axe scans wait for the first visit's offline-ready toast, which slid in
  mid-scan and failed colour contrast.
- **01:35 → 03:05** Three agents fix what the review found:
  - **Touch safety**: hold to drag, undo for moves, swipes sized to what they delete, chips that
    keep the focus, focus never left on the page body, screen reader announcements in French.
  - **Navigation and recovery**: back that goes back, « Logements supprimés » and « Éléments
    supprimés », large titles, sheets mounted on their first opening, the manifest.
  - **Sync**: a calm pill (« Envoi… » only while sending), its own pokes skipped thanks to a hashed
    client tag (a deliberate deviation from its brief, for security), « Serveur injoignable »,
    creates refusing existing ids, no lock-out after an update, pushes capped in bytes, lone
    surrogates refused, the app type-checked against ES2022.
- **03:05 → 03:45** The lead merges them (442 Vitest tests, 41 end-to-end tests), finds and fixes
  « Renommer » in a level's menu leaving the focus on the page body (no keyboard on a phone; an
  e2e test used `press`, which focuses first, and hid it), and makes the PostgreSQL run
  reproducible: `pnpm e2e:postgres` (`scripts/with-postgres.sh`) and a CI job on PostgreSQL 18,
  the major version Render runs.
- **Then**, in parallel: a final fresh-eyes review, regenerated screenshots and a demo GIF, and a
  documentation pass (test counts measured again, DESIGN.md rewritten under 480 lines).
