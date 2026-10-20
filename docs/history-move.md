# Moving the thread history from the Mac to the box

Status: 2026-10-20 UTC, F3 fixes and rehearsals complete; the history is still staged on both hosts. Cutover has NOT run and waits for the user's go. The box's
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
| HSSports | Desktop/Websites/HSSports | LandonDev/HSSports (created 2026-10-19) | 119 (25) | 91 MB | 1.2 GB | 56 MB | clone |
| groupgames | Desktop/Websites/groupgames | LandonDev/group-games | 95 (73) | 43 MB | 30 MB | 1.6 MB | clone |
| monocode | IdeaProjects/monocode | LandonDev/monocode | 53 (0) | 26 MB | 0 | 7.4 MB | clone |
| (home) | /Users/landon | | 40 (13) | 36 MB | small | | map to /srv/agents/home |
| SeeTheReaction | Desktop/Websites/SeeTheReaction | LandonDev/SeeTheReaction (created 2026-10-19, build output filtered) | 30 (3) | 28 MB | 290 MB | 0.8 MB | clone |
| baseheroui | Desktop/Websites/baseheroui | LandonDev/tst | 24 (19) | 19 MB | 10 MB | 0.7 MB | clone |
| CosmicClient | IdeaProjects/CosmicClient | a dir of five repos, see below | 18 (1) | 10 MB | 0 | 312 MB | assemble from clones |
| UnifyLeagues-v2 | Desktop/Websites/UnifyLeagues-v2 | LandonDev/UnifyLeagues-v2 (created 2026-10-19) | 14 (4) | 14 MB | small | 1.7 MB | clone |
| SchedUni | Desktop/Websites/SchedUni | LandonDev/SchedUni (created 2026-10-19) | 7 (3) | 4 MB | 20 MB | 0.2 MB | clone |

The user chose to keep every root live, so on 2026-10-19 the five roots
without a GitHub remote got one, all private under LandonDev, pushed from the
Mac (`gh repo create --source --push`) and cloned on the box:

- HSSports (branch `backend-base-data`, 29 uncommitted files stay on the
  Mac), SchedUni and UnifyLeagues-v2: pushed as they were.
- SeeTheReaction: its two commits carried 300–460 MB tvOS build products,
  which GitHub refuses, so a temp clone was filtered (`apps/tvos/build/` and
  `packages/apple-core/.build/` removed from both commits, a `.gitignore`
  commit added) and that history is what `LandonDev/SeeTheReaction` holds.
  The Mac checkout still has the old history and the build files; to align
  it: `git -C ~/Desktop/Websites/SeeTheReaction checkout -B main origin/main`
  (the tracked build output under those two dirs leaves the working tree).
- CosmicClient is not a repo but a dir of five: CosmicClient-1.8.9,
  CosmicClient-Bootstrap, CosmicClient-Launcher and ClientComms already live
  under github.com/CompilexLLC; CosmicClient-1.21 had no remote and is now
  `LandonDev/CosmicClient-1.21`. The box's `/srv/agents/work/CosmicClient/`
  is assembled from the five clones (Launcher on its default `master`; the
  Mac has `1.21` checked out) plus the plan documents, launch scripts and
  `.temp-code/` from the Mac; `dist/` (2.2 GB of zips) is not copied.

Nothing is left unmappable, so the archive path below is not exercised by
this move; it stays for a future host.

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

## The importer: src/main/server/historyImport.ts

Runs under node 22 (`node:sqlite`) on the box as agents. Both source and
destination must be offline: it refuses either dir if `server.json` or a
local `SingletonLock` names a live process. Use offline snapshots as the
source. Source read transactions stay open on both databases through all
destination commits, so later batches read the same source generation.

```
node src/main/server/historyImport.ts --from <dir> --into <userData> \
  --map scripts/box/history-map.json [--dry-run] [--no-files]
```

`<dir>` holds `temp-code.db`, `temp-code-cold.db`, `checkpoints/`,
`html-renders/` (the VACUUM INTO copies plus rsynced dirs). One transaction
for metadata and hot events, then batches of cold events in the destination
cold file:

