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

**Project settings.** The project header's menu opens the sheet
(`Shell/ProjectSettingsSheet.swift`, presented from the root through
`ProjectSettingsPresenter`, since a sheet on a menu item never shows) at the
large detent with the sheet radius: an inset grouped list, three sections,
one sentence of footer each, one Save top right that sends only the dirty
set (review before plans) and is disabled until something changed; a
failed save is one destructive line in the footer of the section that
failed. **Preamble** has two rows that push the editor
(`Shell/PreambleEditor.swift`): "Project rules" with its word count ("212
words", "Off", "Workspace default · 80 words", "None") and "Workspace
default". The editor is its own screen: Edit and Preview segments in the
bar, the whole height for the text (the desktop's three placeholder lines
while empty), the preview rendered with `{{project}}`, `{{host}}` and
`{{worktree}}` substituted (the host's name, the project's name and its
slug), a panel on the chrome step at the bottom with the "Apply to new
threads" switch and the live word count rolling beside it, "Use workspace
default" when the project has text of its own, the variables in code, and
its own Save. **Reviews** and **Plans** (`Shell/ReviewSettings.swift`,
`Shell/PlanSettings.swift`) follow the global set until a field changes;
the footer's second sentence says which ("Following the global setting.",
"Built-in defaults.", "This project's own setting.") and "Use global
setting" appears only while overriding. The reviewer picker lists Codex and
Claude from the catalog filtered by the host's orchestration rules, the set's
own model kept first as "(not approved)" when the rules no longer approve
it; the time limit is a menu of presets with the current value folded in.
A key without admin sees every control disabled and one footnote at the top
("This key can read these settings but not change them"); the editor opens
read-only with the same line. The drafts and words are the client package's
`Client/ProjectSettings.swift`, under Swift Testing.

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

**The fleet switches** (ios/TempCode/Sources/Shell/FleetSwitches.swift over
the client package's ThreadBatch.swift, the desktop's threadBatch.ts ported
whole) are four rows beside Mark all read: Pause all, Resume all, Stop all,
Archive done, in the host's menu (the `ellipsis.circle` in Home's bar with
one host, on each host header with several) and in the project header's
menu, and again in a thread's menu for its project. A row with nothing to
act on is disabled, never hidden; a key that cannot act reads the reason as
the menu's first line. Pause, Stop and Archive done confirm in a medium
sheet whose title is the live count ("Pause 15 running threads on the
box?", the digits rolling as threads settle while it shows), with the
resources clause and its switch when Archive done would release worktrees
or simulators, and one full-width confirm at the foot (destructive tint for
Stop and Archive done). Resume all runs at once. The outcome is one status
line on the bar material above the tab bar, "Paused 14 · 1 failed: Search
(harness not responding)": a clean result leaves after four seconds, a
failure waits for a tap.

**Queued, stopped, resources.** A queued root (created, waiting for its
`after` sibling) reads the host's "Queued · waiting for X" line through its
`activity`, never sits under Running, and offers Start now in its context
menu and in the working strip (`session.start`, past the `after`); a
stopped root (its harness gone after a restart) reads "Stopped · the
harness is gone" in the strip with Resume (`session.resume`, a fresh
harness on the transcript). A paused master's strip says ", and 2 batch
threads with it". A host that resumed threads after a restart shows "7
threads resumed after restart" once per boot as one quiet line at the top
of Home for fifteen seconds. Resources… in a thread's menu opens the
Resources sheet (ios/TempCode/Sources/Thread/ResourcesSheet.swift): one
group per host the rows live on, each row the label, its path or UDID in
mono, the state word, and Remove (a spinner while the removal is out,
"Waiting for the Mac" when that host is offline); the row leaves when the
host's push says it is gone. Archiving a thread that holds resources, from
a swipe, a context menu or the thread menu, asks first: "Archive <title>?"
with "and remove 2 resources on the Mac" switched on by default.

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
Every paired host is asked at once and rows land per host as it answers
(`CrossHostSearch.run` in `Client/CrossHostSearch.swift`, an `AsyncStream`
of answers the screen writes inside `Motion.withoutAnimation`; the previous
answer stays until the first batch lands, and stable row ids keep an
unchanged row in place while a second host's rows insert). The ranking is
by the hosts' bm25 rank and recency, never by host: thread groups by their
best hit, then the app's notes, then file groups by newest mtime, then
projects by name. A thread's working notes are hits under its head (the
`note.text` glyph, `seq` nil) and the app's notes (`notes.search`) are note
rows (`NoteRow`: the glyph, the title, the snippet with the match in weight,
the host trailing when several; a fact, not a button). The same file in two
copies of a paired project (`ProjectPairs` over every host's workspaces,
through `CrossHostSearch.pairLookup`) is one row on the newer copy, "· newer"
after its line number, the other hosts in the accessibility label. `host:` (a name,
an id, or `mac`), `type:` (thread, file, note, project; it wins over the
scope buttons) and `project:` are typed in the box; the foot names each host
with its time, "…" while it is still answering, offline or failed.

## The thread screen

