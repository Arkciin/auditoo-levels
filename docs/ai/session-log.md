# Session log

One Claude Code cloud session, linked to my computer, on 14 October 2026 (Paris time). "Lead" is
the main Claude agent; "agent" is a sub-agent it launched with a written brief
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
