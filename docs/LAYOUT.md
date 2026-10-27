# UI component plan — the primitive layout

Companion to `DESIGN.md` (tokens, motion rules). This doc decides **which
component builds each surface, and how**. Nothing here is built yet.

## Domain model

- **Workspace** — a folder/repo the user added. Sidebar top level.
- **Project** — a named line of work inside a workspace, bound to either an
  auto-created worktree or a local branch.
- **Thread** — a session inside a project. Six types: **chat**,
  **planning** (produces a plan document file), **project-plan** (the
  project-wide plan with milestones, docs/PROJECT-PLAN.md), **implementation**
  (todo-first, not chat-shaped), **orchestration** (subagent-first),
  **research**. Threads sit in a strip at the top of the main view. Planning
  threads hand off: ONE implementation or orchestration thread is started
  *from* a plan file, which seeds its task list. A project plan hands off
  one milestone at a time, never the whole plan.
- **Later (design for it now, build later):** the app grows into an ADE
  proper — integrated terminals, a file browser, and a real editor. Nothing
  below may assume the main view only ever shows threads.

## Shell anatomy

```
┌─ titlebar ── traffic lights ─ workspace / project ──── activity pill ─ panel toggle ─┐
├────────────┬───────────────────────────────────────────────────┬─────────────────────┤
│ sidebar    │  thread strip (tabs + new-thread)                 │ right panel         │
│            │  ───────────────────────────────────────────────  │ Activity · Agents · │
│ workspaces │  thread view (per type)                           │ Changes · Notes …   │
│  projects  │                                                   │ (the sections the   │
│            │  prompt bar (floating)                            │  thread's state has)│
│ ── conn ── │  branch · cwd meta row                            │                     │
└────────────┴───────────────────────────────────────────────────┴─────────────────────┘
```

- Sidebar, rail, title bar and the bottom dock sit on `bg-sidebar` (a focused
  dock takes `bg-background`); main view on `bg-background`; the one
  gray step + hairline `border-border` separates them (no shadows on docked
  chrome).
- The right side is one panel per root thread, closed by default; "The
  right side" below.

## Region by region

### Titlebar

Drag region (`titlebar-drag`), hiddenInset traffic lights. Left: workspace /
project breadcrumb as quiet text buttons (each opens its switcher popover,
anchored to the text — apple-design §7 spatial anchoring). Right: the
panel toggle as a ghost icon button. Center-right: the **activity pill** — a BeUI
*Dynamic Island* adaptation showing running-agent count with a status dot;
hover morphs it wider to a per-thread status list. This is the one piece of
ambient chrome; it earns its place because agents run in background threads
(phase 2 if time is tight).

### Sidebar