One header for every type, the way Messages and Notes title a screen: back,
the title inline, and under it one quiet line read off `ThreadHeaderLine`
(client package, `Rendering/ThreadFrame.swift`): the status mark, the type
label tinted (a subagent's role instead; "Master" first on a master), the
model, and the elapsed ticking once a second in tabular digits while the
thread is live. The host's name leads that line, in the tertiary step, only
when more than one host is paired; the line drops the host, then compacts
to type · model (or the one word "Queued" / "Stopped"), before the title
truncates. The mark and the words by status:

| status | mark | after the host |
| --- | --- | --- |
| running, starting | spinner | type · model · elapsed |
| watching | info dot, still live | type · model · elapsed |
| waiting | warning dot | type · model |
| error | destructive dot | type · model |
| paused | pause mark | type · model · the frozen elapsed |
| queued | quiet dot | the host's "Queued · waiting for X" line, else "Queued" |
| stopped | the still square | "Stopped · the harness is gone" |
| idle, done | none (the line stays centered) | type · model |

An idle root whose subagents still work shows the spinner with no elapsed:
the time is the child's. Long-press on the header, or Rename… in the menu,
swaps the title for a field in place; Done or losing focus commits a
changed, non-empty title and anything else reverts; the trailing toolbar
group hides while the field is up so it gets the width. A key that cannot
operate never opens the field: it sees the reason in the "Couldn't do that"
alert. The title and the mark cross-fade when they change; nothing animates
on the first paint.

The toolbar's trailing group, left to right: **Start** or **Build** on a
planning root (Build once the host linked a build to the plan), the agent
glyph `person.2` with the running count beside it (shown when the thread
has unarchived children and no Fleet segment lists them already; it pushes
the subagent list), and the ellipsis menu last. The menu, in order: the
reason a lesser key cannot act (first, when there is one), Rename…, Pin
(roots), a divider, Archive (roots, destructive). A subagent's menu has the
reason and Rename only.

Below the header, the type decides the body. The composer (L5) docks at the
bottom, compact, growing on focus, with the desktop's reserved 28 pt working
strip above it: spinner, flavour word, elapsed; paused shows the warning row
with Stop and Continue. The strip never changes height. The header's elapsed
and the strip's answer different questions (the thread, still live; this
turn's phase) and the header never carries the flavour word.

### The composer, the strip, the cards' actions, the sheets

The composer is Messages' at its best (`Thread/Composer.swift`,
`Thread/ComposerStyles.swift`): one 12 pt continuous field on the chrome
step with a 1 px hairline, 36 pt for one line of `body`, growing with the
text to five lines and scrolling past that, and never changing height on
focus. The send button sits inside the field at the trailing edge, a 28 pt
circle 4 pt from the field's edge, on the last line while the text grows.
It fills in the accent only once there is text (the fill and glyph color
cross-fade in 150 ms; empty it is the fill step with the arrow in the
tertiary label) and becomes Stop, filled in the label color, while a turn
runs and the box is empty: the glyphs trade places with the kit's icon
swap (scale, opacity and blur on a 300 ms spring, a 150 ms fade under
reduced motion) and the circle never moves. A watching master is not running
(its button is Send), and a master mid-turn with text sends: the host
whispers the text into the live turn as a steer, so the button is never
Stop while there is text. The desktop's composer has no confirm on Stop,
so neither does the phone. The field's placeholder is "Steer" for a root
implementation or orchestration thread or a master of any type, "Message
the agent" for a subagent, "Message" otherwise. On focus a chip row appears
above the field (200 ms ease-out, the row's 8 pt of travel and fade; it
leaves in 150 ms by fade alone): the model and, for a model with levels,
the reasoning, each a 26 pt chip at the row radius on the fill step opening
a menu over the host's catalog (`catalog.get`, the same list the desktop's
picker shows, one section per provider with a check on the current model).
A pick rides on the next send as `session.send`'s `provider`, `model` and
`reasoning` (`TurnModel.override` sends nothing when the chips match the
thread) and the chips follow the thread's model again once it lands. A read
key, a halted host or a dropped link (after the desktop's 1.5 s grace) puts
the reason in the field in place of the placeholder; the field is off and
the button sits empty. A light impact on send and on a decision, never on
typing; the field clears without animation. The list behind it dismisses
the keyboard interactively.

Photos (`Thread/ComposerAttachments.swift`): a 28 pt plus circle on the
fill step beside the field, for a key that operates, opens the system
photo picker, up to four per turn. Each photo goes up to the thread's host
the moment it is picked (`attachment.begin`, one chunk at a time, `commit`;
the client package's `upload`) and shows in a strip above the field: a
56 pt thumbnail at the row radius with a 10 % outline, a 2 pt bar in the
accent along its foot while it travels (its width rolls on the 150 ms
numeric curve), gone once the host has it, and a remove control at the top
trailing corner. A failed upload keeps its chip with the bar in the
destructive tint and Retry in its menu; Send waits until every photo is on
the host or removed (Stop never waits). The turn names the committed
photos, and a refused send gives the text and the photos back.

The working strip (`Thread/WorkingStrip.swift`) keeps one height whatever
it shows, 28 pt at the default text size and scaled once with it, never
animated, and sits 24 pt in from the screen edge (12 of bar, 12 of line;
the field's own text inset). Six phases, from the status and whether a
send of this device's is out (`WorkingPhase` in the client package):
nothing while idle, waiting, watching or done (the card, the segment dot
and Home's needs-you row already say so); Sending… between a send and the
turn's start; the mini spinner, the flavour word (turning every seven
seconds in the 150 ms cross-fade) and the elapsed in tabular digits; the
paused row in the warning tint at 10 % with the pause glyph, Paused, the
frozen elapsed, on a master "· and N batch threads with it", then Stop (a
quiet capsule on the fill step) and Continue (a warning capsule with a
white label); the stopped row on the quaternary fill with the stop glyph,
Stopped, "· the harness is gone", the frozen elapsed and Resume (a capsule
in the label color); the queued line, the host's "Queued · waiting for
<sibling>" in secondary with Start now (quiet). A refused strip action
re-enables its control and says nothing more: the block is already in the
composer field. Only opacity animates, in 120 ms.

The live cards' actions (`Thread/CardActions.swift`; the cards' rendering
stays in `Thread/TranscriptRows.swift`) are full-width 40 pt buttons at the
card's bottom, at the row radius (the recorded exception to outer = inner +
padding: the card's 12 less its 12 of padding leaves no room, so the next
step down is the row): Allow prominent in the accent with a white semibold
label, Deny quiet on the fill step; Answer prominent, at half opacity until
every question has a choice. A decision shows the moment it is tapped (the
client records it before the wire), the buttons fade as the card settles
in 200 ms ease-out, and a refusal rolls the decision back with one quiet
secondary line ("Not allowed: …") that the next decision clears. A key
that cannot approve sees the reason in the buttons' place; a link down for
a moment sees them at half opacity with the reason under them.

The sheets (`Shell/ThreadSheets.swift`) are the system sheet at medium and
large, 16 pt corners, the drag indicator shown, Cancel on the left and the
one confirming verb (Start, Create, Save) semibold on the right, off until
the form is valid. The type is a grouped inline list: the type's glyph
tinted at the label's weight, the label, the desktop's one-line hint, the
system check on the chosen one. Start a build offers Implementation and
Orchestration, one thread either way; New thread the six root types, and
opened prefilled from the Inbox (the item's repository, title and a
one-line reference as the first message) it adds a title row and a message
row and sends the message right after the create. The
model and reasoning rows read as menu pickers (value in secondary, the
up-down chevron in tertiary) and open the same catalog menus as the
composer's chips. Rename is one field with the title at medium, Save off
until it reads differently; the row menu opens it (the thread screen
renames inline in its header).

Where the desktop splits board and chat side by side, the phone uses a
segmented control under the header with two segments and a swipe between
them. The control is bound to the pager: its raised pill sits at the pager's
offset in pages (`SegmentRules.pillRect`), so it follows the finger during a
swipe and settles with the drawer curve on a tap; each label's primary copy
fades over its secondary one by the same offset (`SegmentRules.weight`),
never a swap of two states. The track is the fill step at 9 pt radius, the
pill 7 pt inside a 2 pt inset (concentric: `Radius.around(7, padding: 2)`),
the raised step with a soft offset shadow in light and the step alone in
dark. The segment chosen is remembered per thread. A warning dot beside the
inactive segment's label marks a new needs-you card there: 6 pt, 4 pt off
the label's trailing edge, both scaling with the label; it grows from a
quarter of its size, fading and unblurring, on the expand spring, and leaves
by opacity; the label never moves. Under reduced motion a tap jumps and the
dot fades. The default segment is the one the desktop makes the hero
(`ThreadPhase.defaultSegment`); a planning thread stopped on a question
forces Chat.

A thread moved or deleted while open shows one quiet line where the body
was, keeps its last title in the header, and loses its composer, segments,
agents button and menu.

Slots, for the threads that fill them (each a named line in this thread's
files, never an empty view):

- (a) host chip: `ThreadHeaderLine.Part.host` rendered in
  `Frame/ThreadHeader.swift` `HeaderPartView` (thread 22).
- (b) account chip: a `Part.account` case after `.model` in
  `Rendering/ThreadFrame.swift`, rendered in `HeaderPartView` (thread 24).
- (c) Notes: the trailing group in `ThreadScreen.swift` `trailing(…)`,
  before the agents button (thread 18).
- (d) fleet switches and Resources…: `ThreadMenu` in
  `Frame/ThreadToolbar.swift`, between `pinItem` and the divider (thread 20).
- (e) master view: `ThreadSegment.segments(for: .master)` and the `.board`
  case of `ThreadScreen.body(for:)` (thread 16).
- (f) project plan view: the `.plan` case of `ThreadScreen.body(for:)`
  (thread 17).
- (g) the subtitle by status: the table above, in `ThreadHeaderLine.init`.

**Notes.** Every root thread's bar carries a `note.text` glyph with a 6 pt
neutral dot when the notes changed since this device last read them (a
per-thread mark in UserDefaults, never synced). It presents the Notes sheet
at the large detent with the 16 pt sheet radius: the menu (Copy as brief,
light haptic) leading, Edit ↔ Done trailing, no close button; swiping down
dismisses and saves. The document is the five sections (Goal, Decisions,
State, Pointers, Open questions) in order, each heading in `.headline` and
its body through the plan page's block stack (PlanType's type and spacing,
parsed through the plan pages' cache); an empty section is folded
to its heading in tertiary with the same spacing, so a thread that wrote only
Goal and State still shows the five-part outline; headings the thread
invented come after. Edit swaps the page for a plain `.body` text editor of
the whole file (autocorrection on, no mono), saved 800 ms after the last
keystroke, on Done and on dismiss; the one quiet line under it reads "Not
saved" after a failure, or "The thread updated the notes meanwhile · Load
theirs" when a push passed the text the edit began from. A push while the
sheet is open replaces sections in place by heading: the reader's section
stays anchored, a changed body cross-fades 150 ms, and nothing animates on
first paint. A read key shows its reason where Edit would be. On Home, a
waiting thread's needs-you row carries the first line of its State as its
second line; the cue's seq still routes the tap to the card.

### Chat

The transcript is the whole body, the desktop's `AgentTranscript` row by
row (`Sources/Thread/TranscriptView.swift`, `TranscriptRows.swift`,
`ToolChip.swift`, `MarkdownView.swift`; the shared ingredients in
`TranscriptStyles.swift`). What the list shows is the client package's row
model (`Rendering/TranscriptRows.swift`, the desktop's `transcriptRows.ts`
and `transcriptActivity.ts`): an entry on its own, a fold of settled tool
chips, or a settled turn's closing line, each with a stable id (an item's
seq, a group's first seq, the turn's user seq), so the list, a search
landing and the scroll proof all speak rows. The plain-words tool lines are
the package's `ToolPhrase` (tested). Row kinds and their mobile form:

