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
┌─ titlebar ── traffic lights ─ workspace / project ──── activity pill ─ rail toggles ─┐
├────────────┬───────────────────────────────────────────────────┬─────────────────────┤
│ sidebar    │  thread strip (tabs + new-thread)                 │ right rail          │
│            │  ───────────────────────────────────────────────  │                     │
│ workspaces │  thread view (per type)                           │ Changes / Files     │
│  projects  │                                                   │ (expandable tabs)   │
│            │  prompt bar (floating)                            │                     │
│ ── conn ── │  branch · cwd meta row                            │                     │
└────────────┴───────────────────────────────────────────────────┴─────────────────────┘
```

- Sidebar and rail sit on `bg-sidebar`; main view on `bg-background`; the one
  gray step + hairline `border-border` separates them (no shadows on docked
  chrome).
- The right rail is collapsed by default and only exists where it has
  content (implementation/orchestration threads).

## Region by region

### Titlebar

Drag region (`titlebar-drag`), hiddenInset traffic lights. Left: workspace /
project breadcrumb as quiet text buttons (each opens its switcher popover,
anchored to the text — apple-design §7 spatial anchoring). Right: rail
toggles as ghost icon buttons. Center-right: the **activity pill** — a BeUI
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
| Project row | custom row; BUI *Sidebar Nav* is the composition reference | name 13px; below/right: `git-branch` glyph + branch or `tc/<tag>` worktree tag, 11px muted; relative time right-aligned; status dot when a thread runs (emerald pulse / amber waiting / red error) |
| Selection | shared-layout pill behind active row (BeUI *Shared Layout Background* recipe, `SPRING_LAYOUT`) | `bg-accent`, `rounded-md`; glides between rows |
| Row menu | BeUI *Animated Context Menu* (pointer-origin morph) | rename, change branch, archive, delete (delete → ReUI dialog confirm) |
| Bottom | connection strip (exists) + settings gear | unchanged |

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
└───────────────────────────────────────────┘        right rail: Changes
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

- **Changes**: right rail panel. File rows appear as edits land (spring in,
  `SPRING_PANEL`): filename, `+n −m` in tabular nums (success/destructive
  colors). Click → BUI *Diff Table* view. Rail tab shows a count that ticks
  via BeUI *Number Animation* (rolling digit).

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
- Orchestrator's own narration is a quiet feed below the board, styled like
  the implementation activity feed.

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
│  ☷  Home: Needs you, Running, Workspaces  Implementation          3/7  │
│  ▦  Running ios:test:client           ✺ Claude Fable 5.1  high 1M      │
│       ✓ Read docs/IOS-DESIGN.md and the home model                     │
│       ▦ Workspaces list with the project headers                       │
│       ○ Snapshot tests for the three sections                          │
│  ⌕  Pricing survey  Research                                           │
│  ▦  Reading the third source                  ◉ gpt-6.1-sol  xhigh     │
│       Two of five pricing pages read; Stripe and Paddle left           │
│  ☷  Search screen  Implementation                                 0/3  │
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
  (`master/boardActions.ts`): Pause all (the running-turn rule, confirmed
  with the live count), Resume all, then Archive done… and Archive all…
  (`master/ArchiveBatchDialog.tsx`: "Archive 3 done threads?" / "Archive
  all 7 threads?" with the live count, the resources checkbox the fleet's
  Archive done offers, `batch.archive`; a running thread is stopped first,
  the master stays; the rows leave from the push). A row with nothing to
  act on is disabled. + Thread is a menu: New thread… (the add sheet) and
  Add existing thread… (`master/AdoptThreadDialog.tsx`: the project's
  unarchived root threads on this host in no batch and no master
  themselves, one checkbox row each; Add is `batch.adopt`). No counts
  sentence: the sections carry their counts.
- **Sections**, each a muted 12px label with its count, in this order: Needs
  you (waiting, error), Running (starting, running, watching, paused), Queued
  (waiting for a sibling: there is no running cap), Done (idle, stopped). An
  empty section is not drawn. Rows oldest first within a section; nothing
  animates a reorder.
- **A row** (`master/MasterRow.tsx`, the rules in `master/rowBody.ts`) is two
  lines on a 16px glyph column, and nothing on it is separated by a dot.
  Line one: the type's glyph in its tint (`THREAD_GLYPHS`), the 13px medium
  title, the type word, and at the right the task tally ("3/7") once the
  thread has a list. Line two: the status glyph (the matrix spinner, an
  amber or red dot, a dashed ring while queued, a pause mark, a check once
  done) beside what the thread is doing (its `activity` while queued or
  working, the question or failure in amber or red while it needs you,
  "Landed 12:08" once the batch lists it, "Done" otherwise), and at the
  right the provider's mark, the model's name, then its effort and context
  in a quieter gray (the host's name first when the thread runs elsewhere).
  Under the lines, by type: an implementation its task list from the fold's
  board state (`session.thread.todos`), a check once done, the spinner on
  the one in hand, a hollow ring ahead; a research or orchestration thread
  one summary line, the first line under `## State` in its notes, else its
  latest words, never the line two already says. Chat and plan rows carry
  the two lines only. Done and queued rows are dimmed.
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
  switches' Stop on a queued root, which archives it).
