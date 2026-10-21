# The iOS app: design

The phone is where you check on work, answer what needs you, and steer. It
is not where you write code. Everything the desktop has (hosts, workspaces,
projects, threads active and archived, the five thread types with their own
views, the transcript, the todo board, the fleet, the plan document, the
sources board, inbox, search) is here, re-shaped for a hand-held screen and
a radio link. Terminal, editor, Aliax pages and appshots stay on the desktop.

This document fixes the decisions. Threads L3 onward build to it and do not
re-decide what is written here; what is not written here is theirs.

## Baseline: what L2 shipped and why it changes

L2's app is a stock SwiftUI skeleton: a "Hosts" root, inset grouped lists,
no workspace, no thread type, no status, generic chevrons.

| Before (L2) | After | Why |
| --- | --- | --- |
| Root screen is Hosts | Root is Home: needs-you and running threads first, then workspaces | A host is plumbing; the user picks the phone up to see work, not servers |
| Inset grouped lists (white cards on gray) | Plain lists, hairline separators, one gray step for section chrome | Cards within cards; the desktop's chrome is one gray step and hairlines |
| Thread row: title, "now", chevron | Status dot, type glyph tinted, title, project, elapsed or relative time, tasks `3/7`; no chevron | The row must say what the thread is and whether it needs you |
| No thread type anywhere | Type glyph and tint on every row and header; type decides the thread screen | Five thread types are the product |
| Transcript opens at the top, blank until scrolled | Opens at the latest row, paints from cache before the socket, "jump to latest" pill when scrolled up | Bottom is where the work is |
| User turn: 16 pt radius filled bubble, 14 pt padding | Bordered field: hairline, 12 pt radius, 12 pt padding, `secondarySystemBackground` | Desktop rule: fields, not colored bubbles; concentric radius with 8 pt inner elements |
| Tool row: inline label only | One-line chip: glyph, verb, target in mono, duration right-aligned in tabular digits; tap expands in place | Desktop Tool Chips; the mobile line has no room for more and needs no more |
| `.secondary` for every quiet text | Two steps: `secondary` for meta, `tertiary` for timestamps and dim halves of a phrase | Hierarchy by weight and color, not size |
| Default SwiftUI push for everything | Push only between levels; sheets for add, pair, new thread; context menus and swipe for row actions | Spatial consistency; CRUD never inline |

## Information architecture

```
Home                      Inbox                 Search
├ Needs you  (approvals, questions, errors, paused)        ← across all hosts
├ Running    (live threads, elapsed, current task)
└ Workspaces (per host when more than one host)
   └ Workspace
      ├ Chats (threads with no project)
      ├ Project ▸ threads (active)
      │   └ "n archived" row at the end of each project
      └ "n archived projects" row at the end
Thread (one screen, five shapes by type; subagents push from their root)
Settings (hosts, notifications, appearance) from the Home header
```

Tab bar with three tabs: Home, Inbox, Search. Settings is a button in the
Home navigation bar, as in Apple's own apps. No fourth tab for hosts.

**Hosts.** One host is the common case and must never cost a tap. With one
paired host, Home shows its workspaces directly and the host's name appears
only in Settings and in a reconnecting status line. With several, Home groups
workspaces under a host header with its connection dot, and Needs-you and
Running merge every host. Pairing lives in Settings → Hosts, by link or key,
as a sheet. An unauthorized or offline host shows one status row at the top
of Home with the action (Retry, Pair again), never a blank screen.

**Needs you** is the first section and the reason the app exists. One row per
thread that has an undecided approval, an unanswered question, an error, or
is paused: tinted warning background at 8 % like the desktop's waiting rows,
the thread title, what it needs in one line ("Approve: run bun test",
"Question: which email?"), elapsed since it started waiting. Tap opens the
thread scrolled to that card. The section is absent when empty, not an
empty state.

**Running** lists live threads: spinner, title, the current task from
`tasks.current` or `activity`, running elapsed in tabular digits. Absent
when empty.

**Workspaces** is the desktop sidebar flattened. A workspace header row
(logo from `/asset`, name, branch dim) collapses or expands, remembered.
Under it projects as section headers (name, branch dim, worktree glyph when
`mode == worktree`) with their active threads newest first, then one dim
row "3 archived" that pushes the archived list. Chats without a project sit
first under the workspace. Archived projects collapse into one dim row at
the end of the workspace. Pinned threads sort first within their project.

