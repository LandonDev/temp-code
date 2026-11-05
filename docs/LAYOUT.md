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
┌─ titlebar ─ traffic lights ─ live chips, + ────────────── plan · agents · ⋯ · panel ─┐
│            │  the shelf: the settled chips, while there are any                      │
├────────────┬───────────────────────────────────────────────────┬─────────────────────┤
│ sidebar    │  thread view (per type)                           │ right panel         │
│            │                                                   │ Agents · Activity · │
│ workspaces │                                                   │ Changes · Notes …   │
│  projects  │                                                   │ (the sections the   │
│            │  composer                                         │  thread's state has)│
│ ── foot ── │  model · context · permission row                 │                     │
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
the home's draft, set to Claude: the composer alone, under a title bar that
holds only its end group (the home has no strip). It starts empty wherever the app was launched from: no folder is
adopted as a workspace, in a dev, preview or packaged build alike. The rail
has its usual shape (the navigation group on top, Accounts and Stats in
it, then the Workspaces list; Check for updates and Settings in the foot) and adds two
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
suffix: macOS names the app already. The title bar draws no title of its own
on any platform: off macOS (Linux, the web /ui) the window's or the
browser's own title shows `document.title`, and the strip's box runs to the
end group, which reaches the bar's end. The dock badge has one meaning: the
threads that need you (an approval or a question) on every host, subagents
included, archived out; never unread, failed or plan-ready. Every window
reports the same count and the dock shows the largest (src/main/dockBadge.ts);
it bounces once when the count rises with no window focused. No dock
progress bar.

## Region by region

### Titlebar

Drag region (`titlebar-drag`), hiddenInset traffic lights; their 78px of
room is kept on macOS alone (`TrafficLightSpacer`). In deck layout
the thread strip (below) fills the bar: its live row is the bar's first
40px, and its shelf of settled threads, when it has a chip, a 32px row
under it, so the bar (`min-h-10`) grows by 32px while the scope has a
settled thread; the shelf folds in and out on `.collapsible-auto` (height
on the layout spring with a fade, keeping its last chips while it folds
away), never growing the bar in one frame. The rail and the workspace
column keep their 40px headers. The bar's icon buttons are 28px
(`icon-sm`) beside the 28px chips, their glyphs 14px at a 1.5 stroke; a
chip's focus ring is the global outline alone.
The home (the rail's Chats: the chats outside every workspace) has no
strip: its chats are the workspace column's Chats list, so chips would say
it twice. Its live row holds the thread on screen's title alone, 13px
medium foreground where the first chip's glyph would start (18px in), then
the same end group; with the home's draft on screen, the end group alone.
The title renames in place on a double-click and opens the thread's menu on
a right-click, as a chip does, and is outside the drag region only over its
words. The row stays 40px, so nothing moves between a workspace and the
home (`heading` on the header model, `HomeHeading` in
chrome/ThreadHeaderStrip.tsx).
The live row's right end is the end group: the project plan's chip when
the project has one, the agents cue while a subagent of the thread on
screen is live, then two ghost icon buttons, each with a `Tooltip`: the ⋯
thread menu, then the panel toggle (`aria-pressed` while the right panel
is open, "Panel ⌘⇧R"; disabled with "No room for the panel" while the
thread's row is too narrow for it), last because it is nearest the panel
it opens. The end group is right-aligned, so ⋯ and Panel keep their places
while the cue comes and goes. The agents cue (chrome/AgentsCue.tsx) is a
quiet 24px control, the composer row's (`ROW_CONTROL`: 8px padding, 12px
muted text, the `foreground/5` hover fill), counting every subagent of the
thread's tree (by `parentId`, any depth; a master's batch threads are its
board's) that works, watches, waits or is queued. It reads left to right,
6px apart: the loudest state's glyph (waiting's amber ring when one needs
you, else working, else queued's dashed ring); one 12px mark for each
distinct provider those agents run on, 2px apart in a fixed order (Claude,
Codex, Muse, Cursor, then the rest; a Meta model under any harness draws
Meta's), the logos the model picker draws, at most four, then "+2"; then
the words in `tabular-nums`, "1 agent" or "3 agents", or while any waits
"1 needs you" in amber, medium weight, the loudest fact said in words. One
mark per provider, not per agent: the count already says how many, so the
marks say only which. Working spins only while the thread itself is
not running a turn (watching or idle); while its own turn runs, its tab and
working line already spin, so the cue draws working's still dot. A new
count morphs its words in place (`MorphText`) and a provider that joins
grows its mark in from a quarter on the layout spring's curve; one that
leaves goes at once, and the control never remounts. The
tooltip and the accessible name are one line, "Agents: 1 needs you, 2
working on Claude Code and Codex". A click opens the right panel on Agents and the chip takes the
panel toggle's pressed fill, which it wears whenever the open panel shows
Agents, by name or as its default (the panel reports the section it draws,
`useShownSection` in lib/rightPanel.ts); a click then closes the panel. With no room
for the panel it is disabled like the toggle, its tooltip "No room for the
panel". It shows in every view (chat, board, plan, research,
orchestration) with the panel open or closed, never on a subagent's tab,
fades in on `--dur-fast` and leaves at once. The live chips, New thread and the end group
share one 40px row box, so all of them sit on one 28px line at y 6. The
scroll arrows belong to the live row: they sit over its own box, never over
the end group. The bar's content ends 12px from the window's edge, the right
panel's inset, so Panel sits over the panel's last button. The rail-closed
stand-ins (Inbox, Notes, Go to File, New Thread, Settings) follow Panel 2px
after it, as the end group's controls sit, each named on hover with its key
by a `Tip`, and are drawn only when there is one; the New Thread stand-in
only on the home, since everywhere else the strip's + is the bar's one New
thread. The Windows controls sit flush at the bar's end, after the inset.
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
chrome/ThreadHostChip.tsx). A disabled row or submenu says why in its
tooltip and accessible description, never a second line: Type "Stop or
wait for the turn to end" while the thread is live, Resources… "Nothing to
remove", Mac bridge "Set on the parent thread" or "Loading", a refused
move its host's reason. The thread's rows include Dev server, checked
while the Dev servers pane is open (only when a host can serve the
project). A master's rows carry, right after Remove as master, New batch
thread… and Add existing thread…: the batch's add sheet and adopt dialog
(`BatchAddDialog`), so a master whose batch is empty, and so has no board,
can start its first child. Then the project: Pause all with the running count (only when
something runs; a failure is a toast), Show terminal while the project
has one, else New terminal with ⌃\`, Recent threads… and Archived threads…: each a `Popover` from
the ⋯ button over one list body (`ThreadListPopover`, in the dialogs chunk, mounted only while a list is open), freshest first, a
row one 28px line of the tinted type glyph, the title and its age at the
end in 12px muted `tabular-nums`, a filter past six and one muted
"No matches" row; Recent threads… lists every settled root of the strip's
scope and a row opens it, Archived threads… restores one (Restore takes
the age's place on hover, in the same cell, so nothing moves); Escape gives focus back to ⋯. A menu row that names a type (the
thread's Type submenu, the workspace's Archive dormant rows) draws
`THREAD_MENU_ICONS`: its type's glyph in its tint. The branch is the top row
of the right panel's Changes section, not the header's.

### Sidebar

| Piece | Component | Styling |
| --- | --- | --- |
| Frame | `chrome/ProjectRail.tsx`, a flex column on `bg-sidebar` | resizable; the 40px header (traffic lights, back, forward, the toggle), the scrolling list, then the foot under one hairline. The navigation group scrolls with the workspaces, so a short window never starves the list (⌘K still reaches Search once it has scrolled away). The classic layout and its tab strip are gone |
| Row | `chrome/RailRow.tsx` (`RailRow`) | every row in the rail and the settings list: 28px, 12px horizontal padding, a 16px glyph slot only when the row has an icon or a glyph (a row with neither starts its label at the 12px inset), 8px to a 13px label that keeps at least 48px (`min-w-12`), so trailing marks never take the whole row. An item is `text-muted-foreground` at rest and `text-foreground` on hover, focus and selection; selection is `aria-current` with a `bg-muted` fill, hover `bg-foreground/5`, never a bar, border or shadow. `surface="group"` is a container: `bg-sidebar-group` at rest, `-hover` on hover, `-selected` while `aria-current` or its menu is open, the label foreground at every state, no transition on the fill. At most one trailing node (`trailingInteractive` puts a control such as a workspace's state glyph beside the row's button) and two `hoverActions`, 24px icon Buttons with their Tooltips (one `TooltipProvider`) in order at the row's end on hover (after `--delay-hover`, fading in on a wrapper so the button keeps its hover fill) and keyboard focus (a mouse click does not hold them; an open action menu keeps them and keeps the mark they cover hidden), whose presses never reach the row (beside an interactive trailing node they follow it, and a plain mark marked `RAIL_YIELD` gives them its place). A Tooltip, never `title=`, and a label the row cuts (a long workspace name) is its own tooltip while it is cut (`useTruncated`); rows never animate in or out. The lists sit in an 8px inset; an icon row's glyph, a heading and a workspace name start at the same 12px inset |
| Heading | `RailHeading` in `chrome/RailRow.tsx` | 28px, 12px `font-medium` muted, sentence case, at the rows' 12px inset; "Pinned" only when pins exist, "Workspaces" ends in Add workspace (one always-visible 24px icon button) unless the list is empty, when an Add workspace… row stands under it instead, and "Working" in the foot. The navigation group has none. Groups are 16px apart |
| List | the navigation group, Pinned, then Workspaces (`railTopRows` in chrome/ProjectRail.tsx) | the navigation group first, one group with no heading and no gap between rows: Search (Tooltip ⌘K, selected while the search view is open), Inbox (medium while something is unseen), Mark all read (every thread on every host, and the seen floor raised, as the Threads menu's item; no selected state), Notes (selected while the Notes view is open), Chats (the home's loose chats, its trailing mark the waiting or working glyph), then Accounts and Stats in the desktop app only (at /ui their pages cannot open, so the rows are absent) |
| Workspace row | `WorkspaceRow` in `chrome/ProjectRail.tsx` on `lib/linkedRail.ts` | a container: `RailRow surface="group"`, the rows 4px apart (`gap-1`) so their fills never touch. It leads with the workspace's 16px glyph (`WorkspaceGlyph`, chrome/WorkspaceGlyph.tsx, the one glyph Search, Inbox, Notes and the folder picker draw too): the logo Customize set, else the repo's icon or its host's GitHub or GitLab mark from the workspace's host unless a mascot was picked, else the mascot (picked, or hashed from the key) in the workspace's colour; an image on the 4px radius, loaded lazily and drawn only once loaded (a data URL at once; the slot keeps its size, so the name never moves), one that fails giving way to the next; never animated, never tinted by state; a linked row reads the leader copy's look. The alias-resolved name follows 8px on in 13px foreground, `font-medium` while one of its threads is unread. Its trailing marks: the selected row's uncommitted lines, "+212 −48" in 12px muted `tabular-nums` (`diffWords`; green and red stay in the Changes section; only the selected row asks git, on the bulk lane, `useGitDiffStats`; the button's name adds "3 files changed, +12, -4", `workspaceRowAriaLabel`; it gives way to the hover actions, and to the name in a rail under 15rem, the row being the `railrow` container), then the state's one `StatusMark` glyph in a 24px ghost button named with its word and count ("Needs you, 4 threads"; Needs you, Failed, Working, Paused, Watching, loudest first; no glyph for idle or done), whose click opens the workspace's threads in a Popover, each row led by its type's tinted glyph and a master's batch threads one step past it, and whose press never starts a drag. On hover (after `--delay-hover`, fading in, the diff leaving the line as they take their place in it) and keyboard focus, Pin or Unpin then ⋯ (the right-click's menu: Customize… (name, logo, colour and mascot in one dialog, applied on Save), Pin or Unpin, Reveal, Mark all read, the fleet switches, Archive, Delete) at the row's end. Drag reorders it, a 2px accent line marks the drop. One "Workspaces" section for every host, no host headers; a workspace linked across hosts (one `linkId`) is one row led by this machine's copy, its threads, glyph, Mark all read, pin and drag spanning every copy; order, pins, recents, labels, colours and mascots keep their keys, the other copies alias to the leader's (`aliasKeys`). No shimmer on the name and no line under the row: Working names the threads. The glyph button is A2's, in `chrome/WorkspaceRowMarks.tsx` |
| Offline tint | `chrome/hostOffline.ts` | with two or more hosts, a row whose host's link is not open (a rail row: every host of it) sits at `opacity-50` with `data-host-offline`, as the master board's rows do; its rows are the launch mirror's and lift when the host is back |
| Working | `RailWorking` / `RailWorkingView` in `chrome/RailWorking.tsx` on `workingRows` (lib/railWorking.ts) | the foot's first block, under its one hairline, from one row (`WORKING_MIN`; nothing else in the rail names a thread): a "Working" heading, then one RailRow per root thread on every host that needs the person, runs a turn, or finished while the window looked elsewhere and has not been looked at (`liveAgentTracker`), needs you first, then working by when the turn began, then done; archived threads and threads housed in a master's batch stay out. A row is an item: the thread's `TypeGlyph` at 12px in the 16px lead column, the title (muted, foreground while it is the thread on screen, `aria-current`), then the host glyph with two or more hosts and the state's `StatusMark` glyph at its end; its name is "<title>, <word>". Its tooltip says the state, what it is about and the elapsed time while it works (the word and the time as two spans, "Working 2m 12s"; `workingTipLine` is its one-line name, "Working: 2m 12s"), the project under them; the clock runs only while a working row shows. A click opens the thread. Four rows, then "N more", which opens the rest in place (a scroller at `max-h-[45vh]`) and reads "Show less" while open |
| Foot | `RailFoot` in `chrome/ProjectRail.tsx` (`railFootRows`) | under one 1px hairline: Working when it has rows (`working`), then 16px under it the rows, in order: the sign-in row while this machine has no Claude or Codex account, the update row (the desktop app only), the Hosts row with two or more hosts, the Away row, Settings (Tooltip ⌘,), then the usage meter. The same foot, without Working, sits under the workspace column while the rail is collapsed (that column lists the threads), where the Go menu and the title bar's stand-ins reach Inbox and Notes |
| Update row | `chrome/UpdateRow.tsx` (`updateRowState`) | one 28px RailRow, always there in the desktop app and absent at /ui: "Check for updates" with the running version at its end in 12px muted `tabular-nums` ("v1.0.307", which yields to the label in a rail under 15rem and stays in the row's name; asks the feed, as the app menu and Settings, General do), "Checking…" with the `Spinner` in the glyph slot and disabled while a check the person asked for runs (the background probes leave the row still), "Updated to 1.0.N" (opens What's new, ✕ dismisses), "Update to 1.0.N" or "Retry update" (installs; What's new as the hover action when there are notes), "Downloading" with its percentage, "Restart to update"; the glyph is the accent while there is something to do, no tinted fill |
| Hosts row | `HostsRow` in `chrome/HostRows.tsx` | only with two or more hosts: one 28px row ending in a 6px dot per host (`toneOf`), quiet while its host is well (`bg-muted-foreground`, half that while stale) and coloured only in trouble: amber while slow, connecting or reconnecting (the amber spinner in its place while it reconnects), red when refused, faint otherwise; its aria-label names each host and its state. A click opens a `DropdownMenu` with a submenu per host (the `HostGlyph`, the name, the state word and the `+N` deploy drift), holding Switch to <host> (not for the host on screen), Add workspace here…, Mark all read, Pause all, Resume all, Stop all and Archive done, then Host settings. A host's boot resume is a sonner toast ("7 threads resumed after restart", the host's name under it with two or more hosts; `useBootResumeToasts`) |
| Away row | `AwayRow` in `chrome/AwayRow.tsx` on `lib/away.ts` | right above Settings, in both feet. The whole 28px row is one switch named "Away from computer" (`role="switch"`, `aria-checked`; Space and Enter flip it): the moon, the 13px label, and at its end a still 32×18 track (switch-track.ts). Off, it reads muted like the foot's other rows; on, the track fills `warning`, the moon turns `warning` and the label foreground. The flip shows at once and rolls back with a toast ("Couldn't turn Away on") when the host refuses. Its tooltip: off "Threads decide without asking you", on "Away since 2:14 PM". It reads this machine's host (the page's host at /ui); the Threads menu's Away from Computer is the same switch, ticked while on |
| Return toast | `AwayReturn` in `chrome/AwayReturn.tsx`, mounted once with the app's toasts | when a live `away` push turns a host's Away from on to off (never the state read at a link's open, so never at boot), each host's tally that lands in the next 3 s joins one sonner toast (`away-return`): "Decided without you in 4 threads" ("in 1 thread"), with Review. No decisions anywhere, no toast. Review opens `AwayReviewDialog` (the dialogs chunk): a `Modal` "Decided while you were away", one `ItemButton` per thread, most decisions first: its `TypeGlyph`, title, `HostGlyph` with two or more hosts, and "3 decisions" muted `tabular-nums`. A click opens the thread and closes the list |
| Usage meter | `chrome/UsageMeter.tsx` on `src/shared/usageMeter.ts` (`meterFor`), the foot's last block | one 28px ghost row per provider with accounts, its own `railrow` container at the 12px inset: the provider glyph, an 80px 4px `Progress` (56px in a rail under 15rem) of the pooled share (the mean room over every account routing could pick, each account's room its tighter of 5h and week; expired and unreported accounts left out; amber below 10%), then "in 2h" (the next refill) in 12px `text-muted-foreground`, or "Limited 3m" in `text-warning` while every account is throttled, on one line at any width; before any report an empty track and no text. A provider whose every account answered that its plan has no caps (Cursor's "no usage caps on this plan", `NO_CAPS_NOTE`) has no row; an account still unanswered, expired or whose poll failed keeps the empty track. No account name. Hover (the tooltip's delays), click or Enter opens a `Popover` to the right: the provider and "62% left", one row per usage window (5h, Week, each per-model cap) with its refill, percent and bar, and one muted foot line, "3 accounts with room". It moves on the `accounts` push alone |
| Settings list | `SettingsNav` in `chrome/SettingsRail.tsx` | while settings are open the rail's list is the pages as 28px RailRows under RailHeadings, then the workspaces (another host's names its host as muted trailing text; two of one name on one host each name where they sit there: the shortest end of the parent folder's path that tells them apart, "work" or "me/work", else the whole path, `workspaceHint`), and Back as the foot's one row |
| Workspace column | `chrome/Sidebar.tsx` | column two holds the workspace's project cards, then its loose chats and archived projects (`WorkspaceSessions`), under one 40px header (a 40px content box with its hairline under it, as the title bar's rows, so its buttons sit on the strip's y 6 line): the workspace's name (Chats at the home) in 13px medium, New thread (Tooltip ⌘N) and the workspace ⋯ menu. No tabs: files and changes are the right panel's Files and Changes sections; ⌘P still goes to a file. While the rail is collapsed a 40px row with the traffic lights and the toggle sits above the header and the rail's foot sits under the threads. The column's own element scrolls the list (the virtualizer's scroll element, as state); across Settings and Back it keeps, per workspace, its offset (re-applied as the rows measure when the list first lays out shorter than it was, until it fits or the person scrolls), its list pages and the Chats fold, and does not replay the selection's reveal. A project card lists no thread rows of its own, only the read-only lines of `cardLines` for what needs saying; a project's threads are picked from the title bar's strip and its ⋯ menu's Recent threads…; only the Chats and Archived folds keep thread rows (a loose chat has no project to go to), each a 32px `ThreadRowView` leading with its type's tinted glyph (`TypeGlyph`, 12px in the 16px lead column) and ending in its status glyph; its subagents one step in, the lead column left empty, then the role's plain glyph. The thread rows are bare: no resting fill, `bg-foreground/5` on hover and `bg-muted` while selected; a fold's heading has no fill open or folded. A fold that follows the cards (`spaced` from `sidebarItems`, lib/sidebarRows.ts) starts 16px below them (`pt-3` on the list's 4px gap), a new group; at the home and in a workspace with no projects it starts at the top. A right-click on any thread row opens that thread's menu, and an inline rename ended by Enter or Escape gives focus back to the row's or card's ⋯ At the home the loose chats are no fold: the column's header already says Chats and holds New thread, so the rows stand under it with no heading (`headed` on the chats item). |
| Project card | `ProjectCardView` / `ProjectCard` in `chrome/WorkspaceSessions.tsx` on `cardLines`, `cardCounts` and `projectCardAriaLabel` (lib/sidebarRows.ts) | one `ItemButton surface="group"` with no border or shadow, `rounded-lg`, `px-3 py-2`, on its own resting fill (`bg-sidebar-group`), `bg-sidebar-group-hover` on hover and `bg-sidebar-group-selected` while selected (`aria-current`) or pressed, 4px from the next card, never animated. A 20px line: the name always in 13px `font-medium` foreground (an unread thread says so by its own line's weight and in the card's accessible name, never by the name) and its last-active time in 12px muted `tabular-nums`, which gives way to ⋯ on hover and focus. A 16px branch line 2px under it: the branch glyph and the branch (else "local checkout"), then "worktree" in medium weight 4px on; a local checkout, the default, says no mode. Then 24px read-only lines in 12px, aligned under the name: each master with something to say as a block (its line with the batch's done tally, its working subagents in the fleet's words, its batch threads one step in with working as a dot, the master's line spinning while anything in the block works, since the block has one moving mark at its head, "N queued"), then the working roots (the spinner or the watching ring, the type's tinted glyph, the title, the host glyph, the elapsed past 3 s; an implementation thread's tally and task 4px apart under it), the paused ones (Paused and the frozen elapsed, a `StatusMark` word and its muted detail), the unread ones (no mark, the title's weight); a thread housed in a master prints only in its block. One page of lines, then "N more" beside the button. Last, a count line when there is something to count: "1 needs you" in amber and "N failed" in red with their glyphs, then muted "N dormant" and "N archived" (a thread inside a master is never dormant), 4px apart, a glyph-led count 8px from the one before it; the menu's fleet switches, Pause all, Resume all and Stop all, act on the project and its linked copies through `requestThreadBatch` (a `projects` scope; Pause and Stop confirm), and its "Archive N dormant threads" (and the workspace menu's) counts those roots and takes each master it archives with its settled batch (lib/archiveDormant.ts, loaded when the row is picked), as a root takes its subagents, while a batch thread that still works stays, a root on the card and in the strip from then on; "No threads" for a project with none; paused is never counted. A click or Enter anywhere on it, a line included, selects the project (App's `onSelectProjectCard`); lines never open a thread. A double-click renames it in place; ⋯ and a right-click open the same menu. Its accessible name says what needs saying ("Alpha, 1 needs you, 2 working, 3 unread"). Dimmed under the offline tint when every copy's host is out of reach. The Archived fold's project rows keep `ProjectRowView`, a 32px fold, its threads one step in (16px) under its name |

**Containers and items.** A container is a workspace row in the rail and a
project card in column two: its name in 13px foreground, never a type tint,
on `sidebar-group`. A rail workspace row leads with the workspace's glyph
(its logo, repo icon or mascot: `WorkspaceGlyph`, the same in Search, Inbox,
Notes and the folder picker), then its name. An item is a thread row anywhere (the Chats and Archived folds, the
rail's Working section, the popover): a 12px type glyph in the 16px lead
column, its title regular and muted unless unread, and no resting fill; it
is never set like a container. A Working row ends in its state's glyph.

**The project's home.** A project card's click selects the project
(`onSelectProjectCard` in App.tsx): any full-window view closes. Coming from elsewhere, the project's most
recent active thread comes forward first (`activeLanding`,
lib/projectLanding.ts): a root on any linked copy that is working, waiting,
paused, queued or watching, newest by its last event, on the host it lives
on; a batch thread stands in for its master, which opens on its board, and
a subagent never counts. With nothing active, a project left while its
draft was on screen comes back on the draft with its text, even when one of
its thread tabs is still open (`DRAFT_LANDING`, lib/projectContext.ts;
saved for every linked copy and the workspace), else its open tab comes
forward, else the thread it was last on, else the project's draft. A click
while the person is already in the project (its tab on screen, or a linked
copy's thread) moves nothing, so a thread turning active never takes their
place. The workspace row (and the title bar's project button) and the
Chats row take the same active thread first; a restored window comes back
on its saved tabs, not a landing. The
project's threads are then the title bar's strip ("Thread strip" below) and
the ⋯ menu's Recent threads…, which lists every one that has settled. There
is no project page in the pane.

### Settings, looked at

`bun run ui:preview src/renderer/src/surfaces/settings/SettingsPages.preview.tsx#SettingsPagePreview --shot`
draws every Settings page over one fake host in three states: answered,
not yet answered (each section's rows in their shape) and refused (each
section's red line with Retry at its heading); `SETTINGS_PREVIEW=editor,hosts`
keeps those pages alone.

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
caps, forwarding and shared folders). Facts on one line are `Facts` spans (one comma
sentence, each 4px from the next; `lib/factsGuard.test.ts`), never dots; numbers are `CommitField`s; switches `SettingSwitch`; options
`ChoiceSelect`. A refused change is said under its own row (a client's
Revoke under that client, a port under Port, Sync now under Sync); only the
listener's own failure sits under Remote access. A refused field puts the
value the host still holds back, as a refused switch slides back. Add host
sits at the page's foot (desktop only).

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
`Table` with a group row per provider: every provider of the host's live
`catalog.get` in its order, under its label and mark, and every model it
knows, the probed ones (Muse Code's `model/list`) and the Meta rows under
Claude and Codex included, each with its Spawned by select and, while
approved, its effort range. The editor asks the catalog again at each mount.
A provider with no models says so in one 12px muted row ("No models until
Muse Code is installed and signed in"); a model the rules name that the
catalog lacks keeps its row, its name muted with "not on this host" 4px
after it, and its select (`staleModels`). An empty list is one 12px muted
line in its section. When the rules live on another host (`rules.get`'s
`home`, docs/box.md "Orchestration rules and thread defaults: one copy, on
the box") the first section's description says "Saved on box", 4px under a
workspace's "Follows the global rules."; while that host is offline it says
"box is offline" and every control is disabled. Thread defaults says the
same under its section.

### The Accounts page

The rail's Accounts row opens it (src/renderer/src/aliax/pages.tsx,
views/accounts.tsx, views/accounts/row.tsx). It is the one page on the
table width: `Page width="table"`, a 1,152px cap where the settings pages
keep 672px, so on a wide pane the usage reads across instead of down. One
section per provider, its heading with Add account (or Add key…) and the
section's ⋯; one `PageRow` per account, no cards.

The rows are one container (`@container/accounts`). From 48rem of it each
row is a table line: the colour dot, the name with its state line and plan
facts taking what is left, then one 136px column per usage window (5h,
Week, a model's cap), the Rate column, the switch and ⋯. The columns are the
page's, not a section's (`barColumns` over every row): a row fills its
window columns from the left, keeps Rate last and holds an empty column for
what it lacks, a key keeps its switch's place, so the 5h, Week and Rate
columns run straight down the page. A key's Pay as you go or Key revoked
stands across the window columns it has none of. Under 48rem the row stacks:
the name and its controls on the first line, the columns on their own line
under the name, sharing its width.

A window's column is its label and the share left (amber when low), the 4px
bar with the even-burn tick, then when it refills, 12px muted and tabular:
"Resets 4:15 PM" inside today, "Resets Thu 9:00 AM" past it, "Resets Nov 12,
9:00 AM" from a week out (`resetWords`, on `clockTime`); its tooltip says how
long until then ("in 2h 10m"). A window that names no reset, or whose reset
passed, says nothing there. The bars of a row are one button whose popover
holds every window (past the bar cap too) with its pace, and the Rate's
lines. An account out of room (the gateways' cooldown, the provider's own
limit, or every window spent; `limitOf`) says so on its state line, the
`StatusMark` word "Limited" in amber with "Resets 4:15 PM" after it, the
latest reset of what binds it, or the word alone when one of them names no
time. Nothing on the page says the live threads of an account: the renderer
does not hold that count.

### The Stats page

The rail's Stats row opens it (src/renderer/src/aliax/views/stats.tsx, the
bundle from the stats worker). One `Page` at 672px, its sections in order:
Pace, Daily output, Model mix, Top projects, Cache hit rate, Busiest hours,
Tools used, each a `PageSection` whose description names its window. A
section with nothing to draw is one `PageEmpty` line ("Nothing yet" where
its description already names the window). While the first index runs the
body is each section's skeleton at its real height, and the page's own line
under the title gives the progress, once; a stats worker that is gone is
one red 12px line there with Reindex, which restarts it. Colour follows
what a series is: Claude `--chart-1`, Codex `--chart-2`, a provider's
second model `--chart-3` and `--chart-4`, the rest "Other"; one hover
readout per chart, 12px ticks, the tooltip on `px-3 rounded-xl`, and every
chart colour reaches 3:1 on the page in both themes
(`lib/chartContrast.test.ts`).

### The right side

One panel per root thread at its pane's right edge (`surfaces/RightPanel.tsx`
on `lib/rightPanel.ts`; a subagent's own tab has none). The panel follows
the thread its pane SHOWS: a master's pane that opened a batch child or a
subagent line from its board shows that thread, and so do the panel's
sections, its section memory and the title bar's agents cue (below). The six owners it replaced
(the project rail and its tab, the fleet drawer's override, the notes
drawer's map, the orchestrator log's state, the classic diff pane) are gone.

- **Store.** `{ open, section, width }` per thread id, persisted in
  localStorage (`monocode.rightPanel`; the width a new thread inherits is
  the last one dragged to). `rightPanel.open/close/toggle/set/setWidth`
  write it; `rightPanel.show(section)` opens a section on the thread on
  screen (⌃D's Debug); `useRightPanel(id)`
  reads it.
- **The shown thread.** `rightPanel.showThread(pane, { id, environmentId })`
  names the thread a pane shows in place of its tab's (MasterView, while a
  child or a subagent line is open in the board's place; null on Back and
  when the view unmounts). Open and width stay the pane's, so the panel
  neither closes nor moves between the board and a child; the section and
  Debug memory are the shown thread's, so a child opens on its own last
  section and Back returns the master's. Every write names a pane or a
  thread a pane shows and lands on the right one (`paneOf`: a thread that is
  a tab on screen keeps its own panel), so the child's Watching line opens
  the pane's panel. ThreadView's `PaneRightPanel` hands RightPanel the
  shown thread's session, read on its own host (another host's thread of
  that id holds the panel's skeleton), and the child's own view is `bare`:
  it draws no second panel. A subagent shown this way has Agents, Activity
  and the checkout sections, never Notes (only a root keeps notes). An
  agent's detail opened inside the Agents section (`AgentDetail`) moves
  nothing: the pane still shows its thread, so the other sections stay on
  it. The agents cue counts the shown thread's subagents
  (`useShownThreadId`).
- **Sections.** `sectionsFor(facts)` is pure, one line per section, in the
  header's order: Agents when the thread has subagents of its own (a
  master's batch lives on its board, never here); Activity when it has
  rows (`activityRows`: the thread's own background tasks with Stop, a
  master's batch, the dev servers its tree opened, its running Mac calls;
  never a row for subagents, which are Agents', and never on another
  thread's dev server); Changes when its cwd is a project checkout, or when it is a
  loose chat whose workspace's folder is a git repository (`checkout`,
  read on the workspace's path); Notes for every root; Files with Changes;
  Build for a thread of a project (never a loose chat, even in a project's
  folder; dev servers live in the bottom dock's tab),
  and Debug for one on a dev build or once "Debug this file" asked for it
  on the thread. The default is Agents when the thread has subagents (live
  or done), else Activity, else Changes, else Notes; the section the person
  picks is remembered per thread, and a remembered section that no longer
  exists falls back to the default. The transcript's Watching line opens
  Agents when the thread waits on subagents, else Activity (`watchSection`).
  There is no Watching section: a wait on subagents is the Agents rows.
- **Frame.** A docked column, 320px by default, 260 to 480 by the sash on
  its left edge, and it yields to the thread: the thread column never goes
  under 360px (`THREAD_MIN`), so in a narrow row the panel is drawn
  narrower, down to 260 (`panelFit`), and in a row narrower than 620 it is
  not drawn at all. Its stored open state stays, so it returns when the row
  widens; meanwhile the title bar's toggle is disabled with "No room for the
  panel" on hover, View › Show Panel is greyed and ⌘⇧R does nothing
  (ThreadView measures its row; `rightPanel.setRoom`, `usePanelRoom`). On
  `bg-sidebar` with the `border-border` hairline; a 40px header
  (`PanelHeader`), the title bar's row height, so its buttons sit 6px from
  its line and the title bar's: the sections (`PanelSections`: flat 28px
  ghost icon buttons 2px apart with no track, each named by its aria-label
  and a tooltip, the selected one's `foreground/7` fill gliding between
  them on the layout spring; seven fit on one line at 260px, so nothing
  wraps or scrolls) from the 12px inset, and Hide (28px, its ⌘⇧R in a key
  cap) at the same inset on the right, under one tooltip provider; the section's body
  below (`ActivitySection`, `FleetList`, `NotesBody`, `ChangesPanel`,
  `FileTree`, `BuildPanel`, `DebugPanel`), whose first row (Changes' branch,
  Build's target, Notes' state, Files' buttons) is one 36px row on the 12px
  inset in every section. It never tweens its width: a
  toggle in place gives the thread its new width at once (one layout; the
  transcript's anchor row holds it) and moves the pane on transform and
  opacity alone (`usePaneMotion` in ThreadView, `PANE_MOTION`): opening, it
  slides in from the row's right edge over `--dur-slow`; closing, it stays
  drawn over the widened thread, inert, sliding a quarter of its width back
  out and fading over `--dur-fast`; a toggle mid-move turns back from where
  it is; under reduced motion it fades. The row clips on x alone, so a
  split's neighbour never sees it. A pane that mounts open (a tab switch, a
  launch) is just there, and the sash's drag is immediate. The body fades in
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
  - **Agents** (`FleetList` over `FleetSectionsView`): the agents in the
    master board's sections (Needs you, Working, Queued, Done,
    lib/threadGroups.ts), each top agent by its own state with its
    descendants indented 16px a level under it (three levels drawn), in a
    native scroller; none is one Empty, "No subagents", on a master with
    "Batch threads are on the board" under it (`MASTER_AGENTS_EMPTY`). A row's line one
    is its state's glyph, its title across the whole line and the host
    glyph at its right edge; the model is the row's last line, the
    provider's logo, the model, its effort and its context window ("Opus
    5.5 High 1M"). The rows are "Orchestration" below.
    While any agent is live the title bar's agents cue says so, whatever the
    panel shows.
  - **Changes** (`chrome/rail/ChangesPanel.tsx`): the one place a
    checkout's changes are listed. Its top row is the branch, the one place
    a thread's branch is changed once it has a message (BranchPicker's
    head: the list, create, and the stash-or-commit choice for a dirty
    tree; its upstream on hover), Sync with `↓2 ↑1` or Publish, Create PR or PR #n, and a ⋯
    menu (Pull, Push, Stash changes, Stage all, Unstage all); a push to the
    default branch confirms. Then the index: Staged and Changes headed
    only when both have rows, each row the file's type icon, its name with
    the folder after it, and `+n −n` (New, Deleted; a file in both groups counts each group's
    own lines, `stagedCounts`/`unstagedCounts` from the host), over which
    Unstage or Discard and Stage lie on the hover reveal (the counts hold
    their place at rest and give way, so the name never reflows; at once on
    keyboard focus); a click opens the diff against HEAD, the
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
    does but commits do; nothing at all when even; a deleted file keeps
    its focus and hover with its name muted, as in the index groups), and
    one fold line, "3 commits ahead, 1 behind", a pressable row over the
    commits, the one place ahead and behind are said. With no branch but the current one there is no
    default target: the `Select` stands alone on "Choose a branch", and a
    picked branch that is gone reads "<branch> no longer exists". A landed
    move is a toast, conflicts one `Alert` with nothing changed. The commit field is
    pinned at the foot while there are changes: the generate button inside
    it, Commit (⌘↩) with a menu for Commit & push and Commit, push & create
    PR. Loading is skeleton rows, nothing is one Empty, "No changes", a
    failure one red line. The scroll body is one virtual list
    (`changesItems.ts` through the rail's `VirtualRows`, on a native
    scroller as the rail's and the board's lists are): only the rows near
    the viewport mount, one `RowsContextMenu` serves them all, and a row
    carries its fold's `Collapsible` only once the fold opens, so a checkout
    with 10,000 untracked files costs what one with ten does, in every warm
    tab. The app's own `.temp-code/` folder is never a change: the host
    leaves it out of every listing behind the section (git status and
    numstats, Stage all, Stash, the commit message's draft).
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
    exit code, Stopped; its detail one comma run, "exit 1, 1m 2s", naming
    the run's branch only when the select shows another) over the command;
    "2 behind origin" with Fetch only when a fetch is due; the log; the
    outputs as rows that reveal the file. No command is one Empty with "Set
    one" (the workspace's Build settings) and no Build button beside it.
  - **Debug** (`DebugPanel`): with no session one muted line, "⌃D in a
    Java file starts a session here"; while one runs, the step controls,
    its `StatusMark` (Working, Paused) and Stop, then Call stack, Variables
    and Console, and the Evaluate field, live only while paused. Variables
    are 28px rows, a name in foreground and its value muted, an expandable
    one led by the disclosure chevron, each level 16px in.

### Inbox, Notes and Search

Three full surfaces opened from the rail, each under the one 40px title
strip (the page's glyph and its name in 13px medium; Search's strip is its
field) and each closed by Escape through `usePageEscape`. Inbox
(surfaces/InboxView.tsx) and Notes (surfaces/NotesView.tsx) share one
frame: a resizable list column (280px by default) whose head is `p-2` (the
Inbox's GitHub and Linear tabs over its filter field, its filter menu and
Refresh; Notes' field and New note), its rows `ItemButton sm` in `p-1`,
2px apart, glyphs 12px in, a selected row `muted`; then the detail, a
`max-w-5xl` column on a 32px inset with 24px between its sections (the meta
line, the 16px title 8px under it, its facts 8px under that, the actions
16px under them). An inbox row is two lines (20px over 16px, 54px); a note's
three (its project and time, its title, its first words). The list is one
tab stop: the selected row takes Tab, and ↑↓ in the field or on a row
select the next row as a click would (`useRovingList`, hooks/useRovingList.ts),
Home and End on a row. Nothing selected draws no detail, since the list
already says why: its skeleton while it loads (`SurfaceSkeleton` kind
`rows`, the row's own shape), else its one `EmptyState`, which says "No
matching …" with Clear filters when the person narrowed it.

Search (surfaces/SearchView.tsx) is the field and the results under it:
28px one-line rows in `p-1`, glyphs 12px in, the highlight following ↑↓ and
the pointer only once it moves (`usePointerHighlight`), and its filters in
the field's menu (chrome/SearchFiltersMenu.tsx: Type, Host and Project as
checked `RowsMenu` rows that rewrite the typed tokens). With two or more
hosts a foot says what each took. Go to File and Go to Symbol are the same
list in a picker dialog (chrome/PickerDialog.tsx) whose rows are menu rows.

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
- **Delete** deletes this copy. With nothing to choose it is a confirm
  (`ConfirmDialog`, Cancel and the red verb); with other copies it is a form
  dialog that asks "Also delete the copy on box", off by default, one
  checkbox per other copy, off while that host is offline.

An unlinked project's dialogs act on the project itself, with no footer
note.

### Thread strip

chrome/ThreadHeaderStrip.tsx: every root thread of the scope on two rows,
each a hand-made `role="tablist"` (DESIGN.md keeps the tab strip
hand-made), "Threads" and "Settled threads". The scope is the selected
project and every linked copy of it, or with no project selected the loose
chats of the workspace and its linked copies (its Chats) or of the home
(the chats outside every workspace): `StripScope`, `looseScopeOf` and
`stripRootThreads` in lib/threadStripModel.ts. The home draws no strip
("Titlebar" above): its model holds no chip, only its chats newest first as
the column lists them (`list`, `isHomeScope` in lib/threadHeaderModel.ts),
so ⌘1–9 open the nth chat of the Chats list, ⌃Tab walks the open ones in
that order, and archiving or deleting the chat on screen selects its
neighbour in the list; the column header's New thread is its new thread. A batch child has no chip
(its master's chip stands for the batch) except while it is on screen. The
strip and the workspace column's project cards read one rule for that
(`batchHome` over `railMasters` in lib/threadStripModel.ts, which
lib/workspaceSessions.ts re-exports): a thread is housed only under an
unarchived pinned master the window knows, on any host, so a batch thread
whose master was archived or unpinned is a root of both, a chip with its
host glyph as it is a line on the card. The card's roots and the strip's
chips are the same threads (chrome/LinkedProjectStrip.dom.test.tsx). The
live row holds the live threads (working, needs you, failed, paused,
queued, plan ready, unread) in a stable order; the shelf under it holds the
settled ones, freshest first, and is drawn only while it has a chip. A
thread moves between the rows when its state changes. The thread on screen
always has a chip and is the active one, whichever row it sits on: the
root of the focused thread pane, or with a file pane focused the root of
the tab's first thread (`tabRoot` in lib/threadHeaderModel.ts). When the
scope does not hold it (another scope's thread, a batch child) its chip
ends the live row and is never saved into the order (`outsideId`,
`saveIds`). A loose strip keeps the project rules; only the archived list
is project-only. ⌘1–9 walk the live row; ⌃Tab walks the live row, then the
shelf. Archiving the active chip selects its neighbour on its own row, else
the other row's first, as a click on it would (`archiveNeighbour`).
Deleting it does the same and the window stays on the project
(lib/threadDelete.ts): a neighbour with a tab brings that tab forward, one
without takes the deleted tab's place, and with no neighbour another tab of
the project comes forward, else the tab becomes the project's draft; a thread deleted in a split loses only its pane, and one
not on screen leaves without moving anything.
An unsent draft is never a chip: with the project's draft on screen no chip
is marked and nothing stands in for it, since the centred composer says
where the person is; a sent thread's chip appears with its first row,
before the host's meta lands (`chipThreadsOf` in chrome/ShellTitleBar.tsx).

- **Order.** Stable, like a browser's tabs: a live chip keeps its place, a
  new one joins at the end (oldest first when several arrive together), and
  a status change never moves one (`orderChips` in lib/threadHeaderModel.ts).
  The order is saved per project (a loose strip under `loose:<workspace>`)
  in localStorage (`monocode.stripOrder`, `stripOrderStore` in
  stores/header.ts: the first 64 ids per project, a chip past them following
  by age; an unchanged order rewritten once a day, and a project not shown
  for 30 days dropped on load) under the link id, so the copies of a linked
  project share one order; the title bar orders the model before it
  publishes, so ⌘1–9 and ⌃Tab walk the chips as they sit. While the pointer
  is over either row a chip whose thread settled holds its place on the
  live row, so nothing shifts under the cursor; it goes to the shelf when
  the pointer leaves the strip, the window loses focus or the page hides.
  The title bar holds it (`holdModel` on the strip's `stripHold` flag,
  `useHeldStripModel` in stores/header.ts) before it publishes, so the row
  drawn and the row the keys walk are one list: ⌘5 is the fifth chip drawn,
  selected as a click on it is (`slotTarget`), so a chip sharing a split
  focuses its own pane and a chip with no tab opens its thread.
- **The live chip.** A ghost `Button` with `role="tab"`, 28px tall, 12px
  padding, `rounded-md`, 2px apart: one 14px glyph slot, 8px, the title
  (13px, truncated at 224px), "Master" in muted type when pinned, the host
  glyph (12px, two or more hosts). The slot holds the type glyph
  (`TypeGlyph`, 1.5 stroke, its type's tint on every chip, active or not)
  at rest, and the `StatusMark` glyph in its place while the thread works,
  waits, fails, pauses or queues, as a browser tab's favicon turns into a
  spinner; the hover line then names the type. Nothing else in the chip
  moves: its width never changes with its state. Muted at rest,
  `foreground/5` and foreground on hover (the fill and the colour swap take
  `--dur-hover`, the ghost button's), `bg-muted` when active (no transition), medium weight when
  unread (an unseen medium-weight copy of the title, its `::after`, holds
  that width at all times, so unread never widens it), the accent ring on
  keyboard focus. A chip whose host's link is
  down takes the rail's offline tint (`opacity-50`, `data-host-offline`).
  No motion: list rows take none.
- **The shelf chip.** The same ghost `Button`, quieter: 24px tall, 8px
  padding, 6px from glyph to title, 12px muted type, a 12px tinted glyph, the
  title truncated at 160px, and no status mark (a shelf chip is settled and
  seen by rule). The row is 32px: its chips sit 2px below the live row's box
  and 6px above the bar's hairline. Hover, active, the host glyph and the
  offline tint are the live chip's.
- **Input.** A primary click selects, on release, and so does a click on
  the active chip (its pane may not be the focused one); dragged 5px it
  carries the thread onto a pane's edge instead ("Panes" below). A right
  press or a Control-click never selects, and the contextmenu opens the
  thread's menu at the pointer (one `RowsContextMenu` over both rows reading
  the chip's `data-menu-id`; rows from lib/threadMenu.ts). Double-click
  renames in place on an `Input`. Arrows, Home and End move focus along a
  row (each row's active chip, else its first, is in the tab order), Enter
  or Space selects. The rows and their gaps are outside the window's drag
  region.
- **Closing a tab.** ⌘W on a thread alone in its tab closes the tab and
  brings the neighbouring tab forward (right, else left, in strip order;
  `planCloseFocused` in lib/workspaceTabGroups.ts); on the strip's last tab
  it does nothing. The thread stays: a live one keeps its chip, a settled
  one sits on the shelf. The thread menu's "Close tab" (after Open to the
  side, only while the thread has a tab; "Close pane" when it shares one)
  does the same. A chip has no hover X: it would read as archive.
- **Hover.** One `Tooltip` per chip under its row's `TooltipProvider`,
  which sits inside the row's tablist (the end group has its own): the lazy
  provider remounts what it wraps when tooltips warm, so none sits around a
  scroller and a scrolled row keeps its place. The label is the title, under
  it the status line as two spans, the word in the tooltip's own ink and
  weight and what it is about in its muted step (`STATUS_ON_TIP`): Working
  then "Running typecheck", Needs you then "Approve Bash", a tally, a
  failure's verdict; then the type while the status mark stands in for its
  glyph, and the host's name with two or more hosts.
- **Overflow.** A live row wider than its room scrolls sideways (a mouse
  wheel scrolls it too), and each end that hides chips gets a ghost
  28px `icon-sm` arrow (the bar's icon buttons' size) on the bar's tone, over the row's own box, that scrolls it
  by most of a width. The shelf scrolls on its own, with no arrows: an edge
that hides chips fades over 24px (`useOverflowEdges`, `OVERFLOW_FADE`).
- **New thread.** The "+" right after the live row, outside its tablist so
  it never scrolls away (chrome/NewThreadChooser.tsx), is a ghost icon
  button, or "New thread" in words on an empty strip, opening a `Popover`
  of `Item` rows, one per thread type, each with its tinted `TypeGlyph`;
  Orchestrate and Research keep an options button whose tune view swaps in
  place with Back.

File and terminal tabs (chrome/SurfaceTabs.tsx) take the chip's shape on a
line `Tabs`: a 36px bar with its hairline, each tab 28px with the file-type
icon, the name (italic for a review) and a 16px slot whose unsaved dot turns
into the close button on hover (or on a clean active tab), the active tab
underlined. No change counts (the Changes panel has them); drag to reorder
keeps its 2px accent drop marker.

### Composer (all thread types)

The box is Claude desktop's: `rounded-xl` on `COMPOSER_SURFACE` (the card
fill and a hairline that steps to `border-input` while the box has focus;
the checkpoint strip above it shares it; the hairline's step eases over
`--dur-fast`), attachments as `Attachment` chips at its top, then one row:
`+` (28px) at the left, the field, Send (a 28px circle) at the right, 6px
from the box's sides and 8px from its top and bottom (the box's 12px radius
less 6 is the controls' 6px), so the empty box is 46px with its hairline.
The field is 14px / 22px (the bubble's size, so a send moves the same text)
with 3px above and below, so its first line is centred on the controls'
28px line; each further line grows the box upward by 22px while its bottom
stays, and `+` and Send stay on the bottom line (`items-end`). A press on
the row's own padding puts the caret in the field. The field snaps to its
height on a keystroke and on the clear after a send; a paste, a restore or
a quote of more than one line eases it over `--dur-base`
(`morphTextareaHeight`'s `animate`, which ComposerInput sets), up to 160px,
then it scrolls. The box is flush with the transcript's column: `ChatFooter`
(surfaces/threads/chatSlots.tsx) lays the strip and the composer in the
scroller's gutter (16px a side plus, on the end, the scrollbar strip the
scroller reserves) and the column (`COLUMN_MAX_CLASS`, after the message
list when it sits beside), and the empty thread (surfaces/EmptySession.tsx)
uses the same gutter and column and the same class chain. The footer is the
toast anchor (lib/toastAnchor.ts), so the stack sits above the box and the
row under it alike.

`+` (chrome/ComposerBar.tsx `AddMenu`) holds Attach files, Mention a file or
thread and Skills and commands; the last two type `@` or `/` at the caret.
Send's glyph is what Enter would do: send, queue or steer, and Pause while
the box is empty mid-turn (`SendButton`).

Under the box, 4px below it, one 24px row (chrome/ComposerBar.tsx), always
there so nothing moves on focus, inset 6px as the box's own row is, so the
model's glyph sits on `+`'s axis (both centred 21px from the box's edge) and
the permission mode ends over Send: at the left the model
button, which reads the model and the effort ("Opus 5.5  High") and opens
the model menu: providers, search, the list, then the model's settings as
rows (Effort, Context, Speed only for the tiers the serving CLI lists, any
other setting). Its model rows are menu rows (`MENU_ROW` at 28px, `rounded-lg`
concentric with the 12px panel's 4px inset), and the group heading, the no-match
line and the setting rows share their 12px inset. In the Claude and Codex tabs a maker's models (Meta's, the
catalog's `vendor` rows) follow the harness's own under the maker's name in
11px muted, each row led by its 14px mark; Effort lists that row's ladder
(Minimal only on the Codex Meta rows) and a vendor row has no Context. At
the right the context meter and the permission mode as a
quiet select (none for fx). They are ghost controls in 12px
`muted-foreground` with 14px glyphs, their hover fill `foreground/5`
(`ROW_CONTROL`, chrome/composerRow.ts; ModelPicker and AccessPicker draw it
with `quiet`). A pick hands the focus back to the field; Escape or a click
outside returns it to the model button, and the permission select follows
the same rule.

A draft's first send remounts the composer in the docked footer: the new
one starts where the old box stood (a FLIP translate of the box, the row
under it and the draft row together, `--dur-slow` `--ease-drawer`; nothing
under reduced motion) with the draft row still open, then folds the row
away (`Collapsible`); a docked draft's box is already in place, so only the
row folds.

The context meter (chrome/ContextMeter.tsx) is the one place the window's
fill shows: a 24px ghost `Button` in the row under the box holding a 14px
ring (a 25% track and the filled arc in the current colour) and the percent
in 12px `tabular-nums`, muted below 85% and amber from 85%, amber on hover
too (`contextTone` in lib/contextUsage.ts; never red), the ring a 14px `Spinner` while the harness compacts, the two crossing over in one 14px box through `SwapIcon`. It draws
only for an existing thread once the harness has reported both the level
and the window (`SessionMeta.context`); Cursor reports none, so it has no
meter. Its hover says "124K of 200K tokens", or "Compacting context". A click opens
a 320px popover (a `LazyPopover`, out of the first paint) above it: "Context"
with the live total at the end, "Compacting context" with its spinner while that
runs, then the harness's categories largest first, the memory files and MCP
tools each under the category it details (at most six, largest first, then
"+N more"; a list the harness sent no category for stands after them with
its total), `Skeleton` rows until the first reading and "Breakdown after
this turn" mid-turn without one, and Compact at the foot when the thread
can (`canCompact` in lib/threadMenu.ts, the thread menu's rule). The
breakdown is `session.context` through lib/contextCache.ts, polled only
while the popover is open and the turn has settled; mid-turn the host
answers null and the last reading stays under the live total. The popover
gives the focus back to the field when it closes. No mascot runs along the
composer.

The row under the box is the `composer-bar` size container, so a narrow box
gives way in one order, by container variants and never by script: the
free space first, then the context meter's percent (under 400px; the ring
stays), then the model button's effort word (under 368px), then the
permission mode's label (under 320px, so its icon is left; its accessible
name and tooltip still say "Permission mode: <mode>"), then the model's
name, truncating and then gone under 144px so the harness icon is left.
The row never wraps. In the box, `+` and Send never shrink and the field
takes what is left; at a 220px box the row holds the model's icon and name,
the ring and the mode's icon.

Each project has one draft (lib/projectDrafts.ts), kept under the strip
order's key, so a linked project's copies share it: its text, @ chips,
attachments by path, model, effort, permission mode, type, rules and host
are remembered in localStorage (`monocode.projectDrafts`, 64 projects, 30
days) and come back when the person returns; pasted bytes live for the run
only. ⌘N, the strip's +, the rail's New chat, New thread… of any type and
Split all go to that one draft and focus its box, retyping it when a type
is asked for, text kept; a project switch with nothing to land on opens it
too, and nothing reaches the host before the first send, which clears it.
A tab holding only the draft closes when the person leaves it; a draft
beside a thread in a split stays. At boot the host archives a day-old root
thread with a placeholder title and no rows, which an older New thread…
made at the click (`archiveEmptyThreads`).

Under the row under the box, 4px below it with the same 6px inset (its
pickers' 14px glyphs on the model's and `+`'s axis), one more quiet row (`DraftRow`) holds
project, host, branch and type (chrome/ThreadTypeChip.tsx: the type's tinted
glyph 4px from its name in the row's 24px box, the select's 28px `sm`
stepped down, each item the same glyph over its hint) on the shell's
new-thread screen and until a thread's first message; an unsent chat draft
adds "Master thread" after the type (chrome/MasterCheck.tsx: a 14px
checkbox and its 12px muted words, the label the hit area with the type
chip's hover fill), whose tick creates the thread pinned as a master
(`session.create { master: true }`) and lives on the draft's record;
another type, or a thread that exists, has none. Last in the row, on a
draft of any type, "Name this thread" (chrome/DraftTitleField.tsx): one
line of at most 80 characters in the row's 12px, muted with the row's
hover fill and no border at rest, the field's ring on focus, the typed name
in the foreground, as wide as its words and the first to give way; Enter
or Escape go back to the message. The name lives on the draft's record and
the first send makes it the title (`session.create { title }`), which the
host keeps over the title it would write from the message; left empty, the
thread is named from its message as before. The field sits in the row, not
the title bar, because a workspace's strip never draws an unsent draft, so
the bar has no title there to edit;
the project picker ends in "Choose folder…", the folder dialog whose pick
becomes the draft's project. After the first message the row is gone: the
branch is changed in the Changes section's head and the type is the thread
menu's Type submenu. The goal is the thread menu's "Goal…", on every
surface and for every root claude or codex thread, answered by the app's one
dialog (`GoalDialogHost` in chrome/GoalDialog.tsx); usage and accounts are the rail's meter (A3), and
the context window is the composer's meter above.

The branch in that row (chrome/BranchPicker.tsx) is the branch's glyph and
its name in mono; a folder that is no repo reads "No repo" in sans, and the
wait for the branch is a `Skeleton` in a short name's shape, never a pill.

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
(⌘\`) and "Hide dock" (⌘J, the bottom-panel glyph, never the X a tab
closes with), both 28px. The Dev servers tab shows only when a host can serve
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
  Previous and Next), which leaves with Revert and Stage once no change is
  left to review. "Save failed" takes the one focus ring (`focus-ring`).
  There is no footer and nothing floats over the text.
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
virtualized list: *Streaming Text* (assistant deltas), *Tool Chips*
(call/result pairs), *Code Block* (shiki stays), *Approval Card*, and one
*working line* per live turn (the working mark and the shimmering words of
the phase: Sending, the host's wait, Thinking and then the thought's newest
sentence in its place, the running call), which becomes the closing line when the turn ends. A thought
is no row; a group opened by hand shows it as "Thought". The person's message is a soft
bubble on the right (`card`, 12px corners, 12/8 padding, at most 85% of the
column, no outline); the model's prose is plain text on the left at 14px on
22px lines. Column max-w-3xl (768px) centered (`COLUMN_MAX_CLASS` in
surfaces/transcriptOutlineModel.ts), the footer flush with it in every
placement (below). docs/DESIGN.md "The transcript" has the row metrics and
the gaps.

The transcript's left side lists the person's own messages
(surfaces/TranscriptOutline.tsx, rules in surfaces/transcriptOutlineModel.ts):
one 28px row per user or handoff message (a steer and an optimistic send
included; reports, nudges and notices never), its first line in 13px muted
text and its clock time ("2:32 PM", `clockTime`) at the end in 12px `tabular-nums`; a thread that
spans days heads each day with an 11px label (Today, Yesterday, Oct 30).
The message being read (the row a third of the way down the viewport; the
first at the top, the last at the end) is in foreground with
`aria-current`, nothing else. It is 208px wide, 16px from the pane's edge
and 24px before the column: from 1264px it sits in the centred column's
gutter, from 864px the column moves right to start after it (never under
600px), and under 864px or with fewer than two messages it hides. It
mounts inside the scroller as a zero-height sticky child, so a wheel over
it scrolls the thread, and caps at the viewport less 40px with its own
scroll. One tab stop; arrows and Home/End move, Enter or Space lands at
once, a click glides; "Earlier messages" heads it while older history
remains. Nothing in it animates but its fold: a 24px ghost chevron
(`DISCLOSURE_CHEVRON`, pointing down while open) sits above the rows, its
glyph on the rows' text edge, and folds the list to the chevron alone and
back; the chevron's tooltip, View → Hide Message List and ⌘⇧M do the same
in every thread of the window, which remembers the choice under one
localStorage key (lib/messageListFold.ts). The rows fade and slide 4px
toward the chevron (opacity and translate, `--dur-fast` going, `--dur-base`
coming back, a fade alone under reduced motion), then leave the tab order;
the rows ride their own chunk (`messageListChunk`,
surfaces/TranscriptOutlineList.tsx), so a list folded from launch loads
nothing until it opens, and an open one draws with the transcript, no
entry motion.
Nothing else moves: in the gutter the column is centred either way, and
beside the list the column keeps its place, so a fold never reflows the
transcript. Folded it is the chevron and nothing else: a rail of dots
would say the list a second time in a form that names nothing.

While the thread has changes nobody kept, the checkpoint strip sits on the
composer's top edge (chrome/SessionReview.tsx): one 32px row with the file's
name in sans (a name, not code), or "3 files", and its `+n −n`, which opens the diff pane, then Undo
(after a confirm naming what goes back) and Keep. With nothing to keep it is
absent. It is the one control for the host's checkpoint.

### The board views: one frame

Plan, research, project plan, implementation and master share
`SplitShell` (surfaces/threads/SplitShell.tsx): the board on the left at a
dragged split (30 to 70 %, double-click resets to 50), the chat on the
right, never under 360px beside the board (the board yields first). A
board may ask for a fitted width (`fit`, in px): it gets `min(<fit>px,
50%)` while the chat shows, until the person drags the sash, and a
double-click then goes back to the fit instead of 50; only
implementation asks today. The
transcript's prose breaks a token longer than its column (a bare URL, a
path) instead of widening it; a code block scrolls inside its own box. The board has one 36px header: a short title, one muted state line in
`tabular-nums` (its facts one comma run, "2 of 3 angles, 12 sources, 4 searches", never a middle dot or space alone), the view's
actions, and last the conversation `Toggle` (`ChatToggle`, pressed while
the chat shows). While the chat is folded and the thread is paused, the
board draws the paused row of the slot above the composer under its header
(`held`, `heldRowOf` in chatSlots.tsx: Stop, Continue, a master's "and 3
batch threads with it"), so a pause never goes out of sight; with the chat
shown the chat's own slot says it and the board draws nothing. Folding is a toggle, not a tween: the board takes the full
width at once, the chat stays mounted (`inert`, parked at its last width)
and fades back in over `--dur-fast` when shown again. The fold is
remembered per thread for the app's run (`useChatFold`, lib/chatFold.ts),
so a tab switch that unmounts a parked view keeps it; a relaunch starts on
the view's phase default, and a question waiting at a remount still opens
the chat. Each view's document
is one column, `max-w-2xl`, read as a document: 15px on 24px lines,
headings above the body (`AgentMarkdown size="document"`). A view without a board is the chat
alone, with no header.

### Planning — a document, not a conversation

The main view IS the plan file (`.temp-code/plan-<thread>.md`), rendered
as the document column and streaming as it is written. The chat sits
beside it while the plan takes shape and folds once the plan is written or
handed off; a question forces it open. Header: the plan's own `#` heading
(the thread's title until it has one; the document then starts under it,
never repeating it as its first line; a project plan keeps "Project plan")
and the task count,
which once the plan is written and settled with no build yet is the Plan
ready mark with the count as its detail;
before the handoff one primary **Start build** opens `StartBuildDialog`
(the board's add sheet's form: the goal first, prefilled from the plan,
then Build (Implement or Orchestrate), Model with its effort and Access as
label-and-control rows, the orchestration rules only for Orchestrate;
Start calls `plan.implement`, one build). After the handoff the header names the build
(the build's tinted type glyph, "Implementation" and its `StatusMark`, each
8px from the next) and
opens it. With the chat folded,
a heading outline sits at the left edge when the board leaves it room
beside the centred 672px document (a container query on the board,
`@min-[69rem]`, never the window's width); it lists the sections the page
renders, so a project plan's milestones are one entry. The frontmatter is
never a section. A task list draws its checkboxes with no bullet.

### Implementation — the tasks and the changes

```
┌ plan heading ── [plan] [planned in] [chat] ┐┃┌ chat ─────────────────────
│ Pass 1  Move the notes   1/1 +40 −12  ›     │┃│ …
│ Dec 31  Opus 5.5  High  200k  $1.20         │┃│
│                                             │┃│
│ Now make the gate run beside the build      │┃│
│ ┌ ◔ Tasks                         2/4 ⌃ ┐   │┃│
│ │ ✓ Read the brief and the board   12s │   │┃│
│ │ ✓ Measure the labels             41s │   │┃│
│ │ ◉ Fit the board column to the  1m 3s │   │┃│
│ │   widest task                        │   │┃│
│ │     ✎ Edited SplitShell.tsx  +18 −4  │   │┃│
│ │     ▸ Ran bun run typecheck          │   │┃│
│ │     ◎ Reading task-list.tsx          │   │┃│
│ │ ○ Docs                               │   │┃│
│ └──────────────────────────────────────┘   │┃│
│ ◉ Needs you  Bash: bun run gate             │┃│
│                                             │┃│
│ Changes                                     │┃│
│ Measure the labels                          │┃│
│ taskListWidth.ts               +62 −0  ›    │┃│
│                                             │┃│
│ closing report (15px)                       │┃│
│ [Start pass 3]                              │┃│
└─────────────────────────────────────────────┘┃└──────────────────────────
  the widest task, 320px to half the pane        the chat takes the rest
```

**The column fits the list.** While the chat shows, the board is as wide
as its widest task needs on one line (the card's border and inset, the
mark, the label and the widest time a row shows under an hour, "59m 59s",
so a ticking time never widens it; the header's own need is a floor),
never under 320px, never past the content's 672px and never over half the
pane; the chat takes the rest. `TaskList` measures its labels on one
offscreen canvas (lib/taskListWidth.ts) and reports before paint and again
once the fonts load; the width follows the labels only, so a task
starting, finishing or ticking never moves it, and a rewrite that changes
the widest label changes it once, without motion. Changes, past passes
and the report cut or wrap inside it. A drag on the sash sets the
person's own split (30 to 70 %) for the view's mount; a double-click goes
back to the fit. Folded, the board is the centred 672px document as
before.

The board is the pass's `TaskList`: every task one 28px line cut at the
column's edge, its whole text in a
tooltip on hover while it is cut, and the running task alone whole, in
full foreground, so when the next task starts the last one collapses to
its line and the new one opens. **The running task shows its work:** its
last three steps (`liveSteps` in implementationBoard.ts: the calls the
transcript folds into a working line (thoughts are no rows), never the todo calls
and never a waiting approval or question, which stay the Needs you line)
sit under its label, indented to it, as the transcript's own rows
(`TaskSteps` through `ActivityRow`), on the card's surface with no box of
their own; a file, a diff or an agent opens from them as in the chat.
Older steps leave the top as new ones land; the chat keeps the full
history. They open on their own when the task starts (on the layout
spring, height and opacity) and fold when it is done or the pass settles
(`--dur-slow`, `--ease-out`), the next task's opening as they fold; a
pause or a waiting approval keeps them. While they show, the running
label is their trigger, its chevron on hover, on focus and while closed;
a person's close or reopen holds for that task (the transcript's open
store). A step that lands fades in and rises 4px; nothing moves at mount;
under reduced motion the open and close are a `--dur-fast` fade. Each started task ends its row in the time
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
│ 2 working, 1 needs you, 3 done            │  │ Needs you                           │
├───────────────────────────────────────────┤  │ ⊙ Review the fold          ✳ Opus 5.5│
│ the orchestrator's transcript             │  │   Approve rm -rf build         48s │
├ composer ─────────────────────────────────┤  │ Working                             │
                                               │ ◌ Build the shell          ✳ Opus 5.5│
                                               │   Editing HomeView.swift 3/7 2m 31s│
                                               │ Done                                │
                                               │ ✓ Find the row sizes  ✳ Opus 5.5 1m│
                                               └─────────────────────────────────────┘
```

- **The thread is the chat.** Above the transcript, inset to its column,
  sits `FleetHeader` (fleet/FleetHeader.tsx): the goal (the latest user
  line) at 15px, and one 13px muted sentence under it, "2 working, 1
  watching, 1 needs you, 3 done" (`fleetSentence`), needs you in amber and
  failed in red.
  Nothing before the first agent. There is no board, no edge tab and no
  "Orchestrator log".
  Under the transcript sit the timer slot and the composer, as on any
  thread: the elapsed time and Stop mid-turn, Paused with Stop and
  Continue; while it waits on its agents the slot is empty and the
  transcript's closing line says "Watching" with the wait's age.
- **The agents are rows in the right panel's Agents section** (`FleetList`,
  fleet/AgentRow.tsx), on every thread that has subagents, in the board's
  sections with a 12px muted heading only where two meet; the glyph column
  sits 12px from the panel's edge, as the Activity section's. A live agent
  (working, waiting, failed, watching, paused, queued) is three lines,
  60px; a settled one (done, idle, stopped) two, 44px, its title muted.
  4px above and below, no gap between the lines: the 13px title on its
  20px line, the 12px lines on 16px.
  Line one: the state's glyph leading (working's spinner the row's one
  moving mark, done's check the panel's only done cue), the title in 13px
  medium across the whole line ("Subagent" when it has none; cut only at
  the row's edge, the whole of it on hover), and the host glyph (two or
  more hosts) at the line's right edge; nothing else. Line two, live rows
  only: the host's phrase while it works, else the state's word where the
  heading does not say it and what the state is about (a question or a
  failure in its tone), then the task tally ("3/7") and the time, which
  ticks only while live (`agentTime`). The last line, every row, is the
  model in 12px muted (`ModelLine`, surfaces/threads/ModelMark.tsx): the
  provider's logo, the short model, its effort in the composer's words and
  the context window ("Opus 5.5 High 1M", "Sonnet 5.5 Low 200k"; a Claude
  model that offers 1M says the thread's choice, any other its catalog
  window), each 4px from the next, only the model's name truncating; the
  role first in its tooltip, "Reviewer, Claude Opus 5.5, high effort, 1M
  context"; and on a settled row how long it ran at the line's end ("4m
  12s", "Finished 2:02 PM" on hover). On hover, after `--delay-hover`, or
  keyboard focus Open (the agent's thread) and, while a turn runs, Stop
  appear at line one's end, the line's last 72px fading out under them
  (a mask that grows over `--dur-fast`, nothing reflowing). Rows read the meta (`agentStatus`); a row loads its
  transcript only to quote a waiting agent or a failure the meta lacks.
  Nothing in the list moves.
- **A row opens the agent's detail**, a 672px Sheet from the window's
  right edge (fleet/AgentDetail.tsx, its content
  fleet/AgentDetailBody.tsx): the title, the status in full, one muted
  tabular line (the model line and host glyph, then one comma run: branch,
  +a −d, tasks, context, cost), the transcript (its skeleton while the
  sheet slides in), and a field that steers a live agent and messages a
  settled one; a send that fails keeps its words in the field and says why
  in one red 12px line under it. A spawn row in the transcript opens the
  same detail.

### Master — the project's batch

A thread whose `isMaster` flag is on routes to `MasterView` whatever its
type (CLAUDE.md "Master threads", docs/master-threads.md for the why); a
project may have any number of masters, each with its own batch, and the
tab's or the rail row's menu makes one ("Make master thread" / "Remove
as master", `session.setMaster`; disabled on an unsent draft with "Send a
message first" as its tooltip, since the host pins only a thread it knows). The board | sash | chat recipe (SplitShell):
the batch on the left, the master's own chat on the right, folding from
the toggle at the end of the view header. The board comes with the batch: it shows while the batch has a row or a step runs. Until then the master is its transcript alone, full width, with no header, sash or fold, as any thread; its thread menu's New batch thread… and Add existing thread… start the first child. A board that arrives live comes with the chat open (a fold left closed by an earlier batch is reset) and fades in over `--dur-base`, opacity only, with no width tween; one there at mount follows the remembered fold. When the batch empties (Archive all, `then: archive-children`) the board leaves in the same frame the chat takes the width, unless a step still runs, in which case it leaves when the step ends. A child of the
batch is never a tab: it lives on the board, and a click puts its full view
in the whole pane, with Back. Back returns to the board as it was left: the
split the person set (MasterView holds SplitShell's split while the child
shows), the board's scroll, and the focus on the row that opened the child,
brought into view even when it moved section meanwhile.

```
┌ iOS batch 2  1/7                                          ⋯   +   ✉ ┐
│ Needs you                                                              │
│  ☷  Live Activity strip                             ✺ Fable 5.1      │
│  ◉  Ad Hoc or Debug?                  (hover: ✉ Message  ⏸ Pause  ⋯) │
│  ☷  Inbox swipe actions                             ✺ Fable 5.1      │
│  ⓘ  Failed  Usage cap until 14:00                                     │
│ Working                                                                │
│  ☷  Home: Needs you, Working, Workspaces            ✺ Fable 5.1      │
│  ⠿  Write the project header rows                                     │
│     ██████████░░░░░░░░░░░░░░░░░░  3/7  ⌄                             │
│     ✓ Read the brief                                                   │
│     ✓ Rail rows                                                        │
│     ✓ Section headings                                                 │
│     ➜ Write the project header rows                                    │
│     ○ Tests                                                            │
│     ○ Docs                                                             │
│     ○ Look at it at 420 and 640px                                      │
│     ◉ Run the tests  Needs you  Approve Bash                           │
│     ◜ Rail rows  Working  Editing Rail.tsx                             │
│     1 done                                                             │
│  ⌕  Pricing survey                                  ◉ GPT-6.1 Sol    │
│  ⠿  Reading the third source                                          │
│  ▢  Tabs or spaces                                  ✺ Fable 5.1      │
│  ⏸  Paused  Running bun test                                          │
│ Queued                                                                 │
│  ☷  Design tokens                                   ✺ Fable 5.1      │
│  ◌  Waiting for Home                                                  │
│ Done                                                                   │
│  ☷  Design foundations                              ✺ Fable 5.1      │
│     Landed 12:08 PM                                                    │
├────────────────────────────────────────────────────────────────────────┤
│ When done                                                         Edit │
│ ✓ Land        2 of 7 landed                                     1m 30s │
│ ⠿ Gate        3 of 7, vitest                           1m 12s   ■ Stop │
│     ✓ typecheck 12s                                                    │
│     vitest  src/main/server/batch.test.ts (14 tests) 120ms             │
│ ◌ Release                                                              │
│ ◌ Deploy to the box                                                    │
│ Then notify you                                                        │
└────────────────────────────────────────────────────────────────────────┘
```

- **Insets**: every left text edge of the board (the header, the section
  headings, a row's glyph column, the foot) sits 12px from the pane, and
  every right edge (the last header control, the model mark, the tally, a
  row's hover actions, a step's time) ends 12px in; the scroller is
  `px-1 pt-1 pb-2` and a row `px-2`, so a hover fill keeps a 4px gutter.
  One type scale: 12, 13 and 14px.
- **Header**: SplitShell's 36px view header (`title`, `detail`,
  `actions`): the batch name (the master's title) in 14px semibold, then
  8px after it the batch's done tally (`doneTally`: the settled rows over
  all of them, "3/7", 12px muted and `tabular-nums`, the same count the
  rail card's master line ends in), then three equal 28px icon buttons
  2px apart, the last on the 12px right edge: ⋯ ("Batch actions"), +
  ("Add thread") and the conversation toggle. The master's summary
  (`rules.summary`) is not on the board: the rules dialog shows it and
  the master says it in its chat. The ⋯ menu is the batch's fleet switches
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
  disabled. + is a menu: New thread… (the add sheet) and Add
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
  vocabulary's words and no count, a 32px row with its words on the last
  16px and 4px under them (the first heading 24px), in this order: Needs you (waiting,
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
  `master/rowBody.ts`; each sits in its own `RowBoundary`, so a row that
  throws is a still 48px row with "Couldn't load" in 13px muted and a
  secondary Retry, and its siblings paint) is an `Item` (a `div role="button"`, `rounded-md`,
  hover `foreground/5`, no border), 48px (`py-1.5`, a 20px line and a 16px
  line, rows flush), on a 16px glyph column, and nothing on it is
  separated by a dot or a run of spaces. Line one: the type's glyph
  (`TypeGlyph`, its type's tint; its word in a tooltip and as its
  accessible name, never printed beside the title), the 13px medium title
  (muted while the row sits in Done or Queued), the host's glyph, and at
  the end the model mark: the provider's mark (12px), the model's name and
  its effort (12px muted, "Fable 5.1 High": the mark already says Claude),
  the whole model, effort and context in its tooltip ("Claude Fable 5.1,
  high effort, 1M context", `modelMarkTip`); the title gives its width up
  first, down to 64px. Line two: `StatusMark`'s glyph hangs in the glyph
  column under the type's (`threadStateOf`, an idle row being done; drawn
  for every state but done and idle), so the detail starts exactly under
  the title; working's spinner is the row's one moving mark. In the text
  column comes the state's word when the section does not say it (watching
  or paused under Working, failed under Needs you, stopped under Done),
  12px medium in its tone, then what the state is about, 12px regular:
  amber for waiting, red for failed, else muted; the task tally (`3/7`,
  12px, `tabular-nums`) ends the line once the thread has a list, except
  on a row with the task bar, which says it on the bar's line.
  The row's accessible name carries the colon form ("Working: Write the
  view", `plainStatus`). The detail: working, an implementation's task in
  hand (its `in_progress` todo), else the host's `statusDetail` or its
  activity; waiting, the open question, else "Approve" and what it was
  doing; failed, the failure; watching, what it watches (the host's
  `statusDetail`; an idle child with live subagents is watching them,
  `threadStatus`'s rule) and queued, why it waits ("Waiting for Home",
  `statusDetail`, else an old host's activity past its lead with a
  capital); paused, what it was doing; done, "Landed 12:08 PM" once the
  batch lists it, else a research or orchestration thread's summary (the
  notes' State line, else its last words). The child the batch's
  `blocked` names says why ("Ended its turn without completing",
  `blockedReason` in src/shared/batchWords.ts, given its capital). A
  detail is written as the host says it (a sentence with its capital, a
  name or a count as it is) and ends without a full stop.
  **The task bar.** An implementation or orchestration row with a task
  list (`taskBar` in master/rowBody.ts; the digest's `todos`, the tally's
  source) has a third 16px line in the title's column while it is not yet
  under Done, so the row is 64px (the board's estimate knows it before the
  measure). Once it sits under Done (finished, landed or stopped:
  `groupOf`) the line goes and the row is 48px again, like every settled
  row: its tally back at the end of line two, or none when every task is
  ticked, since Done already says so. A row that finishes on screen holds
  its open list `FOLD_HOLD_MS` (600ms) so the last tick shows, then the
  list and the line fold away together on `.collapsible-auto`, once, at
  that transition; a row that mounts finished draws neither. The line, from the column's start:
  the 4px `Progress` bar, then 8px on the tally (`3/7`, 12px muted, said
  here and nowhere else on the row) and a 12px chevron, one group. Every
  bar on the board is one width, 35% of the board pane, never under
  160px. The pane is the board's row list (MasterView's `data-board-pane`,
  the width of the scroller's content box), a size container, so the bar's
  `w-[max(160px,35cqw)]` reads the same pane on every row and follows a
  resize with no script. There is no cap: in a column too narrow for the
  bar, its tally and its chevron, the bar shrinks and they never do. The
  open list keeps the title column's width (it may be wider than the bar)
  and its rows truncate at the column's edge.
  The fill is foreground while the row's state is
  working and muted in every other state, so it never competes with an
  amber or red detail and Done stays quiet; it moves only when a task
  ticks, on Progress's own `--dur-slow` `--ease-out` slide, so working's
  spinner stays the row's one moving mark. Line two keeps the task in
  hand, said once, right above the bar. The whole line is one button
  ("Tasks: 3 of 7 done", `aria-expanded`), hover `foreground/5`; its click
  and keys stay off the row. It folds the task list open under it, open
  by default while the row is live (Working, Needs you, Queued) and closed
  under Done: `TaskRows` at its compact size (20px rows, 12px
  labels and marks, each one line cut at the column's edge with the whole
  text on hover; done ticks and strikes, the running task is foreground
  with the cursor, pending muted; no card, header, times or steps). The
  fold the thread moves (open on a new pass, folded at the finish) rides
  `.collapsible-auto`, the fold that opens on its own; a hand's move
  rides the standard Fold row (DESIGN.md); the chevron turns with either.
  The list shows every task, so nothing scrolls inside it; a tick changes
  no height, and the board's rows follow any height the fold takes
  through the virtualizer's ResizeObserver (its estimate counts an open
  list at 20px a task). The person's hand wins both ways and is
  remembered for the window's life by `<master>:<row key>`
  (master/taskFold.ts, a choice only where it differs from the default; a
  plan's row key is the plan's id, so it survives the build starting),
  through the virtualizer unmounting the row, the child pane and back, and
  a section change; never across a reload: a list closed while the thread
  works stays closed through the finish and the next pass, one opened
  while it folds away stays open with its line, and a click back to the
  default clears the choice. Planning, chat, research and project-plan rows have no bar.
  A row of a host whose link is not open sits under the offline
  tint (`opacity-50`, `data-host-offline`): its row is the launch
  mirror's and lifts when the host is back.
  Under the lines, the thread's live subagents, one 20px line each in the
  text column: `StatusMark`'s glyph with working as a dot (`still`: no
  line under a row ever spins), the title in 12px regular foreground, the state's word
  in 12px medium in its tone, what its state is about in 12px muted (the
  board row's own words, `rowStatus` from the meta) and the host's glyph;
  no role glyph (the title says the role). Its whole tree by the parentId
  chain (archived ones left out, a far child's from that host's rows in
  the store), the person's first (waiting, failed, working, then paused or
  queued, oldest first within each), at most three (`AGENT_LINES`), then
  one quiet line, "2 more, 3 done", amber when one past the cap
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
  second row. A plan that started several builds lends its row to the
  first; each later build is a row of its own under its own title, so no
  two rows share a key (a shared key kept the board's layout from
  settling, React #185, the board never painting).
- **A board that throws** outside a row (its model, the foot) is held by
  the view's own boundary: the master shows as its transcript alone, the
  chat and its composer usable, under one 24px line on the load line's
  grid, "Couldn't load the board" in 12px muted and a ghost Retry at the
  column's end, which mounts the board afresh.
- **Hover** (and focus inside the row) fades the model mark out and the
  row's actions in where it sat, three 24px ghost icon buttons 2px apart,
  centred on line one with the last 12px in, with tooltips and no box
  around them: Message (opens the thread's full view with the
  composer focused), the one verb the state calls for (Pause while a turn
  runs anywhere in its tree, Resume when paused or stopped, Start now when
  queued, which is `session.start` past `after`; nothing otherwise), and ⋯,
  the row's menu at the button. Stop, Archive and Remove from queue live in
  that menu. Every action goes to the row's own host: the commands route
  by the thread's id through the store's link for it, and a refusal, the
  verb's or Pause all's and Resume all's, is one toast ("Couldn't pause
  it" over the thread and the host's reason, lib/threadActionToast.ts).
- **Click** opens the thread's full view in the board's place
  (`master/ChildPane.tsx`, given the row's `environmentId`): the whole
  pane, board and master chat gone, becomes the thread's own view (its
  header at once, titled from the row, and the transcript's skeleton until
  the thread's rows load), the one
  its type gets as a tab (the implementation board, the plan document, the
  fleet), over its transcript, the timer slot and its held rows, and the
  composer a tab has
  (`surfaces/threadChat.tsx`, shared with SessionPane: model and reasoning,
  Fast and 1M, permission, the account chip, attachments and paste, `@`
  references, `/` skills, the queue, steer while it runs, the draft kept
  per thread, the approval and question cards in its transcript); App's
  handlers reach it through `SessionActionsContext`. A child on another
  host opens against that host the way a rail row of that host does (the
  store holds every host's rows by id, `data-child-host` names it). The
  header is 36px: Back (a ghost button whose tooltip says "Back to the
  board" with Esc) and the thread's title. A board-type child (an
  implementation, a plan, research) whose board shows draws one header,
  its view's own, with Back leading it (`useViewBack`,
  surfaces/threads/viewBack.tsx), so the title shows once; a chat child,
  and every child while its rows load, keep the pane's bar. Escape, or ⌘↩ outside the composer (inside it ⌘↩ is the composer's
  own), goes back, and the board returns at the scroll it was left at.
  The pane's right panel and the title bar's agents cue follow the child
  while it shows (its subagents, its Activity, its Notes, on its host;
  "The right side" above), and Back hands them back to the master; a
  subagent line opened the same way hands them to that subagent.
  Nothing opens a tab; the strip never lists a child while its master is
  a master (`batchHome` in lib/threadStripModel.ts).
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
  stays put under the scrolling list, always rows, on the board's 12px
  inset (`px-3 py-2`): a "When done" heading (12px medium muted) with Edit, the blocked
  line in red when a child blocks the batch's end, then one 28px row per
  step: the master's list (`rules.steps`, a `BatchStepSpec` each: id,
  name, kind, a shell step's command and cwd) joined by id with the host's
  telemetry (`state.steps`; `liveSteps`), in the state's order, a step the
  rules name that the host has not seen yet pending at the end; the
  renderer writes no step name of its own. A row is `StatusMark`'s glyph
  (`stepState`: pending queued, running working, passed done, failed
  failed, skipped idle), the name (muted while pending or skipped), what
  it is about (`stepDetail`: the land step "as they finish" or "all at
  once" until it runs, then "2 of 5 landed"; a running step its count and
  the host's label as one detail with a comma ("12 of 31, vitest");
  "Skipped" or the host's reason (a plain first word takes its capital); a
  failed step's detail in red; a settled step's detail without the time
  its time column says, and nothing for a bare "passed", which the glyph
  says), its time (12px `tabular-nums`, ticking every
  second from `startedAt` while it runs, nothing under 1.5 s, as a task's:
  `TIME_SHOWN_FROM_MS` in lib/duration.ts), and Stop on the running step
  (`batch.stopStep` with the step's id), Hide and Show on a failed one
  whose log says more than its row.
  The running step's console opens under its own row through
  `Collapsible` (the standard's fold, opacity under reduced motion),
  indented to the name: 12px mono on `card`, 60px to 176px tall, newest
  line at the bottom, following until the person scrolls up (back at the
  bottom, it follows again), "Starting…" before the first line; a shell
  step's command shows once, as its console's first line (`$ <run>`, the
  host writes it). A failed step's console stays open with its last lines
  until Hide, and keeps them while its fold closes; the failure is said once, red on its row, without a stop
  (`stepDetail`), and the console drops a last line that only
  repeats it (`consoleLines`); a log that is only that line opens no
  console (`hasConsole`). No progress bar: the row's detail
  says the count. The last line says what happens then: "Then notify you"
  or "Then archive the threads", 4px under the last step. The rows above
  paint from the session store the moment the board opens (the answer then
  overrides a row's host and status, `mergeBatchChildren`); only the foot
  waits on `batch.board`, as one `aria-busy` still `Skeleton` of the
  heading and two step rows. Nothing on the board spins while it loads. Read from the `batch.board`
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
  strip with one raised Start now; only the header strip leaves it out.
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
  Its own working subagents sit under its title, the count in medium
  weight and each live state 4px after it; each batch thread that works, waits, failed, paused or stopped is
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