| Piece | Component | Styling |
| --- | --- | --- |
| Frame | custom flex column on `bg-sidebar` | 232px, resizable later |
| Top actions | New Thread, Search rows | 13px ghost rows, lucide 15px icons, `text-muted-foreground` → `text-foreground` on hover |
| Workspace group | custom collapsible (motion `height: auto` + `SPRING_LAYOUT`, chevron rotates) | header row: folder icon + name, 12px medium, muted; multi-open (not accordion) |
| Project row | custom row; BUI *Sidebar Nav* is the composition reference | name 13px; below/right: `git-branch` glyph + branch or `tc/<tag>` worktree tag, 11px muted; relative time right-aligned; status dot when a thread runs (emerald pulse / amber waiting / red error); a master and its batch print as one nested block ("Master" below), and nothing inside a master is unread |
| Selection | shared-layout pill behind active row (BeUI *Shared Layout Background* recipe, `SPRING_LAYOUT`) | `bg-accent`, `rounded-md`; glides between rows |
| Row menu | BeUI *Animated Context Menu* (pointer-origin morph) | rename, change branch, archive, delete (delete → ReUI dialog confirm) |
| Workspace list | `chrome/ProjectRail.tsx` on `lib/linkedRail.ts` | one "Workspaces" section for every host, no host headers; a workspace linked across hosts (one `linkId`) is one row led by this machine's copy, its threads, status chip, Mark all read, pin and drag spanning every copy; order, pins, recents, labels, colours and mascots keep their keys, the other copies alias to the leader's (`aliasKeys`) |
| Offline tint | `chrome/hostOffline.ts` | with two or more hosts, a row whose host's link is not open (a rail row: every host of it) sits at `opacity-50` with `data-host-offline`, as the master board's rows do; its rows are the launch mirror's and lift when the host is back |
| Host rows | `chrome/HostRows.tsx`, above Settings | only with two or more hosts: one 28px row per host, no borders, the rail rows' 12px type: the host's `HostGlyph` (12px, `text-content/45`, laptop for a Mac, server otherwise) in the rail icons' 14px box so the names share Settings' text column, the name, the connection dot (`toneOf`, its state in the tooltip), then at the right the boot-resume line while fresh and the `+N` deploy drift, which yield to `⋯` on hover; a click opens the host's menu: Add workspace here…, Mark all read, Pause all, Resume all, Stop all, Archive done, Remote access settings |
| Bottom | connection strip (exists) + settings gear | unchanged |
| Usage meter | `chrome/UsageMeter.tsx` on `src/shared/usageMeter.ts` (`meterFor`), below Settings | one 36px ghost row per provider with accounts: the provider glyph, a 4px `Progress` of the room the next pick would land on (the best account's tightest usage window; a throttled, rate-limited or expired account has none), "resets in 2h" in 12px `text-muted-foreground`; no account name; the row opens the read-only `AccountsPopover`, a `Tooltip` names the provider and the percent left. It replaced the bottom footer; a running terminal shows in its tab's title and the title bar's terminal button |

### Settings → Hosts

One page for this machine and every host it is paired with (settings section
id `remote`, opened with `shell.openSettings("remote")`; a saved
`environments` section reads as it). surfaces/settings/hosts/HostsPage.tsx
draws one section per host from `hostSections` (this machine first, then the
paired hosts in the environments' order, then a host only the Mac bridge or
the devices list knows), 24px apart with one `Separator` between them. A
section is a header (the 12px `HostGlyph`, the name in 14px medium, a paired
host's link state in words, the `+N` drift mark, a paired host's `⋯` menu:
Retry now, Pair again…, Rename…, Routes…, Remove…) and that host's groups
16px apart, each a 12px muted heading over `Item` rows (`Group`, `Row` in
Group.tsx). This machine: its id, listener, public origin, stuck clock and
attachment limit; Clients (Pair a device, New key; pairings, keys, browser
sessions); Release (desktop); Running threads and Load limit; Sync;
Remembered approvals; Devices. A paired host: Deploy with its log, Running
threads, Sync with Sync now, and the Mac bridge (Access, the running and held
calls, the forwarded ports, Settings… for the caps, show-running, forwarding
and shared folders). Facts on one line are `Facts` spans, never dots; numbers
are `CommitField`s; logs and conflict copies are `Collapsible`s under their
row. Add host sits at the page's foot (desktop only).

### The right side

One panel per root thread at its pane's right edge (`surfaces/RightPanel.tsx`
on `lib/rightPanel.ts`; a subagent has none). The six owners it replaced
(the project rail and its tab, the fleet drawer's override, the notes
drawer's map, the orchestrator log's state, the classic diff pane) are gone.

- **Store.** `{ open, section, width }` per thread id, persisted in
  localStorage (`monocode.rightPanel`; the width a new thread inherits is
  the last one dragged to). `rightPanel.open/close/toggle/set/setWidth`
  write it; `rightPanel.show(section)` opens a section on the thread on
  screen (⌃D's Debug, the Dev servers pane's Start); `useRightPanel(id)`
  reads it.
- **Sections.** `sectionsFor(facts)` is pure, one line per section, in the
  header's order: Activity when background tasks, live subagents, a
  watching master's wait or a running dev server exist; Agents when the
  thread has subagents or a batch; Changes when its cwd is a project
  checkout; Notes for every root; Files, Branch, Build and Dev for a
  project thread, and Debug for one on a dev build (or with the debug
  setting on, once one exists). The default is Activity if it exists, else Agents when
  the thread has subagents (live or done) or a batch, else Changes, else
  Notes; a remembered section that no
  longer exists falls back to the default.
- **Frame.** A docked column, 320px by default, 260 to 480 by the sash on
  its left edge, on `bg-sidebar` with the `border-border` hairline; a 36px
  header of `Tabs variant="line"` and a close button; the section's body
  below (`FleetList`, `NotesBody`, `ChangesPanel`, `FileTree`,
  `BranchPanel`, `BuildPanel`, `DevServerPanel`, `DebugPanel`, and a
  placeholder Activity listing what the meta says runs until area A6 lands
  the live list). It toggles, never tweens its width; the body fades in
  over `--dur-fast`. Closed is closed: the thread header's button, ⌘⇧R and
  View › Toggle Thread Panel reopen it on its last section. The agent
  detail sheet (`fleet.detailId`) still slides over the pane.