**Home's furniture** (Shell/HomeView.swift, HomeRows.swift, HomeStyles.swift,
HomeSlots.swift, HomeRowModels.swift; the rules in the client package's
Shell/HomeSections.swift, under Swift Testing). Home is one plain `List` of
native `Section`s under a large title that collapses; no painted header
bands. "Needs you" and "Running" are the system's prominent section headers
(`headerProminence(.increased)`, no hand-set font), 10 pt between sections.
Every row is on the kit's names: `Layout.textEdge` on both sides, `Layout.
rowHeight`, the three text steps, the motion table. A needs-you row is the
one `ThreadRow`, built by `ThreadRowModel.needsYou(item:cue:)`: the status
dot (warning, destructive or the pause mark), the type glyph, the title, the
cue as the second line ("Approve: run bun test", "Question: which email?",
"Paused", cross-fading in place), and how long it has waited as the trailing
time; the row sits on the warning tint at 8 %. Each workspace is a section
whose sticky header is the fold row: the mark at 22 pt (the repo icon in a
continuous `size / 4` corner with a hairline outline, pure black or pure
white at 10 %, else the host mark, else a folder), the name semibold, the
GitHub repo as a stamp under it, and while folded the thread count rolling
its digits; the plus trails in a 44 pt target. Tapping the row folds it (no
chevron); the rows leave on the collapse curve and return on the expand
spring, cross-fades under reduced motion. A host's loose chats are the same
header row with a `bubble.left` glyph, no fold and no plus. Projects are
sub-header rows in the flow (`meta` semibold, the worktree mark at the same
stroke, the branch tertiary truncated in the middle, the plus, and a menu
only when a slot fills it), never bands. A troubled host is one field on the
chrome step at the top (dot, name, what is happening, the Retry or Pair again
capsule), stacked at accessibility sizes. Empty states are one calm sentence
with one tinted action in a 44 pt row: "Nothing needs you right now." with
New thread when neither Needs you nor Running has a row; "No threads here
yet." with New thread in an expanded empty workspace; "No workspaces on
<host> yet…" with Hosts for a host that lists nothing (the system spinner in
a plain row until it has listed); "Nothing paired yet" with Pair a host as the
first run. Status, needs-you and host-note rows are the only rows with an
entrance (`Motion.appear`: 200 ms ease-out with 8 pt of travel in, 150 ms
out); a thread starting is routine and slides nothing; nothing animates in
the first 300 ms after the cached paint. The archived lists share the same
project sub-headers and rows, without the plus or the menu.

**Paired workspaces.** Two hosts' copies of one project (the pairing key from
`HomeSlots.pairing`: same GitHub repo, else the same folder name) are one
workspace row, listed before any host's section so it is never under one
host's name: one connection dot per member host beside the logo, the threads
of every member under it with the host's name on each project header, the
count summed, and one fold for both copies (the fold key is the pairing
key). The default pairing pairs nothing.

**Hosts on Home.** With one host there is no host header; its menu (the fleet
switches), when a slot fills it, is an `ellipsis.circle` in the navigation
bar before Settings. With several, each host's workspaces sit under a header
with the connection dot, the name, a sibling's trailing mark (the deploy
drift) and the menu. A host's one-off lines (the boot-resume note) are quiet
rows under its header with the event motion and no action.

**Home's extension points** (`HomeSlots`, one value passed from `RootView`'s
`HomeView(path: $homePath, slots: …)`; every slot optional, a nil slot draws
nothing, so no menu is ever empty): `pairing` (paired projects), `hostNotes`
and `hostMenu` and `projectBatch` (the fleet switches and the boot-resume
note), `projectSettings` (the project settings entry in the project header's
menu, after New thread and before the batch entries), `hostTrailing` (the
deploy-drift mark on the status row and the host header). Masters need no
slot: a master's row carries its word from `ThreadRow`, its batch children are
roots that Home lists through `HomeModel`, and whatever fills
`ThreadItem.children` nests under its root as subagents do.

**Thread rows** everywhere share one shape: 44 pt minimum, status dot or
spinner leading (desktop `StatusDot` colors: waiting warning, error
destructive, starting and watching info, running spinner, idle and done
none), the type glyph tinted, title in `subheadline` weight regular (semibold
while unseen), second line dim with the model and either `tasks done/total`
or the last activity, trailing relative time in `tertiary`, tabular. Subagent
rows indent one step under their root with the agent glyph. No chevrons:
every row pushes.

**Inbox** is the desktop's GitHub inbox over `github.inbox`, laid out the
way Mail lays a message out, on the kit by name. A row: the author's picture
(36 pt scaled with the title, on the fill step behind the kit's one-pixel
`hairlineBorder` at black or white 10 % so the edge reads the same on every
avatar, a letter until the picture lands, cross-faded in on `Motion.crossFade`),
the title in the title step (semibold while unread: weight is the whole
unread mark, no badge, no dot) with the time trailing as `AgoText` in the
stamp step, then a meta line: the kind glyph (`MetaGlyph`, its stroke the
title's weight), the author, the repository's name with the number dim, the
one word the item waits on in the color that means it (Changes requested
warning, Checks failing destructive, Approved success, Your review info,
Merged violet, Closed destructive for a pull request, Draft and an issue's
Closed plain), and the host's name when there are several; at accessibility
sizes two lines, who over what. Nothing else is colored. Rows sit on
`Layout.rowInsets` and the separator starts at the title. Rows sort newest
first across every host, as the desktop does, with no sections. Swipe
trailing marks read or unread (info tint; full swipe), swipe leading opens on
GitHub, and the context menu has both plus Copy Link; a mark swaps the weight
with no animation. The rules are `InboxModel` in the client package
(`Rendering/Inbox.swift`, tested); seen marks and the last snapshot of every
host live in `InboxStore` (UserDefaults and a JSON per host under Application
Support), so the tab paints at once and never flashes; the first snapshot
ever seeds everything older than a day as seen. Opening the tab reads each
host's stored snapshot (`github.inbox`, SQLite only, again after a minute)
with animations disabled; a pull is the one refresh (`github.inboxRefresh`,
since the inbox is a poll, not a live push), shows the system indicator, and
is the only time the rows reorder under the default animation. A read-only
key is known from `operateBlock` before the pull and reads the stored
snapshot instead; it, a signed-out gh and a repository that failed each get
one meta line at the top. Empty: one calm meta line, shown once every host has
answered or cannot; the system `ProgressView` until then, never on a paint
from disk.

The detail paints its header from the row (picture, author, `repo #n` dim,
the title in `title3` semibold, the state word in its color or Open in
success, `head → base` in mono one step down, labels as plain capsules on the
fill step), then the body as markdown and the conversation (comments, reviews
and review threads in time order, 24 pt pictures, the review verdict in its
color, Resolved plain, `path:line` in mono, replies one step in). A host with
no checkout of the repository says "No checkout of <repo> on <host>." and
asks nothing. For a pull request the Changes section is a count line and a
`groupCard` of rows over `InboxPatch.changes`, 44 pt each with a hairline
between: "All files" first when there are several, then one per file (the
directory dim, the name primary, in mono one step down, head-truncated) with
its `+n −m` or Binary; a row pushes the diff thread's `DiffScreen` with a
`PatchDiffRoute` of that file's slice of the patch, so the phone has one diff
screen, not two. A file whose block the host did not send is inert, and a
truncated patch ends with "The rest of the patch is on GitHub." The body and
the diff load behind a `Shimmer` of the height they will take and cross-fade
in on `Motion.crossFade` (a plain swap under reduced motion); a failed load is
one meta line with Retry. What loaded once stays in the store so going back
and in paints from memory. Open on GitHub is the bar's one button. Nothing on
either screen animates except the press, the cross-fades above and `AgoText`'s
digits.


