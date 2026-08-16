# temp-code — live change streaming + the task board that explains itself

Four milestones, continuing PLAN-4's numbering (M15–M21):

- **M22 — The live change stream**: a disk-truth watcher that streams
  every file change the moment it happens — provider-agnostic, immune to
  harness buffering, covering shell-made changes nothing else can see.
- **M23 — Streaming edit cards everywhere**: files show an active editing
  state with the diff open and +/− counting up while the change streams,
  then collapse to a chip when done — in the implementation board, the
  transcript, and the agent detail alike.
- **M24 — Diff quality**: every diff shows real file line numbers and
  real syntax highlighting, for any language, always.
- **M25 — The task board that explains itself**: depth instead of
  flatness, a live activity summary per working task, a full-width
  completion grid of touched files with per-file time, per-task tokens /
  compactions / a horizontal timeline, and a plan-aware kickoff header.

Design rules for this phase, in priority order:

1. **Never report wrong information.** Every number the UI shows must be
   derivable from something true: disk content, git, or a harness event.
   Where attribution is uncertain the UI widens the claim ("working-tree
   change") rather than guessing ("the agent edited this"). Estimates are
   labeled (`~`), never dressed as exact.
2. **Fast.** Debounced watchers, one diff per settled write burst,
   highlighting off the main thread, no polling loops anywhere.
3. **Not bloated.** Hard caps on every cache (baselines, diffs, per-file
   history); everything watcher-derived is ephemeral — the event log
   stays the only durable record.

---

## M22 — The live change stream (`src/main/server/livediff.ts`, new)

### Why a watcher

The harnesses cannot deliver this. Claude's CLI buffers tool-input
deltas in streaming-input mode (each edit card lands near-whole); codex
batches whole multi-file patches into one item; and changes made through
shell commands (scaffolders, `unzip`, generators — the "276 files at
once" case) never exist as patch data in any harness. The disk is the
one place every change appears the moment it is real. `chokidar` is
already a dependency and `files.ts` already runs per-project watchers
with a tuned ignore list (`pathIgnored`) — this milestone adds a
*session-scoped* stream with diffs, not just change kinds.

### Lifecycle

- A live watcher is keyed by **cwd** and exists only while at least one
  session with that cwd is `running` or `starting` (subagent worktrees
  get their own watcher — their cwd differs). Start on the status
  transition into running; stop 5 s after the last running session in
  that cwd settles (the grace period catches trailing writes).
- Reuse `pathIgnored` from `files.ts` (`.git`, `.temp-code`,
  `node_modules`, build dirs…). Never watch outside the session cwd.

### The correctness contract (baselines)

The stream's diffs answer "what changed **during this run**", not "what
is dirty in the tree" — that is what makes attribution honest:

- On watcher start, snapshot `git status --porcelain` once. For each
  **already-dirty file** (usually a handful), copy its current content
  into an in-memory baseline map — capped at 512 KB per file and 8 MB
  total; a file over cap records `baseline: 'head'` instead.
- When a change event for path P arrives:
  - baseline = the turn-start copy if P was dirty, else `git show
    HEAD:P` (cached after first fetch, same caps), else empty (new file).
  - diff = baseline → current disk content (the existing diff machinery;
    `parsePatchDiff` shapes already exist in ToolGroup).
- Files that blow the caps, binary files, and non-git projects degrade
  explicitly: the event still streams (path, kind, byte delta) with
  `diff: null` — the UI shows "changed · 41 KB" instead of a wrong diff.
- Deletes stream as `kind: 'deleted'` with the baseline as the removed
  content (within caps).

### Debounce and burst shape

- Per-file debounce **100 ms** (a streaming write produces one diff per
  quiet gap, so the diff visibly *grows* through a long write).
- A global flood valve: if more than 200 distinct paths change within
  one second (scaffolder bursts), switch the stream to **summary mode**
  for that burst — per-directory counts and total +/− instead of
  per-file diffs, with the top N (25) files still diffed. The UI shows
  the rest as a folder roll-up. This keeps the 276-file case instant
  instead of computing 276 diffs nobody will read mid-flight.

### Transport & store

- New push (contract.ts):
  `{ push: 'live-edit', cwd, sessionIds, edit: { path, kind:
  'changed'|'created'|'deleted', adds, dels, diff|null, first, ts,
  settled } }` — `sessionIds` = the running sessions in that cwd (the
  renderer attributes to the one it is rendering); `settled: true` is
  sent once when the per-file quiet timer (2 s) fires.
- Renderer store slice: `liveEdits[sessionId][path] = { adds, dels,
  diff, state: 'editing'|'settled', startedTs, settledTs }` — bounded to
  the last 500 paths per session, cleared when the session's turn
  settles + 10 s (the event log's harness cards are the durable record).
- Nothing from this stream is ever written to the event log or the DB.

### Exit test (`scripts/e2e-livediff`)

Scripted registry + a fake "agent" (a shell loop writing files in the
project cwd while a session is running): a slow multi-append write
produces ≥3 growing diffs for one path then one `settled`; a pre-dirty
file diffs against its turn-start copy (not HEAD); a 300-file burst
arrives as summary mode within 1 s; a binary file streams with
`diff: null`; watcher stops after settle+grace; caps hold under a 1 MB
file. Typecheck; relaunch.

---

## M23 — Streaming edit cards everywhere

### One merge policy (the "never wrong" rule for cards)

Two sources can describe the same file: harness edit tool-calls and the
M22 disk stream. Precedence, per path:

1. While a harness edit call for P is **in flight** (tool-call seen, no
   result): the card exists because of the harness, but its diff panel
   renders the **live disk diff** for P as it grows (falling back to the
   harness partial input where the disk hasn't changed yet). The +/−
   counters tick with each stream update.
2. When the harness result lands: the card swaps to the harness-final
   diff (authoritative for that call) and the live record for P retires.
   No double counting: a path claimed by a harness card never *also*
   renders a synthetic disk card.
3. Disk changes with **no matching harness call** within 3 s (shell-made
   changes) become synthetic "disk change" cards — same visual as edit
   cards, marked with a small `via shell` caption so the source is never
   misrepresented. In the implementation board they file under the
   in-progress task; in the transcript they fold into the running tool
   group of that moment.
4. Codex: wire `item/fileChange/patchUpdated` + `outputDelta` into the
   existing `partial: true` tool-call path (the driver already streams
   claude partials this way), so codex patches pour in per-file even
   before the disk confirms them.

### The active editing state (user items: streaming + auto-open + item 1)

- A file being edited renders **open**: diff visible, streaming in, a
  working spinner on the card header, +/− counting up live, subtle
  `editing…` shimmer (existing `TextShimmer`).
- **Exactly one card auto-opens: the file currently being edited.** When
  its edit settles (harness result or stream `settled`), the card
  **auto-collapses to the edit chip** (name + final +/−) — and the next
  file being edited opens. Manual clicks always override: a card the
  user opened stays open, a card the user closed stays closed (an
  `auto`/`user` flag per card; auto never fights the user).
- This replaces today's `defaultOpen` on implementation-board
  `FreshEdit` cards (every card open forever) and applies identically in
  the transcript, the implementation board, and the agent detail — one
  shared `EditCardState` hook, not three implementations.

### Exit test (`scripts/e2e-stream-cards`)

Live claude session asked to write a large file: the card opens while
writing (live diff present before the tool result), counters move ≥2
times, card collapses to chip on completion. Codex apply_patch across 3
files: cards appear per-file before item completion (patchUpdated), then
settle. A `bash`-made change yields exactly one `via shell` card, no
duplicate. UI states verified from the store (auto-open flag), not
pixels. Typecheck; relaunch.

---

## M24 — Diff quality: line numbers + real highlighting, always (item 2)

- **Line numbers**: every diff row renders its true new-file line number
  (and old-file number for deletions). Codex rows already carry them
  (`DiffRow`); claude hunks and M22 disk diffs compute them from hunk
  headers — `parsePatchDiff` already tracks `line`; extend it to number
  every row rather than only the first. No diff renders without a
  gutter again.
- **Highlighting**: the shiki worker (`highlight.worker.ts`, both
  palettes, JS regex engine) currently serves fenced code blocks; route
  diff card content through it too. Language from the file extension
  (one shared `langOf(path)` map; shiki's bundled grammars cover the
  long tail — fall back to plain text, never to wrong colors). Highlight
  the **settled** card synchronously-cached; while streaming, highlight
  the visible tail only, debounced 150 ms, so fast streams never queue
  the worker (rule: fast). Cache keyed by (path, content hash) with an
  LRU of 200 entries (rule: not bloated).
- Diff colors stay the diff's (add/del wash); token colors come from
  shiki — the add/del background and syntax foreground compose.

### Exit test

Unit-level: a TS, Java, CSS and no-extension file each produce
highlighted rows with correct line numbers from all three sources
(claude hunk, codex rows, M22 disk diff); the fallback path renders
plain, never mis-colored. Typecheck; relaunch.

---

## M25 — The task board that explains itself

### Less flat (item 3)

Each task becomes a quiet card instead of a bare row: hairline border,
2px status accent on the left edge (violet working · green done · muted
pending), the task title as the card header with its wall-clock at the
right, content indented under it. Spacing does the hierarchy (rules 6/7
of the house style): 12 px between cards, 6 px inside groups. Completed
cards compress; the working card carries slightly more presence (its
accent pulses at the same cadence as the progress segments). No new
colors, no badges — depth from borders, accents and spacing only.

### Live activity summary per working task (item 4)

Under the working task's header, **above** its file changes, one line
computed from that task's blocks (`block.todo` already attributes them):
`Read 14 files · 6 searches · 3 commands · 2 subagent calls` — counts
bucketed from tool names (Read/Glob→read, Grep→search, Bash/shell→
command, spawn/wait/check→subagent, MCP name→its app). It ticks live as
blocks arrive and stays (final numbers, muted) when the task completes.
The buckets come from one shared classifier in `lib/activity.ts` — the
mirrors and `check_agent` one-liners reuse it, so every surface counts
the same way.

### Completion grid + per-task telemetry (item 5)

When a task completes, its folded body becomes a **full-width grid**
(auto-fill, min 200 px columns) of every file that task added, edited,
or deleted: file name, change kind glyph, `+a −d`, and **time on file**
(summed active-edit durations from M22's records — labeled `~` because
disk time is an approximation of attention). Clicking a cell opens that
file's final diff. The grid replaces the current one-line `▸ 3 changes`
fold; the raw card stream stays reachable behind it.

Per-task telemetry, one muted line under the grid (or under the summary
while working):

- **Tokens**: a new lightweight `usage` AgentEvent — codex emits it from
  `thread/tokenUsage/updated` (already parsed), claude from each
  `result` and from `message_delta.usage` snapshots mid-turn (verify the
  SDK surfaces it; if only turn-level, per-task tokens interpolate and
  are labeled `~`). The fold snapshots cumulative usage at task
  transitions; a task's tokens = the delta between its boundary
  snapshots. Boundaries that straddle a turn edge inherit the label `~`.
- **Compactions**: count of compaction blocks with this task's index —
  shown only when > 0.
- **Timeline**: a horizontal strip under the telemetry line, one row per
  task (think commit-graph density, not Gantt): the task's duration as a
  time-proportional bar, segments colored by the activity classifier
  (read/search/command/edit/subagent), compaction ticks as thin violet
  markers, hover reveals segment detail. One shared `TaskTimeline`
  component; the same data the summary line already bucketed, so no new
  bookkeeping.

### Plan-aware kickoff (item 6)

- `StartButton` sends `Implement the plan "<title>" (<relative path>).`
  — title read from the plan's first `#` heading at send time.
- The board header for a `planPath` session stops echoing the raw first
  message: it pins the **plan itself** — plan title, a compact
  `n/m checklist ticks` count (the plan file's `- [x]` state, which the
  thread updates live), and a click-through that opens the plan document
  (the existing plan viewer). The message bubble in the chat pane keeps
  the literal text; the pin is the human face.
- Scratch threads (no plan) keep the first-message headline as today.

### Exit test (`scripts/e2e-task-board`)

Live claude implementation run over a 3-task job: every block lands
under the right task card; the working task shows a moving activity
summary; on completion the grid lists exactly the files that task's
harness cards + settled disk records touched (cross-checked against
`git status`), with +/− matching `git diff --numstat`; usage snapshots
produce per-task token deltas that sum to the turn totals (±1 for the
`~` boundary); the plan-started thread's board pins the plan title and
tick count. Codex run covers the `usage` event path. Typecheck;
relaunch.

---

## Order, size, risks

**M22 → M23 → M24 → M25.** M22 is the heart — a day, mostly the baseline
contract and its tests. M23 is a day (the merge policy is the work; the
card states are small once the stream exists). M24 is a half day (the
worker and numbering machinery exist). M25 is a day and a half (four
independent UI pieces over data that M22/M23 already deliver, plus the
`usage` event).

Risks and their answers:

- **Watcher storms** (build artifacts written mid-run) → the ignore
  list already excludes build dirs; the flood valve caps the rest.
- **Wrong attribution** (user edits a file mid-run in their editor) →
  attribution claims only "changed during this run in this cwd"; the
  `via shell` caption never says *who*. Session-scoped watchers make
  collisions rare; honesty covers the remainder.
- **Baseline memory** → hard caps with explicit `baseline: 'head'`
  degradation; baselines die with the watcher.
- **Highlight jank on fast streams** → tail-only highlighting behind a
  150 ms debounce; the settled pass does the full file once.
- **Per-task token precision** → deltas of cumulative counters are
  exact at turn boundaries; anything interpolated wears `~`. Never a
  bare wrong number.
- **Auto-open fighting the user** → the `auto`/`user` flag; auto-state
  transitions never touch a card the user has clicked.

## Amendments (implementation, 2026-08-16)

- Claude edit-card line numbers already existed (locateHunks reads the
  landed file); M24 added highlighting + numbered live-diff rows.
- Synthetic `via shell` cards render on the implementation board (under
  the live task); the transcript keeps harness-only rows for now.
- Per-task tokens show output-token deltas from exact boundary snapshots
  only (codex mid-turn `usage` events + turn totals); tasks without
  bracketing snapshots show nothing rather than an estimate.
- The activity classifier lives with the board (ImplementationView); the
  shared-lib refactor waits until a second surface needs it.
