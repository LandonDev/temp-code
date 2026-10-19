# Moving the thread history from the Mac to the box

Status: 2026-10-19, inventory done, importer written and rehearsed on the box; cutover waits for the user's window. The box's
database becomes the one every client attaches to; the Mac keeps a small
local database for Apple-only work and shows the box's threads through its
environment link (Settings → Environments).

## Inventory (2026-10-19, from VACUUM INTO copies, never the live files)

Mac data dir `~/Library/Application Support/temp-code/`:

| file | on disk | after VACUUM INTO | rows |
|---|---|---|---|
| temp-code.db (hot) | 4.0 GB | 320 MB | 5,167 sessions (538 live, 4,629 archived), 668,980 events, 12 workspaces, 41 projects, 5,172 folds, 21 settings |
| temp-code-cold.db | 3.8 GB | 3.8 GB | 7,586,726 events of the 4,618 archived threads |
| stats.db | 750 MB | 737 MB | Aliax usage stats indexed from this Mac's CLI logs |
| checkpoints/ | 8.4 GB | | 1,818 session dirs, every one with a manifest |
| html-renders/ | 121 MB | | pages per session id |
| Local Storage/ | 2.6 MB | | unread marks and layout, per origin |

Referential state of the copy: every session's project and workspace exists;
5 folds and 423 hot events belong to no session (skipped); hot and cold rows
never overlap (`sessions.cold` matches where the rows are). 1,544 sessions
have a `plan_path`; some are absolute Mac paths, the rest relative.

Box data dir `/srv/agents/temp-code-data/` (agents): 1 workspace
(`/srv/agents/work/preview-proof`), 1 session, no events, 2 live bot keys
(grok, chatgpt) among 32 key rows, 26 pairings, 6 browser sessions, settings
`codex.speedTiers`, `github.inbox.auth`, `remote.learnedOrigin`,
`remote.publicOrigin`, `renderer.workspaceSnapshot.v1:web`; `environment.json`,
`server.json`, `tls/`. Fresh restic snapshots before anything moves: box
`4b2fbd1f` (16:29 New York) and the Mac run of 15:32 Central, both 2026-10-19.

## What is history and what is the host's own

History (moves to the box):

- `workspaces`, `projects`, `sessions`, `events` (hot), `cold.events`,
  `session_folds`, `notes` (0 rows today).
- settings rows that describe the user's threads, not the machine:
  `orchestration-rules`, `orchestration-rules:<ws>`, `thread-defaults`,
  `thread-defaults:<ws>`, `turn-pass:*`, `build:*`, and the desktop window's
  `renderer.workspaceSnapshot.v1` (open tabs by thread id), taken only when
  the box has no such row.
- files keyed by session id: `checkpoints/<id>/` (the manifest's `cwd` is
  remapped), `html-renders/<id>/`, `media/sessions/<id>/` (none yet).
- each mapped root's `.temp-code/` dir (transcripts, PROJECT.md, plans); it is
  gitignored, so a clone does not bring it.

Host identity and machine state (each host keeps its own; the importer never
writes them):

- `remote_keys`, `remote_pairings`, `remote_sessions`, every `remote.*`
  setting, `environment.json`, `server.json`, `tls/`.
- `github.inbox.auth` (a token), `github.inbox.viewer`, `github.inbox.fetchedAt`,
  `github_inbox_repos` (a cache the box refetches), `codex.speedTiers` (per
  installed codex and account), `appshots*`.
- `stats.db`: indexed from the Mac's own CLI log files (its `files` table
  tracks offsets into them) and has no environment column. It stays on the
  Mac with Aliax; the Mac's fresh dir gets an APFS clone of it.
- `Local Storage/`, `window-state.json`, `update-times.json`, `.updaterId`,
  `logs/`, Chromium caches.

## Roots

