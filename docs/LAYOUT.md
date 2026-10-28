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

### First run

A new install opens the ordinary window, with no welcome screen or wizard:
a blank chat at the home, set to Claude, with the empty thread and its
composer. It starts empty wherever the app was launched from: no folder is
adopted as a workspace, in a dev, preview or packaged build alike. The rail
has its usual shape (the navigation group on top, then Accounts, then the
Workspaces list; Check for updates and Settings in the foot) and adds two
rows that each leave once their step is done.
While this machine has no Claude or Codex account, the foot's first row is
"Sign in to Claude" (ChatGPT when the default harness is Codex), its glyph
in the accent, the one call to action in the window; it opens the sign-in
window, reads "Signing in…" while that runs, and gives way to the usage
meter once the account arrives. A failure is one toast and a cancel says
nothing; a person who sends first gets a failure card that says "Not
signed in to Claude". While the Workspaces list is empty its heading has no
+ and one "Add workspace…" row stands under it, opening the folder picker
titled Add workspace (⌘O's Open Project keeps "Open project");
the first workspace takes the row's place and gives the heading its +
back. Column two at an empty home keeps its header and shows nothing under
it, so the first send fills it without moving the transcript. Removing the
last workspace returns the rail to that shape (chrome/SignInRow.tsx,
`ProjectSection` in chrome/ProjectRail.tsx, `sidebarItems` in
lib/sidebarRows.ts; fixtures `FirstRunRail` and `SignedInRail` in
chrome/Rail.fixtures.tsx).

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
"Panel ⌘⇧R"; disabled with "No room for the panel" while the thread's row
is too narrow for it), last because it is nearest the panel it opens. The
chips, New thread, the ⋯ menu and the toggle share one 40px row box
(the strip stretches to it, the end group centres in it), so all of them
sit on one 28px line at y 6. The rail-closed
stand-ins (Inbox, Notes, Go to File, New Thread, Settings) and the Windows
controls keep their places, each named on hover with its key by a `Tip`.
In the classic strip one right-click menu serves the tabs and the group
chips: a tab's thread rows then its group rows, a group's Customize… and
its verbs.