- **User turn**: bordered field, 12 pt radius, hairline border, 12 pt
  padding on the chrome step; attachments above the text as thumbnails
  (images, decoded at display size, a 1 px outline at 10 %) or a wash chip
  with a glyph (documents, threads); six lines, then "Show more" on tap;
  Copy Message in the context menu. No stamp under the field (the
  desktop's shows on hover only): the turn's closing line carries the
  time. The project rules the host put ahead of the first message fold
  inside the field above the brief (`PreambleRow`, the host rows thread's).
- **Assistant**: markdown as the page, `body` size, no container, a
  generous measure, selectable, Copy Message in the context menu. Code
  blocks: the desktop's bordered block (10 pt radius, the content wash, a
  hairline edge), the language as a small header when the fence names one,
  line numbers in the dim step, mono one step down, horizontal scroll,
  never wrapped, a fold past 40 lines, Copy in the context menu. Pipe
  tables are a bordered grid that scrolls sideways. Inline code is mono one
  step down on the fill step. An empty streaming block draws nothing; the
  working strip says Thinking. A streaming block mounts
  `StreamingAssistantRow` (`Thread/StreamingRow.swift`, the streaming
  thread's seam), whose markdown parses incrementally on the main actor:
  only the block that changed (normally the last) is parsed again
  (`MarkdownCache.streamingDocument`), so the earlier blocks keep their
  render and nothing flickers between plain and styled; a paragraph past
  8 KiB stays plain until the next block boundary.
- **Thinking**: one folded line, "Thought" with "for 2s" in the dim half,
  "Thinking" shimmering while it streams; tap opens the thought in place
  (the expand spring), the text in `secondary`.
- **Tool**: the one-line chip in the desktop's grammar: the kind's glyph
  in the quiet step at the verb's weight, the verb in the dim step ("Read",
  "Searched for", "Counted to one hundred"), the target loud (a file in
  mono, truncated in the middle), the duration right in tabular digits; no
  chevron at rest (the desktop shows it on hover; five hundred chevrons at
  rest is noise). Running shows a spinner where the duration will be;
  failed draws an ✕ and tints the line destructive. Open: the line becomes
  an 8 pt control inside a 12 pt block (concentric, 4 pt of padding) with
  the chevron turned at its trailing edge, and the body lands under a
  hairline, the input pretty (the command bare, else key and value lines,
  never raw JSON) and the output in mono, destructive when the call failed,
  "… N more lines" past the fold. An omitted body is fetched on open behind
  a shimmer of its final height and fades in 150 ms after the height starts.
  Plan-tool calls are one quiet line.
- **Activity group**: a run of two or more chips between two other rows
  folds behind one disclosure line, "+N previous tool calls" (a
  chevron that turns, "Hide previous" while open), with the newest chip
  always showing: the desktop's `ActivityGroup`. The rule
  (`TranscriptRows.rows`): a tool call that is neither an edit nor a plan
  tool joins the run; everything else (prose, thinking, an edit card, a
  quiet line, a card, a compaction, a system line) breaks it; a run of one
  is a plain chip. The group the agent is in (the last row of the open
  turn) is live and opens by itself; once the turn settles it folds, unless
  the person opened it by hand. That settle-close animates (200 ms
  ease-out) only while the reader is at the bottom, where the fold is the
  newest thing on screen; anywhere else it closes without animation so
  nothing above the reader moves. A search hit inside a group opens the
  group before the list scrolls to it.
- **Edits**: the desktop's bordered card: the icon in a 20 pt box, the file
  name medium, the directory dim, a live verb while the call runs, `+n −m`
  in success and destructive, semibold and tabular; deleted and failed say
  so. Tap opens the diff full screen (unified, mono, line numbers dim; no
  side-by-side on a phone).
- **Approval** and **question** cards: the only raised surfaces in the
  transcript, hairline border and warning tint at 8 % while undecided, the
  gray step once decided. An approval says what the agent wants in plain
  words with the command in a mono well (a file write shows the lines it
  adds), then the steering thread's Allow and Deny (`CardActions.swift`,
  full width); decided it reads Approved, Denied or Denied (timed out). A question shows
  its header small and dim, the question, the options as wash chips that
  wrap (the picked one near-black), an Other field when the question takes
  free text, then the steering thread's Answer (`CardActions.swift`);
  answered, the chosen chips stay on and the rest fall away.
- **Compaction**: a pulsing violet dot and "Compacting context" with the
  elapsed time while it runs; a labelled divider "Context compacted ·
  142k → 38k · 2s · auto" once it lands; a destructive line when it fails.
