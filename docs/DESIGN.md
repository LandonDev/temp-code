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
clumped into one muted 28px line per paragraph whose rows open under it in
one hairline table, 32px a row, with rules between them. Colour means something or is absent: amber when the
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
| `popover` | every floating layer: menu, popover, dialog, sheet, the editors' widgets | oklch 0.24 | white |
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

The tooltip is drawn inverted in both themes: `foreground` fill, `background`
text. The dim behind a dialog or a sheet is `scrim` (black at 30% dark, 18%
light). An image's edge is `image-outline`, a 1px outline at 10% (white in
dark, black in light), on a thumbnail, the lightbox, the QR code and avatars.

The status colours (`success`, `warning`, `destructive`, `info`) are text
as often as fills, so each reaches 4.5:1 as small text on `background`,
`sidebar`, `card` and a selected (`muted`) row in both themes; the light
theme's are the darker steps for that (`lib/statusContrast.test.ts`).

The chart tokens (`--chart-1..4`, aliax/charts) colour thin marks, so each
reaches 3:1 on `background` and `card` in both themes
(`lib/chartContrast.test.ts`). Colour follows the entity, never its rank: a
provider keeps its slot on every chart (Claude `chart-1`, Codex `chart-2`),
a model takes its provider's slots (`chart-1` then `chart-3`, `chart-2` then
`chart-4`) and anything past them folds into Other in `muted-foreground`.
Every chart and the heatmap read a hover out the same way
(`ChartTooltipContent`: the popover's fill, `rounded-xl`, 12px inset), and
their ticks are 12px.

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
a surface above `/10`, with one exception: the window's Close off macOS
(chrome/WindowControls.tsx, Linux and the web /ui) fills solid
`destructive` on hover, as every Windows and Linux window's close does; the
platform's convention outranks ours there.

### Type scale

| Size | Where |
| --- | --- |
| 11px | a key cap, a group label in a menu |
| 12px | secondary lines in the chrome, descriptions under a title, status words, a count in a row's status line |
| 13px | the chrome's default: rows, menus, buttons, fields, tabs, settings, an Item's title, a tooltip (regular, 20px lines); the transcript's action, thinking, notice and closing lines (20px lines in 28px rows, 32px in an open group's table) and their counts (`+46 −3`) |
| 14px | dialog and panel body text (22px lines); the transcript's prose, the person's bubble, a question's prompt and the composer's field (22px lines); a split view's header title (a board's, a plan's, a research thread's: semibold foreground over its 13px rows, its detail 12px muted 8px after it, both truncating, `ViewHeader` in surfaces/threads/SplitShell.tsx) |
| 15px | an h2 in the model's prose; a document's body (a plan, a board's plan, a report: 15/24, its h3 15/24 medium) |
| 16px | a title: a dialog's, a sheet's, a page's, an inbox item's, a note's, a report's, an agent's (semibold on 24px lines at -0.01em, one recipe, `lib/typeScaleGuard.test.ts`); an h1 in the model's prose; a document's h2 |
| 18px | a document's h1 (26px lines, -0.01em) |

`text-xs` is the one class for 12px; `lib/typeScaleGuard.test.ts` refuses
the literal `text-[12px]` throughout renderer source.

Weight and colour make the hierarchy, not size jumps: a title is `font-medium`
foreground, its detail `muted-foreground` at the next size down. Code is the
mono face one size below its surroundings. Tracking: `-0.01em` from 16px
up, none below. Numbers in tables and tallies are `tabular-nums`. File headers, approval
previews and implementation tallies use changeRows' `Counts`: sans at the
line's size, 4px between values, sharing the transcript's numeric renderer. A clock
time has one form, `clockTime` (lib/duration.ts): the locale's hour and
minute, 12-hour with AM/PM where it writes it so ("Landed 12:08 PM",
"Finished 2:02 PM"), never a hand-padded "14:02"; `tabular-nums` where it
sits in a column.

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

`shadow-overlay` on floating layers only: a menu, a popover, a dialog, a
sheet, a toast, the find bar, the jump-to-latest button, the `/` and `@`
popover and the editors' widgets (CodeMirror's tooltip and autocomplete,
Monaco's suggest, hover and usages, each on the popover's fill, hairline and
12px radius). Docked chrome and cards have no shadow, the segmented control's
pill included; their depth is the gray step and the hairline
(`lib/depthGuard.test.ts`). A scroller cut at an edge (the file tabs, the dock
bar) fades that edge over 24px (`useOverflowEdges`) instead of a hard stop. The one exception is a raised button (`default`, `secondary`,
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
`SPRING_LAYOUT` (the tab indicator, icon swaps) and `SPRING_GLIDE` (a
released drag, overdamped so even a flick never overshoots). A drag settles
from where it is drawn and carries the pointer's speed at release
(`releaseVelocity` in lib/drag.ts, the last 100ms of readings), and past its
bounds it follows the rubber band (`rubber`). `springEasing` turns a spring into a CSS `linear()` curve
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
line home. Rows that land together wait `--stagger-step` (30ms, `STAGGER`)
apart.
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
button, link (an `a` or anything with `role="link"`, an inline file link
in the prose among them), option, menu item and tab, unlayered so it beats a utility's
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
its detail in regular weight and `muted-foreground`, 4px after it (two
spans, `StatusMark`). Every line keeps one spacing rule: a glyph sits 8px
from the first word; each word, detail, count or time sits 4px from the
next, about a space; a chevron or the hover actions sit 8px after the last
value. Two texts of different sizes on one line share a baseline: a row
that pairs them aligns on baselines (`items-baseline`), or puts both on one
line height, and a clipped inline-block (`WorkingText`) aligns to the
line's top, since its own baseline is its bottom edge
(`scripts/measure-line-pairs.ts` measures both in a browser). Where one plain string is unavoidable (a tooltip, an
accessible name, a toast, a notification) it is "Word: Detail"
(`plainStatus`, src/shared/statusWords.ts). No visible text separates two
facts with a run of spaces, a middle dot, a pipe or a bullet;
`lib/spaceGuard.test.ts` fails on a run of spaces in any renderer literal.
A run of facts of one kind is one comma sentence (`Facts`,
surfaces/settings/hosts/Facts.tsx: a span each, 4px apart, the comma drawn
after all but the last), never facts set apart by space alone.

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
span in regular weight and muted, 4px after the word: Working then
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
round's tally 4px after the detail. A watching thread on one task names it
in the model's words (Watching then "sleep 45 seconds"); more than one is
counted (`watchPhrase`, src/shared/watch.ts). A turn a wait_for_agent holds
says what it waits on by title, Working then "Waiting on Review the perf
pass" or "Waiting on 2 subagents" (`waitLine`), on the transcript's working
line and in the host's detail alike.

The slot above the composer (surfaces/threads/WorkingStrip.tsx, reserved
at 28px so nothing moves when a turn starts or ends, inset 6px as the
composer's row is, so Stop stands over Send, its facts 4px apart as on
every line, as a banner's and the checkpoint strip's are) holds the open turn's
elapsed time and Stop, nothing else, and the held states with their
actions: Paused with Stop and Continue, Stopped with Resume (the harness is
gone), Queued with Start now; a held row's way on (Continue, Resume, Start
now) is the raised `secondary`, Stop the ghost beside it. Every Stop there
spins in place while it lands (`BusyLabel`, keeping its word), the timer's
set at its width's end (`align="end"`) so the word stands over Send; a held
row's glyph sits in the `+` button's 28px box, on `+`'s axis, its word 8px
after that box, and the queue's grip sits in the same box. What the thread does is the transcript's
working line, a pending approval or question is its card, and a watching
thread's state is the transcript's closing line (Watching then its age,
ticking every second, amber past 30 minutes, opening the Activity section; an
age a half-minute clock refreshes, a banner's or an Activity row's, is whole
minutes, `minuteAge`); nothing above the composer
repeats the working line, and no banner repeats the slot. A person's Stop
idles the thread, the slot empties and the transcript's Stopped line says
so once. A first response is said in the transcript's working line, never
above the composer: Sending from the click until the host echoes the
message, then the host's word for the wait (Starting the CLI, Initializing,
Waiting for the provider, a retry, "Waiting for the provider, 25 s"), then
Thinking, then the summary's newest sentence in its place once the thought streams, then
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
"Approve Bash", "Landed 12:08 PM", "The harness is gone") and written as it
is when it is a name or a count ("3 subagents", "sleep 45 seconds",
"Rail.tsx"); it never ends in a full stop and never repeats the word. A
phase keeps its comma inside the detail ("Rate limited, retry 3 in 32
s"): prose punctuation within one fact, not a joiner between two. The
renderer never changes a detail's case; only a detail read from an old
host's legacy `activity` takes a capital (`legacyDetail`).

At rest a row draws no mark for idle and done (`marksAtRest`): a mark that
would only say "nothing is happening" is noise. Two places draw done's
check: the right panel's Agents rows, where it leads a finished agent (the
panel has no other cue for what is done, and seeing it at a glance is the
section's job), and the rail's Working section, whose rows include a thread
that finished while the window looked elsewhere until it is looked at. A tab is the glyph alone, in the type glyph's place while it
works, waits or fails (the type glyph comes back at rest), so a tab's width
never moves with its state; its hover line and the transcript's working
line say the word and the rest.

Nothing loops. Every status glyph is still except working's spinner, a
rotation and the one moving glyph. A row has one moving mark at most: a
line that depends on a row's own mark (a subagent's under its board row, a
batch thread's under its master in a project card, a spawned agent in the
transcript) draws working as the dot (`StatusMark still`), and a settled
row never moves. A master's line on a project card spins while anything in
its block works, whatever the master's own state (`MasterBlock.lead`), so a
block always moves while it works. In the transcript the one moving mark is
the working line's (`WorkingMark`, its three dots); a running row there
draws working as the dot. When a mounted mark's state changes, its glyph cross-fades in the box that
stays: the old one shrinks to a quarter and fades over `--dur-fast` while
the new one grows from a quarter on the layout spring (`glyph-in`,
`glyph-out` in components.css); never at mount, and under reduced motion
both only fade.

