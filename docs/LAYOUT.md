# UI component plan — the primitive layout

Companion to `DESIGN.md` (tokens, motion rules). This doc decides **which
component builds each surface, and how**. Nothing here is built yet.

## Domain model

- **Workspace** — a folder/repo the user added. Sidebar top level.
- **Project** — a named line of work inside a workspace, bound to either an
  auto-created worktree or a local branch.
- **Thread** — a session inside a project. Four types: **chat**,
  **planning** (produces a plan document file), **implementation**
  (todo-first, not chat-shaped), **orchestration** (subagent-first). Threads
  sit in a strip at the top of the main view. Planning threads hand off: an
  implementation or orchestration thread can be started *from* a plan file,
  which seeds its task list.
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
glyph (chat `message-square`, planning `map`, implementation `list-checks`,
orchestration `git-fork`, 14px) + title + status dot when running. Orchestration tabs may
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