### Project dialogs on a linked project

A project whose `linkId` another host's row shares keeps its settings on
one copy, the box's (`settingsHomeOf`; `lib/projectHome.ts` resolves it
from the catalog and each host's hello). The dialogs act on that copy over
its host's link, so a Mac whose own copy has not pulled the box's last edit
never shows the old values:

- **Project settings** (`chrome/ProjectDialogs.tsx`) and **Preamble**
  (`chrome/PreambleDialog.tsx`) read every field from the home copy and
  save it there; only the branch is this copy's own. The footer says
  "Saved on box" once, muted, left of Cancel. While the home's link is not
  open, Save is off and the footer says "box is offline" instead.
- **Rename** renames the home copy; the others follow.
- **Archive** (and restore) takes every copy, the home first; a home that
  is offline opens the archive dialog with Archive off and the reason. The
  worktree and branch clean-up apply to the copy it was opened on.
- **Delete** deletes this copy and asks "Also delete the copy on box", off
  by default, one switch per other copy, off while that host is offline.

An unlinked project's dialogs act on the project itself, with no footer
note.

### Thread strip

BeUI *Tabs*, underline variant, `SPRING_LAYOUT` indicator. Each tab: type
glyph (chat `message-square`, planning `map`, project plan `milestone`,
implementation `list-checks`, orchestration `git-fork`, 14px) + title + status dot when running. Orchestration tabs may
stack provider glyphs via ReUI *icon-stack*. `+` button opens a popover
(ReUI) anchored to it: thread type picker (three rows with descriptions) +
provider/model — replaces the current NewSessionDialog for threads. Overflow
scrolls horizontally with faded edges (scroll edge effect, no hard border).

### Prompt bar (all thread types)