The ⋯ menu (chrome/ThreadMenu.tsx, a `RowsMenu`) has
three groups. First a quiet line, not an item: the host's glyph and name
when the window has two or more hosts, and the thread's cost at the end in
`tabular-nums` when it is above zero; absent when it would say nothing.
Then the active thread's own rows, the same list its chip's right-click
shows (lib/threadMenu.ts, the thread's one list on every surface), with
"Move to <host>…" rows before Archive (`useThreadHost` in
chrome/ThreadHostChip.tsx; a disabled one carries its reason as a second
line). Then the project: Pause all with the running count (only when
something runs; a failure is a toast), Dev server checked while the Dev
servers pane is open (only when a host can serve the project), Terminal
with ⌘\`, Recent threads… and Archived threads…: each a `Popover` from
the ⋯ button over one list body (`ThreadListPopover`), freshest first, a
row the tinted type glyph, the title and the age, a filter past six and one muted
"No matches" row; Recent threads… lists every settled root of the strip's
scope and a row opens it, Archived threads… restores one (Restore on
hover); Escape gives focus back to ⋯. A menu row that names a type (the
thread's Type submenu, the workspace's Archive dormant rows) draws
`THREAD_MENU_ICONS`: its type's glyph in its tint. The branch is the top row
of the right panel's Changes section, not the header's.

### Sidebar

| Piece | Component | Styling |
| --- | --- | --- |
| Frame | `chrome/ProjectRail.tsx`, a flex column on `bg-sidebar` | resizable; the 40px header (traffic lights, back, forward, the toggle), the scrolling list, a hairline, the foot. The navigation and Accounts groups scroll with the workspaces, so a short window never starves the list (⌘K still reaches Search once it has scrolled away). The classic layout and its tab strip are gone |
| Row | `chrome/RailRow.tsx` (`RailRow`) | every row in the rail and the settings list: 36px, a 16px glyph, a 13px label, `text-muted-foreground` at rest and `text-foreground` on hover, focus and selection; selection is `aria-current` with a `bg-muted` fill, hover `bg-foreground/5`, never a bar, border or shadow; at most one trailing mark (`trailingInteractive` puts a control such as a workspace's status word beside the row's button) and one hover action (an icon Button with its Tooltip that takes the trailing slot's place); a Tooltip, never `title=`, and a label the row cuts (a long workspace name) is its own tooltip while it is cut (`useTruncated`); rows never animate in or out. The lists sit in an 8px inset |
| Heading | `RailHeading` in `chrome/RailRow.tsx` | 28px, 12px `font-medium` muted, sentence case, on the rows' glyph column; "Accounts" over its group, "Pinned" only when pins exist, "Workspaces" ends in Add workspace (one always-visible icon button) unless the list is empty, when an Add workspace… row stands under it instead. Groups are 16px apart |
| List | the navigation group, the Accounts group, Pinned, then Workspaces (`railTopRows`, `railAccountRows` in chrome/ProjectRail.tsx) | the navigation group first: Search (Tooltip ⌘K, selected while the search view is open), Inbox (medium foreground while something is unseen), Mark all read (every thread on every host, and the seen floor raised, as the Threads menu's item; no selected state), Notes (selected while the Notes view is open) and Chats (the home's loose chats, its trailing mark the waiting or working glyph). Then the Accounts group, Accounts and Stats, in the desktop app only (at /ui their pages cannot open, so the group is absent) |
| Workspace row | `WorkspaceRow` in `chrome/ProjectRail.tsx` on `lib/linkedRail.ts` | the glyph, the alias-resolved name, its one `StatusMark` word as its trailing mark (the glyph alone in a rail under 15rem, the row being the `railrow` container: the name keeps its room, and the button's name and the line under the row still say the word) and ⋯ (the right-click's menu: Customize… (name, logo, colour and mascot in one dialog, applied on Save), Pin or Unpin, Reveal, Mark all read, the fleet switches, Archive, Delete) as its hover action; drag reorders it, a 2px accent line marks the drop. One "Workspaces" section for every host, no host headers; a workspace linked across hosts (one `linkId`) is one row led by this machine's copy, its threads, word, Mark all read, pin and drag spanning every copy; order, pins, recents, labels, colours and mascots keep their keys, the other copies alias to the leader's (`aliasKeys`). No diff stat, no pin button, no shimmer on the name. The glyph (logo or mascot, never animated or tinted by state), the word (Needs you, Failed, Working, Paused, Watching, loudest first: Working is a thread running a turn, Watching one that waits on its batch, subagents or background work; a click opens the workspace's threads in a Popover, each row led by its type's tinted glyph and a master's batch threads one step past it) and the 24px line under the row naming the thread behind the word (`+N` for the others) are A2's, in `chrome/WorkspaceRowMarks.tsx`; unread is the row's emphasis |
| Offline tint | `chrome/hostOffline.ts` | with two or more hosts, a row whose host's link is not open (a rail row: every host of it) sits at `opacity-50` with `data-host-offline`, as the master board's rows do; its rows are the launch mirror's and lift when the host is back |
| Foot | `RailFoot` in `chrome/ProjectRail.tsx` (`railFootRows`) | under a 1px hairline, in order: the sign-in row while this machine has no Claude or Codex account, the update row when there is something to act on, the Hosts row with two or more hosts, Settings (Tooltip ⌘,), then the usage meter. The same foot sits under the workspace column while the rail is collapsed, where the Go menu and the title bar's stand-ins reach Inbox and Notes |
| Update row | `chrome/UpdateRow.tsx` (`updateRowState`) | one RailRow, absent while idle or checking: "Updated to 1.0.N" (opens What's new, ✕ dismisses), "Update to 1.0.N" or "Retry update" (installs; What's new as the hover action when there are notes), "Downloading" with its percentage, "Restart to update"; the glyph is the accent while there is something to do, no tinted fill. Check for updates is in the app menu and Settings, General |
| Hosts row | `HostsRow` in `chrome/HostRows.tsx` | only with two or more hosts: one row ending in a 6px dot per host (`toneOf`), its aria-label naming each host and its state; a click opens a `DropdownMenu` with a submenu per host (the `HostGlyph`, the name, the state word and the `+N` deploy drift), holding Switch to <host> (not for the host on screen), Add workspace here…, Mark all read, Pause all, Resume all, Stop all and Archive done, then Host settings. A host's boot resume is a sonner toast ("7 threads resumed after restart", the host's name under it with two or more hosts; `useBootResumeToasts`) |
| Usage meter | `chrome/UsageMeter.tsx` on `src/shared/usageMeter.ts` (`meterFor`), the foot's last block | one 36px ghost row per provider with accounts: the provider glyph, an 80px 4px `Progress` of the pooled share (the mean room over every account routing could pick, each account's room its tighter of 5h and week; expired and unreported accounts left out; amber below 10%), then "in 2h" (the next refill) in 12px `text-muted-foreground`, or "Limited 3m" in `text-warning` while every account is throttled; before any report an empty track and no text. A provider whose every account answered that its plan has no caps (Cursor's "no usage caps on this plan", `NO_CAPS_NOTE`) has no row; an account still unanswered, expired or whose poll failed keeps the empty track. No account name. Hover (the tooltip's delays), click or Enter opens a `Popover` to the right: the provider and "62% left", one row per usage window (5h, Week, each per-model cap) with its refill, percent and bar, and one muted foot line, "3 accounts with room". It moves on the `accounts` push alone |
| Settings list | `SettingsNav` in `chrome/SettingsRail.tsx` | while settings are open the rail's list is the pages as RailRows under RailHeadings, then the workspaces (another host's names its host as muted trailing text; two of one name on one host each name where they sit there: the shortest end of the parent folder's path that tells them apart, "work" or "me/work", else the whole path, `workspaceHint`), and Back as the foot's one row |
| Workspace column | `chrome/Sidebar.tsx` | column two holds the workspace's project cards, then its loose chats and archived projects (`WorkspaceSessions`), under one 40px header (a 40px content box with its hairline under it, as the title bar's rows, so its buttons sit on the strip's y 6 line): the workspace's name (Chats at the home) in 13px medium, New thread (Tooltip ⌘N) and the workspace ⋯ menu. No tabs: files and changes are the right panel's Files and Changes sections; ⌘P still goes to a file. While the rail is collapsed a 40px row with the traffic lights and the toggle sits above the header and the rail's foot sits under the threads. The column's own element scrolls the list (the virtualizer's scroll element, as state); across Settings and Back it keeps, per workspace, its offset (re-applied as the rows measure when the list first lays out shorter than it was, until it fits or the person scrolls), its list pages and the Chats fold, and does not replay the selection's reveal. Threads are not listed under projects: a project's threads are picked from the title bar's strip and its ⋯ menu's Recent threads…; only the Chats and Archived folds keep thread rows (a loose chat has no project to go to), each a 32px `ThreadRowView` leading with its type's tinted glyph (`TypeGlyph`, 12px in the 16px lead column) and ending in its status glyph; its subagents one step in, the lead column left empty, then the role's plain glyph. A right-click on any thread row opens that thread's menu, and an inline rename ended by Enter or Escape gives focus back to the row's or card's ⋯ |
| Project card | `ProjectCardView` / `ProjectCard` in `chrome/WorkspaceSessions.tsx` on `cardLines`, `cardCounts` and `projectCardAriaLabel` (lib/sidebarRows.ts) | one `<button>` with no border or shadow, `rounded-lg`, `px-3 py-2`, a `bg-foreground/5` hover and a `bg-muted` fill while selected (`aria-current`), 4px from the next card, never animated. A 20px line: the name in 13px (foreground when selected, `font-medium` foreground while a thread in it is unread, else muted) and its last-active time in 12px muted `tabular-nums`, which gives way to ⋯ on hover and focus. A 16px branch line 2px under it: the branch glyph and the branch (else "local checkout"), then "worktree" or "local" two spaces on. Then 24px read-only lines in 12px, aligned under the name: each master with something to say as a block (its line with the batch's done tally, its working subagents in the fleet's words, its batch threads one step in, "N queued"), then the working roots (the spinner or the watching ring, the type's tinted glyph, the title, the host glyph, the elapsed past 3 s; an implementation thread's "3/7  task" under it), the paused ones ("Paused" and the frozen elapsed), the unread ones (no mark, the title's weight); a thread housed in a master prints only in its block. One page of lines, then "N more" beside the button. Last, a count line when there is something to count: "1 needs you" in amber and "N failed" in red with their glyphs, then muted "N dormant" and "N archived" (a thread inside a master is never dormant), two spaces apart; "No threads" for a project with none; paused is never counted. A click or Enter anywhere on it, a line included, selects the project (App's `onSelectProjectCard`); lines never open a thread. A double-click renames it in place; ⋯ and a right-click open the same menu. Its accessible name says what needs saying ("Alpha, 1 needs you, 2 working, 3 unread"). Dimmed under the offline tint when every copy's host is out of reach. The Archived fold's project rows keep `ProjectRowView`, a 32px fold |

**The project's home.** A project card's click selects the project
(`onSelectProjectCard` in App.tsx): any full-window view closes, its open
tab comes forward, else the thread it was last on, else a new chat. The
project's threads are then the title bar's strip ("Thread strip" below) and
the ⋯ menu's Recent threads…, which lists every one that has settled. There
is no project page in the pane.

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
line, and Settings… opening the project's settings sheet). There is no
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
  never here); Changes when its cwd is a project checkout, or when it is a
  loose chat whose workspace's folder is a git repository (`checkout`,
  read on the workspace's path); Notes for every root; Files with Changes;
  Build for a thread of a project (never a loose chat, even in a project's
  folder; dev servers live in the bottom dock's tab),
  and Debug for one on a dev build or once "Debug this file" asked for it
  on the thread. The default is Activity if it exists, else Agents when
  the thread has subagents (live or done), else Changes, else Notes; a remembered section that no
  longer exists falls back to the default.
- **Frame.** A docked column, 320px by default, 260 to 480 by the sash on
  its left edge, and it yields to the thread: the thread column never goes
  under 360px (`THREAD_MIN`), so in a narrow row the panel is drawn
  narrower, down to 260 (`panelFit`), and in a row narrower than 620 it is
  not drawn at all. Its stored open state stays, so it returns when the row
  widens; meanwhile the title bar's toggle is disabled with "No room for the
  panel" on hover, View › Show Panel is greyed and ⌘⇧R does nothing
  (ThreadView measures its row; `rightPanel.setRoom`, `usePanelRoom`). On
  `bg-sidebar` with the `border-border` hairline; a 36px
  header of a segmented control (`PanelSections`: `Tabs variant="default"`
  of 28px icon segments, each named by its aria-label and a tooltip, the
  pill gliding between them; seven fit at 260px, so nothing scrolls) and a
  close button; the section's body
  below (`ActivitySection`, `FleetList`, `NotesBody`, `ChangesPanel`,
  `FileTree`, `BuildPanel`, `DebugPanel`). It toggles, never tweens its width; the body fades in
  over `--dur-fast`. Closed is closed: the thread header's button, ⌘⇧R and
  View › Show Panel reopen it on its last section. An agent's
  detail (`fleet.detailId`, surfaces/threads/fleet/AgentDetail.tsx) is a
  672px `Sheet` from the window's right edge (what it holds: "Orchestration"
  below). Its transcript mounts once the slide in has finished, and Open
  closes it before splitting the agent beside its parent.
- **Bodies.** No section has a border, a card or a header bar of its own;
  the panel's header is the only one. A section is a column with a 12px
  inset, 28px rows (`Item size="xs"`, hover `bg-foreground/5`, selected
  `bg-muted` with `aria-current`), groups 16px apart under a 12px medium
  muted heading only where two groups meet, nothing in a row animating.
  Each body is a container (hooks, requests) over a pure `…View` that its
  jsdom test and `<Name>.fixtures.tsx` render.
  - **Agents** (`FleetList`): A18's rows in a scroll area; none is one
    Empty, "No subagents".
  - **Changes** (`chrome/rail/ChangesPanel.tsx`): the one place a
    checkout's changes are listed. Its top row is the branch, the one place
    a thread's branch is changed once it has a message (BranchPicker's
    head: the list, create, and the stash-or-commit choice for a dirty
    tree; its upstream on hover), Sync with `↓2 ↑1` or Publish, Create PR or PR #n, and a ⋯
    menu (Pull, Push, Stash changes, Stage all, Unstage all); a push to the
    default branch confirms. Then the index: Staged and Changes headed
    only when both have rows, each row the file's type icon, its name with
    the folder after it, Unstage or Discard and Stage on hover or focus,
    and `+n −n` (New, Deleted; a file in both groups counts each group's
    own lines, `stagedCounts`/`unstagedCounts` from the host); a click opens the diff against HEAD, the
    right-click menu adds Open in <editor>, and a modified file folds open
    into hunks in both groups (the caret takes the icon's place on hover):
    under Changes each is stageable (index → working copy), under Staged
    each is unstageable (HEAD → index), and a file in both groups folds each
    group on its own (`hunksOf` in surfaces/editorGit.ts, reached through
    `import()`). Under
    them the Against group (`ChangesAgainst.tsx`, what the Branch section
    was): a `Select` of the target, a ⋯ menu with Update from, Rebase
    onto and Merge into (a local target only), the files changed since the
    merge base opening the diff against it ("No file differs" when none
    does but commits do; nothing at all when even), and one fold line,
    "3 commits ahead  1 behind", over the commits, the one place ahead and
    behind are said. With no branch but the current one there is no
    default target: the `Select` stands alone on "Choose a branch", and a
    picked branch that is gone reads "<branch> no longer exists". A landed
    move is a toast, conflicts one `Alert` with nothing changed. The commit field is
    pinned at the foot while there are changes: the generate button inside
    it, Commit (⌘↩) with a menu for Commit & push and Commit, push & create
    PR. Loading is skeleton rows, nothing is one Empty, "No changes", a
    failure one red line.
  - **Notes** (`NotesBody`): the state line ("Updated 2m ago", "Saving…",
    "Not saved" in red), Copy as brief and a pencil at the top; the pencil
    swaps the rendered notes (`AgentMarkdown size="compact"`) for the
    source in place and becomes Done (Escape too); a thread write while the
    person types is one line with Load theirs. None is one Empty with
    "Start the notes".
  - **Files** (`FileTree`): New file, New folder and Collapse all as icon
    buttons over the tree; no root row (the project is the panel's
    context; its actions are the background's right-click menu), no diff
    counts (Changes has them).
  - **Build** (`BuildPanel`): the target `Select` and Build or Cancel; one
    status row (`StatusMark`: Working with the time, Done, Failed with the
    exit code, Stopped) over the command; "2 behind origin" with Fetch only
    when a fetch is due; the log; the outputs as rows that reveal the file.
    No command is one Empty with "Set one" (the workspace's Build settings).
  - **Debug** (`DebugPanel`): with no session one muted line, "⌃D in a
    Java file starts a session here"; while one runs, the step controls,
    its `StatusMark` (Working, Paused) and Stop, then Call stack, Variables
    and Console, and the Evaluate field, live only while paused.

### The viewers

An image (chrome/Lightbox.tsx) and an agent's HTML page
(surfaces/HtmlRenderViewer.tsx) open in a full-window `Dialog`
(`size="full"`, the window less 24px a side), each on its own module
store (lightboxStore.ts, htmlRenderOverlayStore.ts) and each in a lazy
chunk, so neither Dialog is in the first paint. The lightbox has no chrome but the close, the arrows at the
window's sides and the 12px counter; a slide change fades over
`--dur-fast`. The page fills the same frame on `background`, the
document filling it, one secondary close button over its top right corner
that holds focus when it opens, and no title bar. Escape and the arrow keys
reach both through the command map (lib/appCommands.ts); while focus is
inside the page, its bootstrap script passes an Escape the page did not take
up as `tc/escape` (shared/htmlRender.ts), so a page saved before that closes
only through Close or a click outside. A click outside the image or the
page closes them, and focus goes back to what opened them. An image on a
sent message is always a Preview button that opens the lightbox: the chip
shows the thumbnail once its bytes arrive and the file's glyph until then,
and the lightbox says "Couldn't open <name>" when they never do. This
machine's desktop reads an image at any path (`attachment.read` is fenced
only for remote callers).

### Project dialogs on a linked project

A project whose `linkId` another host's row shares keeps its settings on
one copy, the box's (`settingsHomeOf`; `lib/projectHome.ts` resolves it
from the catalog and each host's hello). The dialogs act on that copy over
its host's link, so a Mac whose own copy has not pulled the box's last edit
never shows the old values:

- **Project settings** (`chrome/ProjectDialogs.tsx`, a `Sheet` from the
  right: name and branch, then Completed turn, Reviews, Accounts, Plans and
  Build open under 12px headings, each with its "Use workspace setting" or
  "Use global setting" link, nothing folded) and **Preamble**
  (`chrome/PreambleDialog.tsx`) read every field from the home copy and
  save it there; only the branch is this copy's own. The footer says
  "Saved on box" once, muted, left of Cancel. While the home's link is not
  open, Save is off and the footer says "box is offline" instead.
- **Rename** renames the home copy; the others follow.
- **Archive** (and restore) takes every copy, the home first; a home that
  is offline opens the archive dialog with Archive off and the reason. The
  worktree and branch clean-up apply to the copy it was opened on.
- **Delete** is an alert (`AlertDialog`, Cancel and the red verb): it
  deletes this copy and asks "Also delete the copy on box", off by default,
  one checkbox per other copy, off while that host is offline.

An unlinked project's dialogs act on the project itself, with no footer
note.

### Thread strip

chrome/ThreadHeaderStrip.tsx: the scope's live root threads as one row of
chips, a hand-made `role="tablist"` (DESIGN.md keeps the tab strip
hand-made). The scope is the selected project, or with no project selected
the loose chats of the workspace (its Chats) or of the home (the chats
outside every workspace): `StripScope` and `stripRootThreads` in
lib/threadStripModel.ts. A loose strip keeps the project rules: stable
order, Recent threads, the whole ⋯ menu, ⌘1–9; only the archived shelf is
project-only. The thread on screen always has its chip, in the scope or not
(`onScreenId` in `buildHeaderModel`); settled threads leave the row and are
reached from the ⋯ menu's Recent threads.

- **Order.** Stable, like a browser's tabs: a chip keeps its place, a new
  one joins at the end (oldest first when several arrive together), and a
  status change never moves one (`orderChips` in lib/threadHeaderModel.ts).
  The order is saved per project (a loose strip under `loose:<workspace>`) in localStorage (`monocode.stripOrder`,
  `stripOrderStore` in stores/header.ts, 64 ids per project, a project not
  shown for 30 days dropped on load) under the link id, so the copies of a
  linked project share one order; the title bar orders the model before it
  publishes, so ⌘1–9 and ⌃Tab walk the chips as they sit. While the pointer
  is over the strip a chip whose thread settled holds its place, so nothing
  shifts under the cursor; it goes when the pointer leaves. The title bar
  holds it (`holdModel` on the strip's `stripHold` flag, `useHeldStripModel`
  in stores/header.ts) before it publishes, so the row drawn and the row the
  keys walk are one list: ⌘5 is the fifth chip drawn, selected as a click on
  it is (`slotTarget`), so a chip sharing a split focuses its own pane and a
  chip with no tab opens its thread.
- **The chip.** A ghost `Button` with `role="tab"`, 28px tall, 12px
  padding, `rounded-md`, 2px apart: the type glyph (`TypeGlyph`, 14px,
  1.5 stroke, its type's tint on every chip, active or not), 8px, the title (13px, truncated at 224px), "Master" in
  muted type when pinned, then the `StatusMark` glyph (none for an idle or
  done thread). Muted at rest, `foreground/5` and foreground on hover (the
  colour swap takes `--dur-fast`), `bg-muted` when active (no transition),
  medium weight when unread, the accent ring on keyboard focus. No motion:
  list rows take none.
- **Input.** A primary click selects, on release; dragged 5px it carries
  the thread onto a pane's edge instead ("Panes" below). A right press or a
  Control-click never selects, and the contextmenu opens the thread's menu
  at the pointer (one `RowsContextMenu` over the strip reading the chip's
  `data-menu-id`; rows from lib/threadMenu.ts). Double-click renames in place
  on an `Input`. Arrows, Home and End move focus along the row (only the
  active chip is in the tab order), Enter or Space selects. The row and its
  gaps are outside the window's drag region.
- **Closing a tab.** ⌘W on a thread alone in its tab closes the tab and
  brings the neighbouring tab forward (right, else left, in strip order;
  `planCloseFocused` in lib/workspaceTabGroups.ts); on the strip's last tab
  it does nothing. The thread stays: a live one keeps its chip, a settled
  one leaves for Recent threads. The thread menu's "Close tab" (after Open
  to the side, only while the thread has a tab; "Close pane" when it shares
  one) does the same. A chip has no hover X: it would read as archive.
- **Hover.** One `Tooltip` per chip under a shared `TooltipProvider`: the
  title, and under it the status word with what it is about ("Working
  typecheck", "Needs you  approve Bash", a tally, a failure's verdict).
- **New thread.** The "+" after the last chip (chrome/NewThreadChooser.tsx)
  is a ghost icon button, or "New thread" in words on an empty strip, opening
  a `Popover` of `Item` rows, one per thread type, each with its tinted
  `TypeGlyph`; Orchestrate and Research
  keep an options button whose tune view swaps in place with Back.

File and terminal tabs (chrome/SurfaceTabs.tsx) take the chip's shape on a
line `Tabs`: a 36px bar with its hairline, each tab 28px with the file-type
icon, the name (italic for a review) and a 16px slot whose unsaved dot turns
into the close button on hover (or on a clean active tab), the active tab
underlined. No change counts (the Changes panel has them); drag to reorder
keeps its 2px accent drop marker.

### Composer (all thread types)

The box is Claude desktop's: `rounded-xl` on `COMPOSER_SURFACE` (the card
fill and a hairline that steps to `border-input` while the field has focus;
the checkpoint strip above it shares it), attachments as `Attachment` chips
over the 15px field, and one 32px row under it that never scrolls
(chrome/ComposerBar.tsx). Left: `+` (Attach files, Mention a file or thread,
Skills and commands; the last two type `@` or `/` at the caret) and the
model button, which reads the model and the effort ("Opus 5.5  High") and
opens the model menu: providers, search, the list, then the model's
settings as rows (Effort, Context with the thread's percent, Speed only for
the tiers the serving CLI lists, any other setting; a catalog with no
context setting, Codex's, gets a read-only Context row with the percent and
the window while the thread has a reading). A pick hands the focus back to
the field; Escape or a click outside returns it to the model button, and the
permission select follows the same rule. Right: the permission
mode as a quiet select (none for fx) and the send button, whose glyph is
what Enter would do. Until the thread's first message the box's top row
holds the type select (chrome/ThreadTypeChip.tsx): the type's tinted glyph
and its name, each item the same glyph over its hint. No mascot runs along
the composer.

The row is the `composer-bar` size container, so a narrow box gives way in
one order, by container variants and never by script: the free space
first, then the model button's effort word (under 384px of row) and its
name, truncating and then gone under 208px so the harness icon is left,
then the permission mode's label under 336px, so its icon is left (its
accessible name and tooltip still say "Permission mode: <mode>"). Add and
Send never shrink; every control fits a 220px box.

Under the box, one quiet row (`DraftRow`) holds project, host, branch and
type on the shell's new-thread screen and until a thread's first message;
the project picker ends in "Choose folder…", the folder dialog whose pick
becomes the draft's project. After the first message the row is gone: the
branch is changed in the Changes section's head and the type is the thread
menu's Type submenu. The goal is the thread menu's "Goal…", on every
surface and for every root claude or codex thread, answered by the app's one
dialog (`GoalDialogHost` in chrome/GoalDialog.tsx); usage and accounts are the rail's meter (A3); the
context ring and its breakdown are gone, the percent is on the model menu.

The host in that row (chrome/DraftHostPicker.tsx) shows for a draft of a
project linked across hosts: the host's glyph and name, and a menu of every
connected host; picking one moves the draft there. A host with no copy
reads "New copy" and gets one on pick (`project.ensureLinked`); a host with
no checkout is disabled and says why. The default host is the one of the
thread on screen when it is in the project, else the one last used for it,
else this machine (lib/projectHostChoice.ts).

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
  the picked terminal below the bar. Only the shown project's dock is on
  screen (`shownDock` in lib/projectTerminal.ts decides the grid's dock row
  and the dock alike); another project's dock leaves the screen whole and
  keeps its terminals running.
- **Dev servers** (surfaces/DevServersPane.tsx): a 288px column, the
  starter (one 36px row: the target `Select`, "web (Vite dev server)", and
  Run; the hosts as a `ToggleGroup` with two or more; Replace, Start another
  and Cancel when the thread on screen already runs one; an error line)
  above the dev servers live on the hosts right now, grouped under their
  threads (a 12px muted heading per thread), and the picked one's console
  filling the rest. A row (chrome/DevServerRow.tsx) is what it is in plain
  words with the host glyph, its address and "Open on the Mac :5174" under
  it, Stop at its end. The address is the row's Open control ("Open
  localhost:5199", "Open in browser" on hover); a server on another host
  opens from "Open on the Mac :5174" and its own address stays plain text. It lists only what a host still lists; a row the
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
- **The conflict bar** (surfaces/ConflictBar.tsx, the note's shape through
  `EditorAlert`) sits under the note and above the header, in both editors.
  A disk change under unsaved edits merges in when it touches other lines
  (lib/diskRace.ts); when it touches the lines being edited nothing is
  written and the bar asks: "Changed on disk where you were editing" with
  Reload and Keep mine (⌘S), or "Deleted on disk" with Restore.
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

### Panes

A tab holds a tree of panes (surfaces/PaneTree.tsx on lib/layout.ts); the
pieces it draws are surfaces/paneChrome.tsx.

- **The header.** Alone in its tab a thread has none. In a split every
  thread pane has a 36px `PaneHeader`: the title (13px, truncated; a
  subagent's, which has no chip, shows whole on hover) and Close, a ghost icon button with "Close
  pane ⌘W" on hover. ⌘W closes the focused pane in a split (File › Close
  Pane) and the tab of a thread alone in it (File › Close Tab; "Closing a
  tab" under the thread strip). The focus mark is the header itself: the focused
  pane's is the content's background with the title in foreground, the
  others' the rail's gray with a muted title. A file pane's tab bar takes
  the same two backgrounds. No dot, no status mark, no grip.
- **Moving a pane.** The whole header drags it (the file pane's bar from
  its empty end); past 5px the pane dims and the drop zone shows where it
  lands. Escape cancels.
- **The sash.** A hairline between panes with a 6px hit area each side; a
  4px band on it takes the rail handles' hover and drag tints, and the
  accent when focused from the keyboard. It is focusable ("Resize panes"):
  the arrows along its axis move it 2% (Shift 10%), and a double-click
  makes the group's panes equal. A sash between side-by-side panes keeps
  both at 360px or more (`clampSashBoundary`, the same `THREAD_MIN` the
  right panel yields to); where the pair is narrower than two of those it
  parts evenly. Every resize handle shares `useSashKeys`: axis
  arrows move 2% of its container (Shift 10%), and double-click resets its size.
- **The drop zone.** The half the pane will take, a box inset 4px with
  rounded corners, the hairline and a translucent muted fill, fading in at
  `--dur-fast`; it moves between edges in place. The nearest edge wins:
  every drop splits, nothing drops in the centre.
- **A chip onto a pane.** A thread's chip dragged out of the strip shows
  the same drop zone on the pane under the pointer, and a release there
  opens the thread on that edge, its tab forward and its composer focused
  (`workspaceActions.dropThread`; the strip's chip follows the focused
  pane): a thread already in that tab moves, one
  from another tab leaves it (that tab goes when it held only the thread),
  one open nowhere joins. A release elsewhere, Escape or the window losing
  focus does nothing.
- **Parked tabs.** Only the shown tab's panes take a drop: a parked tab is
  `content-visibility: hidden`, `pointer-events: none` and `aria-hidden`.
- **States.** A gone thread's pane offers Close pane in a split and Close
  tab alone. A slow or failed load is one 12px muted line, its parts 8px
  apart ("Box did not answer", "connection closed", "retrying in 1 s"),
  then Retry.

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
right, never under 360px beside the board (the board yields first). The
transcript's prose breaks a token longer than its column (a bare URL, a
path) instead of widening it; a code block scrolls inside its own box. The board has one 36px header: a short title, one muted state line in
`tabular-nums` (facts set apart by margin, never a middle dot), the view's
actions, and last the conversation `Toggle` (`ChatToggle`, pressed while
the chat shows). While the chat is folded and the thread is paused, the
board draws the strip's paused row under its header (`held`, `heldRowOf`
in chatSlots.tsx: Stop, Continue, a master's "and 3 batch threads with
it"), so a pause never goes out of sight; with the chat shown the chat's
own strip says it and the board draws nothing. Folding is a toggle, not a tween: the board takes the full
width at once, the chat stays mounted (`inert`, parked at its last width)
and fades back in over `--dur-fast` when shown again. The fold is
remembered per thread for the app's run (`useChatFold`, lib/chatFold.ts),
so a tab switch that unmounts a parked view keeps it; a relaunch starts on
the view's phase default, and a question waiting at a remount still opens
the chat. Each view's document
is one column, `max-w-2xl`, at 15px/1.6. A view without a board is the chat
alone, with no header.

### Planning — a document, not a conversation

The main view IS the plan file (`.temp-code/plan-<thread>.md`), rendered
as the document column and streaming as it is written. The chat sits
beside it while the plan takes shape and folds once the plan is written or
handed off; a question forces it open. Header: "Plan" and the task count,
which once the plan is written and settled with no build yet is the Plan
ready mark with the count as its detail;
before the handoff one primary **Start build** opens `StartBuildDialog`
(Implement or Orchestrate, model, effort, access, the goal prefilled from
the plan, the orchestration rules only for Orchestrate; Start calls
`plan.implement`, one build). After the handoff the header names the build
(the build's tinted type glyph, "Implementation" and its `StatusMark`) and
opens it. With the chat folded,
a heading outline sits at the left edge when the board leaves it room
beside the centred 672px document (a container query on the board,
`@min-[69rem]`, never the window's width); it lists the sections the page
renders, so a project plan's milestones are one entry. The frontmatter is
never a section. A task list draws its checkboxes with no bullet.

### Implementation — the tasks and the changes

```
┌ plan heading (or the request) ───── [plan] [planned in] [chat] ┐
│ Pass 1  Move the notes            1/1 +40 −12  ›                │
│ Dec 31  Opus 5.5  High  200k  $1.20                             │
│                                                                 │
│ Now make the gate run beside the build                          │
│ ┌ ◔ Tasks                                 2/3 ┐                 │
│ │ ✓ Read the brief, the board's view a…   12s │                 │
│ │ ◉ Make every task one line that fits    41s │                 │
│ │   the column, with the whole text           │                 │
│ │ ○ Run the publish gate beside the ele…      │                 │
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

The board is the pass's `TaskList`: every task one 28px line cut at the
column's edge (more of it shows as the board widens), its whole text in a
tooltip on hover while it is cut, and the running task alone whole, in
full foreground, so when the next task starts the last one collapses to
its line and the new one opens. Each started task ends its row in the time
its blocks worked (12px, muted, the running one ticking on the shared
clock, a done one in the done tone, nothing under 1.5 s); folded, the
header names the running task on one cut line. Then one line per approval or question
waiting on the person (opening the chat) and the last failure (or
Stopped), then the files each task changed (`ChangeRows`: a row per file
under its task's name, shell-made ones marked `shell`, each opening its
diff preview in place with Open diff under it), then the closing report.
Earlier passes fold into rows above (number, request, tally, diffstat and
the run's record), each opening its tasks and changes; a pure Q&A pass has
no row. A finished pass offers **Start pass N**, which arms the next
message as a new pass; folding the chat while a pass is armed puts it back.
The header's [planned in] button opens the planning thread and draws the
plan type's tinted glyph.
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
  line) at 15px, and one 13px muted sentence under it, "2 working, 1
  watching, 1 needs you, 3 done" (`fleetSentence`), needs you in amber and
  failed in red.
  Nothing before the first agent. There is no board, no edge tab and no
  "Orchestrator log".
  Under the transcript sit the working strip and the composer, as on any
  thread: Working with Stop mid-turn, "Watching  a subagent" while it
  waits on its agents, Paused with Stop and Continue; the transcript draws
  no live row of its own.
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
- **A row opens the agent's detail**, a 672px Sheet from the window's
  right edge (fleet/AgentDetail.tsx, its content
  fleet/AgentDetailBody.tsx): the title, the status in full, one muted
  tabular line (host, model, effort, branch, +a −d, tasks,
  context, cost, elapsed), the transcript, and a field that steers a live
  agent and messages a settled one. A spawn row in the transcript opens the
  same detail.

### Master — the project's batch

A thread whose `isMaster` flag is on routes to `MasterView` whatever its
type (CLAUDE.md "Master threads", docs/master-threads.md for the why); a
project may have any number of masters, each with its own batch, and the
tab's or the rail row's menu makes one ("Make master thread" / "Not a
master", `session.setMaster`; disabled on an unsent draft with "Send a
message first" as its tooltip, since the host pins only a thread it knows). The board | sash | chat recipe (SplitShell):
the batch on the left, the master's own chat on the right, folding from
the toggle at the end of the view header. A pinned master has its board from the first message: with no child yet the header (+ Thread, the batch actions) and the foot stand over an empty list that says nothing of its own. A child of the
batch is never a tab: it lives on the board, and a click puts its full view
in the whole pane, with Back.

```
┌ iOS batch 2  Land all seven, gate once, release      ⋯  [+ Thread ▾]  ✉ ┐
│ Needs you                                                              │
│  ☷  Live Activity strip                   ✺ Claude Fable 5.1  high 1M │
│     ◉ Ad Hoc or Debug?               (hover: ✉ Message  ⏸ Pause  ⋯)   │
│ Working                                                                │
│  ☷  Home: Needs you, Working, Workspaces  ✺ Claude Fable 5.1  high 1M │
│     ⠿ Workspaces list with the project headers                    3/7 │
│        ◉ ⚒ Run the tests  approve Bash                                 │
│        ⠿ ⚒ Rail rows  Editing Rail.tsx                                 │
│       1 done                                                           │
│  ⌕  Pricing survey                         ◉ gpt-6.1-sol  xhigh       │
│     ⠿ Reading the third source                                         │
│  ▢  Tabs or spaces                         ✺ Claude Fable 5.1  medium │
│     ⏸                                                                  │
│ Queued                                                                 │
│  ☷  Inbox swipe actions                   ✺ Claude Fable 5.1  high 1M │
│     ◌ waiting for Home                                                 │
│ Done                                                                   │
│  ☷  Design foundations                    ✺ Claude Fable 5.1  high 1M │
│     landed 12:08                                                  4/4 │
├────────────────────────────────────────────────────────────────────────┤
│ When done                                                         Edit │
│ ✓ Land        2 of 7 landed                                     1m 30s │
│ ⠿ Gate        3 of 7  vitest                           1m 12s   ■ Stop │
│     ✓ typecheck 12s                                                    │
│     vitest  src/main/server/batch.test.ts (14 tests) 120ms             │
│ ◌ Release                                                              │
│ ◌ Deploy to the box                                                    │
│ Then notify you                                                        │
└────────────────────────────────────────────────────────────────────────┘
```

- **Header**: SplitShell's 36px view header (`title`, `detail`,
  `actions`): the batch name (the master's title), the master's summary
  line (`rules.summary`) as its muted detail when it wrote one, then ⋯
  (a ghost icon button, "Batch actions") and + Thread ▾ (a ghost button)
  before the conversation toggle. The ⋯ menu is the batch's fleet switches
  (`master/boardActions.ts`), counting the rows of every host: Pause all
  (the running-turn rule, confirmed with the live count and one line,
  "Each turn holds where it is.") and Resume all go
  to each row's own host through its `session.batch`; Archive done… and
  Archive all… (`master/ArchiveBatchDialog.tsx`: "Archive 3 done threads?"
  / "Archive all 7 threads?" with the live count, the resources checkbox
  the fleet's Archive done offers; done is the host's rule, `BatchState.done`
  from batch.ts, so a child idle on a turn it never completed is not
  counted) run `batch.archive` on the master's host
  (a running thread is stopped first, the master stays) and then, for the
  rows of another host its answer did not cover, that host's own
  `session.batch` (`remoteArchivePlan`: under all the live ones stopped
  first); the rows leave from the push. A row with nothing to act on is
  disabled. + Thread is a menu: New thread… (the add sheet) and Add
  existing thread… (`master/AdoptThreadDialog.tsx`: the project's
  unarchived root threads in no batch and no master themselves, on this
  host and on the project's paired copies elsewhere (`pairedProjectIds`,
  lib/projectPairs.ts), one checkbox row each (the tinted type glyph, the title,
  the type word) with the host's name at the right when they span hosts, in
  a list that scrolls past 320px; Add is one `batch.adopt` on the master's
  host, a thread of another host named `<envId>:<id>`, the host's
  refusals read back by title in the sheet). No counts anywhere: the rows
  say them.
- **Sections**, each a 12px medium muted heading in the status
  vocabulary's words and no count, in this order: Needs you (waiting,
  error), Working (starting, running, watching, paused, and an idle child
  whose subagents still work, which the host's done rule leaves out too;
  `groupOf`), Queued (waiting for a sibling or the running cap), Done
  (idle, stopped). The heading
  says the state's word once, so the rows under it never repeat it. An
  empty section is not drawn. Rows oldest first within a section; nothing
  animates a reorder. The rows are the batch's children on every host the
  renderer knows (`masterChildrenOf` over the whole session store, which
  holds each connected or mirrored host's rows): a child the master started
  on the box sits beside one at home. When `batch.get` lists `children`
  with their hosts (the server's cross-host batch), the list is the
  authority on a row's host and status and the session rows keep the
  bodies (`mergeBatchChildren`; a child the store has no row for becomes
  a plain row with the list's title and type).
- **A row** (`master/MasterRow.tsx`: `MasterRowView` draws from props
  alone, `MasterRow` wires it to the store; the rule is `rowStatus` in
  `master/rowBody.ts`) is an `Item` (a `div role="button"`, `rounded-md`,
  hover `foreground/5`, no border) with two lines on a 16px glyph column,
  and nothing on it is separated by a dot. Line one: the type's glyph
  (`TypeGlyph`, its type's tint; its word in a tooltip and as its accessible
  name, never printed beside the title), the 13px medium title (muted
  while the row sits in Done or Queued), the host's glyph, and at the end
  the provider's mark, the model's name, then its effort and context. Line
  two: `StatusMark`'s glyph for the thread's state (`threadStateOf`, an
  idle row being done) with what the state is about (a done row draws no
  glyph, its detail alone in the text column, the state word kept in its
  accessible name), and the task tally
  (`3/7`, `tabular-nums`, no bar) at the end once the thread has a list.
  The detail: working, an implementation's task in hand (its `in_progress`
  todo), else the activity; waiting, the open question, else "approve"
  and what it was doing; failed, the failure; watching, what it watches
  (an idle child with live subagents is watching them, the strip's rule)
  and queued, the activity without the lead the word says ("Waiting on ",
  "Queued  "); paused, what it was doing; done, "landed 12:08" once the
  batch lists it, else a research or orchestration thread's summary (the
  notes' State line, else its last words). The child the batch's
  `blocked` names says why ("ended its turn without completing", "errored",
  `blockedReason` in src/shared/batchWords.ts). A state its section does
  not name (watching or paused under Working) says its word before the
  detail. Every detail starts lower-case and ends without a full stop. Amber and
  red details take the state's tone; every other detail is the mark's
  muted detail. No task list, third line or progress bar: the child pane
  has the list, one click away. A row of a host whose link is not open
  sits under the offline tint (`opacity-50`, `data-host-offline`): its row
  is the launch mirror's and lifts when the host is back.
  Under the lines, the thread's live subagents, one 20px line each in the
  text column: `StatusMark`'s glyph, the role's glyph (`AGENT_GLYPHS`,
  muted; a line with no role, a batch thread, takes its type's tinted
  glyph), the title, what its state is about in the board row's own words
  (`rowStatus` from the meta: the activity, "approve Bash" in amber, the
  failure in red) and the host's glyph. Its whole tree by the parentId
  chain (archived ones left out, a far child's from that host's rows in
  the store), the person's first (waiting, failed, working, then paused or
  queued, oldest first within each), at most three (`AGENT_LINES`), then
  one quiet line, "and 2 more, 3 done", amber when one past the cap
  waits; a thread whose agents all settled shows nothing. A line opens
  the agent in the board's place as a row opens its thread, and its click
  never reaches the row (`master/agentSummary.ts`). The board builds one
  parent index of the store per meta change and one entry per row
  (`AgentSummaries`, `useAgentSummaries`); a row reads its own
  (`useRowAgents`) and re-renders only when its lines changed.
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
  stays in place when the build starts and the type glyph turns from the
  plan's to the implementation's; the plan, archived after the start or not, is never a
  second row.
- **Hover** (and focus inside the row) fades the model mark out and the
  row's actions in where it sat, ghost icon buttons with tooltips and no
  box around them: Message (opens the thread's full view with the
  composer focused), the one verb the state calls for (Pause while a turn
  runs anywhere in its tree, Resume when paused or stopped, Start now when
  queued, which is `session.start` past `after`; nothing otherwise), and ⋯,
  the row's menu at the button. Stop, Archive and Remove from queue live in
  that menu. Every action goes to the row's own host: the commands route
  by the thread's id through the store's link for it.
- **Click** opens the thread's full view in the board's place
  (`master/ChildPane.tsx`, given the row's `environmentId`): the whole
  pane, board and master chat gone, becomes the thread's own view (its
  header at once, titled from the row, and the transcript's skeleton until
  the thread's rows load), the one
  its type gets as a tab (the implementation board, the plan document, the
  fleet), over its transcript, working strip and the composer a tab has
  (`surfaces/threadChat.tsx`, shared with SessionPane: model and reasoning,
  Fast and 1M, permission, the account chip, attachments and paste, `@`
  references, `/` skills, the queue, steer while it runs, the draft kept
  per thread, the approval and question cards in its transcript); App's
  handlers reach it through `SessionActionsContext`. A child on another
  host opens against that host the way a rail row of that host does (the
  store holds every host's rows by id, `data-child-host` names it). The
  header is 36px: Back (a ghost button whose tooltip says "Back to the
  board" with Esc) and the thread's title; Escape, or ⌘↩ outside the composer (inside it ⌘↩ is the composer's
  own), goes back, and the board returns at the scroll it was left at.
  Nothing opens a tab; the strip never lists a child (`isBatchChild` in
  lib/threadStripModel.ts).
- **Right-click** on a row, or on a subagent line under it, or the row's
  ⋯, opens that thread's one menu (lib/threadMenu.ts, the rows every
  surface shows): Open and New pass… first; a queued thread's menu has
  Start now after them, Remove from queue (the fleet switches' Stop on a
  queued root, which archives it) in Archive's place and no Compact. New pass… is a dialog (`master/NewPassDialog.tsx`,
  the Modal at `lg`): the thread's title, one quiet line with its status
  glyph and the board row's own words for what it does now, else its last
  words (`passLine`), and the same composer for that thread on its host.
  Send does what the composer would there (a turn when idle, steer or queue
  while it runs) and closes the dialog; the row follows from the store.
  Escape or a click outside closes it and the draft stays with the thread.
  A popover or the composer's `@`/`/` list open inside a Modal takes
  Escape first: each stops the key before the dialog hears it.
- **The foot** (`master/BatchFoot.tsx`, the step rules in `master/steps.ts`)
  stays put under the scrolling list, always rows, at the rows' 20px
  inset: a "When done" heading (12px medium muted) with Edit, the blocked
  line in red when a child blocks the batch's end, then one 28px row per
  step: the master's list (`rules.steps`, a `BatchStepSpec` each: id,
  name, kind, a shell step's command and cwd) joined by id with the host's
  telemetry (`state.steps`; `liveSteps`), in the state's order, a step the
  rules name that the host has not seen yet pending at the end; the
  renderer writes no step name of its own. A row is `StatusMark`'s glyph
  (`stepState`: pending queued, running working, passed done, failed
  failed, skipped idle), the name (muted while pending or skipped), what
  it is about (`stepDetail`: the land step "as they finish" or "all at
  once" until it runs, then "2 of 5 landed"; a running step "12 of 31"
  and the host's label apart by margin; "skipped" or the host's reason; a
  failed step's detail in red; a settled step's detail without the time
  its time column says, and nothing for a bare "passed", which the glyph
  says), its time (`tabular-nums`, ticking every
  second from `startedAt` while it runs), and Stop on the running step
  (`batch.stopStep` with the step's id), Hide and Show on a failed one
  whose log says more than its row.
  The running step's console opens under its own row through
  `Collapsible` (the standard's fold, opacity under reduced motion),
  indented to the name: 12px mono on `card`, 60px to 176px tall, newest
  line at the bottom, following until the person scrolls up (back at the
  bottom, it follows again), "Starting…" before the first line; a shell
  step's command shows once, as its console's first line (`$ <run>`, the
  host writes it). A failed step's console stays open with its last lines
  until Hide; the failure is said once, red on its row, lower-case without
  a stop (`stepDetail`), and the console drops a last line that only
  repeats it (`consoleLines`); a log that is only that line opens no
  console (`hasConsole`). No progress bar: the row's detail
  says the count. The last line says what happens then: "Then notify you"
  or "Then archive the threads". Until `batch.board` answers the foot is
  a `Skeleton` of the heading and three rows. Read from the `batch.board`
  answer and the `batch` push (each step's log as the lines since the last
  push, `foldBatchPush`; a push past what is held asks `batch.get` for the
  whole state).
- **Edit** opens the rules (`master/RulesDialog.tsx`, Modal md; the pure
  moves in `master/rulesEdit.ts`): Branches land (As they finish / All at
  once, shown while a merge step is in the list), then the steps in order,
  one row each: its number, its name in a field, its kind or a shell step's
  command muted, and Up, Down, Remove as ghost icon buttons with tooltips.
  Land is pinned first, as the host runs it: its row has its number and
  name only, the row under it cannot move above it, the list opens with it
  on top (made when missing) and the select never offers it.
  Under them the "Add a step…" select: a built-in
  kind (Merge the branches, Gate the merged tree, Release, Publish the Mac
  release, Deploy to the box) lands at once with its name; Shell command
  opens a draft with a name, the command (exit 0 passes) and a directory
  (default the project), Cancel and Add step, in place of the select.
  Then (Notify me / Archive the threads), Summary, the sentence read back
  under the fields. The two choices are `FieldRow`s with a `ChoiceToggle`. Save stays
  off while a step has no name or a shell step no command; it is
  `batch.setRules` with the whole list, the foot takes the change from the
  push.
- **New thread…** opens the add sheet (Modal md, `master/AddThreadDialog.tsx`):
  "Add a thread to <batch>", the brief first (focused; ⌘↩ adds), then one
  `FieldRow` per choice, label left and control right: Type (a
  `ChoiceToggle` of every type, Chat first, Implement chosen), Model (the app's picker, every catalog model), Effort
  (a `ChoiceToggle` of the model's own ladder, whole), Context (200k / 1M,
  Claude only), Host (a `ChoiceToggle` over the master's own host and every saved host whose link is
  open, `linkedHosts`, the master's first, the row hidden with one host;
  another host offers its paired copy of the project and is disabled
  without one, its note on a tooltip), After (a small select: "Nothing,
  start now", else a sibling). Cancel, Add.
  One column, nothing scrolls. Add is `session.create` on the chosen
  host's link with `masterId`, `startedBy` (the master, so the thread's
  settles report to it) and `after` plus the brief as the first message;
  the row arrives from the push. Its model
  menu, like every menu and popover, sits on the popover layer (95, above
  the dialog's 90).
- **Everywhere else** a child is an ordinary root thread in the rail with
  its activity line ("Queued  waiting for <sibling>") and its own working
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
