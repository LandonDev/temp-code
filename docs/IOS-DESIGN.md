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

**Thread rows** everywhere share one shape: 44 pt minimum, status dot or
spinner leading (desktop `StatusDot` colors: waiting warning, error
destructive, starting and watching info, running spinner, idle and done
none), the type glyph tinted, title in `subheadline` weight regular (semibold
while unseen), second line dim with the model and either `tasks done/total`
or the last activity, trailing relative time in `tertiary`, tabular. Subagent
rows indent one step under their root with the agent glyph. No chevrons:
every row pushes.

**Inbox** is the desktop's GitHub inbox over `github.inbox`, laid out the
way Mail lays a message out. A row: the author's picture (36 pt, a 1 pt
outline at black or white 10 % so the edge reads the same on every avatar,
a letter until the picture lands, cross-faded in 150 ms), the title in
`subheadline` (semibold while unread: weight is the whole unread mark, no
badge, no dot) with the time trailing in tabular `caption` tertiary, then a
`footnote` line: the kind glyph, the author, the repository's name with the
number dim, the one word the item waits on in the color that means it
(Changes requested warning, Checks failing destructive, Approved success,
Your review info, Merged violet, Closed destructive for a pull request,
Draft and an issue's Closed plain), and the host's name when there are
several. Nothing else is colored. Rows sort newest first across every host,
as the desktop does, with no sections. Swipe trailing marks read or unread
(info tint; full swipe), swipe leading opens on GitHub, and the context menu
has both plus Copy Link. Seen marks and the last snapshot of every host live
in `InboxStore` (UserDefaults and a JSON per host under Application
Support), so the tab paints at once and never flashes; the first snapshot
ever seeds everything older than a day as seen. Opening the tab reads each
host's stored snapshot (`github.inbox`, SQLite only, again after a minute)
with animations disabled; a pull is the one refresh (`github.inboxRefresh`,
since the inbox is a poll, not a live push), shows the system indicator, and
is the only time the rows reorder under the default animation. A key that
cannot refresh gets one footnote line at the top, as do a signed-out gh and a
repository that failed. Empty: one calm secondary line, shown only once every
host has answered or cannot.

The detail paints its header from the row (picture, author, `repo #n` dim,
the title in `title3` semibold, the state word in its color, `head → base`
in mono one step down, labels as plain capsules with no color), then the
body as markdown, the conversation (comments, reviews and review threads in
time order, 24 pt pictures, the review verdict in its color, Resolved plain,
`path:line` in mono, replies one step in) and for a pull request the patch by
file and hunk: one fold per file on the chrome step with its `+n −m`, the
first open, dim tabular line numbers and a tinted marker in `footnote` mono
(adds success at 12 %, deletes destructive at 12 %), hunk headers in
`caption` mono on the quaternary fill, never side by side, long lines
scrolling sideways inside the file, 2,000 lines before Show all. What loaded
once stays in the store so going back and in paints from memory. Open on
GitHub is the bar's one button. Nothing on either screen animates except
the fold (the expand spring) and the press.

**Search** uses `session.search` and `search.project`: a search field at the
top, results grouped by thread with the matching row quoted, tap lands on
the row.

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
content, then Plan. Plan renders the markdown file (`fs.read` of
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
planning `map`, implementation `checklist`, orchestration
`arrow.triangle.branch`, research `binoculars`. Agent glyphs: orchestrator
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