**Search** uses `session.search` and `search.project` over every paired
host: the system field (on iOS 26 the search tab's own field, `.automatic`;
on 18 to 25 the navigation drawer, always shown), with Threads and Files
scope buttons only when an open host has an unarchived project to grep. A
query waits 250 ms after the last keystroke (a scope change runs at once;
under two characters nothing is asked), then runs on every open host at
once off the main actor, one task-group child per host; the answer
replaces the list whole inside `Motion.withoutAnimation`, so the list never
flashes to empty and two queries' rows never mix. The rows are one flat
list the client package builds (`SearchRows.build` in
`Client/SearchRows.swift`: the row model, the match ranges, the debounce
rule and the foot line, unit-tested; its body is the slot the cross-host
merge, rank, fold and typed filters land in): per thread a head row with
the type glyph at the title's weight and the title in `.title` semibold
that opens the thread, then its hits indented to the title's edge (the
glyph column and its gap, 30 pt, scaled with Dynamic Type), each the
snippet in `footnote` at label strength with the query's words one weight
up (by weight, never color: `MatchEmphasis`) and `AgoText` trailing; a hit
opens the thread at its row, a hit in the thread's notes carries a
`note.text` glyph and opens the thread at its end. In the Files scope each
project is a `SectionHeader` band, then up to 40 lines, each a file glyph,
the path with its line number dim and tabular, and the line in mono with
the match in weight; a file row, or a project row (a project matched by
name, when the selector supplies one), is a fact, not a push. The host is
a dim `.stamp` word trailing a head only when several hosts are paired,
and then a foot line names what each host took ("Mac 320 ms · box 1.2 s",
"box offline", "box failed"); "More matches than shown" closes a cut
answer. Over the empty list one calm `.meta` line: "No host is
connected.", "Every host is offline.", the hint ("Threads and project
files on every host." or "Every thread on every host."), a small spinner
while the first answer is out, or "No results for X"; Cancel clears the
field and returns to the hint. Nothing animates on a keystroke or a scope
tap; the press scale and the ticking time are the only motion. DEBUG
hooks: `TC_TEST_SEARCH` is the query, `TC_TEST_SEARCH_SCOPE=files` opens
the Files scope.

## The thread screen

One header for every type: back, title (inline rename later), a subtitle line
with the type label tinted, the model, and the elapsed running time while
live. Below the header, the type decides the body. The composer (L5) docks at
the bottom, compact, growing on focus, with the desktop's reserved 28 pt
working strip above it: spinner, flavour word, elapsed; paused shows the
warning row with Stop and Continue. The strip never changes height.

Where the desktop splits board and chat side by side, the phone uses a
segmented control under the header with two segments and a swipe between
them. The segment chosen is remembered per thread. A dot on the inactive
segment marks a new needs-you card there. The default segment is the one the
desktop makes the hero.

### Chat

The transcript is the whole body. Row kinds and their mobile form:

- **User turn**: bordered field, 12 pt radius, hairline border, attachments
  as thumbnails under the text (images) or a document line.
- **Assistant**: markdown as the page, `body` size, no container. Code
  blocks: mono one step down, horizontal scroll, a copy action in the
  context menu, never wrapped.
- **Thinking**: one folded line "Thought for 2s" with the dim-half pattern;
  tap expands; expanded text in `secondary`.
- **Tool**: the one-line chip; running shows a spinner where the duration
  will be; failed tints the glyph destructive. Expanded: input and output in
  mono, omitted bodies fetched on expand with a shimmer of the final height
  estimate, 12 pt radius, concentric with the chip's 8 pt.
- **Edits**: the file name, `+n −m` in success and destructive, tap opens the
  diff full screen (unified, mono, line numbers dim; no side-by-side on a
  phone).
- **Approval** and **question** cards: the only raised surfaces in the
  transcript, hairline border and warning tint at 8 %, actions as full-width
  buttons at the bottom (L5 makes them live; L3 and L4 render them with the
  decided state).
- **Compaction, errors, system**: one quiet line, glyph and text, errors in
  destructive.
- **Subagent spawn and report**: a row with the agent glyph, label, model,
  status; tap pushes the subagent thread.

Streaming: new text appends to the last assistant row without re-laying the
rows above; the list stays pinned to the bottom while the user is at the
bottom and shows a "Jump to latest" pill (one, 150 ms fade) once they scroll
up. Turn completion adds nothing visual beyond the strip stopping.

### Implementation: the board is the hero

Segments: **Board** (default) and **Chat**.

The board is the desktop's `ImplementationView` in one column, Reminders
meets a build log: progress visible at a glance, the current task impossible
to miss, nothing shouting. Its pieces live in
`ios/TempCode/Sources/Thread/ImplementationBoardView.swift`,
`BoardStyles.swift` (the board's metrics on `Layout`, the pass wheel's
`PassTint`, the progress line, the status glyph) and `BoardOutcomes.swift`
(the landing rows); the pure selectors in the client package's
`Rendering/Board.swift` and `Rendering/BoardSections.swift`. Every length,
step, radius and motion value is the kit's (`Layout`, `TextStep`, `Radius`,
`Motion`); the board names none of its own.

1. **Goal line** from the plan file when seeded, `subheadline`, dim. Under
   it the **progress line**: a 3 pt capsule track (`quaternarySystemFill`),
   the done share in the success tint, the task under way reaching one step
   further at the same tint at 35 %, and `2 of 5` in the stamp step beside
   it (success once complete). Never a percentage. The fill moves with the
   row-expand spring; the count rolls with `numericText` on `Motion.numeric`.
   The line reads the newest pass that had tasks.
2. **Passes**: once two passes have earned a row, a header per pass on the
   chrome step: a `Layout.dotSize` dot in the desktop's pass colour (green,
   sky, violet, amber, rose, cyan, lime, fuchsia, by pass number; `PassTint`),
   `Pass n` meta semibold, the user's request for that round (first line,
   tertiary; the first pass leaves it to the goal line), and a settled
   pass's `done/total` trailing. The current pass leaves its count to the
   progress line. A single pass has no header.