BUI *Prompt Bar*, rounded style: floating, `rounded-xl`, `bg-popover`, soft
shadow (it's a floating layer), max-w-2xl centered. Model picker inline;
`/` commands later. Send↔Stop swaps via BeUI *Action Swap* (blur swap
motion, replaces the StatefulButton hack). Under it a meta row: branch ·
cwd, 11px muted (Cursor's `main · This Mac`). On implementation and
orchestration threads the bar idles smaller (single line) and grows on
focus — steering, not chatting.

An unsent draft of a project linked across hosts carries the host chip
beside the project picker (chrome/DraftHostPicker.tsx): the host's glyph,
its name and a chevron, 12px muted like the branch picker. Its menu lists
every connected host; picking one moves the draft there. A host with no
copy of the project reads "New copy" and gets one on pick
(`project.ensureLinked`); a host with no checkout is disabled and says why.
The chip leaves once the first message goes out. The default host is the
one of the thread on screen when it is in the project, else the one last
used for it, else this machine (lib/projectHostChoice.ts).

### Bottom dock: terminals, or the Dev servers pane

One dock slot sits beside the main view (bottom by default; the terminal
dock can move to any side). It holds one of two things at a time, both in
the same shell (chrome/DockFrame.tsx: the hairline facing the content, the
sash, double-click for the default size):

- **The terminal dock** (surfaces/ProjectTerminalDock.tsx): one per project,
  a strip of shell tabs, then New Terminal, Dev Servers, Move and Hide.
- **The Dev servers pane** (surfaces/DevServersPane.tsx), always at the
  bottom: a "Dev servers" header (Start a Dev Server, Terminal, Hide), a
  288px list of the dev servers live on the hosts right now, and the picked
  one's console filling the rest in the terminal's mono type. A row is its
  title, the host glyph with two hosts, and on hover or when picked "Open on
  the Mac :5174" and Stop. It lists only what a host still lists; a row the
  host drops leaves at once, nothing animates in or out. With nothing live
  it is one muted line, "No dev servers running". Closed until opened (the
  thread header's Dev server button, the terminal dock's Dev Servers
  button, Run in the panel's Dev section); open and its height persist.

While the pane is open the terminal dock is hidden, its own open flag
untouched; asking for a terminal (⌘J, the titlebar's Terminal, New
Terminal, the pane's Terminal button) puts the pane away. Dev server
consoles are never terminal tabs.

## Thread views

### Chat

The classic transcript, restyled with BUI primitives on the existing
virtualized list: *Streaming Text* (assistant deltas), *Thinking* (collapsed
one-liner, "Thought for 2s" weight/dim pattern), *Tool Chips*
(call/result pairs), *Code Block* (shiki stays), *Approval Card*, *Loading
State* (shimmer + elapsed while waiting). User messages render as
Cursor-style bordered rounded fields, not colored bubbles. Column
max-w-3xl centered.

### Planning — a document, not a conversation

The main view IS the plan file. The agent writes a real markdown plan
(`.temp-code/plans/<thread>.md` in the project) and the view renders it
document-first: typographic markdown (prose styles from `DESIGN.md`), full
width up to max-w-3xl, streaming in as it's written (BUI *Streaming Text*
mechanics on the document body). The agent's questions/back-and-forth appear
as a slim collapsible side-channel below the document — the plan stays the
hero. Header row: plan title + status (drafting / ready) + one primary
action: **Start →** opens an anchored popover choosing Implementation or
Orchestration; the new thread is created seeded from the plan file, and its
todo list is parsed from the plan's task section. Since the plan is a file
on disk, it survives threads and is editable later (see ADE ambitions).

### Implementation — the todos ARE the view

```
┌ goal line (from plan file when seeded) ───┐
│ ✓ 1. Wire schema            12s           │
│ ◉ 2. Build driver           ▾ running     │
│ │   ▸ Read src/drivers/…       0.4s       │
│ │   ▸ Edit codex.ts            1.2s       │
│ │   $ bun test drivers         running…   │
│ │   "The handshake needs…" (quiet note)   │
│ ○ 3. Verify e2e                           │
│ ○ 4. Commit                               │
├───────────────────────────────────────────┤
│ prompt bar (compact)                      │
└───────────────────────────────────────────┘        right panel: Changes
```

The whole view is the todo list — no separate feed. BUI *Task Rows* (list
view) gives the rows; each row is an **expandable trace** using BUI
*Thinking*'s Steps variant as the interior pattern: while a todo runs it
auto-expands and its tool calls stream inside it as step lines (icon + verb +
target + duration — Tool Chips, one-line form), with assistant prose as
quiet muted notes between steps. Completed todos collapse to
`✓ title · duration` (spring height, `SPRING_LAYOUT`); click any row to
re-expand its trace. Exactly one row is open by accident of work, and the
running row is the bright thing on screen — hierarchy by dimming everything
settled. Events map to todos by the harness's todo state: whatever todo is
`in_progress` when an event arrives owns it (pre-first-todo events go to an
implicit "setup" row).

- **Changes**: the right panel's section. File rows appear as edits land:
  filename, `+n −m` in tabular nums (success/destructive colors). Click
  opens the diff.

### Orchestration — the subagent board (the showpiece)

```
┌ goal line + orchestrator status ──────────┐
│ ┌ subagent capsule ┐ ┌ capsule ┐ ┌ ─ ─ ┐  │
│ │ ◉ codex · gpt-5.5│ │ claude  │ │ ...  │  │
│ │ task summary     │ │         │ │      │  │
│ │ ▸ last tool line │ │         │ │      │  │
│ │ 2m14s · $0.16    │ │         │ │      │  │
│ └──────────────────┘ └─────────┘ └ ─ ─ ┘  │
├ orchestrator narration (quiet feed) ──────┤
└───────────────────────────────────────────┘
```

- **Capsules**: BUI *Task Rows* (capsules view) as the base. Each: provider
  glyph, agent type + model/effort, one-line task summary, live last-activity
  line (latest tool call, updates in place with a subtle crossfade), status
  (running pulse / waiting amber — approval needed / done / error), elapsed +
  cost in tabular nums. Grid `repeat(auto-fill, minmax(240px,1fr))`.
- **Drill-in**: click a capsule → it **morphs into the detail surface**
  (shared `layoutId`, BeUI *Morphing Modal* recipe, `SPRING_PANEL`): the
  capsule expands in place into a panel showing that subagent's own activity
  feed (same Tool Chips/Thinking primitives, read-only) + a small
  send-to-agent input. Dismiss reverses the same path (apple-design §7:
  exit the way it entered; §3: interruptible mid-morph).
- **Waiting states surface up**: a subagent's approval-request renders the
  BUI *Approval Card* inline in the capsule detail *and* flips the capsule
  amber.
- The orchestrator's own stream is the chat column the board views share
  (`SplitShell`), folded to its edge tab by default ("Show orchestrator
  log") so the fleet keeps the room.

### Master — the project's batch

A thread whose `isMaster` flag is on routes to `MasterView` whatever its
type (CLAUDE.md "Master threads", docs/master-threads.md for the why); a
project may have any number of masters, each with its own batch, and the
tab's or the rail row's menu makes one ("Make master thread" / "Not a
master", `session.setMaster`). The board | sash | chat recipe (SplitShell):
the batch on the left, the master's own chat on the right, folding to the
edge tab. Until the first child the chat is the whole view. A child of the
batch is never a tab: it lives on the board, and a click puts its full view
in the whole pane, with Back.

```
┌ iOS batch 2                                            ⋯  [+ Thread ▾] ┐
│ Needs you  1                                                           │
│  ☷  Live Activity strip  Implementation                                │
│  ●  has a question — Ad Hoc or Debug?        (hover: ✉ ⏸ ■ ✕ at right) │
│ Running  3                                                             │
│  ☷  Home: Needs you, Running, Workspaces  Implementation  3/7 ▬▬▬░░░░ ›│
│  ▦  Running ios:test:client           ✺ Claude Fable 5.1  high 1M      │
│       ✓ Read docs/IOS-DESIGN.md and the home model                     │
│       ▦ Workspaces list with the project headers                       │
│       ○ Snapshot tests for the three sections                          │
│  ⌕  Pricing survey  Research                                           │
│  ▦  Reading the third source                  ◉ gpt-6.1-sol  xhigh     │
│       Two of five pricing pages read; Stripe and Paddle left           │
│  ☷  Search screen  Implementation  0/3 ░░░░░░░ ›                       │
│  ▦  Writing SearchScreen.swift        ✺ Claude Fable 5.1  medium 1M    │
│       ▦ Results list on the search model                               │
│ Queued  1                                                              │
│  ☷  Inbox swipe actions  Implementation                                │
│  ◌  Queued · waiting for Home             ✺ Claude Fable 5.1  high 1M  │
│ Done  1                                                                │
│  ☷  Design foundations  Implementation                                 │
│  ✓  Landed 12:08                          ✺ Claude Fable 5.1  high 1M  │
├ When the threads are done                                        Edit ─┤
│ Land all seven, gate once, release, then tell me                       │
│ Branches land as they finish, then one gate on the merged tree, a      │
│ release and a deploy to the box. Then you are notified.                │
│ ✓ Merging 2m   ▦ Gate 1m 12s  3 of 7 vitest                     Stop  │
│ ▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬░░░░░░░░░░░░░░                                        │
│ │ ✓ typecheck 12s                                                      │
│ │ vitest  src/main/server/batch.test.ts (14 tests) 120ms              │
│ ○ Release   ○ Deploy to dev  ./deploy.sh dev   ○ Smoke test            │
└────────────────────────────────────────────────────────────────────────┘
```

- **Title bar**: the batch name (the master's title), a quiet ⋯ and
  + Thread ▾. The ⋯ menu is the batch's fleet switches
  (`master/boardActions.ts`), counting the rows of every host: Pause all
  (the running-turn rule, confirmed with the live count) and Resume all go
  to each row's own host through its `session.batch`; Archive done… and
  Archive all… (`master/ArchiveBatchDialog.tsx`: "Archive 3 done threads?"
  / "Archive all 7 threads?" with the live count, the resources checkbox
  the fleet's Archive done offers) run `batch.archive` on the master's host
  (a running thread is stopped first, the master stays) and then, for the
  rows of another host its answer did not cover, that host's own
  `session.batch` (`remoteArchivePlan`: under all the live ones stopped
  first); the rows leave from the push. A row with nothing to act on is
  disabled. + Thread is a menu: New thread… (the add sheet) and Add
  existing thread… (`master/AdoptThreadDialog.tsx`: the project's
  unarchived root threads in no batch and no master themselves, on this
  host and on the project's paired copies elsewhere (`pairedProjectIds`,
  lib/projectPairs.ts), one checkbox row each with the host's name at the
  right when they span hosts; Add is one `batch.adopt` on the master's
  host, a thread of another host named `<envId>:<id>`, the host's
  refusals read back by title in the sheet). No counts sentence: the
  sections carry their counts.
- **Sections**, each a muted 12px label with its count, in this order: Needs
  you (waiting, error), Running (starting, running, watching, paused), Queued
  (waiting for a sibling: there is no running cap), Done (idle, stopped). An
  empty section is not drawn. Rows oldest first within a section; nothing
  animates a reorder. The rows are the batch's children on every host the
  renderer knows (`masterChildrenOf` over the whole session store, which
  holds each connected or mirrored host's rows): a child the master started
  on the box sits beside one at home. When `batch.get` lists `children`
  with their hosts (the server's cross-host batch), the list is the
  authority on a row's host and status and the session rows keep the
  bodies (`mergeBatchChildren`; a child the store has no row for becomes
  a plain row with the list's title and type).
- **A row** (`master/MasterRow.tsx`, the rules in `master/rowBody.ts`) is two
  lines on a 16px glyph column, and nothing on it is separated by a dot.
  Line one: the type's glyph in its tint (`THREAD_GLYPHS`), the
  13px medium title, the type word, then the task tally once the thread has
  a list: "3/7" and a 2px bar filled to done of total (the foot's meter at
  row scale, `taskProgress` in rowBody.ts), inline after the type word,
  never pinned to the right. The title bar carries no batch total:
  the rows say it. Line two: the status glyph (the matrix spinner, an
  amber or red dot, a dashed ring while queued, a pause mark, a check once
  done) beside what the thread is doing (its `activity` while queued or
  working, the question or failure in amber or red while it needs you,
  "Landed 12:08" once the batch lists it, "Done" otherwise), and at the
  right the provider's mark, the model's name, then its effort and context
  in a quieter gray; first, when the thread runs on another host than the
  master, that host's dot and name as the thread header's host chip draws
  them (`rowHost`: the dot's tone from `hostTone`, muted, once per row,
  nothing on a row at home). A row of a host whose link is not open sits
  under the offline tint (`opacity-50`, `data-host-offline`): its row is
  the launch mirror's and lifts when the host is back.
  Under the lines, the thread's live subagents, one 20px line each in the
  text column: the status glyph (`StatusGlyph`), the role's glyph
  (`AGENT_GLYPHS`, muted), the title, what it is doing in the board row's
  words and tones (`whatLine` over `digestLine` from the meta: the
  activity, "waiting for approval — Bash" in amber, the failure in red,
  "Paused") and the host's glyph. Its whole tree by the parentId chain
  (archived ones left out, a far child's from that host's rows in the
  store), the person's first (waiting, failed, working, then paused or
  queued, oldest first within each), at most three (`AGENT_LINES`), then
  one quiet line, "and 2 more · 3 done", amber when one past the cap
  waits; a thread whose agents all settled shows nothing. A line opens
  the agent in the board's place as a row opens its thread, and its click
  never reaches the row (`master/agentSummary.ts`). The board builds one
  parent index of the store per meta change and one entry per row
  (`AgentSummaries`, `useAgentSummaries`); a row reads its own
  (`useRowAgents`) and re-renders only when its lines changed.
  Under them, by type: an implementation its task list from its digest
  (the host's task fold, `batch.board`), a check once done, the spinner on
  the one in hand, a hollow ring ahead. The list is open while the thread
  works or needs you and folded once it sits in Done (`tasksOpenByDefault`);
  the tally is its disclosure, a chevron at its end turning when open, its
  click never reaching the row, and the person's own open or close holds
  while the row is on screen. The fold is the foot's height tween
  (`TweenHeight`, a snap under reduced motion); a research or orchestration thread
  one summary line, the first line under `## State` in its notes, else its
  last words (both from the digest), never the line two already says. Chat
  and plan rows carry the two lines only. Done and queued rows are dimmed.
- **The list paints from one answer.** `batch.board` on the master's host
  answers its children there, a digest per child (`BoardDigest`: todos,
  last words, State line, the question it waits on, the failure) and the
  batch's state; the `board` push (one child's digest, at most every 250 ms)
  and the `batch` push reach only sockets watching that master: one whose
  `session.focus` is the master, or one that asked in the last minute (the
  board asks again every 45 s while it shows). Threads of the batch on
  other hosts read their digests from those hosts the same way. No row loads a transcript,
  polls a context or reads notes. The list is virtualized (`useVirtualizer`,
  the sections as their own header rows); a row is memoized on its ref,
  host and landed mark and reads its own meta and digest, so one child's
  activity renders that row alone. The first complete paint is reported
  once per open as `board-paint master=<id> n=<rows> ms=<n>`.
- **A plan and its build are one row** (`foldRows` in `useMasterModel.ts`):
  a build whose `planThreadId` names a thread of the batch takes that plan's
  row, keyed by the plan's id and titled with the plan's title, so the row
  stays in place when the build starts and the type word turns from Plan to
  Implementation; the plan, archived after the start or not, is never a
  second row.
- **Hover** trades the tally and the model mark for the action cluster
  (1.5px strokes, tooltips): Message (opens the thread's full view with the
  composer focused), Pause or Resume, Stop, Remove (archive with the
  resources offer, ArchiveThreadDialog). A queued row offers Start now
  (`session.start`, past `after`) and "Remove from queue" (the fleet
  switches' Stop on a queued root, which archives it). Every action goes
  to the row's own host: the commands route by the thread's id through
  the store's link for it.
- **Click** opens the thread's full view in the board's place
  (`master/ChildPane.tsx`, given the row's `environmentId`): the whole
  pane, board and master chat gone, becomes the thread's own view, the one
  its type gets as a tab (the implementation board, the plan document, the
  fleet), over its transcript, working strip and the composer a tab has
  (`surfaces/threadChat.tsx`, shared with SessionPane: model and reasoning,
  Fast and 1M, permission, the account chip, attachments and paste, `@`
  references, `/` skills, the queue, steer while it runs, the draft kept
  per thread, the approval and question cards in its transcript); App's
  handlers reach it through `SessionActionsContext`. A child on another
  host opens against that host the way a rail row of that host does (the
  store holds every host's rows by id, `data-child-host` names it). The
  header is one Back control on the same 40px bar as the board's title;
  Escape, or ⌘↩ outside the composer (inside it ⌘↩ is the composer's
  own), goes back, and the board returns at the scroll it was left at.
  Nothing opens a tab; the strip never lists a child (`isBatchChild` in
  lib/threadStripModel.ts).
- **Right-click** on a row, or on a subagent line under it, opens that
  thread's menu (`master/rowMenu.ts`): New pass… first, Open, then the
  tab's own thread actions (`chipMenuItems`: Rename, Continue or Pause,
  Compact, Stop, the master pin, Archive) with the thread chip's host
  moves before Archive; the tab's type options, Mac bridge, resources and
  delete stay on the tab. New pass… is a dialog (`master/NewPassDialog.tsx`,
  the Modal at `lg`): the thread's title, one quiet line with its status
  glyph and the board row's own words for what it does now, else its last
  words (`passLine`), and the same composer for that thread on its host.
  Send does what the composer would there (a turn when idle, steer or queue
  while it runs) and closes the dialog; the row follows from the store.
  Escape or a click outside closes it and the draft stays with the thread.
  A popover or the composer's `@`/`/` list open inside a Modal takes
  Escape first: each stops the key before the dialog hears it.
- **The foot** (`master/BatchFoot.tsx`, the step rules in `master/steps.ts`)
  stays put under the scrolling list: "When the threads are done", the
  master's summary line when it wrote one, the rules as one sentence
  (`rulesSentence`: how branches land, then the steps by the names the
  master gave them, then notify or archive) with Edit beside it, and the
  blocked line in red when a child blocks the batch's end. Then the steps:
  the master's list (`rules.steps`, a `BatchStepSpec` each: id, name, kind,
  a shell step's command and cwd) joined by id with the host's telemetry
  (`state.steps`; `liveSteps` in `master/steps.ts`), in the state's order,
  a step the rules name that the host has not seen yet pending at the end;
  the renderer writes no step name of its own. Two sizes. Idle: one quiet
  row, each step its glyph, name and, once finished, how long it took
  ("Gate 4m 12s"; "skipped" after one the engine passed over). The moment
  a step runs the foot grows to its console, the same for a shell step
  (its command in mono after the name) as for a publish: the steps before
  it in a line above with their state and time; the running step's name
  with its elapsed ticking every second from `startedAt`, its progress as
  "3 of 7" with the host's label and a 2px bar when the total is known,
  Stop at the right (`batch.stopStep` with the step's id); its console lines in the
  app's monospace, newest at the bottom, following until the person scrolls
  up (back at the bottom, it follows again); the steps still ahead in a
  muted row below. A failed step stays open with its last lines and the
  failure in red until Hide folds it. Every step done, the foot shrinks
  back to the row. The grow and shrink are the app's height tween
  (`TweenHeight`: 200 ms, the ease-out curve, a snap under reduced motion),
  the idle row and the console both mounted so either can tween shut, the
  hidden one inert. Read from the `batch.board` answer and the `batch` push
  (each step's log as the lines since the last push, `foldBatchPush`; a
  push past what is held asks `batch.get` for the whole state).
- **Edit** opens the rules (`master/RulesDialog.tsx`, Modal md; the pure
  moves in `master/rulesEdit.ts`): Branches land (As they finish / All at
  once, shown while a merge step is in the list), then the steps in order,
  one row each: its number, its name in a field, its kind or a shell step's
  command muted, and Up, Down, Remove. Under them "Add a step…": a built-in
  kind (Merge the branches, Gate the merged tree, Release, Publish the Mac
  release, Deploy to the box) lands at once with its name; Shell command
  opens a draft with a name, the command (exit 0 passes) and a directory
  (default the project), and its own Add. Then (Notify me / Archive the
  threads), Summary, the sentence read back under the fields. Save stays
  off while a step has no name or a shell step no command; it is
  `batch.setRules` with the whole list, the foot takes the change from the
  push.
- **New thread…** opens the add sheet (Modal md, `master/AddThreadDialog.tsx`):
  "Add a thread to <batch>", the brief first (focused; ⌘↩ adds), then one
  row per choice, label left and control right: Type (segmented), Model
  (the app's picker, every catalog model), Effort (segmented from the
  model's own ladder, whole), Context (200k / 1M, Claude only), Host
  (segmented over the master's own host and every saved host whose link is
  open, `linkedHosts`, the master's first, the row hidden with one host;
  another host offers its paired copy of the project and is disabled
  without one), After ("Nothing, start now", else a sibling). Cancel, Add.
  One column, nothing scrolls. Add is `session.create` on the chosen
  host's link with `masterId`, `startedBy` (the master, so the thread's
  settles report to it) and `after` plus the brief as the first message;
  the row arrives from the push. Its model
  menu, like every Popover, sits on the popover layer (95, above the
  dialog's 90; lib/layers.ts mirrors the `--layer-*` tokens).
- **Everywhere else** a child is an ordinary root thread in the rail with
  its activity line ("Queued · waiting for <sibling>") and its own working
  strip with one quiet Start now; only the strip and its shelf leave it out.
  Under the master's rail row a child on a host whose link is not open
  sits under the same offline tint as on the board (`data-host-offline`).
- **On the project card** (and the workspace popover) a master with a batch
  is one block between the hairlines, three steps deep, each step's mark
  in a 12px box under the step above's glyph:
  ```
  ◌ ▤ iOS batch 2                     3/7
        2 agents · 1 working
     ⠿ ⌗ Home like the sidebar        4m
           1 agent · 1 needs approval
     ● ⌗ Live Activity          Needs you
     • 2 queued
  ```
  The master's line ends with the batch's done tally (green when all are
  done); its own working subagents sit under its title, apart from the
  batch. Each batch thread that works, waits, failed, paused or stopped
  is a line, loudest first (Needs you and Failed in words, a running one's
  task tally or elapsed), its working subagents under its title; queued
  ones are one quiet count and settled ones are the tally. A master
  settled and seen over a finished batch prints nothing, like any dormant
  thread. Nothing inside a master is ever unread (`housedIds`): the
  master reads them, so they carry no dot or bold and no unread count
  anywhere; a waiting one still lights the card's "need you" and the
  workspace chip. In a thread list (Chats, archived) a master's fold
  holds its batch first, then its own subagents.

## ADE ambitions (later — but the frame reserves room now)

Terminals, file browsing, and a real editor come later; the shell must not
paint them into a corner:

- **Main view is a surface host, not a thread host.** The thread strip is
  one kind of tab; editor tabs (files) and terminal tabs join the same strip
  later. Thread views, editors, and terminals are all "surfaces" behind the
  strip — same selection model, same `SPRING_LAYOUT` indicator.
- **The right panel is a section registry** (`lib/rightPanel.ts`): a new
  kind of content is one more `Section` and one line in `sectionsFor`.
- **Files section**: the project tree; clicking a file opens an editor
  surface in the strip.
- **Terminal**: xterm.js + node-pty in the main process, one PTY per
  terminal surface, spawned in the project's worktree cwd.
- The plan file from planning threads is the first editor customer: "edit
  plan" opens it as an editor surface.

## Apple-design mapping (why the layout is shaped this way)

- **Capsule→detail morph, popovers from triggers, tabs' gliding indicator**:
  spatial consistency + anchored origins (§7); all interruptible springs (§3).
- **Task hero focus, dimmed activity feed**: hierarchy by contrast, not
  boxes — simplicity ≠ minimalism (§16.6).
- **Status dots + elapsed + count tickers, no narration**: feedback kinds
  (status/completion/warning/error) shown, not explained.
- **Palette/activity-pill glass**: materials — blur + scale materialize
  together; honor reduced-transparency (§12, §14).
- **Sidebar rows respond on pointer-down; pill glides with velocity**: §1, §5.
- **Everything 13px/12px/11px with weight+dim hierarchy**: typography (§15).
- One showpiece per view (sidebar pill; tab underline; capsule morph) — the
  rest stays still. Restraint is the Cursor feel.
