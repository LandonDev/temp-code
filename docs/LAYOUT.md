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

### Window title and the dock

The window's title names what it shows (src/renderer/src/lib/windowTitle.ts,
written to `document.title` from App.tsx): a page that covers the window
alone ("Settings", "Search", "Inbox", "Notes", "Accounts", "Stats"), else the
focused thread's title ("New thread" untitled), file's name or "Terminal",
then " — " and the project's name; "TempCode" with nothing open. No app
suffix: macOS names the app already. The dock badge has one meaning: the
threads that need you (an approval or a question) on every host, subagents
included, archived out; never unread, failed or plan-ready. Every window
reports the same count and the dock shows the largest (src/main/dockBadge.ts);
it bounces once when the count rises with no window focused. No dock
progress bar.

## Region by region

### Titlebar

Drag region (`titlebar-drag`), hiddenInset traffic lights. In deck layout
the bar is one row: the thread strip (below) fills it, and its right end
holds exactly two ghost icon buttons, each with a `Tooltip`: the ⋯ thread
menu, then the panel toggle (`aria-pressed` while the right panel is open,
"Panel ⌘⇧R"), last because it is nearest the panel it opens. The rail-closed
stand-ins (Inbox, Notes, Go to File, New session, Settings) and the Windows
controls keep their places.