- **Errors and system**: "Failed · the harness's words" in destructive with
  the alert glyph; the user's own Stop is a gray "Stopped"; a pass row reads
  "Pass · what it did"; everything else is one quiet line, glyph and text.
- **A failed thread's row** (Home's Needs you, every list) reads the host's
  one-line verdict (`failure.summary`) on its second line; the error row's
  first line is the fallback for a host that sent none.
- **Subagent spawn and report**: a row under a rail: the agent's glyph,
  "Spawned" or "Reported", its title in a wash, its status with the dot;
  tap pushes the subagent thread.
- **Failure**: the host's verdict on a failed turn as a card: the summary,
  the cause, a note naming what only the desktop can do (sign in, pick an
  account or a model), and the actions this key can take as full-width
  buttons, Retry last; needs-you tint while live, chrome once the thread
  moves on. An error without a verdict, and a Stop, stay one quiet line.
- **Review**: the merge review's outcome: lead and detail, held in
  destructive, merged in success, the rest secondary; blocking findings as
  rows (file:line in mono, the claim, tap expands the failure scenario on
  the row spring); minor findings folded; the reviewer thread one chip away;
  Merge anyway behind a confirm sheet for an approve key, the reason in its
  place for a lesser one.
- **Gate**: the run's outcome; failed in destructive with its last lines
  folded in mono; passed as a quiet line with a green check.
- **Batch, account-gone, other host rows**: one quiet line each, the host's
  words.
- **Plan handoff**: the build's row (status, glyph, title, model) when this
  host has it; tap pushes it.
- **Preamble**: "Project rules · 212 words" folded inside the first user
  field above the brief; tap opens the text on a 150 ms cross-fade.
