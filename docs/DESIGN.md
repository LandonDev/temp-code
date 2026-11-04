# Design system

This is the standard every renderer change follows. It wins every conflict
with docs/LAYOUT.md, a skill's advice, a library's default or a thread's
brief. `src/renderer/src/components/README.md` is the map from each class of
UI element to the one component that renders it.

## The look, in one paragraph

Claude desktop's transcript inside Cursor's chrome. The chrome is quiet and
dense: 13px type, one gray step between the rail, the content and a floating
layer, hairline borders, no shadows on anything docked. The transcript is
tight: 14px prose on 22px lines in a 768px column, the person's words in a
soft bubble on the right, the model's as plain text on the left, its actions
clumped into one muted 28px line per paragraph whose rows hang under its
words when it opens, with no box around them. Colour means something or is absent: amber when the
person is needed (and on the context meter from 85% full), red when
something failed, green for lines added, the one
blue accent for links and focus, and a thread's type on its glyph alone.
Motion is short, physical and interruptible;
nothing bounces, glows, slides in from nowhere or stays on screen when it is
done.

## The one standard

Kobra (kobra.systems) on Base UI is the component library. Every button,
field, menu, popover, dialog, sheet, tab, switch, tooltip, list row, empty
state, spinner, skeleton, question card and task list is the
component under `src/renderer/src/components/ui`, adapted once at install
to the tokens below, to `chrome/icons` and to the motion values below.
The README's table is the authority on which component renders which class
of element; nothing is rendered twice by two different things.

What this standard retired is gone: the old drawer, settings shim, rail and
composer action buttons and motion button, the four custom toast stacks
(sonner), the nine spinner builds (`Spinner`), the twenty status-to-colour
maps (`StatusMark`) and every raw button (`Button`, `ItemButton`). ReUI, BeUI
and Beautiful UI are no longer sources; their registries are gone from
components.json. `lib/motionGuard.test.ts`, `lib/colourGuard.test.ts` and
`domTitles.test.ts` keep it that way.

Hand-made and staying so: the transcript's rows and markdown pipeline, the
composer's field, the rail, the tab strip, the editor, the terminal, the
charts (`aliax/charts`, on recharts and the `--chart-1..4` tokens). They are built from the components above wherever they have a
button, a menu, a field or a status.

## Tokens

The token layer is the top of `src/renderer/src/index.css`. Nothing in
`src/renderer` writes a literal colour, duration or curve; a new value is a
new token, named for its use, added there first.

### Colour

Dark is the default theme; `html.theme-light` is the light one (`dark:` in
a class means the default). One neutral palette; there is no hue, saturation
or glass setting any more.

| Token | Use | Dark | Light |
| --- | --- | --- | --- |
| `sidebar` | the rail and the title bar | oklch 0.17 | oklch 0.972 warm |
| `background` | content | oklch 0.195 | white |
| `card` | a bounded region inside content (a card, a transcript action list) | oklch 0.225 | oklch 0.985 |
| `popover` | every floating layer: menu, popover, dialog, sheet, tooltip (light) | oklch 0.24 | white |
| `muted` | a hovered or highlighted row, a track, a key cap | oklch 0.275 | oklch 0.955 |
| `sidebar-group` | a group's resting fill in the chrome (a project card in the workspace column) | oklch 0.213 | oklch 0.961 warm |
| `sidebar-group-hover` | that group hovered | oklch 0.244 | oklch 0.95 warm |
| `sidebar-group-selected` | that group selected | `muted` | oklch 0.94 warm |
| `secondary` | the secondary button | oklch 0.29 | oklch 0.94 |
| `border` | every hairline | white 9% | black 8% |
| `input` | a field's border, a switch's off track | white 12% | black 12% |
| `foreground` | text that matters | oklch 0.93 | oklch 0.2 |
| `muted-foreground` | text that supports it | oklch 0.68 | oklch 0.5 |
| `primary` / `primary-foreground` | the one primary button per surface, a checked box, a switch on | near-white / near-black | near-black / white |
| `accent` | links, focus rings, the rare call to action | blue 62% | blue 48% |
| `warning` | the person is needed; the context meter from 85% full | amber | amber |
| `destructive` | failed, delete | red | red |
| `success` | lines added, passed | green | green |
| `info` | the one informational tint | blue | blue |

The status colours (`success`, `warning`, `destructive`, `info`) are text
as often as fills, so each reaches 4.5:1 as small text on `background`,
`sidebar`, `card` and a selected (`muted`) row in both themes; the light
theme's are the darker steps for that (`lib/statusContrast.test.ts`).

The `sidebar-group` steps are a container's surface, never an item's: a
thread row stays bare in every list. They are opaque steps away from
`sidebar`, each at least 0.01 of OKLab L past the one before and the
selected step the farthest, with both inks at 4.5:1 on each
(`lib/sidebarGroup.test.ts`). Light's ladder is narrow: its selected step
stops at L 0.94, where amber text still reaches 4.5:1; under it amber falls
short. The amber, red and green text a card carries reaches 4.5:1 on all
three; the info blue never sets text in the workspace column and is held to
the 3:1 glyph bar there, since its 4.5:1 would need L 0.953 and leave no room
for three steps under the sidebar.

### Type tints

A thread's type has one colour, and only its glyph takes it: never a title,
a label, a fill or a border. `TypeGlyph` (surfaces/threads/TypeGlyph.tsx) is
the one thing that draws a type's glyph, and a menu row naming a type uses
`THREAD_MENU_ICONS`. The tints are v1.0.303's, held as literals so a status
colour's retune never moves a type.

