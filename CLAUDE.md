# temp-code — instructions for AI sessions

This file is an index, loaded whole into every Claude thread's first request, and
it holds to 40,000 bytes (scripts/claudeMdBudget.test.ts): at 305 KB it was most
of a 200k window and every thread compacted on every request
(docs/agents/prompt-overhead.md). A new subject's long account goes in
`docs/agents/<slug>.md`; this file gets one entry for it.

## One line: prod runs the newest published GitHub release
- `/Applications/TempCode.app` runs the newest `v1.0.N` release on
  github.com/LandonDev/temp-code (public). It updates itself through
  electron-updater: at launch, every 5 minutes, and when a window comes
  forward after 15 idle minutes it reads the feed's latest-mac.yml, offers
  the release, downloads only when asked, and restarts on request. A
  release it is TOLD about skips the wait: the Publish button's script
  exiting green inside the app, or the box's `release-available` push over
  the peer link after its deploy, makes it fetch that second and offer
  "Restart to update" (src/main/update.ts `selfUpdate`, the rules in
  updateTrigger.ts: a version it already runs or holds is ignored, and
  nothing installs without the restart click). Its data
  lives in `~/Library/Application Support/TempCode/` (`dev:prod` still runs
  on the older `temp-code/` dir).
- Nothing reaches users until `bun run release:publish` runs (see below).
  Every green commit on master is still tagged locally, so commit only
  finished, verified slices: the next publish ships everything since.
- `stable` is a pointer the updater no longer reads; it is moved onto
  master at each cutover (`git branch -f stable master`) and otherwise
  left alone. The pre-MonoCode line (v96) lives on in the reflog only.

## The user lives in the installed app — never touch it
Do not launch anything against the prod userData (that means never
`bun run dev` without TEMP_CODE_USER_DATA, and never `bun run dev:prod`
from an AI session), do not send messages into the user's threads, and
do not kill or restart the installed app.

## Testing: spawn an isolated dev instance
```bash
env -u ELECTRON_RUN_AS_NODE \
  TEMP_CODE_USER_DATA="$HOME/Library/Application Support/temp-code-dev" \
  TEMP_CODE_DEBUG_PORT=9224 bun run dev
```
- Own database, own window; CDP on 9224 for driving and screenshots
  (`window.__app` exposes the store in dev builds). A fresh userData starts
  with an empty rail, wherever it was launched from: add the folder with
  Add workspace….