1. workspaces: insert when the id is new; a destination workspace that
   already owns the remapped path (say the box already registered
   `/srv/agents/work/temp-code`) wins, and the import's projects and sessions
   point at it.
2. projects, sessions: insert when new, paths remapped, `archived` forced to
   1 under an unmappable root.
3. events: hot rows to the hot file, cold rows to the cold file, by
   `(session_id, seq)`; rows of unknown sessions skipped. Compare seq sets,
   including both destination tiers, rather than row counts: a session with
   extra rows can still have holes. Rows already in either tier stay there.
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
`scripts/box/import-history.sh <from-dir> [--dry-run]` on the box as root.
The wrapper takes `/run/lock/temp-code-update.lock` first, then
`box-backup.lock`, and holds both through snapshot, stop, import, restart
and health checks. `box-update` uses the same order and keeps the locks
through its switch, restart and rollback. Either refuses at once with a
maintenance-lock message while the other runs. Do not restart the service
by hand during this work.

Before the window, install the fixed maintenance helpers through stages 75
and 85 (see docs/box.md Updating), then deploy the green ref containing F3
through `box-update`. The deployed importer and wrapper must include these
fixes. A rehearsal only, with no live snapshot or service changes:

```sh
ssh box 'bash /srv/agents/temp-code-builds/current/scripts/box/import-history.sh /srv/agents/history-move/mac --dry-run --into /srv/agents/history-move/rehearsal/data'
```

`--into` is allowed only with `--dry-run` and refuses the live data path.
It still takes both locks. Check its row report and identity counts; the
rehearsal must preserve keys, pairings and browser sessions.

1. Wait for the user's go. User quits TempCode.app and runs no `dev:prod`.
   Check no process holds the data dir and no live `SingletonLock` remains.
   Confirm fresh restic backups on both hosts before changing either.
2. Run `scripts/mac/split-data-dir.sh copy`: final `VACUUM INTO` copies of
   both offline databases; rsync the delta of copies, `checkpoints/`,
   `html-renders/` and `.temp-code/` dirs to the box. Never use a running
   Mac data dir as the import source, even with `--dry-run`.
3. Run the deployed `scripts/box/import-history.sh /srv/agents/history-move/mac`
   as root. It snapshots the box, stops its writer, prints identity counts,
   runs a dry run and the import, checks both databases and identity counts,
   then starts and probes the host under both locks. Check thread counts,
   a few threads on tempcode.landonhale.com/ui and the box's existing keys.
4. Confirm all mapped clones and worktrees under `/srv/agents/work` are
   ready. Rsync the final `.temp-code/` dirs into them; list any missing roots.
5. Run `scripts/mac/split-data-dir.sh split` with `TC_BOX_KEY` and
   `TC_BOX_ENV_ID` supplied through the environment. It builds and checks
   the fresh dir before renaming anything. It copies the exact Mac
   `remote_keys`, `remote_pairings` and `remote_sessions` tables and indexes,
   every `remote.*` setting (including saved environments), machine settings,
   `environment.json`, `tls/`, `Local Storage/`, window and updater state,
   and an APFS clone of `stats.db`. It adds the box environment and leaves
   history in `<data-dir>.moved-<current-date>`; nothing is deleted.
   Check `remote_keys before=N after=N` and the pairing/session counts.
   The script compares every copied identity row before it swaps dirs.
6. User reopens TempCode.app: the Mac host has no local history, and the
   box's threads show under its saved environment. Existing Mac keys and
   browser sessions must still authenticate to the same Mac environment id.
7. Prove the box's keys still work with `bun scripts/e2e-box-remote.ts` and
   `scripts/e2e-mcp-remote.ts`. Keep keys and pairing links out of logs.

## F3 verification (2026-10-20 UTC, cutover still pending)

- Unit gate: 2,798 tests across 328 files; hub 12 tests; Swift contract 29;
  Swift client 141; typecheck, generated contract check and production build
  passed. The existing Swift probe freshness test at
  `TempCodeSocketTests.swift:226` failed once, then the full client suite passed.
  A later JS run hit three `HtmlRenderFrame.dom.test.tsx` teardown errors
  after all assertions passed; the full JS rerun passed without those errors.