| Token | Type | Dark | Light |
| --- | --- | --- | --- |
| `type-chat` | chat | `#60a5fa` | `#2563eb` |
| `type-planning` | plan | `#a78bfa` | `#7c3aed` |
| `type-project-plan` | project plan | planning's | planning's |
| `type-implementation` | implementation | `#34d399` | `#059669` |
| `type-orchestration` | orchestration | `#cedd59` | `#7d6700` |
| `type-research` | research | `#22d3ee` | `#0891b2` |

Orchestration was amber at v1.0.303, the same amber as Needs you; it now
sits 31° (dark) and 42° (light) of OKLCH hue from `warning`. The rule, held
by `lib/typeTint.test.ts`: each tint reaches 3:1 (the non-text bar) on
`background`, `sidebar`, `card` and `muted` in both themes, and stands at
least 30° of OKLCH hue from `warning` and `destructive`. Light
implementation (3.30) and research (3.23) are under 4.5:1, which is why no
text may take a type tint. A glyph is always tinted, on an active chip or
an idle one; a row's own dimming (offline, disabled) dims it with the row,
and it never brightens to mean active.

Opacities on `foreground` are the hover vocabulary: `/5` a hovered row,
`/7` a hovered ghost button, `/12` a pressed one. Status colours never fill
a surface above `/10`.

### Type scale

| Size | Where |
| --- | --- |
| 11px | a key cap, a group label in a menu |
| 12px | secondary lines in the chrome, descriptions under a title, status words, a count in a row's status line |
| 13px | the chrome's default: rows, menus, buttons, fields, tabs, settings, a tooltip (regular, 20px lines); the transcript's action, thinking, notice and closing lines (20px lines in 28px rows, 26px hung in an open group) and their counts (`+46 −3`) |
| 14px | dialog and panel body text, an Item's title; the transcript's prose, the person's bubble, a question's prompt and the composer's field (22px lines) |
| 15px | an h2 in the model's prose |
| 16px | a dialog or sheet title (semibold); an h1 in the model's prose |

Weight and colour make the hierarchy, not size jumps: a title is `font-medium`
foreground, its detail `muted-foreground` at the next size down. Code is the
mono face one size below its surroundings. Tracking: `-0.01em` from 16px
up, none below. Numbers in tables and tallies are `tabular-nums`.

### Spacing

The 4px grid. Inside a row: 8px between glyph and label, 12px horizontal
padding, rows 28px tall in menus, dense lists (search results among
them: one line each) and `RailRow` (the rail, whose workspace rows sit
4px apart on `sidebar-group`, and the settings list), 32px for the thread rows of the workspace
column's Chats and Archived folds and 28px for the rows nested under them.
A project card in that column sits on `sidebar-group`: a 20px name line, a
16px branch line 2px under it, 24px read-only thread lines, and cards sit 4px
apart. The Chats and Archived folds under the cards start 16px below them, a
new group. Every menu, context menu and
select row takes its box from `MENU_ROW` (components/ui/menu-row.ts,
exported by dropdown-menu.tsx). Between groups in a panel or page: 16px; between sections: 24px.
A panel's inset is 12px; a dialog's 20px. Never a value off the grid.

### Radius ladder

`sm` 4px a key cap, a checkbox; `md` 6px a row's hover, a small button;
`lg` 8px a button, a field, a menu row, a card inside content;
`xl` 12px a popover, a card that stands alone, the composer; `2xl` 16px a
dialog, a sheet; `full` a switch, an avatar, a pill. Nested radii are
concentric: the inner radius is the outer minus the padding.

### Shadow

`shadow-overlay` on floating layers only (menu, popover, dialog, sheet).
Docked chrome and cards have no shadow; their depth is the gray step and
the hairline. The one exception is a raised button (`default`, `secondary`,
`destructive`): it carries its own stack, a lip, an edge and a soft drop
(`--raise-primary`, `--raise-secondary`, `--raise-destructive`, with their
`-lit` and `-lifted` steps, a value per theme), on a fill layer behind its
label (`.t-raise` in index.css). A raised button never sits inside an
`overflow-hidden` box that would clip its drop; a clip the content needs
goes on an inner span.

### Scrollbar

`--scrollbar-thumb` (foreground at 20%), `--scrollbar-thumb-hover` (32%)
and `--scrollbar-thumb-active` (40%) colour the pill; `--scrollbar-size`
(10px) is the strip; `--scrollbar-inset` (0) is the track's end margin, set
to its radius by a rounded scroller. They follow `--foreground` into the
light theme. "Scrolling" has the rule.

### Motion tokens