- These are ENFORCED in code: a dev build without TEMP_CODE_USER_DATA
  exits immediately (it would open the installed app's database — a
  second SQLite writer there freezes the user's live threads), and each
  userData dir takes a single-instance lock. If several sessions test at
  once, each needs its OWN userData dir and debug port (temp-code-dev2 /
  9226, …).
- `env -u ELECTRON_RUN_AS_NODE` is required — the variable leaks into
  agent shells and breaks Electron.
- Renderer must be on port 5173; a different port means a stale dev
  server from another session is holding it. Kill it (`pkill -f
  electron-vite`) and relaunch — electron-vite never restarts the main
  process on its own, so main-process changes always need a relaunch.
  When another app's dev server holds 5173 (lifeos sits on `[::1]:5173`,
  and the window would load it in the renderer's place), set
  `TEMP_CODE_RENDERER_PORT=5177` (electron.vite.config.ts: that port,
  strict) and check `document.title` over CDP before trusting the window.
- Kill your dev instance when the pass is done.
- Updater end to end: `bun run script:e2e-updater` (scripts/e2e-updater.ts)
  builds two signed, un-notarized copies of the tree (1.0.N-1 and 1.0.N) with
  their own bundle id and product name, serves the newer one from a local
  feed, and drives the older copy under /private/tmp/tc-updater-e2e through
  check → download → restart over CDP (port 9230) until the bundle on disk
  is 1.0.N and the relaunched app answers. The hooks it uses:
  `TEMP_CODE_UPDATE_FEED=<url>` makes a packaged copy that also has
  `TEMP_CODE_USER_DATA` read a generic feed (latest-mac.yml + zip) at that
  URL, with its downloads under `~/Library/Caches/temp-code-harness-updater`;
  and a `tempcodeHarness` block in the bundled package.json (electron-builder
  extraMetadata) carries the same three TEMP_CODE_* keys into an app that
  Squirrel's ShipIt relaunches without our environment (src/main/harness.ts).
  Its Squirrel state lives in `~/Library/Caches/dev.landon.tempcode.e2e.ShipIt`.
  Nothing of this touches /Applications/TempCode.app or its caches.

## The user dogfoods master on the prod data
`bun run dev:prod` runs master against the prod userData (CDP on 9220).
It is the user's command, not ours. The single-instance lock keeps it and
the installed app from running at once: quit one before opening the
other. Master only adds to the database (new tables, defaulted columns),
so the two apps can take turns on it. Layout lives in localStorage, which
differs by origin, so it does not carry across; unread is the host's mark
("Read and unread: the host's mark" below) and does.

## The prod worktree is retired
~/IdeaProjects/temp-code-prod was the old local updater's build checkout.
The updater no longer reads it or the source repo at all; it can stay
detached as a scratch checkout or be removed. Never build into or swap
/Applications/TempCode.app yourself.

## Subjects: one entry each, the long account in docs/agents

Read the file a task touches before changing that subject; each keeps its
section's text as it was when CLAUDE.md was split (2026-11-11).

- **Releases** — `bun run gate` (scripts/gate.ts: `commit` and `publish`
  tiers, `TIER_PATHS`); a post-commit hook tags `release-N` on every green
  master commit (`bun scripts/release.ts`); `bun run release:publish`
  (scripts/release-publish.sh) ships HEAD's 1.0.N to the feed; both are
  buttons in Settings → Hosts, pressed by the user. No AI attribution
  trailers in commits. [docs/agents/releases.md](docs/agents/releases.md)
- **Project preambles** — the house rules as markdown on the project row
  (`projects.preamble`), added to a thread's first message on every start
  path by `decidePreamble` (src/main/server/projectPreamble.ts).
  [docs/agents/project-preambles.md](docs/agents/project-preambles.md)
- **UI standard** — docs/DESIGN.md wins every conflict; Kobra on Base UI under
  src/renderer/src/components/ui, mapped in components/README.md; the guard
  tests under src/renderer/src/lib/*Guard.test.ts; verify with typecheck, the
  tests you touched and `bun run ui:preview`; never run prettier on
  src/renderer. [docs/agents/ui-standard.md](docs/agents/ui-standard.md)
- **Launch-time code caches and the bundle split** — boot.js and the compile
  cache, the `tempcode-app://` scheme, lazy chunks (`defineChunk`,
  surfaces/chunks.ts) under the index chunk's budget (`bun run check:bundle`).
  [docs/agents/launch-code-caches.md](docs/agents/launch-code-caches.md)
- **Launch mirror** — the rail paints from session summaries kept in the app
  database (src/main/server/launchMirror.ts) and reconciles with
  `session.changes`. [docs/agents/launch-mirror.md](docs/agents/launch-mirror.md)
- **Provider traffic** — every Claude and Codex child goes through the loopback
  gateway (gateway.ts, gatewayCore.ts, its own utility process); routing by
  headroom, usage-reset recovery across hosts, Meta keys, failure kinds (`failureKind.ts`, `FailureCard`), the
  turn's wait words, warm harnesses, the request shape trace and the codex
  model-metadata wait. [docs/agents/provider-traffic.md](docs/agents/provider-traffic.md)
- **Prompt overhead** — what a fresh thread's first request carries, measured
  per model by `bun run script:measure-first-request`; prompt byte budgets
  (src/shared/promptBudget.ts) and the thrash guard (`context_thrash`).
  [docs/agents/prompt-overhead.md](docs/agents/prompt-overhead.md)
- **Muse Code** — provider `muse`, one `muse serve` per thread over the Muse
  Session Protocol (src/main/server/drivers/muse.ts), config dirs per account
  and skills scope. [docs/agents/muse-code.md](docs/agents/muse-code.md)
- **Remote access** — the fixed-port listener behind the tunnel
  (src/main/server/remote/listener.ts), keys and capabilities, the path fence,
  pairing, `/ui`. [docs/agents/remote-access.md](docs/agents/remote-access.md)
- **The Linux agent host (the box)** — headless mode, `box-update`, deploy
  drift, harness and memory sync, the Mac bridge, dev servers, process guard,
  threads across hosts, the relay, devices, restart resume, backups.
  [docs/agents/linux-agent-host.md](docs/agents/linux-agent-host.md)
- **Search across hosts** — one query fanned out to every host
  (lib/crossHostSearch.ts), an FTS5 index per host (turnIndex.ts).
  [docs/agents/search-across-hosts.md](docs/agents/search-across-hosts.md)
- **One project across hosts** — linked projects by `linkId`, settings homed on
  the box, one rail, host glyphs (remote/projectLinks.ts, lib/linkedRail.ts).
  [docs/agents/one-project-across-hosts.md](docs/agents/one-project-across-hosts.md)
- **Chats outside every workspace** — a thread with no project or workspace is
  the home's, whatever its cwd. [docs/agents/chats-outside-workspaces.md](docs/agents/chats-outside-workspaces.md)
- **Thread notes** — `notes.md` per thread, `update_notes`, the reminders, host
  lines that never start a turn (src/main/server/threadNotes.ts,
  notesPrompts.ts). [docs/agents/thread-notes.md](docs/agents/thread-notes.md)
- **Away from computer** — one state per host, questions answered and approvals
  allowed while away (src/main/server/away.ts).
  [docs/agents/away-from-computer.md](docs/agents/away-from-computer.md)
- **Add-ons** — MCP servers every harness reaches through the `app` server,
  one copy on the box, grants in aliax-core (src/main/server/addons/).
  [docs/agents/add-ons.md](docs/agents/add-ons.md)
- **Skills** — one store, materialized per host and provider
  (src/main/server/skills/); Codex and Muse get a pointer to a skill named in a
  message, never its body (slash.ts). [docs/agents/skills.md](docs/agents/skills.md)
- **Computer use** — the `tc-computer` Swift service, the `computer_*` tools,
  confirmations, the session tier (src/main/server/computer/,
  docs/computer-protocol.md). [docs/agents/computer-use.md](docs/agents/computer-use.md)
- **Background work and watching** — background tasks on the session row, the
  Watching state, the Activity section (src/shared/watch.ts, lib/activity.ts).
  [docs/agents/background-work-and-watching.md](docs/agents/background-work-and-watching.md)
- **Review before merge** — the `merge_branch` tool's optional reviewer and
  gate (src/main/server/mergeReview.ts). [docs/agents/review-before-merge.md](docs/agents/review-before-merge.md)
- **The desktop transcript** — a viewport window (AgentTranscript.tsx,
  lib/transcriptWindow.ts), the streaming reveal, markdown in a worker.
  [docs/agents/desktop-transcript.md](docs/agents/desktop-transcript.md)
- **The interactive lane** — `session.focus`, request lanes and the push
  coalescer (src/main/server/lane.ts, focus.ts).
  [docs/agents/interactive-lane.md](docs/agents/interactive-lane.md)
- **The renderer over time** — React 19.3.1, the renderer soak and its gate
  rows, the rules that keep a push re-rendering only what it changed.
  [docs/agents/renderer-over-time.md](docs/agents/renderer-over-time.md)
- **The shape that scales** — profiling, checkpoints, the running cap and the
  stats worker. [docs/agents/shape-that-scales.md](docs/agents/shape-that-scales.md)
- **The iOS contract** — `ios/TempCodeContract` is generated from zod by
  `bun run gen:swift`; never edit Generated/. [docs/agents/ios-contract.md](docs/agents/ios-contract.md)
- **The iOS client** — ios/TempCodeClient and ios/TempCode, docs/IOS-DESIGN.md,
  the simulator proofs. [docs/agents/ios-client.md](docs/agents/ios-client.md)
- **Read and unread** — the host owns a thread's read mark
  (`sessions.read_at`, `SessionMeta.readAt`; `session.markRead` and
  `session.markUnread`), the desktop and the phone lay it over their own maps.
  [docs/agents/read-and-unread.md](docs/agents/read-and-unread.md)
- **Native chat source research** — what the T3 SwiftUI app and other native
  chat apps do that could carry over to the phone's transcript
  (docs/research/native-chat-rendering.md). [docs/agents/native-chat-source-research.md](docs/agents/native-chat-source-research.md)
- **The menu bar** — src/shared/menuTree.ts is the menu as data.
  [docs/agents/menu-bar.md](docs/agents/menu-bar.md)
- **The fleet switches** — Pause, Resume, Stop and Archive done over a scope
  (`session.batch`, lib/threadBatch.ts). [docs/agents/fleet-switches.md](docs/agents/fleet-switches.md)
- **Plans and the auto-start** — `plan_complete` and the build the host starts
  (src/main/server/planFlow.ts). [docs/agents/plans-auto-start.md](docs/agents/plans-auto-start.md)
- **One build per plan, the project plan** — the `project-plan` thread type
  (docs/PROJECT-PLAN.md). [docs/agents/plans-project-plan.md](docs/agents/plans-project-plan.md)
- **Master threads** — a pinned master's batch of root threads, the queue and
  running cap, the batch's steps engine, the board (docs/master-threads.md,
  src/main/server/batch.ts). [docs/agents/master-threads.md](docs/agents/master-threads.md)