Threads are counted through their project's workspace. App-managed worktrees
(`~/.temp-code/worktrees/<slug>`) belong to the workspace of their project and
are remade from the clone on the first turn (sessions.ts `ensureCwd`).

| workspace | Mac root | remote | threads (live) | events | checkpoints | .temp-code | plan |
|---|---|---|---|---|---|---|---|
| CosmicPrisons-Shredded | IdeaProjects/CosmicPrisons-Shredded | LandonDev/CosmicPrisons | 3,561 (322) | 2.4 GB | 1.8 GB | 31 MB | clone |
| cosmicweb | Desktop/Websites/cosmicweb | LandonDev/cosmicprisons-web | 760 (56) | 600 MB | 5.3 GB | 494 MB | clone |
| temp-code | IdeaProjects/temp-code | LandonDev/temp-code | 249 (16) | 173 MB | 20 MB | 42 MB | clone; iOS work stays on the Mac |
| NorthCentralRefs | Desktop/Websites/NorthCentralRefs | LandonDev/NorthCentralRefs | 184 (3) | 68 MB | small | 3.7 MB | clone |
| HSSports | Desktop/Websites/HSSports | none (local git, 95 MB .git) | 119 (25) | 91 MB | 1.2 GB | 56 MB | push to GitHub first, else Mac-only |
| groupgames | Desktop/Websites/groupgames | LandonDev/group-games | 95 (73) | 43 MB | 30 MB | 1.6 MB | clone |
| monocode | IdeaProjects/monocode | LandonDev/monocode | 53 (0) | 26 MB | 0 | 7.4 MB | clone |
| (home) | /Users/landon | | 40 (13) | 36 MB | small | | map to /srv/agents/home |
| SeeTheReaction | Desktop/Websites/SeeTheReaction | none (local git, 3.4 GB .git) | 30 (3) | 28 MB | 290 MB | 0.8 MB | push first, else Mac-only |
| baseheroui | Desktop/Websites/baseheroui | LandonDev/tst | 24 (19) | 19 MB | 10 MB | 0.7 MB | clone |
| CosmicClient | IdeaProjects/CosmicClient | none (no git, 12 GB) | 18 (1) | 10 MB | 0 | 312 MB | Mac-only |
| UnifyLeagues-v2 | Desktop/Websites/UnifyLeagues-v2 | none (local git) | 14 (4) | 14 MB | small | 1.7 MB | push first, else Mac-only |
| SchedUni | Desktop/Websites/SchedUni | none (local git) | 7 (3) | 4 MB | 20 MB | 0.2 MB | push first, else Mac-only |

A Mac-only root's threads still move to the box, archived and readable, with
their Mac paths kept (see "Unmappable roots"). The same importer can instead
put them into the Mac's fresh database (`--roots` filter, identity mapping)
if the user wants them live there.

## Path remap

Longest prefix wins; applied to `workspaces.path`, `projects.cwd`,
`sessions.cwd`, absolute `sessions.plan_path`, `notes.source_cwd` and each
checkpoint manifest's `cwd`. Event payloads are history and keep the paths
they recorded (46,371 hot rows mention `/Users/landon/`).

| from | to |
|---|---|
| `/Users/landon/IdeaProjects/<X>` | `/srv/agents/work/<X>` |
| `/Users/landon/Desktop/Websites/<X>` | `/srv/agents/work/<X>` |
| `/Users/landon/.temp-code/worktrees/<slug>` | `/srv/agents/home/.temp-code/worktrees/<slug>` |
| `/Users/landon` | `/srv/agents/home` |

The mapping file (`scripts/box/history-map.json`) lists the roots to map;
a workspace root with no entry is unmappable.

## Unmappable roots

The workspace row is imported with its Mac path so the tree stays whole and
every thread stays readable; its projects and threads are imported with
`archived = 1`, so the default list hides them and the archived view shows
them; the importer writes one settings row, `history.import`, whose JSON
names each missing root with its thread count. Nothing is dropped and
nothing is left pointing at a path that looks valid but is not.