CSS `--dur-hover` 60ms (a button's hover fill; a menu row highlights at once), `--dur-fast`
120ms (press, every exit, every reduced-motion fade), `--dur-base` 180ms (menu and popover entrances; folds),
`--dur-slow` 240ms (dialog and panel entrances), `--dur-drawer` 300ms (a
sheet). Curves: `--ease-out` for entrances and most transitions,
`--ease-exit` for a closing overlay, `--ease-drawer` for a sheet,
`--ease-in-out` for a symmetric move. Springs live in `lib/ease.ts`:
`SPRING_PRESS` (press only), `SPRING_LAYOUT` (the tab indicator, icon
swaps), `SPRING_PANEL` (a row morphing into a card), `SPRING_GLIDE` (a
released drag). `springEasing` turns a spring into a CSS `linear()` curve
and its settle time (`SPRING_LAYOUT_CSS`: 370ms, no overshoot), for a
transition that glides like the spring without JavaScript; the same curve
is a token, `--dur-layout` on `--ease-layout` (the folds that open on their
own), held equal to it by lib/ease.test.ts. Code that drives motion itself
(the transcript's scroll glides) reads a curve through `cubicBezier`. The
stream's reveal is `REVEAL` (a step of whole words every 100ms, each fading
in over `--dur-reveal` 400ms on `--ease-reveal`, linear). A hover-revealed
control waits `--delay-hover` 100ms before it shows. `FOLD_HOLD_MS` (600ms) is the beat a
working group stays open after its work moved on. The word morph
(`MorphText`) leaves over `--dur-swap-out` 90ms and arrives over
`--dur-base`, both on `--ease-swap` (`cubic-bezier(0.2, 0, 0, 1)`,
`EASE_SWAP`), which also glides its box's width and slides the closing
line home.
`lib/motionGuard.test.ts` fails on any literal duration or curve outside
`lib/ease.ts` and this layer; its script and CSS allow-lists are empty.
Three things loop, each a Web Animation of `transform` alone that the
compositor runs: the spinner's 900ms turn (`SPINNER_TURN`, on the box
around the arc), the working mark (`MARK`: three dots that gather and part
every 1.6s, each segment on `--ease-breathe`) and the working words'
shimmer (`SHIMMER`: a bright band crossing the words every 3s, held off
them until 15% of the period and swept to 85% on Claude's shimmer curve).
The mark and the shimmer start at 0 on the document timeline, so a remount
picks the gesture up where it was.

### Layers

`--layer-dialog` 90, `--layer-popover` 95 (menus, popovers, selects:
above a dialog so a picker inside one is never hidden), `--layer-toast`
100, `--layer-tooltip` 110.

### Focus

One ring: index.css draws a 2px `accent` outline inset 2px on every
button, link, option, menu item and tab, unlayered so it beats a utility's
`outline-none`, and so a row in a tight list never clips it. An element it
does not name (a scroll region, a `pre`, a `div` with `tabIndex`, a checkbox
root) takes `focus-ring`, the same outline. Nothing draws a second band
(`focus-visible:ring`); a field keeps `focus-field`. `lib/focusGuard.test.ts`
holds it.

## Typography and text hierarchy

Hard rule: no bullet points in the UI. Lists of bullets in a panel, a card,
a settings page, a notice or a transcript row are a smell; the one place a
bulleted list may stay is a markdown list the model wrote in its answer.

What to do instead: a group of related facts is set apart by text hierarchy
and space, not by glyphs or separators. A status is a `StatusMark` (glyph,
word, tone) on its own line or at the end of the title line. A detail line
sits under its title in `muted-foreground` at the next size down, with 2px
between them. A secondary line sits 4px below the detail in the same muted
tone, or at the end of the row in `tabular-nums` when it is a count or a
time. Groups are 16px apart; a group that needs a name gets a short
`font-medium` heading in 12px `muted-foreground`, never a label with a
colon. Two facts on one line differ in weight and colour, never only in
the space between them: a state's word in medium weight and its tone, then
its detail in regular weight and `muted-foreground`, 6px after it (two
spans, `StatusMark`). Where one plain string is unavoidable (a tooltip, an
accessible name, a toast, a notification) it is "Word: Detail"
(`plainStatus`, src/shared/statusWords.ts). No visible text separates two
facts with a run of spaces, a middle dot, a pipe or a bullet;
`lib/spaceGuard.test.ts` fails on a run of spaces in any renderer literal.

Other rules: nothing is said twice (a count in the title is not repeated in
the body); nothing is explained that the layout already shows; labels are
nouns, buttons are verbs; a chip or badge exists only when it carries a
state the row cannot otherwise show, and never beside a title.

## Status vocabulary

`StatusMark` (components/ui/status.tsx) is the only status-to-glyph, -word
and -colour map. Every rail row, tab, strip, board row, card and the phone's
rows say exactly this:

| State | Glyph | Word | Tone |
| --- | --- | --- | --- |
| working | the spinner | Working | foreground |
| waiting | a dot in a ring | Needs you | amber |
| paused | two bars | Paused | muted |
| failed | a ring with a bang | Failed | red |
| queued | a dashed ring | Queued | muted |
| stopped | a square | Stopped | muted |
| watching | a ring | Watching | muted |
| plan-ready | a page | Plan ready | muted |
| done | a check | Done | muted |
| idle | a faint ring | Idle | muted |

Working drawn under a row that already moves (`StatusMark still`) is a 6px
dot in the working tone, never a still arc: a frozen arc reads as a spinner
that hung.

The word may be followed by what the state is about, drawn as a second
span in regular weight and muted, 6px after the word: Working then
"Editing Rail.tsx", Needs you then "Approve Bash", Watching then "3
subagents", Failed then "Usage cap". The host sends the detail on its own
(`SessionMeta.statusDetail`); `activity` keeps a legacy two-space string
for old readers and is read only when the detail is absent. A watching
thread always says what it watches; a row that cannot say is a bug. A
thread idle or done whose subagents still work is watching them (Watching
then the one subagent's title, "Review the perf pass", or "3 subagents") in the transcript's closing line,
the tab, the chip and the rail alike, and the fleet header counts watching on its own. `threadStatus` (lib/threadStripModel.ts) is the one
place that decides a thread's state and its detail, the tree's overrides
included, and `ThreadStatusMark` (chrome/TabIndicator.tsx) draws it with the
round's tally 8px after the detail. A watching thread on one task names it
in the model's words (Watching then "sleep 45 seconds"); more than one is
counted (`watchPhrase`, src/shared/watch.ts). A turn a wait_for_agent holds
says what it waits on by title, Working then "Waiting on Review the perf
pass" or "Waiting on 2 subagents" (`waitLine`), on the transcript's working
line and in the host's detail alike.

The slot above the composer (surfaces/threads/WorkingStrip.tsx, reserved
at 28px so nothing moves when a turn starts or ends) holds the open turn's
elapsed time and Stop, nothing else, and the held states with their
actions: Paused with Stop and Continue, Stopped with Resume (the harness is
gone), Queued with Start now. What the thread does is the transcript's
working line, a pending approval or question is its card, and a watching
thread's state is the transcript's closing line (Watching then its age,
amber past 30 minutes, opening the Activity section); nothing above the composer
repeats the working line, and no banner repeats the slot. A person's Stop
idles the thread, the slot empties and the transcript's Stopped line says
so once. A first response is said in the transcript's working line, never
above the composer: Sending from the click until the host echoes the
message, then the host's word for the wait (Starting the CLI, Initializing,
Waiting for the provider, a retry, "Waiting for the provider, 25 s"), then
Thinking with the summary's newest sentence once the thought streams, then
the running call ("Reading format.ts", "Running the tests", "Waiting on
Review the perf pass"), and the mark alone while prose streams
(`workingPhase`). A phase stays at least 300 ms once it paints and one that
came and went inside that hold never shows; the words shimmer, and a change
morphs them (the old words lift 3px and leave, then the new ones rise from
3px below as the box glides to their width), in the row's 28px, so nothing
below it moves. The timer above the
composer counts from the click and never steps back when the host's own
start arrives.

A detail is sentence-cased when it is a sentence ("Waiting for memory",
"Approve Bash", "Landed 12:08", "The harness is gone") and written as it
is when it is a name or a count ("3 subagents", "sleep 45 seconds",
"Rail.tsx"); it never ends in a full stop and never repeats the word. A
phase keeps its comma inside the detail ("Rate limited, retry 3 in 32
s"): prose punctuation within one fact, not a joiner between two. The
renderer never changes a detail's case; only a detail read from an old
host's legacy `activity` takes a capital (`legacyDetail`).

At rest a row draws no mark for idle and done (`marksAtRest`): a mark that
would only say "nothing is happening" is noise. The one exception is the
right panel's Agents rows, where done's check leads a finished agent: the
panel has no other cue for what is done, and seeing it at a glance is the
section's job. A tab is the glyph alone;
its hover line and the transcript's working line say the word and the rest.

Nothing loops. Every status glyph is still except working's spinner, a
rotation and the one moving glyph. A row has one moving mark at most: a
line that depends on a row's own mark (a subagent's under its board row, a
batch thread's under its master in a project card, a spawned agent in the
transcript) draws working as the dot (`StatusMark still`), and a settled
row never moves. A master's line on a project card spins while anything in
its block works, whatever the master's own state (`MasterBlock.lead`), so a
block always moves while it works. In the transcript the one moving mark is
the working line's (`WorkingMark`, its three dots); a running row there
draws working as the dot. When a mounted mark's state changes into
working, waiting or watching its glyph breathes once (opacity over
`--dur-slow`); under reduced motion it does not. Every other change is
instant.

## Panels, modals, menus, popovers, sheets

The right side is one panel, one width (320px, resizable), one header, with
sections that exist only when they have content (Activity, Agents, Changes,
Notes) and a segmented control of icon segments that lists only those
sections, each named on hover and by its accessible name; its default
section follows the thread's state. An Activity row, folded, is one 28px line
of plain words (glyph, label, age, Stop); a shell's command shows only in
its fold, as the first line of its output. It yields to the thread, which never
goes under 360px beside it. It is a docked column, not a drawer or
a sheet, and it never animates its width (it toggles; the content fades
over `--dur-fast`). The bottom dock holds the terminal and the dev servers
pane. Nothing else floats at the side of a thread.

A modal (`Dialog`) is for a form, a CRUD action or a decision that needs the
whole screen's attention; it never holds a list that could be a panel. A
confirm (`AlertDialog`) is for destructive, irreversible actions only, with
one title, one line and two buttons; code that must ask first awaits
`useConfirm()` (chrome/ConfirmDialog.tsx), never `window.confirm`. A
confirm never holds a checkbox: a destructive decision with options is a
form `Dialog` with its `CheckRow`s and the red verb in its footer (Delete
project with cleanup or other copies). A thread's resources are a removal
form of that kind; its dev servers live in the Activity section and the
dev servers pane, never in a dialog.
`chrome/Modal.tsx` and `chrome/ConfirmDialog.tsx` are thin shells on
`Dialog` and `AlertDialog` for their existing callers. A sheet is for a long form or picker
that would not fit a dialog. A menu (`DropdownMenu`, `ContextMenu`) is
verbs; a popover is content (a picker, a preview, a list of accounts). A
menu's rows are `MenuRow` data rendered by `RowsMenu` (from a trigger) or
`RowsContextMenu` (one per list, at the pointer), each row a 14px glyph, a
label and the key cap of a real binding (`shortcutFor`); the window's menu
bar alone is words and keys. Menus come in one size: the row of "Spacing",
in the dropdown and the context menu alike. A thread offers the same rows on every
surface (lib/threadMenu.ts). Menus and popovers load with their first use,
out of the first paint (chrome/menuRows.tsx). A label on hover is `Tip` or
`TruncateTip`, never a `title=`. A
popover scales from its trigger; a menu scales from its trigger; a context
menu fades at the pointer; a dialog rises 4px and fades; a sheet slides 16px
from its edge. Every one of them exits in `--dur-fast`, back a quarter of
the way it came, and keeps its direction. Under reduced motion they cross-
fade in `--dur-fast`; nothing appears in one frame.

A page (Settings, Accounts, Stats) is `Page`, `PageSection` and `PageRow`
from `components/page.tsx`: a 672px column with a 24px inset, one 16px
semibold title with a 12px muted line under it, sections 24px apart, each
under a 12px medium muted heading with 8px to its first row, rows 12px top
and bottom with a hairline between neighbours and never a box. A row's
control is one `Switch`, one `ChoiceSelect`, one `Input` or one `Button`;
a loading value is a `Skeleton` in its shape, an error a red 12px line
under its row. A section loaded from a host waits for the socket to open,
asks again on every new socket until it has answered, and past 10 s says
"The host did not answer" with Retry (lib/connection/openRead.ts); a late
answer still lands. A row with a second action gives it its own row or
opens a dialog: Linear's key field sits behind Connect…, and the release
notes are a row under Release, whose one button is the updater's. Switching pages does not animate.

## Scrolling

Every scroller is a native element with `overflow-*-auto`, and one rule in
`index.css` draws its bar on every platform: an invisible track and a 6px
pill on `--scrollbar-thumb` in a 10px strip. The pill hides at rest and
shows while the pointer is over the scroller or while it scrolls
(`lib/scrollActivity.ts` marks a scrolling element `data-scrolling` and
clears it `SCROLL_IDLE_MS` after the last scroll); Chromium cannot fade a
scrollbar, so it shows and hides at once. There is no scroll-area component.

A rounded scroller sets `--scrollbar-inset` to its radius
(`[--scrollbar-inset:var(--radius-xl)]` on a menu), so the pill never runs
into a clipped corner. One region has one scroller: a dialog scrolls its
body or its list, never both (the Modal body is a flex column, so a list
marked `min-h-0` shrinks under its cap first); the only nested scroller is
a bounded log or code console. A vertical list says `overflow-x-hidden`
beside `overflow-y-auto`, so a 1px overhang never raises a sideways bar; a
horizontal bar appears only where content overflows. A pure text region
(notes, a log, the preamble preview) takes `tabIndex={0}` and the focus
ring (`focus-ring`), so the keyboard reaches it. Where a first overflow must not shift
the content (the transcript, the pages) the scroller reserves its strip
with `scrollbar-gutter: stable`. Nothing sets `scrollbar-color` or
`scrollbar-width` but `.scrollbar-none` (tab strips scrolled by wheel):
either one makes Chromium drop the rule. Monaco and xterm draw their own
bars and take the same tokens through their themes, the same sizes through
their options and `index.css`.

## Iconography

`@renderer/chrome/icons` (Hugeicons under lucide names), 16px in rows and
buttons, 14px in dense chrome, 12px as a mark beside text, 1.5px stroke,
`currentColor`. The stroke is the icons' default (`ICON_STROKE`, held to
this line by chrome/icons.test.ts), so no call site writes 1.5; a glyph that
reads too thin takes the next size up, never a heavier stroke. An icon never carries meaning alone where a word fits; a
tool row in the transcript keeps its tool icon beside its humanized verb.
Two glyphs carry colour: `StatusMark`'s, for a state, and the type glyph
(`TypeGlyph`), in its type's tint ("Type tints"). Every other glyph is
uncoloured: a subagent's role glyph (`AGENT_GLYPHS`), a tool's, the host's.
The host glyph (chrome/HostGlyph.tsx) stays as it is: 12px, uncoloured, the
name on hover, drawn only with two or more hosts.

## Loading and empty states

A surface that waits shows a `Skeleton` in the shape of what is coming when
the wait is a load, and a `Spinner` with a word ("Loading…", "Starting…")
when it is an action. A list with nothing in it shows one `Empty`: a title,
one line, at most one action; never an illustration or a dashed box. A
list the person narrowed (a typed filter, the filter menu) says so in that
line and offers Clear filters as its action. A
section of a settings page with nothing in it shows one muted line in a
row's place (`PageEmpty`), never `Empty`: the section's heading is already
the title. A
new thread (a draft) shows the composer and nothing else, and so does a
project with no thread on screen: its draft, the composer alone, with no
chip, badge or heading for it; a thread its host holds with no rows shows
the composer under one muted line (the host's failure summary, else "No
messages yet"), never the new-thread screen. Inside a picker
or menu, no match is one muted row, never `Empty`. A lazy surface falls back
to a `SurfaceSkeleton` kind, and a small section's wait is `LoadingLine`
(both in surfaces/SurfaceSkeleton.tsx, beside `EmptyState`). Text that is
being produced shimmers (`WorkingText`); nothing else does.

## Motion values

| Surface | Enter | Exit | Reduced motion |
| --- | --- | --- | --- |
| Dialog | fade + scale 0.95→1 + rise 4px, `--dur-slow` `--ease-out` | fade + scale →0.98, `--dur-fast` | fade only |
| Sheet | fade + slide 16px from its edge, `--dur-drawer` `--ease-drawer` | fade + slide 16px back, `--dur-slow` | fade only |
| Popover, menu, select | fade + scale 0.95→1 from the trigger, `--dur-base` | fade + scale →0.98, `--dur-fast` | fade only |
| Context menu | fade at the pointer, `--dur-fast` | fade, `--dur-fast` | same |
| Tooltip (13px regular on 20px lines, 24px tall) | after 300ms (`TOOLTIP` in lib/ease.ts), fade + scale 0.98→1, `--dur-fast` `--ease-drawer`; neighbours in one `TooltipProvider` (a closing line's or a notice's actions, the title bar's groups, a split view's header, a rail row's hover actions) open at once within the 120ms grace, the label moving instead of reopening | fade + scale →0.98, `--dur-fast` | fade |
| Toast (sonner) | rise and fade, `--dur-base` | fade, `--dur-fast` | fade |
| Right panel, rail | no width animation; content fades `--dur-fast` | same | same |
| Tab indicator | segmented: the pill glides on `SPRING_LAYOUT_CSS` (`TabsIndicator`); line tabs and the tab strip: instant | — | jump |
| Press, a raised button (`default`, `secondary`, `destructive`) | its fill layer scales 0.985 (0.997 × 0.985 full width) while the label stays put, `--dur-fast` | release, `--dur-hover` | none |
| Press, ghost, link, outline and every row (a rail row, an Item, a toggle, a tab, a hover action) | the fill steps to `foreground/12` at once; nothing scales | back over `--dur-hover` | same |
| Hover fill (a button; a menu row and a rail row highlight at once; a raised button lightens, and secondary lifts its shadow, over `--dur-fast`) | `--dur-hover` | `--dur-hover` | same |
| Hover reveal (a closing line's actions, a message's Copy, a code block's and a tool output's Copy, an Agents row's Open and Stop over its model mark) | waits `--delay-hover`, then fades in `--dur-fast`; keyboard focus shows it at once | fades `--dur-fast`, at once | same |
| Fold (collapsible) | height, `--dur-slow` `--ease-out` | height, `--dur-base` | opacity |
| Fold that opens on its own (`.collapsible-auto`: the transcript's working group, the running task's steps, the title bar's shelf) | height on the layout spring (`--dur-layout` `--ease-layout`) + opacity `--dur-base` `--ease-out` | the same, so the rows are gone before the box closes | opacity, `--dur-fast` |
| A step landing in it (`.step-land`) | fade + rise 4px, `--dur-base` `--ease-out`; only a step that lands while the fold is open, never at mount, on a hand open or when a panel unhides | none | none |
| The working group's rows, opening on their own | glide 22px from the prose edge into their hang (translate), on the layout spring | — | none |
| The working group's window (its newest five rows) | the oldest row leaves the top as the list glides up by its measured height, `--dur-base` `--ease-out` | — | none |
| The working group's fold | waits `FOLD_HOLD_MS` once the work moved on, so the last row's settle shows, then folds on `.collapsible-auto` | — | the same wait, then the fade |
| Disclosure chevron | rotates with its fold, `--dur-base` `--ease-out`, everywhere | same | none |
| Icon swap (`SwapIcon`; keyed for more than two states, as a tool row's waiting, working, failed and icon) | opacity + scale 0.25→1 on `SPRING_LAYOUT` | fade + scale →0.25, `--dur-fast` | opacity, `--dur-fast` |
| Word morph (`MorphText`: a row's verb or a group's phrase changing tense, the working line's phases, the working line becoming the closing line) | only once the old words have left: the new rise from 3px below, `--dur-base` `--ease-swap`, while the box glides from the old width to theirs (a Web Animation from its live width when cut short); never on mount or for new words under one key | the old words lift 3px and fade first, `--dur-swap-out` `--ease-swap`; never two words in one place | fade out, then in, `--dur-fast`; no glide |
| Scroll glide (jump to latest, a burst while following, a jump to a row) | `DUR.drawer` on `EASE_OUT` | — | instant |
| Park on send (prompt to top) | the transcript glides to park the prompt, `DUR.drawer` on `EASE_DRAWER`; from more than 2.5 screens away it jumps to within 2.5 screens first, as every long jump does | the parked runway retires over `DUR.base` on `EASE_OUT` | instant |
| Jump to latest button | fade + scale 0.95→1, `--dur-base` `--ease-out` | `FADE_OUT` | fade |
| Count | ticks from the shown value, `--dur-slow` `--ease-out` | — | none |
| Shimmer (`WorkingText`) | a masked band and a bright copy of the words (the band's `::before`) cross them in opposite directions, transform only, every 3s (`SHIMMER`); not mounted in a hidden pane or document | — | still muted text |
| Working mark (`WorkingMark`, the working line's glyph) | three 3px dots gather into one and part every 1.6s, transform only (`MARK`); enters and leaves as an icon swap does | — | the three dots at rest |
| The working line settling | the mark leaves as an icon does, the words morph into "Worked for 2m 4s" (or Stopped) and slide from the glyph slot to the prose edge, 22px, `--dur-base` `--ease-swap`; the hover actions mount | — | the morph's fades; no slide |
| Spinner | the one arc turning | — | still |
| Appshot | fade + scale 0.95→1 centred, `--dur-slow`; holds; glides into its chip, `--dur-drawer` `--ease-drawer` | — | fade in and out in place, `--dur-fast` |
| Released drag | settles on `SPRING_GLIDE` | — | none |
| Scrollbar | shows at once on hover or scroll | hides at once, `SCROLL_IDLE_MS` (900ms) after the last scroll or when the pointer leaves | same |
| List rows (rail, tabs, fleet, attachments, the transcript's message list) | none | none | none |
| Transcript rows | one `--dur-fast` fade on first appearance, never replayed | — | none |
| Streaming text | the prose: the jitter buffer (surfaces/smoothText) steps whole words every 100ms (`REVEAL.stepMs`), holding a bare block marker and a table's header row until they have content; each step is one span fading in over `--dur-reveal` on `--ease-reveal` (lib/streamReveal.ts, `.stream-step`), and the settle waits for the last fade; a live short line (the working line's newest sentence of a thought) takes the same fade in `StreamingText` | — | whole-word steps, no fade |
| Composer send | the bubble rides with the content as the prompt parks, rising 16px and fading in, `--dur-slow` `--ease-drawer`; in follow mode it flies from the field only when it lands within 240px of it | — | fade, `--dur-fast` |
| Composer field height | snaps on a keystroke and on the clear after a send; a change of more than one line the person did not type (a paste, a restore, a quote) eases over `--dur-base` | — | snaps |
| Composer, a new thread's first send | the box keeps its width and moves into its docked place (a FLIP translate, `--dur-slow` `--ease-drawer`) | — | none |
| Pane switch | opacity, `--dur-fast`; no rise | — | none |

Rules: animate `transform` and `opacity` (and height only through the
collapsible); every animation is interruptible and starts from the current
value; nothing animates on a keystroke; nothing overshoots without a
gesture; every animated class carries its `motion-reduce:` guard.

## The transcript

The target is Claude desktop's Code tab with our tool icons and humanized
names kept (the plan at .temp-code/plan-h5M-bmLmzYd4.md fixes the rows,
.temp-code/plan-zY_qkaKjrxzL.md the metrics and the motion). It is tight: a
768px column (`COLUMN_MAX_PX` in surfaces/transcriptOutlineModel.ts) inside
the scroller's 16px gutter, the composer flush with it in every placement,
the root in the sans face at 13px. Whatever sits on the column (the working
strip, the load line, the no-rows line, an orchestration's fleet header, the
transcript skeleton) takes `COLUMN_MAX_CLASS`, never a width of its own; a
test refuses the old 896px anywhere in the renderer.

The composer is one row in its box, as Claude's: the `+` menu (28px) at the
left, the field, Send (a 28px circle) at the right, 6px from the sides and
8px from the top and bottom, so the empty box is 46px with its hairline. The
field's first line is centred on the controls' 28px line; each further line
grows the box upward by 22px while its bottom stays, and the controls stay
on the bottom line. Under the box, 4px below it, a 24px row holds the model
at the left and the context meter and the permission mode at the right,
ghost controls in 12px muted text; it is always there, so nothing moves on
focus, and at a narrow width it gives way in order (the meter's percent,
then the model's effort, then the mode's label, then the model's name,
leaving their glyphs). The empty thread's composer and the docked one are
one class chain.

| Element | Size / line |
| --- | --- |
| The prose, the person's bubble, a question's prompt, the composer's field | 14px / 22px |
| A line: a group's line, an action, a thought, a notice, an approval, the closing line | 13px / 20px in a 28px row, 26px hung in an open group; the glyph in a 14px slot, 8px to the words, so words start at 22px |
| Counts (`+46 −3`, a failed tally) | the text's size (13px in a row and on the group line) `tabular-nums`; the failed mark 4px from its number |
| Code in a row's body: a command, its output, a diff | 12px / 20px mono |
| A code block in the prose | 13px / 20px mono |
| Inline code | one pixel under its text (13px in the prose), `rounded-sm bg-muted` |
| Headings in the prose | h1 16px / 24 semibold −0.01em; h2 15px / 22 semibold; h3 to h6 14px / 22 semibold |
| A table's cells | 13px / 20px, 36px rows |

The gap belongs to the boundary between two rows, never to a row:
`transcriptRows.ts` gives each row its `gap` from the row before it, and a
row that draws nothing takes none. 16px before the first row; 32px from the
previous turn to a turn's first row; 16px from a bubble to its first reply
row; 12px between two blocks (prose, a bubble, a card) or a block and a
line; 4px between two lines; 8px from the last item to the closing line;
8px under "Load earlier messages"; 16px under the last row. Inside the
prose (surfaces/transcript/markdown.css): 12px between blocks, 4px between
list items and into a nested list, 20px above a heading and 4px under it,
20px around a rule, 8px between two paragraphs in an item or a quote; a
list hangs its text at 22px, like a row's words.

The lines that remain: the hairline of one card (a row's opened body, a code
block, a table, a question, failure or held-review card, the composer), the
rules between a table's rows and the title bar's bottom border. None between
turns, none between rows, none inside an open group. A blockquote is a 2px
`border` line with muted, upright text; a table's header has no fill.

The person's message is a right-aligned bubble (`card`, `rounded-xl`, 12/8
padding, at most 85% of the column) with no avatar or timestamp, its
preamble line 4px above it. A message the person sent into a running
turn (a steer) carries one 12px `muted-foreground` word under the bubble at
its right edge, Sent, Received or Queued for the next turn, or Not
delivered in the red tone; its time is in the word's tooltip, never in the
flow, and a word that changes on screen fades in on `--dur-fast`
(transcript/UserMessage.tsx `SteerLine`). The model's prose is plain text.
Between paragraphs, the actions since the last paragraph are one muted line
("Created diag.ts, ran a command  +46 ▾") that opens into one row per action
hung 22px under it, so a row's glyph sits under the line's words, with no box
and no rules ("Created  diag.ts  +46 ▸", "Ran  npx convex dev…  ▸", "Read
types.ts ▸"), verb muted, object in foreground, counts green and red, a
caret per row. Every row of the list sits on one grid (transcript/stepLine.ts):
glyph, verb, target, counts, extras, caret, each slot only when it has
something and 8px apart, 26px a row; a call that names nothing reads its
verb alone ("Ran a command"), a connector's call names the connector
("Cosmic Admin  Build get"), a todo update's tally sits muted in the counts
slot, and a host step folded in reads verb then target like a call. A row's opened body is one card (a hairline, `rounded-lg`,
`bg-card`, 12px inset, from the row's glyph to the column's end); an edit's
diff takes the same card with its tints running to its edges. A lone command
opens a card headed by its tool name with the command in mono and its output
under it. An output shows whole, never cut: past 320px (`max-h-80`, sixteen
20px lines) it scrolls inside its own box, the one nested scroller "Scrolling"
allows, with no fill of its own (it sits in the card) and no "N more lines";
its Copy shows at the box's top right on hover and takes the whole output.
The box's cap is its row's height once open: the window measures it like
any row, with no containment. File changes keep their counts on the line and their diff behind
the caret.

The group the turn is working in opens on its own once it holds two calls:
the line folds open above the first row and the rows glide into their hang.
While it works it shows its newest five rows, the line still naming them
all, the running ones included; a call still running is no row (the working
line under the turn says it) and lands as a past-tense row once it settles.
When the work moves on (the model writes again, or the turn ends) it waits
`FOLD_HOLD_MS`, its last row landing, and folds. A person's hand decides for
that group from then on: toggling its line or opening a row's body inside it
ends the automatic open, window and fold, and a group opened by hand shows
every row, its thoughts among them. A step waiting on the person keeps it open; a paused turn holds it
as it is; a group that mounts while working shows open with no motion, one
that mounts settled shows closed. Live
background work is the right panel's Activity section; a task that settled
is one step of the run it woke ("Task finished  deploy the preview"),
never a row of its own. No timestamps
in the flow; the closing line says what the turn took and nothing else. A
live turn's time is the slot above the composer's: the transcript draws
the closing line once the turn is over, and a paused turn is not over (only
a surface with no slot, the fleet's agent detail, draws the live state as
its last row). A thread still watching ends in "Watching" with the watch's
age under its last closing line, on every surface; in a pane it opens the
Activity section.
An approval card carries the amber glyph and its two buttons, not the
word. A thought is no row: while it streams the working line says Thinking
and its newest sentence, and once it ends it shows only in a group opened
by hand, as "Thought ▸" with no duration, which opens the text. Each live
turn ends in one working line, from Send to the turn's end: the working
mark, then the phase's words in the shimmer (one running call by its verb,
muted, and its object in foreground, with an edit's live counts, or a
chevron that opens a command's or a tool's body under the line). It hides
while a step waits on the person (the card says so), while the turn is
paused and after a Stop. When the turn ends it becomes the closing line,
which reads "Worked for 2m 4s", its copy, note, hand-off and second-opinion
buttons showing on hover or keyboard focus; a turn the person stopped
closes on "Stopped" instead, with the same buttons. Every notice (a gate, a review, a compaction, a
pass, a batch, a second opinion asked of another harness) is one muted
line with a glyph, a lead and its details; only a held review and a failure
are cards. A compaction is one line that counts from its start, takes
its outcome in place and reads "Compaction stopped" when its turn ended
without one. The host's steps of the agent's work fold into the run they sit
in, as calls do: a subagent spawned (on its call's row, one row per child
for a batch), each agent that settled ("Finished", "Failed", "Needs you",
"Stopped" or "Paused", then its title, behind the state's glyph), a
finished task, the check on idle tasks, a gate or release outcome, a review
that merged, the turn pass, the plan's build hand-off, a merge the batch
made. A held review, a failure, Stopped, compaction, "Batch done" and
account-gone stay lines of their own. Every agent row names its agent by
title, the one bright text on its 28px line, and an open wait is no row:
the working line says "Waiting on <title>". A handoff keeps its bubble: its text is the person's brief. The
left side, where the column leaves room, lists the person's own messages,
one line and a clock time each, the one being read in foreground
(`TranscriptOutline` on `JumpList`; docs/LAYOUT.md "Chat"). A
question card sets the sans face; mono is for code inside it. Its question
is at the prose's 14px on 22px lines, its options 28px rows at 14px with an
option's description as a muted 13px line under it, and the amber Needs you
glyph sits by its title. Its frame is `CARD_SHAPE` (surfaces/QuestionCard.tsx,
shared with the held review), and inside a `bg-card` body it draws no second
frame. Every action
row ends in a caret: it turns on a row that opens a body and stays still on
one that opens its file.

## Restraint

No cards within cards. No glows. No decorative badges or chips. No
repeating the same data twice. No over-explaining: states are shown, not
narrated. No colour without meaning. No shadows on docked UI. No left colour
bar for focus or selection (a focused or selected row is a `muted` fill).
No bullet points in the UI. A toast never covers a control: the stack sits
8px above the focused thread's strip, 16px inside its column's right edge
and no wider than that column less 16px a side (`toastInset` in
components/ui/toaster.tsx, measured from the footer `ChatFooter` registers in
lib/toastAnchor.ts); on a master view whose chat is folded, 8px above the
board's foot (BatchFoot registers while the chat is folded, and a folded,
inert column seats nothing); and 16px from the window's corner where no
thread is focused. Confirmation dialogs only for destructive,
irreversible actions. Every spacing and timing value is a token we can name.

## Verifying without a dev instance

A renderer change proves itself with a jsdom DOM test beside the component
(`*.dom.test.tsx`, `NODE_ENV=test npx vitest run <file>`), the renderer
typecheck (`npm run typecheck:web`) and, for anything visual, a static
render through `html_preview` (render the component with
`react-dom/server`'s `renderToStaticMarkup` against `out/renderer`'s CSS,
or a hand-written HTML sketch of the same tokens). The one electron-vite
build per branch is for `bun run check:bundle`; the index chunk stays under
5 MiB + 16 KiB and imports no lazy surface statically; of Base UI only the dialog
is in the first paint (the tooltip defers its primitive, the menus and popovers
ride the menu chunk, and every select the select chunk: the composer's pickers draw
the same trigger until it lands, components/lazy-select.tsx).