- **Click** opens the thread's full view in the board's place
  (`master/ChildPane.tsx`): the whole pane, board and master chat gone,
  becomes the thread's own view, the one its type gets as a tab (the
  implementation board, the plan document, the fleet), over its transcript
  and a one-line composer that sends while it is idle and steers while it
  runs, with Stop beside Send. The header is one Back control on the same
  40px bar as the board's title; Escape or ⌘↩ anywhere in the view goes
  back, and the board returns at the scroll it was left at. Nothing opens a
  tab; the strip never lists a child (`isBatchChild` in
  lib/threadStripModel.ts).
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
  hidden one inert. Read on mount, every 5 s while the pane shows, and from
  the `batch` push when one arrives.
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
  (segmented over the registry's hosts, this one first; another host offers
  its paired copy of the project and is disabled without one), After
  ("Nothing, start now", else a sibling). Cancel, Add. One column, nothing
  scrolls. Add is `session.create` with `masterId` and `after` plus the
  brief as the first message; the row arrives from the push. Its model
  menu, like every Popover opened inside a Modal, reads the dialog's layer
  (`LayerContext` in lib/layers.ts) and sits above the sheet.
- **Everywhere else** a child is an ordinary root thread in the rail with
  its activity line ("Queued · waiting for <sibling>") and its own working
  strip with one quiet Start now; only the strip and its shelf leave it out.

## ADE ambitions (later — but the frame reserves room now)

Terminals, file browsing, and a real editor come later; the shell must not
paint them into a corner:

- **Main view is a surface host, not a thread host.** The thread strip is
  one kind of tab; editor tabs (files) and terminal tabs join the same strip
  later. Thread views, editors, and terminals are all "surfaces" behind the
  strip — same selection model, same `SPRING_LAYOUT` indicator.
- **Right rail is a panel registry**: Changes and Files now; Terminal later.
  The Expandable Tabs switcher just gains entries.
- **Files panel**: ReUI *tree* over the project cwd; clicking a file opens an
  editor surface (CodeMirror 6 — lighter than Monaco, themes from our
  tokens) in the strip.
- **Terminal**: xterm.js + node-pty in the main process, one PTY per
  terminal surface, spawned in the project's worktree cwd.
- The plan file from planning threads is the first editor customer: "edit
  plan" opens it as an editor surface.

## Full inventory — every component, verdict

### Beautiful UI (19) — agent semantics

| Component | Verdict | Use |
| --- | --- | --- |
| Thinking | **use** | collapsed reasoning traces everywhere; its *Steps* variant is the expanded-todo interior in implementation threads |
| Streaming Text | **use** | assistant deltas in chat; plan document body; muted notes in impl |
| Tool Chips | **use** | tool call/result everywhere; step lines inside todos |
| Approval Card | **use** | permission prompts (restyle existing) |
| Task Rows | **use** | impl todo rows + orchestration capsules |
| Prompt Bar | **use** | the composer, rounded style |
| Code Block | **use** | frame/chrome; shiki keeps painting |
| Diff Table | **use** | Changes panel diff view |
| Loading State | **use** | agent-working shimmer + elapsed |
| Sidebar Nav | reference | composition guide for our sidebar rows |
| Search | reference | palette empty-state pattern |
| Chat | reference | transcript composition guide |
| Selection Actions | later | select transcript text → Explain/Improve |
| Recommendation Card | skip | no suggestion surface |
| Context Cards | skip | no RAG surface |
| Records Table | skip | no CRM grid |
| Filter Table | skip | ditto |
| Insight Cards | skip | no analytics |
| Fine-tune Card | skip | no design inspector |

