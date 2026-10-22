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

**Inbox** is the desktop's GitHub inbox over `github.inbox`, rows naming the
host when there are several; refresh by pull with `github.inboxRefresh`
(this is the one place pull-to-refresh is right, since the inbox is a poll,
not a live push). Detail: the PR or comment with the diff read-only.

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

The board is the desktop's `ImplementationView` in one column:

1. **Goal line** from the plan file when seeded, `subheadline`, dim.
2. **Passes**: one section per round that produced todos or work, numbered
   and colored with the desktop's pass colors (green, sky, violet, amber,
   rose, cyan, lime, fuchsia, by pass number), header being the user's
   request for that round, first line only, dim.
3. **Todos**: a row per todo with the status glyph (circle pending, spinner
   in progress, check completed), the content, duration in tabular digits
   when done. The running todo is the bright row; settled rows dim. Tap a row
   to expand its trace: the tool chips and quiet notes that landed while it
   was in progress, mapped by the harness's todo state as on the desktop
   (`groupByTodo`). Exactly one row expands at a time; the running row is
   open by default.
4. **Changes**: file rows as edits land, `+n −m`, grouped by todo, tap opens
   the diff. Count in the section header ticks with a numeric text
   transition.
5. **Needs you** cards inline in order.
6. **Closing report**: the agent's final markdown once all todos are
   complete, or the answer when a follow-up produced no todos.
7. **Fleet**: when the thread spawned subagents, their rows sit under the
   plan, pushing to the agent's detail.

Chat is the mechanics transcript (thinking, reads, commands, prose), the same
Chat body as above.

### Planning: the document is the hero

Segments: **Plan** and **Chat**; Chat is default until the plan file has
content, then Plan. A project-plan thread (docs/PROJECT-PLAN.md) has the
same two segments and renders its file the same way; it has no Start (its
milestones are planned one at a time from the desktop's options card). Plan renders the markdown file (`fs.read` of
`planPath`) document-first, `body` size, generous measure, streaming in as
it is written. Header action **Start** (L5) opens a sheet choosing
Implementation or Orchestration. A thread stopped on a question forces the
Chat segment with the question card in view.

### Orchestration: the fleet is the hero

Segments: **Fleet** (default once the first agent spawns) and **Log**.
Fleet: the goal line and orchestrator status, then one full-width row per
subagent: provider glyph, agent-type glyph, label, model and effort dim, the
last tool line updating in place with a 150 ms cross-fade, status (running
spinner, waiting warning, done, error), elapsed and cost in tabular digits.
Tap pushes the agent's detail: its own transcript read-only, with a
send-to-agent field in L5. A waiting agent's approval card renders in the
detail and tints its fleet row. Log is the orchestrator's own transcript.

### Research: the sources are the hero

Segments: **Sources** and **Chat**; Chat default until research activity
lands. Sources: the report pin on top (title, status, tap opens the report
markdown), then one section per angle with its queries and the sources they
surfaced streaming in beneath: favicon, title, domain dim, claim in one
line. The chat docks as the second segment and the app switches to Sources
when the report completes.

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
hairlines, small dense type, color only for meaning.

| Token | Value | Use |
| --- | --- | --- |
| Background | `systemBackground` | content |
| Chrome step | `secondarySystemBackground` | section headers, fields, the composer bar |
| Raised | `tertiarySystemBackground` (dark) / white with shadow (light) | sheets and cards that float |
| Hairline | `separator` at 1 px, inset to the text edge | rows, fields, chips |
| Text | `label`, `secondaryLabel`, `tertiaryLabel` | three steps and no more |
| Info | `systemBlue` | chat type, starting and watching dots |
| Success | `systemGreen` | implementation type, `+n`, completed |
| Warning | `systemOrange` | orchestration type, waiting, paused, needs-you tint at 8 % |
| Destructive | `systemRed` | errors, `−m`, failed tools |
| Violet | `systemPurple` | planning type |
| Cyan | `systemCyan` | research type |
| Radius | 8 pt chips and rows, 12 pt fields and cards, 16 pt sheets | outer = inner + padding, always |
| Type | `subheadline` rows, `body` transcript, `footnote` meta, `caption2` timestamps; mono one step down | Dynamic Type honored up to accessibility sizes |
| Numbers | `monospacedDigit()` on every elapsed, count and cost | nothing jitters as it ticks |

Thread type glyphs are the desktop's, in SF Symbols: chat `bubble.left`,
planning `map`, project plan `flag.checkered` (violet, like planning),
implementation `checklist`, orchestration `arrow.triangle.branch`, research
`binoculars`. Agent glyphs: orchestrator
`person.2`, implementer `wrench`, reviewer `checklist`, explorer
`magnifyingglass`. Icon stroke follows the text weight next to it; outline
default, fill marks the active state.

No shadows except on floating layers. No glows. No badges with text; dots
only, and only when they mean something. Nothing is shown twice.

## Motion

Values are exact.

| Interaction | Motion |
| --- | --- |
| Press on any row or button | scale `0.96`, 160 ms, ease-out, from pointer-down; no hover states on touch |
| Push and pop | the system navigation transition, untouched |
| Sheets | the system sheet, 16 pt radius, detents medium and large |
| Segment swipe | interactive, follows the finger, settles with the drawer curve `cubic-bezier(0.32, 0.72, 0, 1)` |
| Row expand (todo trace, tool body) | spring `duration 0.35, bounce 0`; content fades in 150 ms after the height starts; collapse 200 ms ease-out |
| Needs-you row appearing | 200 ms ease-out, opacity and 8 pt translateY; removal 150 ms opacity only |
| Last-activity line changing | 150 ms cross-fade with 2 pt blur; the row never changes height |
| Counts and elapsed | `contentTransition(.numericText())` |
| Streaming text | none; append only |
| Status dot to spinner | cross-fade 150 ms |
| Jump-to-latest pill | 150 ms opacity and 8 pt translateY, both directions |
| Reduced motion | cross-fades replace every translate and spring |

Nothing animates on first paint from cache. Nothing animates on a keyboard
action. Every animated change has a static cue as well.

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