A thread's model at a row's end is `ModelMark` (surfaces/threads/ModelMark.tsx):
the provider's logo, the short model name and, where the row asks for it
(the master board's thread rows), the effort in the composer's words
("Opus 5.5 High", "Sol Extra high"), all 12px `muted-foreground`, the logo
6px from the name and the effort 4px after it, never joined by a dot. In a
narrow row the title gives its width up first, down to 64px; then the name
truncates, and the effort never does. The agent detail leads its numbers line with the same `ModelLine`, then
the host and branch; queues use `effortWord` for effort names. A right
panel Agents row says its model on a line of its own under everything else (`ModelLine`): the logo,
the name, the effort and the context window ("Opus 5.5 High 1M", "Sonnet
5.5 Low 200k"), each 4px from the next, only the name truncating. The
tooltip is the uncut form ("Claude Opus 5.5, high effort, 1M context"),
the one home of what a narrow row hides; on an Agents row it is the row's
own tooltip, since the row's open control lies over the line.

While any subagent of the thread on screen is live, the title bar's end
group holds the agents cue (chrome/AgentsCue.tsx), a quiet 24px row
control: the loudest state's glyph, one 12px mark per distinct provider of
the live agents (at most four, then "+N"), and "3 agents", or "1 needs you"
in amber while one waits; the line "Agents: 1 needs you, 2 working on
Claude Code and Codex" is its tooltip and name. It keeps the one-moving-mark rule: while the thread's own
turn runs (its tab and working line spin), the cue draws working's still
dot, and it spins only while the thread watches or idles. It fades in on
`--dur-fast` `--ease-out` and leaves at once, so no dead control stays
under the pointer.

## Panels, modals, menus, popovers, sheets

The right side is one panel, one width (320px, resizable), one header, with
sections that exist only when they have content (Agents, Activity, Changes,
Notes) and a 40px header of flat icon buttons, the selected one filled, that
lists only those sections, each named on hover and by its accessible name;
its default section follows the thread's state, Agents first. An Activity row, folded, is one 28px line
of plain words (glyph, label, age, Stop); one that opens (a shell's log, a
dev server's pane) has its open control laid over it with Stop beside it,
as every row with controls of its own; a shell's command shows only in
its fold, as the first line of its output, one `CONSOLE` capped at 240px
whose first read draws skeleton lines in the same box. The panel's other
logs (Build, the Debug console) keep the console's 20px lines. It yields to the thread, which never
goes under 360px beside it. It is a docked column, not a drawer or
a sheet, and it never animates its width: the thread takes its width at
once and the pane slides in from the edge or back out over it (the motion
table). The bottom dock holds the terminal and the dev servers
pane. Nothing else floats at the side of a thread.

A modal (`Dialog`) is for a form, a CRUD action or a decision that needs the
whole screen's attention; it never holds a list that could be a panel. A
confirm (`AlertDialog`) is for destructive, irreversible actions only, with
one title, one line and two buttons; code that must ask first awaits
`useConfirm()` (chrome/ConfirmDialog.tsx), never `window.confirm`. A
confirm never holds a checkbox: a destructive decision with options is a
form `Dialog` with its `CheckRow`s and the red verb in its footer (Delete
project with cleanup or other copies). An archive is red only while a box that
removes something from disk is ticked (worktrees, simulators, a project's
cleanup); archiving alone loses nothing, so its verb is the primary. A thread's resources are a removal
form of that kind; its dev servers live in the Activity section and the
dev servers pane, never in a dialog.
Every form or decision dialog has one shape: `Modal` (or `ModalPanel` when a parent holds it open), `ModalBody` and `DialogFooter`, whose `start` slot holds a quiet verb (Remove override, Delete) and whose children sit between Cancel and the confirm; `lib/dialogShapeGuard.test.ts` refuses a bare `DialogContent` or ui/dialog's `DialogFooter` outside the shells (the pickers, the lightbox, the page viewer). `chrome/Modal.tsx` and `chrome/ConfirmDialog.tsx` are thin shells on
`Dialog` and `AlertDialog`, and every form dialog has their one shape:
`Modal`, `ModalBody` and `DialogFooter`, 448px or wider, a hairline over
the footer, Cancel then the verb, an action of the dialog's own at the
footer's start; a field's label is `Field` over it, a choice a `FieldRow`. A sheet is for a long form or picker
that would not fit a dialog. A menu (`DropdownMenu`, `ContextMenu`) is
verbs; a popover is content (a picker, a preview, a list of accounts). A
menu's rows are `MenuRow` data rendered by `RowsMenu` (from a trigger) or
`RowsContextMenu` (one per list, at the pointer), each row a 14px glyph, a
label and the key cap of a real binding (`shortcutFor`); the window's menu
bar alone is words and keys. Menus come in one size: the row of "Spacing",
in the dropdown and the context menu alike. A thread offers the same rows on every
surface (lib/threadMenu.ts). Menus and popovers load with their first use,
out of the first paint (chrome/menuRows.tsx). A label on hover is `Tip` or
`TruncateTip`, never a `title=`. `TruncateTip` mounts no tooltip trigger
while its text fits; it checks the element and any truncating text inside
it on mount, text changes and resize. Activity labels, Agents status lines,
fleet goals, home titles and split-view titles all use it. A
popover scales from its trigger; a menu scales from its trigger; a context
menu fades at the pointer; a dialog rises 4px and fades; a sheet slides 16px
from its edge. Every one of them exits in `--dur-fast`, back a quarter of
the way it came, and keeps its direction. Under reduced motion they cross-
fade in `--dur-fast`; nothing appears in one frame.

A page (Settings, Accounts, Stats) is `Page`, `PageSection` and `PageRow`
from `components/page.tsx`: a 672px column with a 24px inset (a page that
is a table, Accounts, takes `width="table"`, 1,152px, and lays its rows as
columns from 48rem of its own container, stacked under it), one 16px
semibold title with a 12px muted line under it, sections 24px apart, each
under a 12px medium muted heading with 8px to its first row, rows 12px top
and bottom with a hairline between neighbours and never a box. A row's
control is one `Switch`, one `ChoiceSelect`, one `Input` or one `Button`;
a loading value is a `Skeleton` in its shape, an error a red 12px line
under its row. A section loaded from a host waits for the socket to open,
asks again on every new socket until it has answered, and past 10 s says
"The host did not answer" with Retry (lib/connection/openRead.ts; a page's
own read is `useHostRead`, lib/connection/hostRead.ts, and a store's scopes
keep the same rule: plans, rules, thread defaults); a late answer still
lands. A failure never stands in as a value: no "Not installed", "No JDK
found", Connect… or empty field the host did not say, and a field that saves
stays away until its value has loaded. A row with a second action gives it its own row or
opens a dialog: Linear's key field sits behind Connect…, and the release
notes are a row under Release, whose one button is the updater's. Switching pages does not animate.

Escape belongs to the innermost layer. A page (Settings, Notes, Inbox,
Search) closes on Escape only through `usePageEscape` (lib/pageEscape.ts):
a dialog, a confirm, a menu, a select or a popover above it takes the key
first, and a focused field lets go before the page closes (Settings puts
the field's value back, Notes and Inbox keep the text; Search's one field
is the page, so Escape there closes it).

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
horizontal bar appears only where content overflows.
`lib/scrollerGuard.test.ts` checks each renderer class string and refuses
`overflow-y-auto` without `overflow-x-hidden` or `overflow-x-auto`; there
are no exceptions. A pure text region
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
reads too thin takes the next size up, never a heavier stroke. No icon takes a
`strokeWidth` prop outside chrome/icons and the charts (the same test refuses one). An icon never carries meaning alone where a word fits; a
tool row in the transcript keeps its tool icon beside its humanized verb.
Two glyphs carry colour: `StatusMark`'s, for a state, and the type glyph
(`TypeGlyph`), in its type's tint ("Type tints"). Every other glyph is
uncoloured: a subagent's role glyph (`AGENT_GLYPHS`), a tool's, the host's.
The host glyph (chrome/HostGlyph.tsx) stays as it is: 12px, uncoloured, the
name on hover, drawn only with two or more hosts.
A workspace's glyph is not an icon: `WorkspaceGlyph` (chrome/WorkspaceGlyph.tsx)
draws the person's logo, the repo's icon or the mascot in the workspace's own
colour, 16px in a rail row and 14px beside text, an image on the 4px radius,
never tinted by state; it is the one drawing of it in the rail, Search,
Inbox, Notes and the folder picker.

## Loading and empty states

A surface that waits shows a `Skeleton` in the shape of what is coming when
the wait is a load, and a `Spinner` with a word ("Loading…", "Starting…")
when it is an action. A button uses `BusyLabel` to reserve both states
at rest; its spinner is hidden from assistive tech so the verb stays its
name. `lib/busyLabelGuard.test.ts` refuses a bare Spinner in Button or
AlertDialogAction children, including a primitive's render slot. An icon
button keeps its name on the button and uses an empty BusyLabel for its
busy glyph. A list with nothing in it shows one `Empty`: a title,
one line, at most one action; never an illustration or a dashed box. A
list the person narrowed (a typed filter, the filter menu) says so in that
line and offers Clear filters as its action. A
section of a settings page with nothing in it shows one muted line in a
row's place (`PageEmpty`), never `Empty`: the section's heading is already
the title. A section's failure that no row owns is one red line in the same
place (`PageError`); an error a row owns is that row's red line. A
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
| Dialog (transitions, so a close mid-open turns back from where it is; the entry is CSS `@starting-style`) | fade + scale 0.95→1 + rise 4px, `--dur-slow` `--ease-out`; a picker opened by a key (⌘P, ⌘⇧O) appears at once | fade + scale →0.98, `--dur-fast` `--ease-exit` | fade only |
| Sheet (transitions) | fade + slide 16px from its edge, `--dur-drawer` `--ease-drawer` | fade + slide 16px back by the same edge, `--dur-slow` | fade only |
| Popover, menu, select (transitions) | fade + scale 0.95→1 from the trigger, `--dur-base` | fade + scale →0.98, `--dur-fast` `--ease-exit` | fade only |
| Context menu (transitions) | fade at the pointer, `--dur-fast` | fade, `--dur-fast` | same |
| Tooltip (13px regular on 20px lines, 24px tall) | after 300ms (`TOOLTIP` in lib/ease.ts), fade + scale 0.98→1, `--dur-fast` `--ease-drawer`; neighbours in one `TooltipProvider` (a closing line's or a notice's actions, the title bar's groups, a split view's header, a rail row's hover actions) open at once within the 120ms grace, the label moving instead of reopening | fade + scale →0.98, `--dur-fast` | fade |
| Toast (sonner, on `--layer-toast`; index.css overrides its 400-500ms defaults, out-specifying its injected stylesheet) | rise and fade, `--dur-base` `--ease-out`, no height or shadow transition | fade, `--dur-fast` `--ease-exit` | fade, `--dur-fast` |
| Right panel (a toggle in place; the thread takes its width at once, so no frame lays out the transcript) | slides in from the row's right edge (`translate-x-full`→0) and fades, `--dur-slow` `--ease-out`; mounted open (a tab switch, a launch) it is just there; a section's body fades `--dur-fast` | drawn over the thread, inert: a quarter of its width back out and a fade, `--dur-fast` `--ease-exit` | fade only |
| Rail | no width animation; content fades `--dur-fast` | same | same |
| The composer's slash and @ menu (transitions; the entry is `@starting-style`; open while a `/` or `@` is typed, with nothing to pick one muted 28px row, "No matches", or "Loading…" while the project's files or the host's commands are read, or "Couldn't load commands" in red when the host gave no list, which Escape closes) | fade + rise 4px from the box's edge, `--dur-base` `--ease-out`; a row keeps its element as the filter narrows, and the frame's height follows the list on the same transition | its last rows stay, inert, while it fades 1px back down, `--dur-fast` `--ease-exit`; typing it open again turns it back | fade only |
| Tab indicator | segmented: the pill glides on `SPRING_LAYOUT_CSS` (`TabsIndicator`); line tabs and the tab strip: instant | — | jump |
| Press, a raised button (`default`, `secondary`, `destructive`) | its fill layer scales 0.985 (0.997 × 0.985 full width) while the label stays put, `--dur-fast` | release, `--dur-hover` | none |
| Press, ghost, link, outline and every row (a rail row, an Item, a toggle, a tab, a hover action, a board row, a task list's header, a row control around the composer) | the fill steps to `foreground/12` at once; nothing scales (`ROW_PRESS` in components/ui/press.ts for a row drawn by hand, `ROW_CONTROL` in chrome/composerRow.ts for the quiet controls under and over the composer's box); a control floating on its own fill (jump to latest) lays `foreground/12` over that fill instead | back over `--dur-hover` | same |
| Hover fill (a button; a pressable row on a board or in a card at `foreground/5`, never `muted`, which means selected; a menu row and a rail row highlight at once; a raised button lightens, and secondary lifts its shadow, over `--dur-fast`). A pressed toggle is `muted` with foreground text, as `Toggle` draws it, the title bar's Panel and the agents cue included, so hovering it never looks like pressing it | `--dur-hover` | `--dur-hover` | same |
| Hover reveal (`reveal(group)` in components/ui/reveal.ts, the one recipe: a closing line's and a notice's actions, a message's Copy, a code block's and a tool output's Copy and Raw, an edit's Edit here and Show diff, an HTML page's Open, the queue's Send now, Remove and tune button, a model row's star, a dock tab's close, a Changes row's Discard and Stage over its counts and its fold's chevron over the file's icon, a hunk's Stage, the new-thread chooser's options, an Agents row's Open and Stop over its title line's end, a board row's actions over its model mark, an archived row's and a device's actions, a rail row's Pin and ⋯ over its trailing mark or, beside a workspace's state glyph, over the name's end right before it on the row's own fill, a task's chevron, an archived thread's Restore over its age) | waits `--delay-hover`, then fades in `--dur-fast`; keyboard focus (`has-focus-visible`; `row` adds focus on or anywhere in a row that takes focus itself) and an open menu show it at once, a mouse click does not hold it (focus-within never shows a reveal: lib/revealGuard.test.ts); the fade rides a wrapper, so the button keeps its own hover fill; controls over something at rest (`overlay`) take no pointer until they show: the pointer turns on with the fade, after the same wait. What they cover gives way on the same timing (`yields(group)`: the model mark, the counts, a file's icon, a workspace's diff, a listed thread's age, an Agents row's host glyph), so nothing reflows and the two cross over together: the controls keep their place at rest or lie over what yields, and nothing toggles its display on a hover (lib/revealGuard.test.ts). A control that arrives with its owner (the title bar's agents cue) fades in on a wrapper too (`FADE_IN`) | fades `--dur-fast`, at once | same |
| Fold (collapsible) | height, `--dur-slow` `--ease-out` | height, `--dur-base` | opacity |
| Fold that opens on its own (`.collapsible-auto`: the transcript's working group, the running task's steps, the title bar's shelf, a master board row's task list and its bar line) | height on the layout spring (`--dur-layout` `--ease-layout`) + opacity `--dur-base` `--ease-out` | the same, so the rows are gone before the box closes | opacity, `--dur-fast` |
| A step landing in it (`.step-land`) | fade + rise 4px, `--dur-base` `--ease-out`; only a step that lands while the fold is open, never at mount, on a hand open or when a panel unhides; steps that land in one commit wait their place in the batch, `--stagger-step` (30ms, `STAGGER`) apart, the fourth and later at three steps | none | none |
| The open table growing as rows land (`useHeightGlide`, lib/heightGlide.ts) | its height glides from where it is drawn to the rows it now holds, on the layout spring (`--dur-layout` `--ease-layout`), retargeted from the screen when another lands mid-glide; one row in and one out at the window's cap nets nothing; never at mount, on a fold, on the lone-to-table entry or a hand's decision | — | the height steps |
| The working group's rows, opening on their own (a lone call becoming a table) | glide 12px from the prose edge to the table's inset (translate), on the layout spring, while the table's frame fades in over `--dur-base` `--ease-out` (`table-frame-in`); never at mount: a settled or reopened table draws its frame at once | — | the frame fades over `--dur-fast`; nothing moves |
| The working group's window (its newest five rows) | the oldest row leaves the top as the list glides up by its measured height, `--dur-base` `--ease-out` | — | none |
| The working group's fold, and a board row's task list once its thread is done (`useFoldHold`, lib/foldHold.ts) | waits `FOLD_HOLD_MS` once the work moved on, so the last row's settle shows, then folds on `.collapsible-auto` | — | the same wait, then the fade |
| Disclosure chevron (`DISCLOSURE_CHEVRON`, components/ui/disclosure.ts: one ChevronRight turning `rotate-90`; a menu trigger's chevron is a still `ChevronDown`) | rotates with its fold, `--dur-base` `--ease-out`, everywhere; its line's words and the chevron lift to foreground at once, on hover and keyboard focus alike, with no fill (the Watching line's mark, detail and age among them), so the turn is the one thing that moves; nothing beside it times its own turn or colour or turns it 180° (`lib/disclosureGuard.test.ts`) | same | none |
| Icon swap (`SwapIcon`; keyed for more than two states, as a tool row's working, failed and icon; a group line's glyph when its main kind changes, a compaction's from start to its outcome, the context meter's ring and its compacting spinner, a Spawned row's bot to its provider's mark) | opacity + scale 0.25→1 on `SPRING_LAYOUT` | fade + scale →0.25, `--dur-fast` | opacity, `--dur-fast` |
| Word morph (`MorphText`: a row's verb or a group's phrase changing tense, the working line's phases, the working line becoming the closing line) | only once the old words have left: the new rise from 3px below, `--dur-base` `--ease-swap`, while the box glides from the old width to theirs (a Web Animation from its live width when cut short); never on mount or for new words under one key | the old words lift 3px and fade first, `--dur-swap-out` `--ease-swap`; never two words in one place | fade out, then in, `--dur-fast`; no glide |
| Scroll glide (jump to latest, a burst while following, a jump to a row) | `DUR.drawer` on `EASE_OUT` | — | instant |
| Park on send (prompt to top) | the transcript glides to park the prompt, `DUR.drawer` on `EASE_DRAWER`; from more than 2.5 screens away it jumps to within 2.5 screens first, as every long jump does | the parked runway retires over `DUR.base` on `EASE_OUT` | instant |
| Jump to latest button | fade + scale 0.95→1, `--dur-base` `--ease-out` | `FADE_OUT` | fade |
| Count | ticks from the shown value, `--dur-slow` `--ease-out`; a pane shown again reads the count it holds | — | none |
| Shimmer (`WorkingText`) | a masked band and a bright copy of the words (the band's `::before`) cross them in opposite directions, transform only, every 3s (`SHIMMER`); not mounted in a hidden pane or document | — | still muted text |
| Working mark (`WorkingMark`, the working line's glyph) | three 3px dots gather into one and part every 1.6s, transform only (`MARK`); enters and leaves as an icon swap does | — | the three dots at rest |
| The working line settling (only once every row of the turn has finished revealing: the mark stays till then) | the mark leaves as an icon does, the words morph into "Worked for 2m 4s" (or Stopped; "Worked" while the time is still to land, which then fills in) and slide from the glyph slot to the prose edge, 22px, `--dur-base` `--ease-swap`; the hover actions mount | — | the morph's fades; no slide |
| Spinner | the one arc turning, on the document timeline from 0 (every spinner in phase; a remount picks the turn up) | — | still |
| Lightbox | opens from the thumbnail that asked for it (its transform origin is the thumbnail's centre) and settles back toward it as the dialog does | — | fade only |
| Appshot | fade + scale 0.95→1 centred, `--dur-slow`; holds; glides into its chip, `--dur-drawer` `--ease-drawer` | — | fade in and out in place, `--dur-fast` |
| Released drag (every sash let go past its bound, the reorder drop, an Escape glide-back) | settles on `SPRING_GLIDE` from where it is drawn, carrying the pointer's speed at release | — | at once |
| Scrollbar | shows at once on hover or scroll | hides at once, `SCROLL_IDLE_MS` (900ms) after the last scroll or when the pointer leaves | same |
| List rows (rail, tabs, fleet, attachments, the transcript's message list, the composer's queue, dragged by its grip; every reorder is `hooks/useSortable`) | none; a row being reordered follows the pointer on the list's axis from where it was grabbed while the others hold still with the insertion line, then glides into its slot (or back to its own, on Escape or a drop that changes nothing) on `SPRING_GLIDE` | none | the line alone; the drop at once |
| The transcript's message list folding to its chevron (its chevron, View → Hide Message List, ⌘⇧M) | the rows fade in and slide 4px from the chevron, `--dur-base` `--ease-out` (opacity and translate; nothing else moves) | they fade and slide 4px toward it, `--dur-fast`, then leave the tab order | fade only, `--dur-fast` |
| A queued message arriving above the composer (chrome/MessageQueue.tsx) | fade + rise 4px, `--dur-base` `--ease-out`, on a full `transform` string so the compositor runs it (motion's `y` is main-thread) | fade, `--dur-fast` | fade, `--dur-fast` |
| Transcript rows | one `--dur-fast` fade on first appearance, never replayed: a row on screen never changes its key (the echo of the person's message keeps the optimistic row's, `Block.rowKey`) | — | none |
| A question card arriving (once per question: a remount of its row replays nothing) | fade + rise 4px, `--dur-base` `--ease-out` (`@starting-style`, `QUESTION_ENTER`) | — | fade, `--dur-fast` |
| Next and Back between a card's questions | the arriving question fades in over `--dur-base` `--ease-out` while the leaving one fades out over `--dur-fast` `--ease-exit`, in place; the card's height glides to the new question's over `--dur-base` `--ease-out` (the card is the last row, below the reader's anchor, so nothing above it moves); Back slides 8px in at the actions' start | the same | the fades; the height snaps |
| A question answered | at the click, the card folds closed on `.collapsible-auto` while its one-line answers open in its place on the same fold; a refused answer opens the card again | — | opacity, `--dur-fast` |
| The working line held (a card waits, the turn is paused) | folds closed on `.collapsible-auto` with its words kept; a resume reopens the same element | the same fold | opacity, `--dur-fast` |
| The Watching line, the fleet detail's live state | each in a kept fold under the turn: opens and closes on `.collapsible-auto`, mounted once it first opens, never unmounted while on screen | the same fold | opacity, `--dur-fast` |
| A status glyph changing state (`StatusMark`) | in the box that stays: the new glyph grows from 0.25 on the layout spring (`glyph-in`) while the old shrinks out over `--dur-fast` (`glyph-out`); never at mount | — | both fade, `--dur-fast` |
| The thought on the working line | each sentence is a phase: it morphs into the next (`MorphText`), held 300ms, a long one cut with an ellipsis | — | the morph's fades |
| Streaming text | the prose: the jitter buffer (surfaces/smoothText) steps whole words every 100ms (`REVEAL.stepMs`) a lead behind the live end (100ms here, 250ms for another host's thread, grown by an underrun, never slower than the stream, every character within 1.5s), draining at the stream's end instead of snapping and revealing a row born live from its first word, holding a bare block marker, a table's header row and a table row with only its pipes until they have content; each step is one span fading in over `--dur-reveal` on `--ease-reveal` (lib/streamReveal.ts, `.stream-step`), and the settle waits for the last fade. Code is not prose: inside an open fence a line shows once its newline arrives (a line held `REVEAL.lineHoldMs`, 600ms, steps by words) and fades in as one element. A list item, a table row, a heading, a quote's line or a fence born mid-stream rises 4px over `--dur-base` `--ease-out` as it fades (`.stream-rise`), a paragraph never; a table's card fades in with its header row. The working line's newest sentence of a thought is no stream but a phase of its own, morphing in (`MorphText`) | — | whole-word and whole-line steps, no fade or rise |
| A streaming code block growing | its body glides to the new line's height, `--dur-base` `--ease-out` (`useHeightGlide`), while its row's reveal is armed; settled blocks never move | — | the height steps |
| Composer send | the bubble rides with the content as the prompt parks, rising 16px and fading in, `--dur-slow` `--ease-drawer`; in follow mode it flies from the field only when it lands within 240px of it | — | fade, `--dur-fast` |
| Composer field height | snaps on a keystroke and on the clear after a send; a change of more than one line the person did not type (a paste, a restore, a quote) eases over `--dur-base` | — | snaps |
| Composer, a new thread's first send | the box keeps its width and moves into its docked place (a FLIP translate, `--dur-slow` `--ease-drawer`) | — | none |
| Pane switch | opacity, `--dur-fast`; no rise; a switch by a key (⌃Tab, ⌘1–9) at once | — | none |
| The agents cue arriving in the title bar | fade, `--dur-fast` `--ease-out` (`@starting-style`); once there, a new count morphs its words (`MorphText`) and a provider's mark that joins grows from 0.25 on `--dur-layout` `--ease-layout` | at once; a mark that leaves goes at once | the fades |
| The slot above the composer emptying | — | the outgoing row stays, inert, and fades `--dur-fast` `--ease-out`; the 28px stays | at once |
| Switch (a setting's `Switch`, the rail's Away row) | the thumb slides on its clip-path, `--dur-slow` `--ease-out`, and grows 5px toward the other side on the track's hover; the track's fill changes over `--dur-fast`; the row around the Away track never moves | the same | snaps |
| Progress bar | the indicator slides by `translateX` inside its clipped, rounded track, `--dur-slow` (a scale would squash its round ends) | — | none |

Rules: animate `transform` and `opacity` (and height only through the
collapsible, the question card's frame between its questions, the slash menu's frame, or `useHeightGlide` for a box whose content grows while it is read); every animation is interruptible and starts from the current
value; nothing animates on a keystroke but the menu it opens; nothing overshoots without a
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
test refuses the old 896px anywhere in the renderer. A line outside the
scroller (the load and no-rows lines, the footer) keeps the gutter outside
the column, `COLUMN_GUTTER_CLASS` around `columnClass()`
(threads/chatSlots.tsx), never a padding inside it, so its text starts on
the column's edge at every width.

The composer is one row in its box, as Claude's: the `+` menu (28px) at the
left, the field, Send (a 28px circle) at the right, 6px from the sides and
8px from the top and bottom, so the empty box is 46px with its hairline. The
field's first line is centred on the controls' 28px line; each further line
grows the box upward by 22px while its bottom stays, and the controls stay
on the bottom line. The rows over and under the box (the slot, the queue's
heading, the row under the box, the draft row) take the box row's 6px inset,
so their first glyph sits on `+`'s axis. Under the box, 4px below it, a 24px row holds the model
at the left and the context meter and the permission mode at the right,
ghost controls in 12px muted text; it is always there, so nothing moves on
focus, and at a narrow width it gives way in order (the meter's percent,
then the model's effort, then the mode's label, then the model's name,
leaving their glyphs). The empty thread's composer and the docked one are
one class chain.

| Element | Size / line |
| --- | --- |
| The prose, the person's bubble, a question's prompt, the composer's field | 14px / 22px |
| A line: a group's line, an action, a thought, a notice, an approval, the closing line | 13px / 20px in a 28px row, 32px in an open group's table (12px in); the glyph in a 14px slot, 8px to the words, so words start at 22px; each word, detail, count or time 4px from the next; a chevron or the hover actions 8px after the last |
| Counts (`+46 −3`, a failed tally) | the text's size (13px in a row and on the group line) `tabular-nums`; the failed mark 4px from its number |
| Code in a row's body: a command, its output, a diff | 12px / 20px mono |
| A code block in the prose | 13px / 20px mono |
| Inline code | one pixel under its text (13px in the prose), `rounded-sm bg-muted` |
| A connector chip in the composer's field (`/linear`) | the field's text, medium, its brand mark 12px 4px before the name, on inline code's `rounded-sm bg-muted` |
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
turns and none between rows; inside an open group a hairline parts two
table rows and nothing else. A blockquote is a 2px
`border` line with muted, upright text; a table's header has no fill.

The person's message is a right-aligned bubble (`card`, `rounded-xl`, 12/8
padding, at most 85% of the column) with no avatar or timestamp, its
preamble line 4px above it, its chevron trailing and its text ending on the
bubble's right edge. Attachments sit 8px apart inside it; past twelve lines
it clamps, and Show more is a 24px target whose words keep their place. A message the person sent into a running
turn (a steer) carries one 12px `muted-foreground` word under the bubble at
its right edge, Sent, Received or Queued for the next turn, or Not
delivered in the red tone; its time is in the word's tooltip, never in the
flow, and a word that changes on screen morphs (`MorphText`)
(transcript/UserMessage.tsx `SteerLine`). The model's prose is plain text.
Between paragraphs, the actions since the last paragraph are one muted line
("Created diag.ts, ran a command +46 ▾") that opens into a table under it, as
Claude's: one hairline frame with a 12px radius from the prose's edge across
the column, no fill, one 32px row per action with its words 12px in and a
hairline between two rows ("Created diag.ts +46 ▸", "Ran npx convex dev… ▸",
"Read types.ts ▸"), verb muted, object in foreground, counts green and red, a
caret per row. Every row of the list sits on one grid (transcript/stepLine.ts):
glyph, verb, target, counts, extras, caret, each slot only when it has
something: the glyph 8px from the verb, verb, target and counts 4px apart,
the extras and the caret 8px after the last value, 32px a row in the table; a call that names nothing reads its
verb alone ("Ran a command"), a connector's call names the connector
("Cosmic Admin  Build get"), a todo update's tally sits muted in the counts
slot, and a host step folded in reads verb then target like a call. A row's opened body is the row's lower part under one hairline inside an
open group's table; a lone row's is one card (a hairline, `rounded-lg`,
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
word; the call's row above it keeps its tool icon, so the mark shows once.
In an open table the waiting approval is a 40px row, 6px round its raised
buttons, so their drop clears the table's clipped frame. A thought is no row: while it streams the working line says its
newest sentence in place of Thinking (Thinking until the first, a long one
cut with an ellipsis at the row's edge), and once it ends it shows only in a group opened
by hand, as "Thought ▸" with no duration, which opens the text. Each live
turn ends in one working line, from Send to the turn's end: the working
mark, then the phase's words in the shimmer (one running call by its verb,
muted, and its object in foreground, with an edit's live counts, or a
chevron that opens a command's or a tool's body under the line). It folds away
while a step waits on the person (the card says so) and while the turn is
paused, and comes back in the same element; a Stop turns it into Stopped at
once. When the turn ends, and its text has finished appearing, it becomes the
closing line, which reads "Worked for 2m 4s" ("Worked" until the time lands), its copy, note, hand-off and second-opinion
buttons showing on hover or keyboard focus; a turn the person stopped
closes on "Stopped" instead, with the same buttons. Every notice (a gate, a review, a compaction, a
pass, a batch, a second opinion asked of another harness) is one muted
line with a glyph, a lead in medium weight and its details as one muted
comma run after it ("Release passed master, release-277"); only a held review and a failure
are cards. A compaction is one line that counts from its start, takes
its outcome in place and reads "Compaction stopped" when its turn ended
without one. The host's steps of the agent's work fold into the run they sit
in, as calls do: a subagent spawned (on its call's row, one row per child
for a batch), each agent that settled ("Finished", "Failed", "Needs you",
"Stopped" or "Paused", then its title, behind the state's glyph), a
finished task, the check on idle tasks, a gate or release outcome, a review
that merged, the turn pass, the plan's build hand-off, a merge the batch
made, and what happened while the person was away (a decision the thread
noted, a question the host answered for them, an approval it skipped). An
away line is the host's words, muted; a question leads with its still help
glyph and an approval with its lock, both in the muted tone, and a decision
has no glyph. A held review, a failure, Stopped, compaction, "Batch done" and
account-gone stay lines of their own. Every agent row names its agent by
title, the one bright text on its line (28px alone, 32px in a table), and an open wait is no row:
the working line says "Waiting on <title>", drawn like a call: "Waiting on"
muted, the title (or "2 subagents") in foreground. A handoff keeps its bubble: its text is the person's brief. The
left side, where the column leaves room, lists the person's own messages,
one line and a clock time each, the one being read in foreground
(`TranscriptOutline` on `JumpList`; docs/LAYOUT.md "Chat"). A
question card sets the sans face; mono is for code inside it. It is the one
card the transcript allows: a hairline on the card fill, 12px corners and a
16px inset (`QUESTION_SHAPE`, surfaces/QuestionCard.tsx; the held review keeps
`CARD_SHAPE`), and inside a `bg-card` body it draws no second frame. Its title
is 14px medium by the amber Needs you glyph, flat, and a set of more than one
question ends the title row with where the person is ("2 of 3", 12px muted,
tabular). Its question is at the prose's 14px on 22px lines, its options a
flat list of 36px rows 4px apart (a menu row's 8px radius, 8px above and
below the 14px label's 20px line) with an option's description as a muted
13px line under it; the 20px key cap sits on the label's first line. Selected
is the row's fill (`foreground/10`) and the cap turned primary, never a
border; hover is `foreground/5`, a press `foreground/12`, all at once. Its
actions end the card 16px under the options, right-aligned 8px apart, the
raised buttons at `sm`: Back and Skip `secondary`, Next or Continue (with ⌘⏎)
`default`; Back arrives at the group's start, so Skip and Next never move. Every action
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
ride the menu chunk (drawn by their parts through components/ui/lazy-menus.tsx), and every select the select chunk: the composer's pickers and every
`ChoiceSelect` draw the same trigger, at the caller's size and width, until it
lands, components/lazy-select.tsx).