### BeUI motion (38)

| Component | Verdict | Use |
| --- | --- | --- |
| Button (base/stateful/magnetic) | **in repo** | base press feedback; magnetic never |
| Action Swap | **use** | Send↔Stop in prompt bar |
| Tabs | **use** | thread strip (underline variant) |
| Shared Layout Background | **use** | sidebar selection pill recipe |
| Animated Context Menu | **use** | sidebar/tab right-click + ⋯ menus |
| Morphing Modal | **use** (recipe) | capsule → detail morph |
| Tooltip | **use** | icon buttons; blur+spring spawn |
| Animated Toast Stack | **use** | errors, agent-finished notices |
| Number Animation | **use** | changes count, cost tickers |
| Loader | **use** | dots variant, inline waits |
| Text Animation | **use** (shimmer only) | loading labels |
| Input | use in forms | new project/thread dialogs |
| Combobox | use in forms | model picker in dialogs |
| Checkbox / Radio Group / Switch | use in forms/settings | worktree-vs-branch = radio glide |
| Drawer | fallback | subagent detail on narrow windows |
| Animated Badge | maybe | status dots with pulse (dots only, no text badges) |
| Select | maybe | prompt-bar model picker if BUI's isn't enough |
| Popover (goo) | skip — too liquid for an ADE; ReUI popover instead |
| Center Morph Modal | skip (one morph recipe is enough) |
| Bouncy Accordion | skip (single-open; workspaces are multi-open) |
| Preview Rail | **in repo, repurpose maybe** | right-rail tick nav if rails multiply |
| Theme Toggle | later | settings, View Transition repaint |
| Bottom Sheet / Pull to Refresh / Swipe patterns | skip (desktop app) |
| Tilt Card / Marquee / CTA Buttons / Dock / Wheel Picker / Cylinder Carousel / Shader Background / Scroll Animation / Range Slider / Table | skip — decorative, or wrong tool (virtualized transcript already exists; no sliders/tables needed) |

### BeUI blocks (20)

| Block | Verdict | Use |
| --- | --- | --- |
| Command Palette | **use** | ⌘K: threads, projects, actions; glass surface |
| Expandable Tabs | **use** | right-rail switcher (icon → labeled pill) |
| Dynamic Island | **use, phase 2** | titlebar activity pill |
| File Upload | later | prompt-bar attachments |
| Expandable Action Bar | maybe | hover actions on sidebar rows |
| Morphing Tabs | maybe later | thread strip upgrade if reordering matters |
| Notification Stack | skip (toast stack covers it) |
| OTP / Sign Up / Wallet / Swap / Prediction Market / Fixtures / Availability / Masonry / Bloom Menu / Feedback / 404 | skip — different products |

### ReUI (19 building blocks + base `ui/`)

| Component | Verdict | Use |
| --- | --- | --- |
| base `ui/` set (button, dialog, dropdown, popover, scroll-area, select, separator, skeleton, spinner, textarea, tooltip, input, checkbox) | **in repo** | structural fallbacks; dialog = destructive confirms; popover = anchored pickers |
| badge | **in repo** | only where a state means something |
| tree | **in repo** | Files panel in right rail (later) |
| timeline | reference | activity feed structure |
| alert | use sparingly | inline error rows |
| icon-stack | maybe | stacked provider glyphs on orchestration tab |
| data-grid | later | only if a real records surface appears |
| filters / autocomplete / sortable / scrollspy / stepper / frame | skip for now |
| date-selector / event-calendar / gantt / kanban / number-field / phone-input / rating | skip — wrong product |

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