3. **Todos**: a row per todo, `Layout.rowHeight` minimum, the status glyph in
   the `Layout.glyphWidth` column (`circle` tertiary pending, the spinner
   tinted success while the thread works on it, `circle.dotted` when in
   progress but not running, `checkmark.circle.fill` success when done; the
   stroke follows the text's weight, medium on the live row), the content,
   the duration in the stamp step once done (the live row's ticks each
   second). The **running row** is the bright one: `label`, medium, on a
   field in the success tint at 6 % (`Radius.field`, inset 8 from the edge
   with 8 of padding so the glyph column still starts at `Layout.textEdge`).
   Done rows step to `secondaryLabel`, pending to `tertiaryLabel`; the colour
   change rides `Motion.crossFade`, the weight change snaps. A glyph changing
   state swaps with the kit's icon swap (scale 0.25→1, opacity 0→1, blur
   4→0, `Motion.iconSwap`; a cross-fade under reduced motion). A row with a
   trace carries a `chevron.right` (caption2 semibold, tertiary) that turns
   90° on the expand spring. Tap a row to expand its trace: the tool chips
   (the transcript's `ToolChip`, as it is) and quiet notes that landed while
   it was in progress, mapped by the harness's todo state as on the desktop
   (`groupByTodo`), inset to the text column. Exactly one row expands at a
   time; the running row is open by default, and follows the harness when
   it moves to the next todo. Expand is `Motion.expand` with the content
   fading in on `Motion.expandContent`; collapse is `Motion.collapse`.
4. **Changes**: a `Changes` section header whose count rolls (`CountText`),
   then file rows as edits land, `+n −m`, grouped by todo (the group label
   meta at `Layout.textEdge`, setup first; no labels when the pass has one
   todo), tap opens the diff.
5. **Needs you** cards inline in order, each with the row-appear transition
   inside a container that animates the list on `Motion.rowAppear`.
6. **Closing report**: a `Report` section header, then the agent's final
   markdown once all todos are complete, or the answer when a follow-up
   produced no todos.
7. **Fleet**: when the thread spawned subagents, an `Agents` header with
   the count and their rows under the plan, pushing to the agent's detail.
8. **Landing**: after Changes, the host's own lines in the order they landed
   (`OutcomeRows`; the fold keeps every notice's payload on
   `SystemLine.notice`, `Board.isOutcome` picks the ones with a gate or a
   review, `RoundData.outcomes` files them per pass). A **gate row**
   (`GateLine`, the desktop's `gateLine`): "Typecheck passed on <branch>"
   behind `checkmark.circle` in success; a failed one in the destructive
   tint with its error count or failed step, and the log's last 20 lines
   (mono caption2 on the chrome step, `Radius.row`) behind a tap on
   `Motion.expand`. A **review row** (`ReviewLine`, the desktop ReviewCard's
   lead and summary): "Reviewed by GPT-6.1 Sol" in the title step with "no
   blocking findings, 1 minor" under it, `AgoText` trailing. A held review
   sits on the needs-you field (`Radius.field`, padding 12) with the lead
   medium, its findings as plain rows under it (`file:line` mono, the
   summary meta, the failure scenario caption2 tertiary; minor ones a step
   dimmer, or folded into "and N minor" past five findings) and a Reviewer
   pill pushing to the reviewer thread. No Merge anyway on the phone: the
   override needs the approve capability and stays on the desktop.
9. **Plan line**: under the goal, "Planned in <plan title>" (`map` glyph,
   violet, meta; 30 pt in the header, a 44 pt hit area) when the host linked
   a planning thread (`planThreadId`); tap pushes it; absent when the thread
   is unknown here.
10. **Queued**: a build created behind a sibling (`after`) draws the goal
    line and one row, the queued dot with the host's "Queued · waiting for
    <sibling>" line; nothing else is drawn, never "No tasks yet".

Chat is the mechanics transcript (thinking, reads, commands, prose), the same
Chat body as above.

### Planning: the document is the hero

Segments: **Plan** and **Chat**; Chat is default until the plan file has
content, then Plan. A project-plan thread (docs/PROJECT-PLAN.md) has the
same two segments and renders its file the same way; it has no Start (its
milestones are planned one at a time from the desktop's options card). Plan
renders the markdown file (`file.read` of `planPath`, polled 1.5 s running
and 8 s idle while the screen shows) document-first, `body` size, generous
measure, streaming in as it is written. Header action **Start** (L5) opens a
sheet choosing
Implementation or Orchestration. A thread stopped on a question forces the
Chat segment with the question card in view.

The page is a set document (`PlanView.swift`, type in `PlanStyles.swift`,
blocks from the client package's `PlanDocument`), the way Notes or iA
Writer set one:

- **Type.** Headings `title.bold`, `title2.semibold`, `title3.semibold`,
  then `headline`, the large ones tracked −0.02 em of their size (−0.5,
  −0.4, −0.3, 0); 16/14/10/6 pt more space above a heading than the 12 pt
  block gap and 4 pt less below it; the document's first block takes no
  space above. Prose is `body` with 4 pt of lead; the measure is the page
  width inset 20 pt, capped at 640 pt and centered beyond it. Code is the
  page's own `PlanCodeView`: mono one step down (`callout`), never wrapped,
  no language header and no line numbers, 10 pt inside `Surface.fill` at
  half opacity in `Radius.row`, folded past 40 lines ("Show all N lines" on
  `.pressable`, the fold with `Motion.expand` / `Motion.collapse`), Copy in
  the context menu. Tables are `subheadline` with tabular digits, header
  semibold over a hairline, hairlines at 60 % between rows, none under the
  last, no vertical rules, 16 pt between columns, the first column on the
  text edge, a cell over 40 characters wrapped at 280 pt, the grid scrolling
  sideways when wider than the page. A quote is body secondary behind a
  2 pt `tertiaryLabel` bar; a rule is a `Hairline` with 6 pt each side.
- **Lists** hang: the marker sits in a 26 pt column (scaled with the
  body), the text starts after it and wraps to its own edge, each depth
  moves one column in; ordinals count per depth in tabular digits; `• ◦ ▪`
  by depth. A `[ ]` / `[x]` item carries the board's task glyph (`circle`
  tertiary, `checkmark.circle.fill` `Tint.success`) at `subheadline` on the
  first text baseline, and a done item reads secondary.
- **Streaming.** Blocks are identified by index and only ever append, each
  carrying its own space above, so new content lands below the reader and
  nothing above it moves (`PlanDocumentTests` holds the parser to it: a
  longer text keeps every block but the last); the page keeps the document
  it has while a new version parses (never a drop to plain text), and
  nothing in the page animates (`transaction` with no animation) but the
  code fold and the slot row.
- **Position.** The first visible block is remembered per host and thread
  (`plan.position.<environmentId>/<sessionId>`) and restored without
  animation on the next open; nothing is saved while the restore is on
  its way.
- **Loading.** The last text of every plan is cached on disk
  (`Caches/plans/<safe key>.md`) by the client package's `PlanPages`,
  keyed `<environmentId>/<sessionId>` so two hosts never share a slot, and
  paints before the first read answers; a plan under 6 KiB parses on its
  first paint, a longer one shows its plain text at body size until the
  parse lands. No content yet is one quiet `subheadline` line at the text
  edge ("Writing the plan…" while running, "No plan yet" idle); never a
  spinner in the page.
- **Slots.** `PlanView(sessionId:document:running:status:action:)` draws
  one row above the first block, on the text edge: the status line at the
  meta step leading, the action (a `PillButton`, or the build chip, on
  `.pressable`) trailing, both on the first text baseline, 32 pt tall at
  least with 8 pt below. The row appears with `.rowAppearTransition()`;
  the plain init draws no row at all.
- **Composition.** `PlanPage(key:text:running:cache:content:)` owns the
  scroll view, the measure, the position memory, the cache write and the
  empty line; `PlanDocumentView(document:range:)` draws a run of blocks
  with the document's indices as ids; `PlanDocument.frontmatter` and
  `.sections(level:)` cut a file with a header and fixed sections. The
  project plan view composes these.

The research report opens on the same page (`ReportScreen`), until the
research thread's own screen replaces it.

### Orchestration: the fleet is the hero

Segments: **Fleet** (default once the first agent spawns) and **Log**.
Fleet (`Thread/FleetView.swift`): the goal in `body` text, then one status
line with its mark (the orchestrator's own state while it runs, waits or
fails; else what it waits on: "Waiting on its subagents", "A subagent
needs you", "Done"; the headers carry the counts, the line never repeats
them), then the fleet in three groups under the design's section headers
with a count: **Running**, **Waiting**, **Done** (failed
agents sit first in Done with their red mark). Empty groups are left out.
Log is the orchestrator's own transcript.

The agent row (`Thread/FleetStyles.swift`, `AgentRow`), shared by the
Fleet segment, the subagent list and the implementation board's Agents
section: a 16 pt status mark (spinner running, warning dot waiting,
destructive dot failed, info dot watching, pause mark paused, a green check
settled; marks cross-fade 150 ms in a frame that never changes size), the
title in `subheadline` medium (regular and `secondary` once settled) with
the elapsed time on its line, a meta line in `footnote secondary` of the
provider's own mark drawn as a path in the text color (`ProviderGlyph`),
the role glyph, model and effort, and the worktree name when the agent
works in one; the activity line in a fixed 18 pt frame (scaled with
Dynamic Type) that swaps in place with the 150 ms cross-fade and 2 pt
blur; the stats line when there is anything to say. Elapsed over cost on
the right, `caption` tabular with `numericText`. One clock drives every
live row. A waiting row sits on the needs-you tint in an 8 pt rounded field
inset 8 pt from the edge; the text stays at the 16 pt edge. Hairlines
between rows, inset to the text edge, none after the last of a group. A
row that changes group moves with the needs-you row motion.

**Subagent list** (`Thread/SubagentListScreen.swift`,
`SubagentListScreen(client:rootSessionId:)`): the desktop's right-side
subagent panel as a screen, pushed from a thread's toolbar button. Title
"Subagents" over the thread's name, then the same grouped rows, live,
nothing to pull. Fleets of twelve read as three short lists.

**Agent detail** (`Thread/AgentDetailScreen.swift`), pushed from any
row: the title over the role in the bar; an identity strip under it with
the mark, the meta line (with the worktree), the activity line, stats,
elapsed and cost, closed by a hairline; then the agent's own transcript
(`TranscriptView`, so a waiting agent's approval or question card sits at
the end, where the screen opens, and decides from there); then one line at
the bottom, "Steer this agent…" while it runs and "Send to this agent…"
once idle, one filled send button, through `client.send`. A key that
cannot act sees the reason in the field. DEBUG hooks on the Fleet segment:
`TC_TEST_OPEN=agents` pushes the list, `agent-detail` the first agent.

### Research: the sources are the hero

Segments: **Sources** and **Chat**; Chat default until research activity
lands (a boarded source, a spawned angle or report text), then Sources; the
app switches to Sources when the report completes. Sources reads like
Safari's reading list crossed with a research notebook
(`Sources/Thread/SourcesView.swift`), every value a kit name:

- **The report pin** on top is the board's only raised surface (`.raised` at
  `Radius.field`): the `doc.text` glyph in cyan at the title's semibold, the
  title step semibold in two lines, the state line (a `Layout.dotSize` dot,
  green "Complete"; the mini spinner "In progress" while the thread runs, or
  "Complete · 2 angles still running"; a tertiary dot when stopped early;
  cross-fading on `Motion.crossFade`), the summary in two meta lines, a
  chevron. Tap opens the report full screen.
- **The coverage line** under it in meta: "15 sources · 4 searches · 2 of 3
  angles done", digits rolling with `.numeric`; spawned angles count, the
  root's own research does not. Empty when nothing has happened.
- **One section per angle** as a `SectionHeader`: the child's title (else
  the boarded label, "Direct research" for the root's own, else "Angle n");
  trailing, a mini spinner and `SwapText` Starting / Searching / Reading
  while it runs, read off its newest boarded row, or `CountText` once settled.
- **Query rows** carry the magnifier in the glyph column; their sources
  follow as `Layout.rowHeight` rows: the site's icon at `Layout.glyphWidth`
  in a continuous `size / 4` corner with a 1 px outline at 10 % black (light)
  or white (dark), a letter tile on `Surface.fill` until one process-wide
  cache loads it (a miss is remembered); the title step in one line, the
  domain as a stamp, the claim in one meta line; `Hairline(inset:)` between
  sources at the text edge; `.pressable`. **Tap** opens the page in an
  in-app Safari view (full screen, Done, cyan controls, reader off); **hold**
  previews the whole title, claim and address with Copy Link first, then
  Open in Safari and Share.
- **Arrivals**: once the first page has painted and rested 400 ms, a source
  that lands enters on `Motion.appear`; history paints in place. **Empty**:
  the `binoculars` glyph, then "Searching" with a spinner while the thread
  runs, "Loading" while history loads, else "No sources yet".

The report (`Sources/Thread/ResearchReportScreen.swift`) is a full-screen
cover set as a document at a 640 pt measure: the title once, at `title` bold
with −0.5 tracking, the state line and "· 3 sources", the summary at
`callout` as the lede over a hairline; then the body through the transcript's
`MarkdownBlocksView` after a pure citation pass (`ReportCitations.decorate`
links every `[n]` or `[n, m]` by scheme, inline code left alone; the screen
styles the runs): a resolved number is a cyan semibold superscript that opens
its page in the Safari cover, an unlisted one dim and unlinked. Numbers
resolve to the report's own Sources / References list, else to the board's
distinct urls in arrival order; a matching list renders as numbered
reading-list rows (`ReportLayout.pieces`). The document keeps streaming
while open; Done dismisses.

## Settings

Settings is the one place the app is Apple's own: a pushed, inset grouped
list, as Settings → Wi-Fi is, because the user already knows how to read it
and nothing here is the product. Rows carry no glyphs (the desktop's
settings rows carry none). Every row that needs explaining gets one sentence
of footer, never a paragraph; the app's version and contract close the
screen, dim and centred, so a screenshot answers "which build". Section
headers are the system inset grouped headers, not `GroupHeader`: that one
is for a hand-built card on a plain background, and the brief here is
"indistinguishable from Apple's Settings". Rows keep the system highlight;
nothing in a grouped list scales on press (Apple's Settings never does, and
a scale fights the swipe actions). The screens hold only SwiftUI; every
word they say (the connection word, the fix per state, the build line, the
push word, the capability titles) and the forget flow are the client
package's `Shell/HostPresentation.swift`, where they have tests.

- **Hosts** pushes the list; the row's trailing half is one connection dot
  per host and the single host's name, or the count (stacked under the
  label at accessibility sizes).
- **Notifications** is one row: the switch with the registrar's word beside
  it ("Off", "On", "Registering…", "No relay", "Failed", "Not allowed"). The
  switch moves at once and holds its position while the permission prompt
  and the hosts answer; the word cross-fades 150 ms. When the phone refused
  permission an "Allow in Settings" row opens the system Settings. The footer
  names what stands in the way.
- **Appearance** is the inline picker with checkmarks: System, Light, Dark.
  A theme flip snaps; nothing animates it.

**Hosts.** One row per paired host: the connection dot leading in the mark
column (`Layout.markWidth`), the name, a second line in the meta step (the
address while connected, else what is wrong in two words: "Connecting…",
"Unreachable", "Reconnecting…", "Offline", "Different host", "Needs an
update", "Key refused", "Paused"), and the environment id abbreviated
(`env_AbCd…StUv`) trailing in mono `caption`, `tertiary` (an id must stay
legible; the stamp step's `caption2` is under the floor for eight glyphs of
mono). The second line is destructive only when the state waits on the
person: Key refused, Different host, Needs an update (`HostFix.waitsOnUser`).
Offline, Unreachable, Connecting and Reconnecting are the phone's to fix
and stay `secondary`. The second line swaps in place with
`.swapTransition()` (150 ms, opacity and 2 pt of blur; opacity alone under
reduced motion). Swipe and long press offer Pair Again and Forget; every row
pushes the detail through the stack's `NavigationPath`, and the proof's
`TC_TEST_OPEN=host` hook appends the same `HostDetailRoute` to that path,
so the bar's title is the host's name on either path with no principal item.

**Host detail.** Five sections, in this order:

1. **Status**: the dot, the live `StatusText` with its countdown, a spinner
   while connecting; under it the one action that fixes the state (Retry Now
   when the host is out of reach, Pair Again when the key was refused or the
   address answers as another host, nothing when the host needs an update
   the phone cannot do); the footer says why.
2. **Activity**: what the host is doing. Thread 21 fills it with one line,
   `HostActivitySections(client:)`, a view of its own under `Shell/Hosts/`
   whose body is one or more `Section`s (deploy drift, the Mac bridge's
   running and held calls, the devices, the harness and memory sync lines,
   a running deploy's log). Empty until it lands.
3. **Key**: Read, Operate, Approve, Admin, each with one line of what it
   allows and a checkmark in the tint when the key has it; the footer says
   a new key on the host is how to change it.
4. **Host**: Name (editable in place), Address, Environment id in mono
   (selectable), Version as `1.0.N · <sha7>` from the hello's `build`
   (`HostBuildLine`; the version alone without a commit; no row for a host
   that sent none), Contract from the last hello, Notifications for this
   host, the pairing date.
5. **Pair Again** and the red **Forget This Host**.

Forgetting is a confirmation dialog naming the host. `forgetHost` first
sends `remote.push.unregister` on the host while the socket is open (best
effort, so a forgotten host stops sending notices whose tap would land on an
environment the phone no longer knows), then removes the key, stops the
socket and clears the cache. The message says what holds: the threads stay
on the host, it stops sending notifications here when it can be reached, and
the key stays valid there until revoked.

**Pairing** (Add a Host, Pair Again) is a medium sheet, 16 pt radius
(`Radius.sheet`), with the large detent for the keyboard: a segmented
Pairing Link / Key, the field with a paste button at its trailing edge while
empty (a pasted link that reads cleanly is redeemed at once; a typed one is
recognised, the footer naming the host it pairs with, and submitted with
Return or Add), an optional name, and the refusal under the field inside the
same card, footnote in destructive with the `exclamationmark.circle` glyph
at the same weight, arriving with `.rowAppearTransition()` (200 ms, 8 pt of
travel) and leaving 150 ms when typing resumes. Never an alert. Add swaps
for a spinner with a 150 ms cross-fade; a success haptic and the sheet
dismisses with the host already in the list; an error haptic on a refusal.
The first field takes the keyboard once the sheet has settled (350 ms), with
no animation.

Nothing here needs more than a `read` key: `remote.push.*` are `read`,
pairing is `POST /api/pair`, forgetting is local. The Key section is where
a person learns why a control elsewhere is disabled.

## Visual system

Everything maps to the desktop's `DESIGN.md`: quiet chrome, one gray step,
hairlines, small dense type, color only for meaning. The kit that carries it
is `ios/TempCode/Sources/Design/` (the views) and the client package's
`Sources/TempCodeClient/Design/` (the pure logic: `TimeFormat`, `ModelName`,
`CompactNumber`, `ThreadRowModel`, unit-tested there with Swift Testing);
every screen names its helpers and never a raw color, radius, font step,
inset or duration. A sibling that needs a shared piece the kit lacks builds
it in its own area on these names.

| Token | Value | Use | Helper |
| --- | --- | --- | --- |
| Background | `systemBackground` | content | `Surface.background` |
| Chrome step | `secondarySystemBackground` | section headers, fields, the composer bar | `Surface.chrome` |
| Raised | `tertiarySystemBackground`; in light mode two soft shadows with an offset (black 6 % r 1 y 1, black 8 % r 12 y 4), in dark the ring only | sheets and cards that float | `Surface.raised`, `.raised(radius:)` |
| Fill | `tertiarySystemFill` | what a chip or pill sits on | `Surface.fill` |
| Hairline | `separator` at 1 px, inset to the text edge | rows, fields, chips | `Hairline(inset:)`, `.hairlineBorder(shape)`, `.separatorAtTextEdge()` |
| Text | `label`, `secondaryLabel`, `tertiaryLabel` | three steps and no more; a tint replaces the color alone | `.textStep(.title / .meta / .stamp, weight:, tint:)` |
| Info | `systemBlue` | chat type, starting and watching dots | `Tint.info` |
| Success | `systemGreen` | implementation type, `+n`, completed | `Tint.success` |
| Warning | `systemOrange` | orchestration type, waiting, paused, needs-you tint at 8 % | `Tint.warning`, `Surface.needsYou` |
| Destructive | `systemRed` | errors, `−m`, failed tools, a failure summary | `Tint.destructive` |
| Violet | `systemPurple` | planning and project-plan types | `Tint.violet` |
| Cyan | `systemCyan` | research type | `Tint.cyan` |
| Quiet | `systemGray2` | a state with no urgency: the queued dot, the stopped square | `Tint.quiet` |
| Radius | 8 pt chips and rows, 12 pt fields and cards, 16 pt sheets | outer = inner + padding, always | `Radius.row / .field / .sheet`, `Radius.around(inner, padding:)`, `Radius.inside(outer, padding:)`, `.rowCorner / .fieldCorner / .sheetCorner` (continuous) |
| Type | `subheadline` rows, `body` transcript, `footnote` meta, `caption2` timestamps; mono one step down | Dynamic Type honored up to accessibility sizes | `TextStep.title` (subheadline, label), `.meta` (footnote, secondary), `.stamp` (caption2, tertiary, tabular) |
| Numbers | `monospacedDigit()` on every elapsed, count and cost | nothing jitters as it ticks | `.numeric(value)`, `CountText`, `ElapsedText`, `AgoText` |
| Lengths | 16 pt text edge, 44 pt rows with 6 pt vertical padding, 10 pt gaps, 14 pt mark, 7 pt dot, 20 pt glyph, 16 pt subagent indent, 6 pt before a title's tag | rows, headers and separators meet on the same edges | `Layout.textEdge / .rowHeight / .rowVertical / .rowGap / .markWidth / .dotSize / .glyphWidth / .indent / .tagGap / .rowTextEdge / .rowInsets` |

Thread type glyphs are the desktop's, in SF Symbols: chat `bubble.left`,
planning `map`, project plan `flag.checkered` (violet, like planning),
implementation `checklist`, orchestration `arrow.triangle.branch`, research
`binoculars`. Agent glyphs: orchestrator
`person.2`, implementer `wrench`, reviewer `checklist`, explorer
`magnifyingglass`. Icon stroke follows the text weight next to it (the
symbol weight is the stroke: `TypeGlyph(type:weight:)`, `AgentGlyph(type:weight:)`,
`MetaGlyph(_:weight:)`, `HostMark(host:weight:)` draws 1.5 beside regular and 2
beside semibold); outline default, fill marks the active state
(`TypeGlyph(active: true)` cross-fades to `ThreadType.filledSymbol`).

The status mark (`StatusDot(status:running:weight:)`) leads every row in a
14 pt column that scales with the title; the marks cross-fade and the column
never moves. Each is a static cue VoiceOver reads; an empty column is hidden
from it.

| Status | Mark | VoiceOver |
| --- | --- | --- |
| `running`, or a settled root whose subagents still work (`running: true`) | the mini spinner | Running |
| `starting`, `watching` | dot, `Tint.info` | Starting, Watching |
| `waiting` | dot, `Tint.warning` | Needs you |
| `error` | dot, `Tint.destructive` | Failed |
| `paused` | `pause.fill` at the title's weight, `Tint.warning` | Paused |
| `stopped` | a 6 pt continuous square, `Tint.quiet` | Stopped |
| `queued` | dot, `Tint.quiet` | Queued |
| `idle`, `done` | nothing | |

The row: `ThreadRow(row: ThreadRowModel)` is the one list row (44 pt,
`StatusDot`, the glyph at the title's weight, the title semibold while
unseen, `ThreadRowSecondLine`, `ThreadRowTime` trailing);
`.threadRowActions(client:meta:)` adds pin, archive and rename. The model
(`ThreadRowModel(session:unseen:)`, in the package) decides what the row
says: after the title, one muted word (`tag`, "Master" for a pinned master,
never truncated); the second line opens with `model` and then shows, in
order of precedence, the host's `failure.summary` in destructive, the tasks
("3/7 Writing tests"), the last activity (the host writes "Queued · waiting
for X" there), or nothing at the same height. Two slots keep siblings out of
the kit: `ThreadRow(row:) { accessory }` places a view between the second
line and the pin (an account mark: thread 24), and `.threadRowActions(client:
meta:) { menu }` places rows after Pin and before Archive (Start now, Resume:
thread 20). A sibling that composes the model fills `model`, `detail` or
`tag` and never parses them back. Section chrome: `SectionHeader` is the
band on the chrome step for long lists (Home, Search, the archive);
`GroupHeader` sits above an inset card (`.groupCard()`) on screens that are
a few short groups (Settings, sheets, a detail); inside a `List`, use
`.listStyle(.insetGrouped)` with `Section` instead. Small actions:
`PillButton(title, systemImage:, tint:)` in a row (a 28 pt capsule with a
44 pt hit area), `WideButton(title, prominent:)` at the foot of a sheet or
card.

No shadows except on floating layers (`.raised()` adds two in light mode,
both with an offset). No glows. No badges with text; dots only, and only when
they mean something. Nothing is shown twice.

## Motion

Values are exact, and each row has a name in `Motion` (Design/Motion.swift)
so a screen references the name, never the number. Every "ease-out" below
is the desktop's `EASE_OUT` (lib/ease.ts), `cubic-bezier(0.16, 1, 0.3, 1)`,
behind one private `Motion.out(seconds)`; SwiftUI's `.easeOut` is never
used.

| Interaction | Motion | Name |
| --- | --- | --- |
| Press on any row or button | scale `0.96`, 160 ms, ease-out, from pointer-down; no hover states on touch; reduced motion dims to 60 % instead | `.buttonStyle(.pressable)` (`Motion.press`, `Motion.pressScale`, `Motion.pressDim`); `.pressableStatic` dims without scaling where a scale would fight a swipe |
| Push and pop | the system navigation transition, untouched | |
| Sheets | the system sheet, 16 pt radius, detents medium and large | `Radius.sheet` |
| Segment swipe | interactive, follows the finger, settles with the drawer curve `cubic-bezier(0.32, 0.72, 0, 1)` | `Motion.drawer` |
| Row expand (todo trace, tool body) | spring `duration 0.35, bounce 0`; content fades in 150 ms after the height starts; collapse 200 ms ease-out | `Motion.expand`, `Motion.expandContent`, `Motion.collapse` |
| Needs-you row appearing | 200 ms ease-out, opacity and 8 pt translateY; removal 150 ms opacity only | `.rowAppearTransition()` (`Motion.appear(reduced:)`, `Motion.rowAppear`, `Motion.rowLeave`, `Motion.travel`) |
| Last-activity line changing | 150 ms cross-fade with 2 pt blur; the row never changes height | `SwapText`, `.swapTransition()` (`Motion.swap(reduced:)`, `Motion.crossFade`, `Motion.crossFadeBlur`) |
| Counts and elapsed | `contentTransition(.numericText())` on 150 ms | `.numeric(value)` (`Motion.numeric`), `CountText`, `ElapsedText`, `AgoText` |
| Streaming text | none; append only | |
| Status dot to spinner | cross-fade 150 ms | `StatusDot` (`Motion.crossFade`) |
| A glyph trading state (Send ↔ Stop, outline ↔ fill, pin ↔ unpin) | scale 0.25 → 1, opacity 0 → 1, blur 4 → 0, spring `duration 0.3, bounce 0`; reduced motion: opacity on `cubic-bezier(0.2, 0, 0, 1)` 150 ms | `.iconSwapTransition()` with `.id(symbol)` in a `ZStack` (`Motion.iconSwap(reduced:)`, `Motion.iconSwap`, `Motion.iconSwapScale`, `Motion.iconSwapBlur`, `Motion.iconFade`); `TypeGlyph(active:)` uses the symbol replace effect instead, since Glyphs builds without Motion |
| Jump-to-latest pill | 150 ms opacity and 8 pt translateY, both directions | `.jumpTransition()` (`Motion.jump(reduced:)`) |
| Reduced motion | cross-fades replace every translate and spring | every `Motion.*(reduced:)` and the four transition modifiers read it themselves |

Every transition carries its own timing, so an enclosing `withAnimation`
cannot stretch it. Nothing animates on first paint from cache
(`Motion.withoutAnimation {}` around the paint). Nothing animates on a
keyboard action. Every animated change has a static cue as well.

## Performance

- **Paint from disk.** The cache holds workspaces, projects, sessions, the
  last 75 rows per thread and expanded bodies. Home and any thread the user
  has opened paint from the cache before the socket is open; the socket's
  catch-up applies as a diff, never a reload.
- **Rows are the unit.** Lists are `List` or `LazyVStack` with stable
  identities by `seq`; a streaming assistant row updates its own text only.
  Markdown is parsed off the main actor into `AttributedString` once per
  row version and cached by `seq` and text hash.
- **Bodies on demand.** Omitted bodies (over 2 KiB) are fetched when a chip
  expands and cached; a diff is fetched when opened.
- **Budget.** A cold thread open is 75 rows, one page back on scroll to the
  top. The row count, not turns, bounds every window.
- **Images** go through `/asset` with the system URL cache and a memory
  cost cap; thumbnails are decoded at display size.
- **Nothing on the main actor waits on the network.** Every RPC is an async
  call off a detached task; the UI reads the observable models only.
- **Background.** The socket closes after the 10 s grace and the app paints
  from cache on return while the probe runs; a probe within 1.5 s changes
  nothing on screen.
- **Measure.** Scroll a 2,000-row thread at 120 Hz with the Instruments
  animation hitch template; a hitch over 8 ms in the transcript is a bug.

## Threads from here

| Thread | Scope | After |
| --- | --- | --- |
| L3 shell | tokens, type glyphs, Home with Needs you, Running, Workspaces, archived rows, host grouping and status row, Inbox, Search, Settings with Hosts; thread rows; read-only | now |
| L4 thread screens | the header, segments, Chat transcript rules, Implementation board, Plan document, Fleet, Sources, diff screen; the cache paint, markdown cache and 120 Hz proof; read-only | now, in parallel with L3 |
| L5 actions | composer and working strip, send and stop, approve and answer, start a build from a plan, new thread sheet, send-to-agent, swipe archive and pin, rename, pairing | L3 and L4 |
| L6 push | APNs through the hub (the phone's token registered with every host, the host's `apns` subscription, the hub's token-auth delivery), Live Activity for a running thread (the strip on the lock screen and in the Dynamic Island, pushed by the host, ended when the thread settles), notification taps landing on the card, one Notifications row in Settings, the device build | landed 2026-10-20; the live pass needs the team id and the APNs key from the developer account |

L3 owns `ios/TempCode/Sources/Design/` and `Sources/Shell/`; L4 owns
`Sources/Thread/` and the rendering models in `TempCodeClient`. L3 commits
`Design/` first so L4 can build on it; until then L4 works in the client
package.
