# How this project was built with AI

Auditoo asked to see how candidates work with AI coding agents. This folder is the honest record.

| File | What it is |
| --- | --- |
| [`session-log.md`](session-log.md) | Chronological log of the session (Paris time): requests, decisions, agent runs, what went wrong and how it was corrected |
| [`agent-briefs.md`](agent-briefs.md) | The briefs the lead gave its sub-agents, so the delegation can be judged on its inputs |
| [`../../CLAUDE.md`](../../CLAUDE.md) | The rules file for any AI agent working on this repository (architecture map, invariants, checklist) |

## The workflow in one paragraph

One **lead agent** (Claude, in a Claude Code cloud session, linked to my computer) owned the
architecture, the shared domain package, the screens and every merge. Self-contained chunks went to
**sub-agents running in parallel**, each with a written brief: what to build, the contract to
respect (the shared package), what not to touch, how to verify, and a final report to write. The
lead reviewed each report, ran the whole suite, looked at screenshots, and committed in small
conventional commits. I set the goal and the constraints (production quality, mobile-first,
offline-first, submit within a day), made the calls that only a human could make (identity,
accounts, deployment, what to show), and reviewed the checkpoints. At night the loop turned to
review: an independent, read-only reviewer hunted bugs while three agents built on their own git
branches; the lead merged the branches, then three more agents fixed what the review had found.

## Verification loops (why the AI output can be trusted)

- **Types and lint everywhere**: strict TypeScript, Biome; no merge without `pnpm check`.
- **Tests as the contract**: 442 Vitest tests, among them a seeded simulation of three devices
  going offline at random (`apps/web/src/sync/convergence.test.ts`), 89 component tests driven by
  role and French name, and a contrast check of the palette; 41 Playwright end-to-end tests on an
  emulated phone, each failing on an uncaught exception or a Content Security Policy violation,
  with axe scans of every screen in both themes. CI runs them on PGlite and on PostgreSQL 18, and
  holds the bundle to a budget. Sub-agents checked that their tests catch bugs by injecting faults
  on purpose.
- **Eyes on the UI**: the lead drove the production build with Playwright on an emulated Pixel 7
  and read the screenshots before every UI commit.
- **Cross-checks between agents**: the e2e agent tested what the lead built; an independent,
  read-only reviewer hunted bugs in what the other agents built; the docs agents verified every
  claim against the code and reported inconsistencies.

## Course corrections (where the AI was wrong, and who caught it)

| What went wrong | Caught by | Fix |
| --- | --- | --- |
| A `<fieldset>` of suggestion chips kept its `min-content` width: the page became wider than the screen, mobile Chrome zoomed out and the sync sheet opened off-screen | Lead, reading a screenshot | `min-w-0` on the fieldset, `overflow-x: clip` on the app column as a safety net |
| Collapsing levels while dragging one moved dnd-kit's measured rect: the floating copy drifted ~350 px from the finger and dropped in the wrong place | E2E agent (test written against the finger, marked `fixme`) | Levels keep their rooms during a drag; the test now passes |
| A uniqueness test drew 1,000 random keys among ~14.5 M: it failed ~3 % of runs (birthday bound) | Docs agent, measuring it | Seeded generator |
| Detecting a replaced server database on pull only would still lose data: a push could reach the new database before the pull noticed | Sync agent, reasoning through the protocol | Pushes carry the database epoch; mismatched pushes are refused |
| One invalid mutation made the whole push fail with 400, forever | Server and sync agents (independently) | Per-mutation validation; invalid ones are acknowledged as rejected |
| Two tabs pushing from memory could skip a mutation of the other tab | Sync agent | Pushes read the outbox from IndexedDB |
| Error logs dumped the whole node-postgres client (2.4 kB per line) | Server agent, during a smoke run | Logger keeps name, message, code, stack, cause |
| `pkill -f` matched the lead's own shell and killed it, twice | Lead (own mistake) | Kill by PID only; rule written into the later briefs |
| The shadcn registry was unreachable from the sandbox | Lead, during setup | Components written by hand following the new-york v4 source, `components.json` kept for the CLI |
| `navigationPreload` on: one wasted request per navigation | Web foundation agent (deviation from its brief, accepted) | Disabled, reason documented in `sw.ts` |
| Commits were first signed with a work email | Me | History rewritten to my GitHub identity, original dates kept |
| The GitHub connector could not be linked from this session | Me and the lead | Plan B: the lead copied the repository (git bundle) into my folder; I pushed from my PC |
| « Terminé » closed the room field and dropped the room being typed | Independent reviewer (critical) | « Terminé » adds it first |
| A flick that started on a drag handle moved a room instead of scrolling the page | Independent reviewer | A finger drags only after holding the handle still for 250 ms |
| A 45 px flick deleted a whole house | Independent reviewer | Gestures sized to what they delete: a flick must cover a quarter of the row, and levels and logements only reveal a « Supprimer » button |
| Quick taps on a suggestion chip landed on the text field, as the rooms they added pushed the chips down | Independent reviewer | The page scrolls by as much as the chips moved, before it paints; the field keeps the focus |
| Back navigation looped between the list and a logement | Independent reviewer | Back goes back in history, or replaces the logement with the list |
| A ⋮ menu opened on touch-down: a scroll starting on one opened it | Product UX agent | Touch and pen open menus on the tap |
| The 1 MiB body limit could block a device's queue forever (a push of 100 level copies could weigh 6.5 MiB) | Product UX agent | An 8 MiB limit, then pushes capped at 1 MiB by the device |
| A queued mutation of an unknown kind crashed the app at startup | Sync feedback agent | Refused like any mutation that cannot apply; later, no outbox entry can lock a device out |
| Zod's eval probe violated the new Content Security Policy | Quality agent | Zod's compiler off in browsers (`packages/shared/src/zod-config.ts`) |
| The merged axe gate failed colour contrast: the first visit's offline-ready toast slid in mid-scan | Lead, merging | Scans wait for the service worker, then for the toast's entrance |
| The merged level copies had no French wording for their rejections | TypeScript's exhaustive switches, at the merge | Wording for level copies |
| « Renommer » in a level's menu left the focus on the page body: no keyboard on a phone. An e2e test used `press`, which focuses first, and hid it | Lead, after merging | The level header drops its menu while renaming; the test checks the focus |
| DESIGN.md's end-to-end run on PostgreSQL 16 had been done by hand, with nothing to reproduce it | Lead | `pnpm e2e:postgres` (`scripts/with-postgres.sh`) and a CI job on PostgreSQL 18, the major version Render runs |
| The docs, patched by several agents in parallel, disagreed on the test counts (304 in one place, 275 in another; a run has 442), and listed a limitation (a rejection announced twice after a restart) that a throwaway test disproved | Docs agent, final pass | Counts measured from one run; the limitation rewritten |

The full conversation is available on request.