- `historyImport.test.ts` covers equal/larger cold row counts with a missing
  seq, cross-tier duplicates, a live source, source reads across commits,
  both root mapping directions and slash normalization.
- `historySplit.test.ts` ran the real split on an offline copy of the small
  Mac `temp-code-dev-empty` database, with test identity rows added only to
  that copy: keys 2 → 2, cookies and pending pairing still work, revoked key
  stays revoked, saved environments survive, old history stays in the renamed
  dir and fresh history is empty. No live Mac data dir changed.
- Box wrapper dry run on `/srv/agents/history-move/rehearsal/data`: workspaces
  13, projects 41, sessions 5,168, hot events 668,561, cold events 7,685,694,
  folds 5,168, settings 22; every add was zero. Keys 28 → 28, pairings
  26 → 26, browser sessions 6 → 6.
- Direct box lock test: importer dry run blocked `box-update`; an updater
  forced to reject an absent source bundle before building blocked the
  importer. Both returned the maintenance-lock message. The live PID,
  start time and `current` link stayed unchanged.
- `scripts/box/test-history-maintenance.py` ran on the box in private mounts
  with fake build/service commands and a local restic repo. Both lock
  directions, first deploy with no `current` or databases, failed first
  deploy, rollback with both locks held, and restore of uploaded generation
  A after local generation B replaced it all passed.
- Full R2 backup uploaded the existing offline SQLite backup generation with
  its new manifest (no live database reads). The fixed restore-drill script
  restored snapshot `fb39aa0b`, checked both files and all table counts against
  that uploaded manifest, and passed. Generation: `3543b0d6`.

## After

- The Mac backup keeps covering the renamed dir until the user removes it
  (`scripts/mac/backup.sh` takes `TEMP_CODE_DATA`; the agent plist gains the
  moved dir as a second path, or the script gets the one-line default).
- docs/box.md "Where the history lives"; CLAUDE.md's prod-data line.

## Harness transcripts (2026-10-20): the resume ids moved, their files did not

After the cutover every Claude thread on the box failed its next message
with `No conversation found with session ID: <id>`. The database carries
each thread's native session id (`sessions.native_id`, 555 active claude
rows, 92 codex), and the driver passes it to the CLI as the resume target,
but the files those ids name live outside the data dir: Claude Code's
`~/.claude/projects/<cwd slug>/<id>.jsonl` and Codex's
`~/.codex/sessions/<date>/rollout-*.jsonl`. The importer moved neither, and
nothing forgot the id on failure, so every send retried the same resume.

Two fixes, both landed:

- **The driver forgets a lost native session and the registry reseeds.**
  `drivers/claude.ts` matches the CLI's text (`LOST_NATIVE_SESSION`) on the
  error result's `errors` and on the SDK's thrown "returned an error result"
  and calls `ctx.nativeSessionLost()`; the registry nulls `nativeId`, waits
  for the turn to settle, and continues the thread on a fresh process with
  the same transcript handoff a provider switch uses (`lostNativeHandoff`:
  a native-resume provider, no native id, assistant text in the log, no live
  handle), followed by a continue-run that answers the last user message.
  The same rule seeds a later plain send if the recovery itself failed.
  `sessions-native-lost.test.ts` covers both.
- **`scripts/mac/copy-claude-projects.sh` copies the files.** Run on the Mac
  (`--dry-run` first): every `~/.claude/projects` dir lands under the slug of
  its cwd mapped through `scripts/box/history-map.json` (cwd read from the
  first transcript line; slug rule `[^A-Za-z0-9_-]` → `-`, so
  `/Users/landon/IdeaProjects/temp-code` becomes `-srv-agents-work-temp-code`),
  and `~/.codex/sessions` copies as it is. Re-runnable, newer files win,
  nothing on the box is deleted. After it, a thread resumes natively with
  its full context; before it, the handoff keeps the thread usable with the
  dialogue replayed as text.