## The importer: scripts/box/import-history.ts

Runs under node 22 (`node:sqlite`) on the box as agents, against a stopped
writer (it refuses a data dir whose `server.json` pid is alive).

```
node scripts/box/import-history.ts --from <dir> --into <userData> \
  --map scripts/box/history-map.json [--dry-run] [--roots a,b] [--no-files]
```

`<dir>` holds `temp-code.db`, `temp-code-cold.db`, `checkpoints/`,
`html-renders/` (the VACUUM INTO copies plus rsynced dirs). One transaction
over the destination hot file with the source files and destination cold
file attached:

1. workspaces: insert when the id is new; a destination workspace that
   already owns the remapped path (say the box already registered
   `/srv/agents/work/temp-code`) wins, and the import's projects and sessions
   point at it.
2. projects, sessions: insert when new, paths remapped, `archived` forced to
   1 under an unmappable root.
3. events: hot rows to the hot file, cold rows to the cold file, by
   `(session_id, seq)`; rows of unknown sessions skipped.
4. folds, notes, allowlisted settings: insert when new.
5. files: `checkpoints/<id>` (manifest cwd remapped) and `html-renders/<id>`
   copied when the destination lacks them.
6. `history.import` settings row: when, from which host, counts, missing roots.

Idempotent: inserts only what is missing, so a rerun changes nothing.
`--dry-run` prints, per table, destination rows now, rows the import would
add, and the total after. The real run prints the same table from the
actual counts.

## Rehearsal results (2026-10-19)