- **Turn end**: a settled turn closes with one quiet line, "Worked for 12s
  · 3:04 PM" behind a check (the desktop's `TurnEnd`), Copy answer in the
  context menu (the turn's prose joined by blank lines). Nothing while the
  turn runs: the working strip has the live timer. The open turn and a
  pending turn have none.

Streaming: new text appends to the last assistant row without re-laying the
rows above (rows compare by value and keep their identity by the row
model's ids); the list stays pinned to the bottom while the user is at the
bottom and shows a "Jump to latest" pill (one, raised, 150 ms opacity and
8 pt of travel) once they scroll up. Turn completion adds the closing line
and nothing else. Nothing animates on first paint from cache. Images reach
the phone through `fs.media` and the `/asset` GET; the host an image lives
on is `MediaImage.hostOf(_:)` (the media-host thread's seam).

### The account chip and menu

Every Claude or Codex thread's subtitle ends with the account it spends
from: a 6 pt dot in the account's own colour (Aliax's `#rrggbb`; tertiary
when it has none) and the short name (nickname, else the email's local
part) in `caption` medium secondary, or "Auto" one step dimmer with no dot
when the host picks. A 44 pt hit area; press dims (`pressableStatic`), no
scale in the dense bar. Tap opens the system sheet (16 pt, medium and large
detents), titled "Account", with the source line under it ("From project
billing-page", "From workspace cosmic-web", "Auto · picked by model").

Three scopes in a segmented row, only those the thread has: **This thread**
reads the route (the account checked is the one it spends from; a "Route
automatically" pill under the rows asks the host to re-pick, and "Already
on the best account" is the one word back when nothing moved); **Project**
and **Workspace** pin over `project.setAccounts` and `workspace.setAccounts`
(admin). Rows: "Automatic" first, with what it follows ("Best account for
the model", "Follows the workspace: work"), then the provider's accounts in
the snapshot's order, a check on the one that applies at that scope, and
one "gone from this host" row in tertiary when the pin or the route names
an account the snapshot no longer knows. A pin shows at once and reverts
with the reason on the reserved line under the segments when the host
refuses. A key below admin keeps the rows and says "This key can't change
pins" there; nothing hides.

Each account row carries a 3 pt capsule bar: the least room among the
usage windows the thread's model spends (5h, the weekly one, and the
Fable cap for a Fable model), success above a quarter, warning down
to a twentieth, destructive below, and destructive at zero while the
account is rate limited ("rate limited · 39m") or signed out ("sign in
again"); the stamp beside the name is the tightest window's reset ("in 2h
14m"), tabular. The sheet reads `accounts.list` once on open and the
`accounts` push after; stamps tick every 30 s.

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
same two segments; it has no Start (its milestones are planned one at a
time from the options card, see Project plan below). Plan
renders the markdown file (`file.read` of `planPath`, polled 1.5 s running
and 8 s idle while the screen shows) document-first, `body` size, generous
measure, streaming in as it is written. The page's header row (the state line and the action, in
`PlanView`'s two slots; `Thread/PlanFlow.swift` on the client package's
`PlanFlowState`) follows the plan flow of planFlow.ts and exists only once
the plan is complete: "Plan complete" while the planner still speaks;
"Waiting for you to start the build" with **Start**, which opens the Start
sheet (Implementation first, Orchestration second) whose confirm calls
`plan.implement`, so the host picks the title, the seed and the project's
plan settings and the build is pushed; "Build started" with a chip naming
the build, which pushes it (no chip when the build lives on another host).
A key that cannot operate keeps the Start pill and the tap says why. The
toolbar carries no Start or Build. A build shows "Planned in <title>" under
its board's goal, a row that pushes the planning thread; a thread row of a
complete plan with no build carries the tag "Plan ready". A thread stopped
on a question forces the Chat segment with the question card in view.

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


### Project plan: the milestones are the hero

The same Plan and Chat segments as a planning thread, and the same page
(`ProjectPlanView.swift` composed on `PlanPage`, values in
`ProjectPlanStyles.swift`, the parse in the client package's `ProjectPlan`):
the fixed sections (the title, Goals, Current state, Risks, Open questions)
render as the document through `PlanDocumentView(range:)`, and `## Milestones`
keeps its heading and trades its body for native rows. Nothing animates while
the file streams in: a milestone appearing adds a row below the reader, a
field landing changes that row's own lines.

- **The progress line** under the heading: a 3 pt `Surface.fill` capsule
  filled `Tint.success` to done of total, "3 of 7 done" beside it in the
  stamp step with rolling digits; no percentage. The fill's width animates
  with `Motion.expand` (none under reduced motion).
- **A milestone row** (44 pt min, 8 pt vertical, a `Hairline` below at the
  text edge): the checkbox in the 26 pt marker column (`circle` tertiary /
  `checkmark.circle.fill` `Tint.success` at `body`, a 44 × 44 hit area,
  `.pressable`, a light impact on the tick), the ordinal in a second 26 pt
  column in the meta step, then the title at `body` (secondary once done, no
  strikethrough; the color crosses over `Motion.crossFade`) with the scope as
  one dim `footnote` line. Tapping the text expands the row with
  `Motion.expand` (`Motion.collapse` back, `Motion.crossFade` under reduced
  motion): the scope wraps, "Done when" semibold with its text, and the
  dependency chips ("Depends on" and a 20 pt `Surface.fill` capsule per
  number at `caption2`, scrolling sideways past the row). One row open at a
  time; a milestone with no fields has no expand. A tick is optimistic over
  `projectPlan.tick` (the glyph swaps with `Motion.iconSwap`, the row's
  glyph a small spinner meanwhile) and reconciles when the next poll shows
  the file; a build landing on the host ticks the file and the row follows
  on the 8 s idle poll.
- **The options card** after `status: complete` in the frontmatter (and only
  that): a `groupCard` with "The plan is complete" and the count in its
  header, then four `.pressable` rows (glyph in a 20 pt column, title in the
  title step, a one-line detail in the meta step, hairlines at the text edge):
  Plan the next milestone (`map` violet, the next milestone's number and
  title; "Every milestone is done" disables it), Start an orchestration
  thread for milestone N (`arrow.triangle.branch` warning), Revise the plan
  (`pencil`, a native alert with a text field; empty sends the desktop's
  default re-survey turn), Keep / Stop keeping as the project's plan (`pin`
  info / `pin.slash`). The two starts open a sheet in the Start-a-build
  shape (the milestone with its scope and done-when, the model and reasoning
  prefilled from the plan thread), create the thread with its brief, link it
  to the milestone over `projectPlan.link` and push it. The card appears with
  `.rowAppearTransition()`; a busy row's glyph is a small spinner; the footer
  reads a read key's reason or the last refusal.
- **A read key** disables the checkbox and the four rows and says why: one
  meta line under the progress line and in the card's footer, the same
  `ActionBlock.text`. Nothing is hidden.
- **The Home chip** sits in the project header before the plus
  (`ProjectPlanChip.swift`, the `projectTrailing` slot): `flag.checkered`
  violet at `caption2.semibold` and "Plan", or "Plan · 3/7" once kept, in a
  28 pt `Surface.fill` capsule inside a 44 pt hit area, the count rolling.
  It opens the plan thread; its context menu holds the four options (a read
  key's reason as the first, disabled line). The state (`projectPlan.get`)
  is cached per host and project, loaded on appear, refreshed after every
  action from the chip and when a project-plan, implementation or
  orchestration thread of the project goes idle, and asked again after a
  reconnect. Nothing shows for a project with no plan file and no plan
  thread.

### Orchestration: the fleet is the hero

Segments: **Fleet** (default once the first agent spawns) and **Log**.
Fleet (`Thread/FleetView.swift`): the goal in `body` text, then one status
line with its mark (the orchestrator's own state while it runs, waits,
fails, is paused, stopped or queued; else what it waits on: "Waiting on
its subagents", also while a child is only queued, "A subagent needs you",
"Done", "Done, one agent stopped"; the headers carry the counts, the line
never repeats them), then the fleet in four groups under the design's
section headers with a count: **Running**, **Waiting**, **Queued**,
**Done** (failed and stopped agents sit first in Done with their marks).
Empty groups are left out. Log is the orchestrator's own transcript.

The agent row (`Thread/FleetStyles.swift`, `AgentRow`), shared by the
Fleet segment, the subagent list, the implementation board's Agents
section and the master board: the kit's 14 pt mark column (spinner
running, warning dot waiting, destructive dot failed, info dot watching,
pause mark paused, a dashed ring queued, a still square once the harness is
gone, a green check settled; marks cross-fade 150 ms in a column that never
changes size), the title in `subheadline` medium (regular and `secondary`
once settled) with the figures on its line, a meta line in `footnote
secondary` of the provider's own mark drawn as a path in the text color
(`ProviderGlyph`), the role glyph, model and effort, the worktree name when
the agent works in one and the host's name when the agent lives on another
host than its root; the activity line on the kit's sizer (a hidden one-line
text fixes the height) swapping in place with the 150 ms cross-fade and
2 pt blur (a queued agent's line is the host's "Queued · waiting for …", a
stopped one's "stopped · the harness is gone"); the stats line when there
is anything to say. Elapsed over cost on the right, `caption` tabular with
`numericText`: one step above the stamp on purpose, because `caption2
tertiary` fails the contrast floor on the needs-you tint. A live row's
figures tick on their own one-second clock and nothing else in the row
re-renders on the tick; a row whose host is away stands still. A waiting row sits on the needs-you tint in an 8 pt rounded
field inset 8 pt from the edge; the text stays at the 16 pt edge. Hairlines
between rows at 40 pt (`FleetLayout.textInset`), none after the last of a
group. A row that changes group moves with the kit's row motion; nothing
moves on the first non-empty paint, so a fleet arriving from the socket
after an empty cache lands still.

Subagents on another host: a box thread that spawned a child on the Mac
has that child in the Mac client's list under the box root's id, so the
fleet is gathered from every paired host (`Fleet.gather`, the root's host
first). The remote row ends its meta line with the host mark and name;
while that host is not open its activity line reads the host's transport
line ("Reconnecting in 12 s", "Offline") and its figures stand still; its
detail reads from that host. Agents spawned on a host this phone is not
paired with are counted once at the foot ("2 agents run on hosts this
phone is not paired with"), not tappable: pairing is in Settings.

**Subagent list** (`Thread/SubagentListScreen.swift`,
`SubagentListScreen(client:rootSessionId:)`): the desktop's right-side
subagent panel as a screen, pushed from a thread's toolbar button. Title
"Subagents" over the thread's name, then the same grouped rows across
hosts, live, nothing to pull. Fleets of twelve read as four short lists.

**Agent detail** (`Thread/AgentDetailScreen.swift`), pushed from any
row through `AgentDetailRoute` (host, agent, the root's directory, the
host's name): the title over the role in the bar; an identity strip under
it with the mark, the meta line (with the worktree and the host), the
activity line, stats, elapsed and cost, closed by a hairline; then the
agent's own transcript (`TranscriptView`, so a waiting agent's approval or
question card sits at the end, where the screen opens, and decides from
there); then one line at the bottom, "Steer this agent…" while it runs and
"Send to this agent…" once idle, "Resume to send" off when stopped and
"Starts when its turn comes" off when queued, one filled send button,
through `client.send` on the agent's own host. A key that cannot act sees
the reason in the field. DEBUG hooks on the Fleet segment:
`TC_TEST_OPEN=agents` pushes the list, `agent-detail` the first agent; on
the detail `TC_TEST_ACTION=send:<text>|approve|deny|answer:<label>` runs
once on the agent. The test server's `TC_TEST_FLEET=large` seeds twelve
agents in all four groups.

The pieces the master board and any other fleet surface build from, all in
`FleetStyles.swift`: `FleetLayout.textInset`, `AgentStatusMark`,
`ProviderGlyph`, `AgentMetaLine`, `ActivityLine`, `AgentStatsLine`,
`AgentFigures`, `AgentRow`, `FleetSections`, `FleetRows`, `FleetLoading`,
`FleetEmpty`, `FleetUnpairedNote`, `FleetGather`, `AgentDetailRoute` and
`.fleetDestinations(registry:)`.

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

### The diff screen

One screen for every diff: an edit row in the transcript, a Changes row on
the board, and a pull request's files in the Inbox. Three ways in, one
screen (`DiffScreen`): `DiffRoute` (an edit's card, read from the thread's
own host with `session.rowBody`), `LinesDiffRoute` (lines already in hand
with the host's counts) and `PatchDiffRoute(title:patch:file:adds:dels:)`
(a unified patch; `file` keeps one file of a many-file patch, so the Inbox
opens a pull request per file and names the file in the title). Unified,
never side by side on a phone. The model and its parsers are the client
package's `Rendering/DiffDocument.swift` (`DiffLine`, `DiffHunk`,
`DiffDocument`, and `DiffLayout` for the column's geometry), with their
Swift Testing suite; `Thread/DiffStyles.swift` keeps the UIKit
measurements (`DiffMetrics`) and the palette.

- **Header**: the path on one line in two steps, the directory `tertiary`
  and the file name in the title's color, `subheadline` semibold, head
  truncated so the name always shows, a long press copies the path; `+n −m`
  trailing in success and destructive (the host's count when the route
  carries one, the parsed count otherwise).
- **Hunks**: a jump or a step back in the new-side numbering starts one, as
  the desktop's gap does, and every edit of a file starts one. Each hunk is
  a pinned section row on the one gray step: the line range ("Lines
  40–43", "Line 12 removed"), the file name first when the document spans
  files, the hunk's own `+n −m` trailing, a hairline under it.
- **Lines**: mono one step down from the rows (`footnote`, Dynamic Type
  honored, the gutter and row height measured from the same font), the
  number `tertiary` right-aligned in the gutter, the sign bold in the line's
  color in the gutter and never in the text, the row tinted success or
  destructive at 10 % with a 2 pt bar of the full color on the leading
  edge, context text at 70 %: the desktop's `DiffBody` values. No
  intra-line emphasis, as on the desktop.
- **Sideways**: each hunk scrolls horizontally on its own, under the pinned
  gutter, by a sideways drag on any of its rows; the first change decides
  the axis for the gesture's life and a vertical start is the scroll
  view's. The finger's momentum carries it, both ends rubber-band (Apple's
  `d·c·w / (d·c + w)`, c = 0.55) and it settles with a bounce-0 spring
  whose duration follows the travel: 0.35 s plus 0.4 ms per point, never
  past 0.6 s. A hunk that fits never moves.
- **Virtualized**: a lazy column of fixed-height rows; a 3,600-line diff
  opens and scrolls at 120 Hz with nothing built off screen.
- **Toolbar**: a bottom bar with previous and next hunk and "n of m" in
  tabular digits between them, numeric transition; the position follows the
  scroll from the fixed row heights (`DiffLayout.hunkIndex`). Hidden for a
  single hunk. Navigation is `ScrollPosition.scrollTo(y:)` on the header's
  exact offset (`DiffLayout.hunkStarts`), 250 ms on the strong ease-out
  curve `(0.23, 1, 0.32, 1)`; jumps under reduced motion.
- **Context menu** on any line: Copy line, Copy hunk (unified, with signs).
- **Loading**: the shimmer of the height the lines will take, from the line
  count the host left with the omitted body; rows cross-fade in over it in
  150 ms; a route whose lines are in hand (a patch, lines, or an edit whose
  every preview carries its lines) parses before the first frame and never
  shows it. Previous and next hunk hold the counter on the target while the
  scroll animates; the finger catching a hunk mid-settle blends to it
  through an interactive spring. **Gone**: one line in destructive with Retry; part of an edit
  gone shows the rest under the same line. **Nothing to show**: one quiet
  line ("This edit left no lines to show."; for a patch, "No changes to
  show.", which covers a binary or truncated file).

## Two hosts

The phone pairs with more than one host (the Mac and the box) and, since the
desktop learned to share work between them, four things follow on the phone.
The models are pure and live in the client package (`ProjectPairs`,
`CrossHost`, `PathHost`, `MovedThread`); the views are `Hosts/HostDot.swift`
and `Thread/HostChip.swift`.

**One project on two hosts.** Two workspaces are one project when they name
the same GitHub repository (`repo:<owner/name>`, lowercased), else when their
folders share a name (`name:<basename>`). Within one host the first workspace
with a key keeps it, so a pair has at most one member per host; a second
same-named folder on one host keys as `<env>:<workspace id>` and never folds.
The phone reads no path map: the Mac's map (`/srv/agents/work/<X>` ↔
`~/IdeaProjects/<X>`) gives both sides the basename `<X>`, which the name rule
already covers, and the map is an admin setting a client key cannot read.
Home's row for a paired project carries one 7 pt dot per host, 2 pt apart, in
registry order, in the trailing cluster before the thread count, centered on
the title line (`PairedHostMarks`; VoiceOver: "On Mac and box", the value the
hosts' states). A thread row under it names its host as the first word of its
second line in the stamp step (`HostWord`), only when more than one host is
paired (`ProjectPairs.showsHost`); with one host nothing names it.

**A thread's host.** The thread header's subtitle holds a chip
(`HostChip`): a 6 pt dot in the host's tone and the host's name in the meta
step on the fill step with row corners (8 pt continuous), 7 pt horizontal and
2 pt vertical padding, a 44 × 28 pt hit area, the press scale; shown only
with more than one host paired (the header's rule). The dot sits on the
text's cap-height centre, not the line box's. A tap opens a compact popover
anchored to the chip (`presentationCompactAdaptation(.popover)`, the system's
own scale from the trigger): the host's name, its state line (the same
`StatusText` as Home's host row, ticking while a retry is pending), and
Retry when it helps (reconnecting, offline, refused). The phone offers no
move: `session.move` is the Mac's own local RPC, which no remote key can call.

The host tone, one rule for every dot that means a host's link:

| Tone | When | Color |
| --- | --- | --- |
| fresh | open, re-listed | Success |
| stale | open, not yet re-listed | Success at 50 % |
| busy | connecting, reconnecting, suspended | Warning |
| away | offline | `tertiaryLabel` |
| refused | the key was refused | Destructive |

The dot cross-fades 150 ms between tones after the first paint and never on
it; its accessibility value is the state line's words, the static cue.

**A moved thread.** The `session-moved` push says a thread now runs on
another host; the client drops its rows and keeps a `MovedThread` record
(where, when, which subagents) in memory for this process. A screen open on
the thread shows one quiet line in its place, with the row appear motion:
"Moved to box" as a full-width 44 pt row with a trailing `chevron.right`,
whose tap opens the same thread on that host (same id, same seqs) through
the router; when that host is not paired, "Moved to a host this phone is
not paired with" as plain text. Only a client subscribed to the source host
sees the push: a phone in the background sees the thread leave one host and
appear on the other at the next list, with no line.

**A cross-host subagent.** A box thread's child spawned on the Mac is an
ordinary thread there with the box thread as its parent; the parent's log
holds an `agent-spawned` row naming the child's host, and the host's tools
name it `<env>:<session>`. `CrossHost` turns either form into a placement
(the host, the session, remote or not, paired or not): the fleet reads the
child from that host's client, its row names the host with `HostWord`, and a
child on a host this phone has not paired reads "on a host this phone is not
paired with" in place of its status and is not tappable. The note never
names the host: the wire carries the environment id alone, and no client key
can fetch a name for it.

**Files and media by host.** A path a thread names opens on the host the
desktop's rule picks (`PathHost`): a catalog root (a project cwd or a
workspace path) is a definite answer; outside every root the thread's host.
An `fs.media` URL carries `&host=<id>`, the host whose bytes they are; the
image loads from that host's client when it is paired, else from the
thread's. A missing file reads "No such file on <host>." (the host's name
only with more than one host paired); every other failure keeps the host's
words. A photo the phone sends has no home on any host, so every upload goes
to the thread's host, whose attachment folder the fence admits; a cross-host
subagent's composer uploads to the child's host, because its client is the
child's.

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
| Success | `systemGreen` | implementation type, `+n`, completed, a host link that is open (50 % until re-listed) | `Tint.success` |
| Warning | `systemOrange` | orchestration type, waiting, paused, needs-you tint at 8 %, a host link connecting or reconnecting | `Tint.warning`, `Surface.needsYou` |
| Destructive | `systemRed` | errors, `−m`, failed tools, a failure summary, a refused host key | `Tint.destructive` |
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
| Preamble fold | 150 ms cross-fade, no height spring | `Motion.crossFade` |
| Needs-you row appearing | 200 ms ease-out, opacity and 8 pt translateY; removal 150 ms opacity only | `.rowAppearTransition()` (`Motion.appear(reduced:)`, `Motion.rowAppear`, `Motion.rowLeave`, `Motion.travel`) |
| Last-activity line changing | 150 ms cross-fade with 2 pt blur; the row never changes height | `SwapText`, `.swapTransition()` (`Motion.swap(reduced:)`, `Motion.crossFade`, `Motion.crossFadeBlur`) |
| Counts and elapsed | `contentTransition(.numericText())` on 150 ms | `.numeric(value)` (`Motion.numeric`), `CountText`, `ElapsedText`, `AgoText` |
| Streaming text | the jitter-buffer reveal (`SmoothText`): paced at the measured arrival rate behind a 120–500 ms playout lag, painted every 33 ms, no fade and no translate; a chip's target types in and cross-fades 150 ms with 2 pt blur when replaced; edit counts tick with `numericText`; reduced motion reveals per batch | `SmoothTextReveal`, `StreamingAssistantRow`, `LiveChipLabel` (`Motion.swap`, `Motion.crossFade`) |
| Status dot to spinner | cross-fade 150 ms | `StatusDot` (`Motion.crossFade`) |
| A glyph trading state (Send ↔ Stop, outline ↔ fill, pin ↔ unpin) | scale 0.25 → 1, opacity 0 → 1, blur 4 → 0, spring `duration 0.3, bounce 0`; reduced motion: opacity on `cubic-bezier(0.2, 0, 0, 1)` 150 ms | `.iconSwapTransition()` with `.id(symbol)` in a `ZStack` (`Motion.iconSwap(reduced:)`, `Motion.iconSwap`, `Motion.iconSwapScale`, `Motion.iconSwapBlur`, `Motion.iconFade`); `TypeGlyph(active:)` uses the symbol replace effect instead, since Glyphs builds without Motion |
| Send button filling | fill and glyph color 150 ms ease-out when text arrives or leaves; the arrow ↔ stop square is the glyph-trading row above, the circle never moves | `Motion.crossFade` on the fill; `.id(stops)` with `Motion.iconSwap(reduced:)` on the glyph |
| Composer chip row | appears on focus: 200 ms ease-out, opacity and 8 pt translateY; leaves 150 ms opacity only; the dock's height follows on the collapse curve | `Motion.appear(reduced:)`, `Motion.collapse` |
| Working strip state | 120 ms ease-out, opacity only; the row never changes height | `WorkingStripView.fade` (the one 120 ms curve; the kit has none) |
| Attachment chip | appears 200 ms ease-out, opacity and 8 pt translateY; removal 150 ms opacity only | `Motion.appear(reduced:)` |
| Upload bar | width on the 150 ms numeric curve; hidden once the host has the file | `Motion.numeric` |
| Card decided | buttons fade, card settles 200 ms ease-out; a refusal's quiet line cross-fades in 150 ms | `Motion.collapse`, `Motion.crossFade` |
| Haptics | light impact on send and on a decision; nothing on keyboard input | `.sensoryFeedback(.impact(weight: .light), trigger:)` |
| Jump-to-latest pill | 150 ms opacity and 8 pt translateY, both directions | `.jumpTransition()` (`Motion.jump(reduced:)`) |
| Diff hunk sideways | follows the finger through an interactive spring, momentum from the release velocity, rubber band at both ends, settles with spring `duration min(0.6, 0.35 + travel × 0.0004), bounce 0`; next and previous hunk scroll 250 ms on `timingCurve(0.23, 1, 0.32, 1)` to the header's exact offset | `DiffMotion.track`, `DiffMotion.settle(travel:)`, `DiffMotion.jump` (Thread/DiffStyles.swift); `DiffLayout.hunkStarts` for the offsets |
| Diff lines landing | 150 ms cross-fade over the shimmer; nothing when the lines were in hand | `Motion.crossFade`; the counter rolls with `.numeric(current)` |
| Fleet toast | 150 ms opacity, both directions; a clean result leaves after 4 s | `FleetToastLine` (`Motion.crossFade`) |
| Fleet confirm's count | `contentTransition(.numericText())` on the title, 150 ms | `FleetConfirmSheet` (`Motion.numeric`) |
| Resource row removed | 150 ms opacity, once the host's push says so | `ResourcesSheet` (`Motion.rowLeave`) |
| Headroom bar on a snapshot change | fill width 200 ms ease-out; never on the first paint; reduced motion snaps | `AccountMenu`'s `AccountMotion.bar` (for `Motion` to absorb) |
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
  Rows are the row model's rows: a group is one row however many calls it
  folds. Markdown is parsed off the main actor into `AttributedString` once
  per row version and cached by `seq` and text hash; a streaming row parses
  the changed block only, on the main actor.
- **Bodies on demand.** Omitted bodies (over 2 KiB) are fetched when a chip
  expands and cached; a diff is fetched when opened.
- **Budget.** A cold thread open is 75 rows, one page back on scroll to the
  top. The row count, not turns, bounds every window.
- **Images** go through `/asset` with the system URL cache and a memory
  cost cap; thumbnails are decoded at display size.
- **Nothing on the main actor waits on the network.** Every RPC is an async
  call off a detached task; the UI reads the observable models only.
- **Background.** Leaving: the socket closes after a 10 s grace (iOS usually
  freezes the process first, so the grace rarely runs). Coming back: the
  screen the person left is still there, exactly as they left it, scrolled
  to the same row, painted from what the app already held. Within the
  grace the live socket is probed and kept; past it the stale socket is
  replaced at once, never probed for five seconds. On the new session the
  thread on screen catches up first (`afterSeq` from its cursor), the other
  open threads next, while the shell catches up alongside: workspaces and
  projects in one round trip, and the session list reconciled with
  `session.changes` from the cursor the cache kept (the metas that changed
  and the ids that left, merged in place; the whole `session.list` walk
  only on `reset`, with no cursor, or on a host that predates the method).
  Every catch-up lands as a diff with no reload, no empty flash and no
  duplicate rows; a tail the host replaced whole (`reset`) is a fresh paint
  with no motion even on screen. A change that lands where nobody is
  looking (another thread, Home while a thread is up, the shell while the
  app re-lists) is published with animations off, so nothing that was
  already true moves; rows that arrived while away get the enter motion
  only on the list the person is looking at. A list that comes back as it
  was is not republished. The thread on screen stays seen through the
  catch-up: its seen mark follows its rows and again its fresh meta. The
  status line (`StatusLine`) is one line of footnote text over the content,
  never in it: it exists only after the transport has been away 1.5 s,
  fades in and out over 150 ms, and is gone the frame the socket opens; the
  background's own `suspended` state never shows. Elapsed timers run from
  the host's `busySince`, so they are right on the first frame back and
  after a kill. The tab, each tab's stack, the thread's segment, the
  new-thread and Start sheets (`SheetMemory`) and the row the person was
  scrolled to (`ScrollMemory`, the item at the top while scrolled up) survive
  a cold launch (`NavigationMemory`; the clients exist before the first
  frame, so the restored thread paints from the cache at once). Once every
  host has caught up, the Live Activities and the badge (Home's Needs you
  count) are brought in line with what the app shows; a queued thread ends
  its activity like a finished one. A host that restarted mid-turn says so
  once per boot (`bootResume`, deduped by the boot's time in the cache).
- **Measure.** Scroll a 2,000-row thread at 120 Hz with the Instruments
  animation hitch template; a hitch over 8 ms in the transcript is a bug.
- **Streaming.** A streaming row's text is paced by `SmoothTextReveal`
  inside the row's own state, so a paint changes one row's body and nothing
  in the fold; the revealed prefix goes through the incremental markdown
  path (the last block only). Partial tool calls and live edits update one
  row in place by `callId` and by path; a batch of N rows is one write to
  the thread's state. The list anchors its bottom edge on size changes.
  Budget: no frame over 8 ms at 120 Hz on the 2,000-row chat while a turn
  streams.

## Push, the Live Activity and the Dynamic Island

The lock screen and the island show the desktop's running row, nothing
else; the host sends what that row needs and the clock ticks on the device.

| Surface | Shows |
| --- | --- |
| Content state | `phase` (working, paused, waiting, finished, failed, stopped), `since`, `ts`, `seq`, `title`, `task` (the in-progress task, else the activity line; a master's running batch step), `done`/`total` when the thread has a list, `unit` (tasks, or threads for a watching master's batch), `reason` (the needs-you line) while it waits. Pushed on every change of what the card shows; task-line-only changes coalesced to one push per 20 s. A queued thread has no activity: it is not live |
| Lock screen card, row 1 | glyph tinted by type (20 pt frame, semibold), title `subheadline` semibold one line, the timer `footnote` tertiary in tabular digits on the title's baseline |
| Lock screen card, row 2 | indented 28 pt to the title's edge, 18 pt tall whatever it says: the status mark (14 pt frame: the spinner while working, the pause mark, a 7 pt dot for waiting, done and failed, a 6 pt still square for stopped, the StatusDot's marks) and one line. Working: the task alone in `footnote` secondary (the spinner already says working; the desktop row never spells it). Paused and waiting: the word `footnote` medium in warning, then the task or the reason in secondary. Finished, failed and stopped: the word alone, Done success, Failed destructive, Stopped secondary |
| Lock screen card, row 3 | only with a list: a 3 pt tally capsule (quaternary track, filled in the type's tint while working or waiting, warning paused, success finished, destructive failed, secondary stopped) and `3/7` `caption2` tabular, secondary while live, success once finished with all done; the same for a master's threads. VoiceOver: "3 of 7 tasks done" / "3 of 7 threads done" |
| Island compact | leading the type glyph while working, paused or waiting, the final state's mark once settled; trailing `3/7` when there is a list, else the timer in a 60 pt slot that shrinks to 0.8 before `1:02:33` would clip, colored by the phase once the thread stops working |
| Island minimal | the status dot (8 pt): the type's tint while working, warning paused and waiting, success done, destructive failed; a 6 pt still square for stopped |
| Island expanded | glyph, title, timer on the top row; the status line and the tally below; keyline in the type's tint; every presentation deep-links to the thread and the row |
| Notification | title the thread's title, subtitle the project (else the workspace), body one line: "Needs approval: Bash — bun test", "Asked: which database?", "Plan ready to approve", "Waiting for you", "Done in 12m · 7 tasks", "Plan complete — implementation started: …", "Batch done · 3 landed · gate passed in 4m 12s", "Batch stopped: gate failed · at vitest", "Failed: <the host's summary, else the first line>", "Stopped: the harness is gone", "Quiet for 12 min while working". Grouped per thread; relevance needs-you 1, failed 0.8, stuck 0.6, finished 0.4; sound only for needs-you and failed; time-sensitive only for needs-you; Approve and Deny on an approval (Approve asks for the unlock); a refusal answers one notice saying why. No emoji, no exclamation marks |
| The host in the subtitle | the host does not know how many hosts a phone pairs with, so the phone decides: the alert is `mutable-content` with the host's name under `tc.host`, and the notification service extension appends it ("temp-code · box") only when two or more hosts are paired, from the App Group directory the app publishes |
| In the foreground | nothing for the thread on screen; a thread whose Live Activity is live gets the list only, unless it needs you |
| In the background | an alert and the activity's end for the same settle both show: the alert is the persistent record, the activity leaves after two minutes, and the shared collapse id folds repeats |
| The clock | runs on the device from `since` while working; paused and every end freeze it at the state's time, so the final card reads the work time as it was. A waiting end shows the work time, not the time spent waiting: that count belongs to the app's Needs-you row |

Motion: WidgetKit animates a Live Activity's content changes itself and
ignores view-level `.animation`, so the widget carries none; the line
cross-fades with `contentTransition(.opacity)`, the tally rolls with
`numericText`, the bar's width rides the system's update transition.
Every change has a static cue (word, color, mark); nothing depends on
motion, and the first state is a plain render. Flavour words stay inside
the app's working strip.

## Threads from here

| Thread | Scope | After |
| --- | --- | --- |
| L3 shell | tokens, type glyphs, Home with Needs you, Running, Workspaces, archived rows, host grouping and status row, Inbox, Search, Settings with Hosts; thread rows; read-only | now |
| L4 thread screens | the header, segments, Chat transcript rules, Implementation board, Plan document, Fleet, Sources, diff screen; the cache paint, markdown cache and 120 Hz proof; read-only | now, in parallel with L3 |
| L5 actions | composer and working strip, send and stop, approve and answer, start a build from a plan, new thread sheet, send-to-agent, swipe archive and pin, rename, pairing | L3 and L4 |
| L6 push | APNs through the hub (the phone's token registered with every host, the host's `apns` subscription, the hub's token-auth delivery), Live Activity for a running thread (the running row on the lock screen and in the Dynamic Island, pushed by the host, ended when the thread settles), notification taps landing on the card, Approve and Deny on an approval notice, one Notifications row in Settings, the device build | landed 2026-10-20; the row's content state, the island and the notification format on 2026-10-21; the live pass needs the team id and the APNs key from the developer account |

L3 owns `ios/TempCode/Sources/Design/` and `Sources/Shell/`; L4 owns
`Sources/Thread/` and the rendering models in `TempCodeClient`. L3 commits
`Design/` first so L4 can build on it; until then L4 works in the client
package.
