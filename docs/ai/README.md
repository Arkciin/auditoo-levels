# How this project was built with AI

Auditoo asked to see how candidates work with AI coding agents. This folder is the honest record.

| File | What it is |
| --- | --- |
| [`session-log.md`](session-log.md) | Chronological log of the session (Paris time): requests, decisions, agent runs, what went wrong and how it was corrected |
| [`agent-briefs.md`](agent-briefs.md) | The exact briefs given to the six sub-agents, so the delegation can be judged on its inputs |
| [`../../CLAUDE.md`](../../CLAUDE.md) | The rules file for any AI agent working on this repository (architecture map, invariants, checklist) |

## The workflow in one paragraph

One **lead agent** (Claude, in a Claude Code cloud session, linked to my computer) owned the
architecture, the shared domain package, the screens and every merge. Self-contained chunks went to
**sub-agents running in parallel**, each with a written brief: what to build, the contract to
respect (the shared package), what not to touch, how to verify, and a final report to write. The
lead reviewed each report, ran the whole suite, looked at screenshots, and committed in small
conventional commits. I set the goal and the constraints (production quality, mobile-first,
offline-first, submit within a day), made the calls that only a human could make (identity,
accounts, deployment, what to show), and reviewed the checkpoints.

## Verification loops (why the AI output can be trusted)

- **Types and lint everywhere**: strict TypeScript, Biome; no merge without `pnpm check`.
- **Tests as the contract**: 185 unit and integration tests, including a seeded simulation of
  three devices going offline at random (`apps/web/src/sync/convergence.test.ts`), and 8 Playwright
  end-to-end tests on an emulated phone. Sub-agents checked that their tests catch bugs by
  injecting faults on purpose.
- **Eyes on the UI**: the lead drove the production build with Playwright on an emulated Pixel 7
  and read the screenshots before every UI commit.
- **Cross-checks between agents**: the e2e agent tested what the lead built; the docs agent
  verified every claim against the code and reported inconsistencies.

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

The full conversation is available on request.