The ⋯ menu (chrome/ThreadMenu.tsx, a `DropdownMenu` at the `sm` size) has
three groups. First a quiet line, not an item: the host's glyph and name
when the window has two or more hosts, and the thread's cost at the end in
`tabular-nums` when it is above zero; absent when it would say nothing.
Then the active thread's own rows, the same list its chip's right-click
shows (`chipMenuItems`, rendered by the one `MenuRows` for both menus), with
"Move to <host>…" rows before Archive (`useThreadHost` in
chrome/ThreadHostChip.tsx; a disabled one carries its reason as a second
line). Then the project: Pause all with the running count (only when
something runs; a failure is a toast), Dev server checked while the Dev
servers pane is open (only when a host can serve the project), Terminal
with ⌘\`, Recent threads (the settled threads, freshest first, at most
12, each with its age) and Archived threads… (a `Popover` from the ⋯ button
with a search field past six; Restore on hover). The branch is the right
panel's Branch section, not the header's.

### Sidebar

| Piece | Component | Styling |
| --- | --- | --- |
| Frame | `chrome/ProjectRail.tsx`, a flex column on `bg-sidebar` | resizable; the 40px header (traffic lights, back, forward, the toggle), the scrolling list, a hairline, the foot. Deck only: the classic layout is retired (`useSidebarLayout` answers `deck`) |
| Row | `chrome/RailRow.tsx` (`RailRow`) | every row in the rail and the settings list: 36px, a 16px glyph, a 13px label, `text-muted-foreground` at rest and `text-foreground` on hover, focus and selection; selection is `aria-current` with a `bg-muted` fill, hover `bg-foreground/5`, never a bar, border or shadow; at most one trailing mark (`trailingInteractive` puts a control such as a workspace's status word beside the row's button) and one hover action (an icon Button with its Tooltip that takes the trailing slot's place); a Tooltip, never `title=`; rows never animate in or out. The lists sit in an 8px inset |
| Heading | `RailHeading` in `chrome/RailRow.tsx` | 28px, 12px `font-medium` muted, sentence case, on the rows' glyph column; "Pinned" only when pins exist, "Workspaces" ends in Add workspace (one always-visible icon button) |
| List | Chats, then Pinned, then Workspaces | Chats is the first row (the home's loose chats, its trailing mark the waiting or working glyph); Notes and Mark all read are not in the rail (Search finds notes with `type:note`, each thread's notes are the right panel's; Mark all read is in the View menu and every workspace and host menu) |
| Workspace row | `WorkspaceRow` in `chrome/ProjectRail.tsx` on `lib/linkedRail.ts` | the glyph, the alias-resolved name, its one `StatusMark` word as its trailing mark and ⋯ (the right-click's menu: label, colour, mascot, Pin or Unpin, Reveal, Mark all read, the fleet switches, Archive, Delete) as its hover action; drag reorders it, a 2px accent line marks the drop. One "Workspaces" section for every host, no host headers; a workspace linked across hosts (one `linkId`) is one row led by this machine's copy, its threads, word, Mark all read, pin and drag spanning every copy; order, pins, recents, labels, colours and mascots keep their keys, the other copies alias to the leader's (`aliasKeys`). No diff stat, no pin button, no shimmer on the name. The glyph (logo or mascot, never animated or tinted by state), the word (Needs you, Failed, Working, Paused, loudest first; a click opens the workspace's threads in a Popover) and the 24px line under the row naming the thread behind the word (`+N` for the others) are A2's, in `chrome/WorkspaceRowMarks.tsx`; unread is the row's emphasis |
| Offline tint | `chrome/hostOffline.ts` | with two or more hosts, a row whose host's link is not open (a rail row: every host of it) sits at `opacity-50` with `data-host-offline`, as the master board's rows do; its rows are the launch mirror's and lift when the host is back |
| Foot | `RailFoot` in `chrome/ProjectRail.tsx` (`railFootRows`) | under a 1px hairline, in order: the update row when there is something to act on, the Hosts row with two or more hosts, Inbox (medium foreground while something is unseen), Search (Tooltip ⌘K), Accounts, Stats, Settings (Tooltip ⌘,), then the usage meter. The same foot sits under the workspace column while the rail is collapsed |
| Update row | `chrome/UpdateRow.tsx` (`updateRowState`) | one RailRow, absent while idle or checking: "Updated to 1.0.N" (opens What's new, ✕ dismisses), "Update to 1.0.N" or "Retry update" (installs; What's new as the hover action when there are notes), "Downloading" with its percentage, "Restart to update"; the glyph is the accent while there is something to do, no tinted fill. Check for updates is in the app menu and Settings, General |
| Hosts row | `HostsRow` in `chrome/HostRows.tsx` | only with two or more hosts: one row ending in a 6px dot per host (`toneOf`), its aria-label naming each host and its state; a click opens a `DropdownMenu` with a submenu per host (the `HostGlyph`, the name, the state word and the `+N` deploy drift), holding Switch to <host> (not for the host on screen), Add workspace here…, Mark all read, Pause all, Resume all, Stop all and Archive done, then Host settings. A host's boot resume is a sonner toast ("7 threads resumed after restart", the host's name under it with two or more hosts; `useBootResumeToasts`) |
| Usage meter | `chrome/UsageMeter.tsx` on `src/shared/usageMeter.ts` (`meterFor`), the foot's last block | one 36px ghost row per provider with accounts: the provider glyph, an 80px 4px `Progress` of the pooled share (the mean room over every account routing could pick, each account's room its tighter of 5h and week; expired and unreported accounts left out; amber below 10%), then "in 2h" (the next refill) in 12px `text-muted-foreground`, or "Limited 3m" in `text-warning` while every account is throttled; before any report an empty track and no text. No account name. Hover (the tooltip's delays), click or Enter opens a `Popover` to the right: the provider and "62% left", one row per usage window (5h, Week, each per-model cap) with its refill, percent and bar, and one muted foot line, "3 accounts with room". It moves on the `accounts` push alone |
| Settings list | `SettingsNav` in `chrome/SettingsRail.tsx` | while settings are open the rail's list is the pages as RailRows under RailHeadings, then the workspaces (another host's names its host as muted trailing text), and Back as the foot's one row |
| Workspace column | `chrome/Sidebar.tsx` | column two holds only the workspace's projects and threads (`WorkspaceSessions`) under one 40px header: the workspace's name (Chats at the home) in 13px medium, New thread (Tooltip ⌘N) and the workspace ⋯ menu. No tabs: files and changes are the right panel's Files and Changes sections; ⌘P still goes to a file. While the rail is collapsed a 40px row with the traffic lights and the toggle sits above the header and the rail's foot sits under the threads |
| Project row | `ProjectRowView` / `ProjectRow` in `chrome/WorkspaceSessions.tsx` | a 32px fold: the chevron, the name (`font-medium` while a thread in it is unread) and one `StatusMark` word at the end, the loudest of Needs you, Failed, Working and Paused (`groupMark`, lib/sidebarRows.ts), nothing when quiet; ⋯ and a right-click open its menu. Open by default, the person's close remembered (`lib/projectFolds.ts`). Its threads are 32px `ThreadRowView` rows under it, each ending in its glyph alone (`rowState` → `StatusMark`; the word and what it is about on hover), a settled row in nothing, unread by weight; subagents and a master's batch one step in, the master with its batch's done tally. No border, branch line, time, dot or tint |

### Settings → Hosts

One page for this machine and every host it is paired with (settings section
id `remote`, opened with `shell.openSettings("remote")`; a saved
`environments` section reads as it). surfaces/settings/hosts/HostsPage.tsx
draws the page as frame sections (`PageSection`, `PageRow`) from
`hostSections`: each host is one section headed by its name, its link state
as a `StatusMark` from `linkMarkOf`, the `+N` drift mark, Retry or Pair
again when the link needs one and a `⋯` menu (this machine: Copy
environment id; a paired host: Rename…, Routes…, Remove…), how a paired host
is reached under the heading. This machine's section holds Remote access,
Port, Public origin, Stuck after, Attachment limit, Running threads and Load
limit; Clients (one ghost Add… menu: Pair a device…, New key…; Revoke and
Sign out confirm), Release (Publish, Release checkout), Sync (switches, the
conflict copies under Memory), Remembered approvals and Devices follow as
their own sections. A paired host's section holds Deploy with its log,
Running threads and Sync with Sync now; "Mac bridge for <host>" follows
(Access, the running and held calls, the forwarded ports, Settings… for the
caps, forwarding and shared folders). Facts on one line are `Facts` spans,
never dots; numbers are `CommitField`s; switches `SettingSwitch`; options
`ChoiceSelect`. Add host sits at the page's foot (desktop only).

### Settings → a workspace

Each workspace has its own page (section id `ws:<workspace id>`,
surfaces/settings/Workspace.tsx), its sections in this order: New threads,
Completed turn, Accounts (a `ChoiceSelect` per routed provider), Build (the
command and outputs; the Build rail tab's settings link opens this page,
scrolls here and focuses the section, `openBuildSettings` →
`takeRequestedBuildFocus`), the workspace's orchestration override
(Orchestration, Subagent models, Subagent routing; the workspace menu's
rules item lands here the same way, `openOrchestrationSettings` →
`takeRequestedRulesFocus`) and Projects (one row per live project, the
accounts its threads spend from, its pins over the workspace's, as the muted
line, and Settings… opening the project's settings dialog). There is no
separate Build page, and the Orchestration page holds the global rules only.
Orchestration, Reviews, Appshots and Archive are pages on the same frame
(`Page`, `PageSection`, `PageRow`); Orchestration's models are one flat
`Table` with a group row per provider. An empty list is one 12px muted line
in its section.

### The right side

One panel per root thread at its pane's right edge (`surfaces/RightPanel.tsx`
on `lib/rightPanel.ts`; a subagent has none). The six owners it replaced
(the project rail and its tab, the fleet drawer's override, the notes
drawer's map, the orchestrator log's state, the classic diff pane) are gone.

- **Store.** `{ open, section, width }` per thread id, persisted in
  localStorage (`monocode.rightPanel`; the width a new thread inherits is
  the last one dragged to). `rightPanel.open/close/toggle/set/setWidth`
  write it; `rightPanel.show(section)` opens a section on the thread on
  screen (⌃D's Debug); `useRightPanel(id)`
  reads it.
- **Sections.** `sectionsFor(facts)` is pure, one line per section, in the
  header's order: Activity when background tasks, live subagents, a
  watching master's wait or a running dev server exist; Agents when the
  thread has subagents of its own (a master's batch lives on its board,
  never here); Changes when its cwd is a project
  checkout; Notes for every root; Files, Branch, Build and Dev for a
  project thread, and Debug for one on a dev build (or with the debug
  setting on, once one exists). The default is Activity if it exists, else Agents when
  the thread has subagents (live or done), else Changes, else Notes; a remembered section that no
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

chrome/ThreadHeaderStrip.tsx: the selected project's live root threads as
one row of chips, a hand-made `role="tablist"` (DESIGN.md keeps the tab
strip hand-made). The thread on screen always has its chip; settled threads
leave the row and are reached from the ⋯ menu's Recent threads.

- **Order.** Stable, like a browser's tabs: a chip keeps its place, a new
  one joins at the end (oldest first when several arrive together), and a
  status change never moves one (`orderChips` in lib/threadHeaderModel.ts).
  The order is saved per project in localStorage (`monocode.stripOrder`,
  `stripOrderStore` in stores/header.ts, 64 ids per project, a project not
  shown for 30 days dropped on load) under the link id, so the copies of a
  linked project share one order; the title bar orders the model before it
  publishes, so ⌘1–9 and ⌃Tab walk the chips as they sit. While the pointer
  is over the strip a chip whose thread settled holds its place
  (`holdDepartures`), so nothing shifts under the cursor; it goes when the
  pointer leaves.
- **The chip.** A ghost `Button` with `role="tab"`, 28px tall, 12px
  padding, `rounded-md`, 2px apart: the type glyph (14px, 1.5 stroke,
  uncoloured), 8px, the title (13px, truncated at 224px), "Master" in
  muted type when pinned, then the `StatusMark` glyph (none for an idle or
  done thread). Muted at rest, `foreground/5` and foreground on hover (the
  colour swap takes `--dur-fast`), `bg-muted` when active (no transition),
  medium weight when unread, the accent ring on keyboard focus. No motion:
  list rows take none.
- **Input.** A primary press selects; a right press or a Control-click
  never selects, and the contextmenu opens the thread's menu at the pointer
  (`ContextMenu`, rows from `chipMenuItems`). Double-click renames in place
  on an `Input`. Arrows, Home and End move focus along the row (only the
  active chip is in the tab order), Enter or Space selects. The row and its
  gaps are outside the window's drag region.
- **Hover.** One `Tooltip` per chip under a shared `TooltipProvider`: the
  title, and under it the status word with what it is about ("Working
  typecheck", "Needs you  approve Bash", a tally, a failure's verdict).
- **New thread.** The "+" after the last chip (chrome/NewThreadChooser.tsx)
  is a ghost icon button, or "New thread" in words on an empty strip, opening
  a `Popover` of `Item` rows, one per thread type; Orchestrate and Research
  keep an options button whose tune view swaps in place with Back.

File and terminal tabs (chrome/SurfaceTabs.tsx) take the chip's shape on a
line `Tabs`: a 36px bar with its hairline, each tab 28px with the file-type
icon, the name (italic for a review) and a 16px slot whose unsaved dot turns
into the close button on hover (or on a clean active tab), the active tab
underlined. No change counts (the Changes panel has them); drag to reorder
keeps its 2px accent drop marker.

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

### Bottom dock: terminals, or the Dev servers tab

One dock slot sits under the main view; it is bottom only (a dock saved on
another side comes back at the bottom at the default height). It holds one
of two things at a time, both in the same shell (chrome/DockFrame.tsx: the
hairline on its top edge, the sash, double-click for the default size) and
under the same 36px bar (chrome/DockBar.tsx): the project's terminals as
`Tabs variant="line"` (the terminal glyph, the title, the cwd on hover, a
close on the active or hovered tab, middle click closes, drag to reorder),
then a "Dev servers" tab with the live count beside it, then New terminal
(⌘\`) and Hide (⌘J). The Dev servers tab shows only when a host can serve
the project, a server runs or the pane is open. Switching is instant.

- **Terminals** (surfaces/ProjectTerminalDock.tsx): one dock per project,
  the picked terminal below the bar.
- **Dev servers** (surfaces/DevServersPane.tsx): a 288px column, the
  starter (one 36px row: the target `Select`, "web (Vite dev server)", and
  Run; the hosts as a `ToggleGroup` with two or more; Replace, Start another
  and Cancel when the thread on screen already runs one; an error line)
  above the dev servers live on the hosts right now, grouped under their
  threads (a 12px muted heading per thread), and the picked one's console
  filling the rest. A row (chrome/DevServerRow.tsx) is what it is in plain
  words with the host glyph, its address and "Open on the Mac :5174" under
  it, Stop at its end. It lists only what a host still lists; a row the
  host drops leaves at once, nothing animates in or out. With nothing live
  the console's place is one `Empty`: "No dev servers running" over the
  command Run would start. Closed until opened (the thread menu's Dev
  server row, the bar's tab, a Run); open and its height persist, and
  it takes the terminals' height. In this state a terminal tab switches
  to the terminals; Hide closes the pane and the terminals under it.

Asking for a terminal (⌘J, the thread menu's Terminal, New terminal, a
terminal tab) puts the pane away. Dev server consoles are never terminal
tabs.

### File tabs: one header row over the editor

A file opens as a tab in a file pane (surfaces/FilePane.tsx), the editor
in CodeMirror (surfaces/FileEditor.tsx). A changed file opens as a review
tab: the same editor in diff mode, editable, with stage and revert on each
hunk. The tab names the file and shows its dirty mark (chrome/SurfaceTabs.tsx);
nothing under it repeats them.

- **The note**, when the app shows a file instead of handing it to the
  editor ("Mac copy differs: on branch X here", "No Mac copy", a launcher
  that failed), is one `Alert` above everything (surfaces/FileNoteBar.tsx):
  info for a read-only preview, error for a launcher that fell back or an
  action that failed, "Read-only" after the text, the one action at the end.
- **The header** (surfaces/FileHeader.tsx) is one 32px row on every file
  tab: the folder in mono, cut from the left; on a review tab `+n −n`;
  then "Saving…" or "Save failed" while that is so, Preview and Source on a
  Markdown file, and on a review tab the change stepper ("2/5" between
  Previous and Next). There is no footer and nothing floats over the text.
- **The body**: the editor, or for Markdown the preview and the source
  swapped in place. Loading is a `Skeleton` of code lines under the
  header's slot; a file that will not open is one `Empty` with Retry.
- **The diff** tints added and removed lines success and destructive at
  10% beside the gutter mark, never with a left bar (editorGit.ts
  `gitThemeSpec`); the hunk bar is a floating layer.
- **⌘F** is surfaces/FindBar.tsx on Kobra components, rendered into
  CodeMirror's panel at the top right: the field with its count inside, the
  case, word and regex toggles, Previous, Next and Close, and the replace
  row under it while replace shows. It opens from the keyboard, so it has no
  motion.

## Thread views

### Chat

The classic transcript, restyled with BUI primitives on the existing
virtualized list: *Streaming Text* (assistant deltas), *Thinking* (collapsed
one-liner, "Thought for 2s" weight/dim pattern), *Tool Chips*
(call/result pairs), *Code Block* (shiki stays), *Approval Card*, *Loading
State* (shimmer + elapsed while waiting). User messages render as
Cursor-style bordered rounded fields, not colored bubbles. Column
max-w-3xl centered.

While the thread has changes nobody kept, the checkpoint strip sits on the
composer's top edge (chrome/SessionReview.tsx): one 32px row with the file's
name, or "3 files", and its `+n −n`, which opens the diff pane, then Undo
(after a confirm naming what goes back) and Keep. With nothing to keep it is
absent. It is the one control for the host's checkpoint.

### The board views: one frame

Plan, research, project plan, implementation and master share
`SplitShell` (surfaces/threads/SplitShell.tsx): the board on the left at a
dragged split (30 to 70 %, double-click resets to 50), the chat on the
right. The board has one 36px header: a short title, one muted state line in
`tabular-nums` (facts set apart by margin, never a middle dot), the view's
actions, and last the conversation `Toggle` (`ChatToggle`, pressed while
the chat shows). Folding is a toggle, not a tween: the board takes the full
width at once, the chat stays mounted (`inert`, parked at its last width)
and fades back in over `--dur-fast` when shown again. Each view's document
is one column, `max-w-2xl`, at 15px/1.6. A view without a board is the chat
alone, with no header.

### Planning — a document, not a conversation

The main view IS the plan file (`.temp-code/plan-<thread>.md`), rendered
as the document column and streaming as it is written. The chat sits
beside it while the plan takes shape and folds once the plan is written or
handed off; a question forces it open. Header: "Plan" and the task count;
before the handoff one primary **Start build** opens `StartBuildDialog`
(Implement or Orchestrate, model, effort, access, the goal prefilled from
the plan, the orchestration rules only for Orchestrate; Start calls
`plan.implement`, one build). After the handoff the header names the build
("Implementation" and its `StatusMark`) and opens it. On a wide pane with
the chat folded, a heading outline sits at the left edge.

### Implementation — the tasks and the changes

```
┌ plan heading (or the request) ───── [plan] [planned in] [chat] ┐
│ Pass 1  Move the notes            1/1 +40 −12  ›                │
│ Dec 31  Opus 5.5  High  200k  $1.20                             │
│                                                                 │
│ Now make the gate run beside the build                          │
│ ┌ ◔ Tasks                                  2/3 ┐                │
│ │ ✓ Gate in parallel                          │                 │
│ │ ○ Run the publish gate                      │                 │
│ └─────────────────────────────────────────────┘                 │
│ ◉ Needs you  Bash: bun run gate                                 │
│                                                                 │
│ Changes                                                         │
│ Gate in parallel                                                │
│ gate.ts                                       +18 −4  ›         │
│                                                                 │
│ closing report (15px)                                           │
│ [Start pass 3]                                                  │
└─────────────────────────────────────────────────────────────────┘
```

The board is the pass's `TaskList`, then one line per approval or question
waiting on the person (opening the chat) and the last failure (or
Stopped), then the files each task changed (`ChangeRows`: a row per file
under its task's name, shell-made ones marked `shell`, each opening its
diff preview in place with Open diff under it), then the closing report.
Earlier passes fold into rows above (number, request, tally, diffstat and
the run's record), each opening its tasks and changes; a pure Q&A pass has
no row. A finished pass offers **Start pass N**, which arms the next
message as a new pass; folding the chat while a pass is armed puts it back.
Live subagents and the working tree's changes are the right panel's
Agents and Changes; the transcript keeps every tool call. The pure folds
are `implementationBoard.ts`.

### Research — the report and its sources

Header: "Research" with the angles, sources and searches as separate
words, and a button opening the report file. The report's title, its
`StatusMark` and summary while it is written, its body once complete;
then the angles, each opening its agent, live ones saying what they do,
their findings opening the file, and under each query its sources (the
favicon, the title, the host, the claim; the address in a tooltip).

### Orchestration — the chat under a header

```
┌ Ship the iOS thread screens ──────────────┐  ┌ Agents ─────────────────────────────┐
│ 2 working, 1 needs you, 3 done            │  │ ▫ Build the shell   ◌ Editing Home… │
├───────────────────────────────────────────┤  │ ▫ Review the fold   ⊙ Needs you  a… │
│ the orchestrator's transcript             │  │ ▫ Find the row sizes         ✓ Done │
├ composer ─────────────────────────────────┤  └─────────────────────────────────────┘
```

- **The thread is the chat.** Above the transcript, inset to its column,
  sits `FleetHeader` (fleet/FleetHeader.tsx): the goal (the latest user
  line) at 15px, and one 13px muted sentence under it, "2 working, 1 needs
  you, 3 done" (`fleetSentence`), needs you in amber and failed in red.
  Nothing before the first agent. There is no board, no edge tab and no
  "Orchestrator log".
- **The agents are rows in the right panel's Agents section** (`FleetList`,
  fleet/AgentRow.tsx), on every thread that has subagents. A row is one
  36px line: the role glyph, the title (at most half the row), the host
  glyph (two or more hosts), and at the right edge the status: the host's
  phrase while the agent works ("Editing HomeView.swift"), else the
  vocabulary's word and what it is about ("Needs you  approve rm -rf
  build", "Failed  usage cap", "Watching  bun test", "Queued  120 of 120
  running"), Done alone once finished; the full text in a tooltip. Rows
  read the meta (`agentStatus`); a row loads its transcript only to quote a
  waiting agent or a failure the meta lacks. Nothing in a row moves.
- **A row opens the agent's detail** over the pane (fleet/AgentDetail.tsx,
  its content fleet/AgentDetailBody.tsx): the title, the status in full,
  one muted tabular line (host, model, effort, branch, +a −d, tasks,
  context, cost, elapsed), the transcript, and a field that steers a live
  agent and messages a settled one. A spawn row in the transcript opens the
  same detail.

### Master — the project's batch

A thread whose `isMaster` flag is on routes to `MasterView` whatever its
type (CLAUDE.md "Master threads", docs/master-threads.md for the why); a
project may have any number of masters, each with its own batch, and the
tab's or the rail row's menu makes one ("Make master thread" / "Not a
master", `session.setMaster`). The board | sash | chat recipe (SplitShell):
the batch on the left, the master's own chat on the right, folding from
the toggle at the end of the board's own header. Until the first child the chat is the whole view. A child of the
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
  master, that host's dot and name (`rowHost`: the dot's tone from `hostTone`, muted, once per row,
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
  strip with one quiet Start now; only the header strip leaves it out.
  Under the master's rail row a child on a host whose link is not open
  sits under the same offline tint as on the board (`data-host-offline`).
- **In the workspace column** a master is a thread row ending in its
  batch's done tally (`3/7`, green when all are done) and its mark; its
  fold holds its batch first, then its own subagents.
- **In the workspace popover** (a rail row's word) a master with a batch
  is one block:
  ```
  iOS batch 2                       3/7  ○ Watching
  2 agents  1 working
     ▤ Home like the sidebar              ◌ Working
     ▤ Live Activity                      ⊙ Needs you
     2 queued
  ```
  Its own working subagents sit under its title, two spaces between their
  parts; each batch thread that works, waits, failed, paused or stopped is
  a row one step in, loudest first; queued ones are one quiet count and
  settled ones are the tally. A master settled and seen over a finished
  batch prints nothing, like any dormant thread. Nothing inside a master
  is ever unread (`housedIds`): the master reads them, so they carry no
  weight and no unread count anywhere; a waiting one still lights its
  project's and its workspace's Needs you.

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
- One showpiece per view (sidebar pill; tab underline) — the
  rest stays still. Restraint is the Cursor feel.