Staging on the box: `/srv/agents/history-move/mac/` (the two copies, 8.5 GB
of `checkpoints/`, `html-renders/`, the seven mapped roots' `.temp-code/`);
the upload ran at about 9 MB/s compressed, 5 minutes in all. Destination:
`/srv/agents/history-move/rehearsal/data`, a read-only `VACUUM INTO` of the
live box databases (1 workspace, 1 session, 32 key rows).

| step | result |
|---|---|
| dry run on the Mac copy (schema-only scratch) | 12 / 41 / 5,167 / 668,557 hot / 7,586,726 cold / 5,167 folds / 16 settings to add, 0.5 s |
| real run on the Mac scratch | 27 s, both files `quick_check` ok |
| dry run on the box | the same adds on top of the box's 1 / 0 / 1 / 0 / 0 / 1 / 5 |
| real run on the box, database only | 6 s; rerun adds 0 to every table |
| trial instance on the rehearsal dir (systemd-run, scratch HOME, random port, headless) | ready in 9 s; hello contract 1; `session.list` 503 live and 4,665 archived (538 − 36 live threads under missing roots + the box's own 1; 4,629 + 36); `session.events` of a live thread 489 rows and of a cold thread 597 rows; 41 projects, 13 workspaces |
| real run with files | 4 s; 1,797 checkpoint dirs and 44 html-render dirs copied (the 42 staged dirs of threads newer than the copy were skipped); the mapped manifest reads `/srv/agents/work/temp-code`, the HSSports one keeps its Mac path; rerun copies 0 |

The trial's cold mover moved the hot rows of the 36 newly archived threads to
the cold file (98,968 rows), which is the app's normal behaviour.

Two things the rehearsal found:

- The transcript mirror (server/mirror.ts) created every project cwd that
  was missing, so the app's `ensureCwd` would have taken the CosmicPrisons
  worktrees for present and started harnesses in empty dirs. `contextCwd`
  now answers null for a cwd that is not on disk; the mirror writes nothing
  there. The dirs the rehearsal left under `/srv/agents/home/.temp-code/
  worktrees` were removed.
- Worktree branches: of CosmicPrisons-Shredded's 19 worktree projects, only
  `reboots`, `u33` and `performance` still exist as branches (on origin, not
  ahead of it). `update-32`, the biggest live one (242 threads), sits on a
  detached HEAD at `8bf39b7e8`, a commit on `origin/main`; the other 15 are
  archived projects whose branches are gone. On the box the four live
  worktrees exist at the Mac's heads (`update-32` detached at `8bf39b7e8`,
  `update-33` on `u33`, `partial-reboots` on `reboots`, `performance`); the
  archived ones are remade by `ensureCwd` from `main` on a first turn, which
  is what the Mac would do too now that their branches are gone.

Clones: gh is signed in on the box (thread G), so the seven mapped roots are
cloned under `/srv/agents/work` on their default branches (`git init` +
`remote add` + `fetch` + `checkout`, since the rehearsal had already left a
`.temp-code/` in each). Their `.temp-code/` dirs come from the Mac at
cutover (rsync, Mac wins).

## Rehearsal plan (as run)

1. rsync the inventory copies and `checkpoints/`, `html-renders/`, each root's
   `.temp-code/` to `/srv/agents/history-move/mac/` on the box.
2. Scratch destination `/srv/agents/history-move/rehearsal/data`: the box's
   latest pre-update snapshot of its own databases plus a copy of its
   `environment.json`-less state (a scratch dir gets a fresh identity).
3. Dry run, real run, rerun (must add 0 rows); `quick_check` on both files.
4. A trial instance the way the launcher starts one (systemd-run, scratch
   HOME, random loopback port, headless) on that data dir; `tc-local
   session.list` and `session.events` of one imported thread; `/healthz`.
   The public `/ui` reaches the live host only, so opening a thread there is
   part of the cutover's verification.
5. Record counts and timings here.

## Cutover (needs the user for a few minutes)

Scripts: `scripts/mac/split-data-dir.sh copy|split` on the Mac and
`scripts/box/import-history.sh <from-dir> [--dry-run]` on the box (as root,
from the deployed build: snapshot under the backup lock, stop the service,
dry run, import, `quick_check`, start, probe).

1. User quits TempCode.app (and runs no `dev:prod`). Check: no process holds
   the data dir, no `SingletonLock`.
2. Final `VACUUM INTO` copies of both databases; rsync the delta of copies,
   `checkpoints/`, `html-renders/`, `.temp-code/` dirs to the box.
3. On the box, as root: take the launcher's pre-update snapshot of the live
   databases, stop `temp-code.service`, run the importer for real as agents,
   start the service, wait for `/healthz` and the hello (the launcher's own
   probe), `tc-local session.list` counts, open a handful of threads on
   tempcode.landonhale.com/ui.
4. Clone the mapped roots under `/srv/agents/work` (needs G's gh login;
   `git init` + `remote add` + `fetch` + `checkout` works in a dir that
   already holds `.temp-code/`). Roots whose clone is not ready are listed
   in the report.
5. On the Mac: rename the data dir to `temp-code.moved-2026-10-19`; create a
   fresh `temp-code` with the Mac's identity (`environment.json`), `Local
   Storage/`, `window-state.json`, `update-times.json`, `.updaterId`, an
   APFS clone of `stats.db`, and a database holding only the Mac's own
   settings (`github.inbox.*`, `codex.speedTiers`, `appshots*`,
   `thread-defaults`, `orchestration-rules`) plus the box as a saved
   environment (a client key minted on the box, stored the way pairing
   stores it). Nothing is deleted.
6. User reopens TempCode.app: the Mac host is empty, the box's threads show
   under its environment.
7. Prove the box's keys still work: `bun scripts/e2e-box-remote.ts`, and the
   MCP keys through `scripts/e2e-mcp-remote.ts`.

## After

- The Mac backup keeps covering the renamed dir until the user removes it
  (`scripts/mac/backup.sh` takes `TEMP_CODE_DATA`; the agent plist gains the
  moved dir as a second path, or the script gets the one-line default).
- docs/box.md "Where the history lives"; CLAUDE.md's prod-data line.
