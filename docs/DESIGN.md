# Design system

This is the standard every renderer change follows. It wins every conflict
with docs/LAYOUT.md, a skill's advice, a library's default or a thread's
brief. `src/renderer/src/components/README.md` is the map from each class of
UI element to the one component that renders it.

## The look, in one paragraph

Claude desktop's transcript inside Cursor's chrome. The chrome is quiet and
dense: 13px type, one gray step between the rail, the content and a floating
layer, hairline borders, no shadows on anything docked. The transcript is
generous: 15px prose on a 1.6 line height, the person's words in a soft
bubble on the right, the model's as plain text on the left, its actions
clumped into one muted line per paragraph that opens into a single
thin-bordered list. Colour means something or is absent: amber when the
person is needed, red when something failed, green for lines added, the one
blue accent for links and focus. Motion is short, physical and interruptible;
nothing bounces, glows, slides in from nowhere or stays on screen when it is
done.

## The one standard

Kobra (kobra.systems) on Base UI is the component library. Every button,
field, menu, popover, dialog, sheet, tab, switch, tooltip, list row, empty
state, spinner, skeleton, question card, plan card and task list is the
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
| `secondary` | the secondary button | oklch 0.29 | oklch 0.94 |
| `border` | every hairline | white 9% | black 8% |
| `input` | a field's border, a switch's off track | white 12% | black 12% |
| `foreground` | text that matters | oklch 0.93 | oklch 0.2 |
| `muted-foreground` | text that supports it | oklch 0.68 | oklch 0.5 |
| `primary` / `primary-foreground` | the one primary button per surface, a checked box, a switch on | near-white / near-black | near-black / white |
| `accent` | links, focus rings, the rare call to action | blue 62% | blue 48% |
| `warning` | the person is needed | amber | amber |
| `destructive` | failed, delete | red | red |
| `success` | lines added, passed | green | green |
| `info` | the one informational tint | blue | blue |

Opacities on `foreground` are the hover vocabulary: `/5` a hovered row,
`/7` a hovered ghost button, `/12` a pressed one. Status colours never fill
a surface above `/10`.

### Type scale

| Size | Where |
| --- | --- |
| 11px | a key cap, a group label in a menu, a count |
| 12px | secondary lines in the chrome, descriptions under a title, status words |
| 13px | the chrome's default: rows, menus, buttons, fields, tabs, settings |
| 14px | dialog and panel body text, an Item's title |
| 15px | the transcript's prose, the composer's field (line height 1.6) |
| 16px | a dialog or sheet title (semibold) |

Weight and colour make the hierarchy, not size jumps: a title is `font-medium`
foreground, its detail `muted-foreground` at the next size down. Code is the
mono face one size below its surroundings. Tracking: `-0.01em` from 16px
up, none below. Numbers in tables and tallies are `tabular-nums`.

### Spacing

The 4px grid. Inside a row: 8px between glyph and label, 12px horizontal
padding, rows 28px tall in menus and dense lists, 36px in the rail and
settings. Between groups in a panel or page: 16px; between sections: 24px.
A panel's inset is 12px; a dialog's 20px. Never a value off the grid.

### Radius ladder

`sm` 4px a key cap, a checkbox; `md` 6px a row's hover, a small button;
`lg` 8px a button, a field, a menu at the `sm` size, a card inside content;
`xl` 12px a popover, a card that stands alone, the composer; `2xl` 16px a
dialog, a sheet; `full` a switch, an avatar, a pill. Nested radii are
concentric: the inner radius is the outer minus the padding.

### Shadow

`shadow-overlay` on floating layers only (menu, popover, dialog, sheet).
Docked chrome and cards have no shadow; their depth is the gray step and
the hairline.

### Motion tokens

CSS `--dur-fast` 120ms (press, hover, every exit, every reduced-motion
fade), `--dur-base` 180ms (menu, popover, tooltip entrances; folds),
`--dur-slow` 240ms (dialog and panel entrances), `--dur-drawer` 300ms (a
sheet). Curves: `--ease-out` for entrances and most transitions,
`--ease-exit` for a closing overlay, `--ease-drawer` for a sheet,
`--ease-in-out` for a symmetric move. Springs live in `lib/ease.ts`:
`SPRING_PRESS` (press only), `SPRING_LAYOUT` (the tab indicator, icon
swaps), `SPRING_PANEL` (a row morphing into a card), `SPRING_GLIDE` (a
released drag). `springEasing` turns a spring into a CSS `linear()` curve
and its settle time (`SPRING_LAYOUT_CSS`: 370ms, no overshoot), for a
transition that glides like the spring without JavaScript.
`lib/motionGuard.test.ts` fails on any literal duration or curve outside
`lib/ease.ts` and this layer; its script allow-list is empty. The only
kept CSS rule defines Tailwind’s named spinner token. The shimmer token
keeps its 2s sweep, and the spinner token keeps its 900ms turn.

### Layers

`--layer-dialog` 90, `--layer-popover` 95 (menus, popovers, selects:
above a dialog so a picker inside one is never hidden), `--layer-toast`
100, `--layer-tooltip` 110.

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
colon. Two facts on one line are separated by two spaces of margin, never a
middle dot, a pipe or a bullet.

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

The word may be followed by what the state is about, muted after it:
"Working  typecheck", "Needs you  approve Bash", "Watching  3 subagents",
"Failed  usage cap". A watching thread always says what it watches; a row
that cannot say is a bug. `threadStatus` (lib/threadStripModel.ts) is the one
place that decides a thread's state and its detail, the tree's overrides
included, and `ThreadStatusMark` (chrome/TabIndicator.tsx) draws it with the
round's tally 8px after the detail. A watching thread on one task names it
in the model's words ("Watching  sleep 45 seconds"); more than one is
counted (`watchPhrase`, src/shared/watch.ts).

The strip above the composer (surfaces/threads/WorkingStrip.tsx) is the
one place a live thread on screen says its state: no banner and no
transcript row repeat it. A working strip ends with Stop; a person's Stop
idles the thread, the strip empties and the transcript's Stopped line says
so once. Stopped with Resume means the harness is gone.

A detail starts lower-case, never ends in a full stop and never repeats the
word. Two facts on one line are separated by margin, never by a middle dot,
a pipe or a bullet.

At rest a row draws no mark for idle and done (`marksAtRest`): a mark that
would only say "nothing is happening" is noise. A tab is the glyph alone;
its hover line and the strip above the composer say the word and the rest.

Nothing loops. Every status glyph is still except working's spinner, a
rotation and the one moving glyph. When a mounted mark's state changes into
working, waiting or watching its glyph breathes once (opacity over
`--dur-slow`); under reduced motion it does not. Every other change is
instant.

## Panels, modals, menus, popovers, sheets

The right side is one panel, one width (320px, resizable), one header, with
sections that exist only when they have content (Activity, Agents, Changes,
Notes) and a segmented control that lists only those sections; its default
section follows the thread's state. It is a docked column, not a drawer or
a sheet, and it never animates its width (it toggles; the content fades
over `--dur-fast`). The bottom dock holds the terminal and the dev servers
pane. Nothing else floats at the side of a thread.

A modal (`Dialog`) is for a form, a CRUD action or a decision that needs the
whole screen's attention; it never holds a list that could be a panel. A
confirm (`AlertDialog`) is for destructive, irreversible actions only, with
one title, one line and two buttons; code that must ask first awaits
`useConfirm()` (chrome/ConfirmDialog.tsx), never `window.confirm`.
`chrome/Modal.tsx` and `chrome/ConfirmDialog.tsx` are thin shells on
`Dialog` and `AlertDialog` for their existing callers. A sheet is for a long form or picker
that would not fit a dialog. A menu (`DropdownMenu`, `ContextMenu`) is
verbs; a popover is content (a picker, a preview, a list of accounts). A
menu's rows are `MenuRow` data rendered by `RowsMenu` (from a trigger) or
`RowsContextMenu` (one per list, at the pointer), each row a 14px glyph, a
label and the key cap of a real binding (`shortcutFor`); the window's menu
bar alone is words and keys. A thread offers the same rows on every
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
under its row. Switching pages does not animate.

## Iconography

`@renderer/chrome/icons` (Hugeicons under lucide names), 16px in rows and
buttons, 14px in dense chrome, 12px as a mark beside text, 1.5px stroke,
`currentColor`. An icon never carries meaning alone where a word fits; a
tool row in the transcript keeps its tool icon beside its humanized verb.
The host glyph (chrome/HostGlyph.tsx) stays as it is: 12px, uncoloured, the
name on hover, drawn only with two or more hosts.

## Loading and empty states

A surface that waits shows a `Skeleton` in the shape of what is coming when
the wait is a load, and a `Spinner` with a word ("Loading…", "Starting…")
when it is an action. A list with nothing in it shows one `Empty`: a title,
one line, at most one action; never an illustration or a dashed box. A
list the person narrowed (a typed filter, the filter menu) says so in that
line and offers Clear filters as its action. A
thread with no messages shows the composer and nothing else. Inside a picker
or menu, no match is one muted row, never `Empty`. A lazy surface falls back
to a `SurfaceSkeleton` kind, and a small section's wait is `LoadingLine`
(both in surfaces/SurfaceSkeleton.tsx, beside `EmptyState`). Text that is
being produced shimmers (`TextShimmer`); nothing else does.

## Motion values

| Surface | Enter | Exit | Reduced motion |
| --- | --- | --- | --- |
| Dialog | fade + scale 0.95→1 + rise 4px, `--dur-slow` `--ease-out` | fade + scale →0.98, `--dur-fast` | fade only |
| Sheet | fade + slide 16px from its edge, `--dur-drawer` `--ease-drawer` | fade + slide 16px back, `--dur-slow` | fade only |
| Popover, menu, select | fade + scale 0.95→1 from the trigger, `--dur-base` | fade + scale →0.98, `--dur-fast` | fade only |
| Context menu | fade at the pointer, `--dur-fast` | fade, `--dur-fast` | same |
| Tooltip | fade + scale 0.95→1, `--dur-base`; moves between triggers instead of reopening | fade, `--dur-fast` | fade |
| Toast (sonner) | rise and fade, `--dur-base` | fade, `--dur-fast` | fade |
| Right panel, rail | no width animation; content fades `--dur-fast` | same | same |
| Tab indicator | segmented: the pill glides on `SPRING_LAYOUT_CSS`; line tabs and the tab strip: instant | — | jump |
| Press | scale 0.985, `--dur-fast` | release | colour only |
| Fold (collapsible) | height, `--dur-slow` `--ease-out` | height, `--dur-base` | opacity |
| Disclosure chevron | rotates with its fold, `--dur-base` `--ease-out` | same | none |
| Icon swap (`SwapIcon`) | opacity + scale 0.25→1 on `SPRING_LAYOUT` | fade + scale →0.25, `--dur-fast` | opacity, `--dur-fast` |
| Count | ticks from the shown value, `--dur-slow` `--ease-out` | — | none |
| Shimmer (`TextShimmer`) | one highlight sweeps the muted text, 2s | — | still muted text |
| Spinner | the one arc turning | — | still |
| Appshot | fade + scale 0.95→1 centred, `--dur-slow`; holds; glides into its chip, `--dur-drawer` `--ease-drawer` | — | fade in and out in place, `--dur-fast` |
| Released drag | settles on `SPRING_GLIDE` | — | none |
| List rows (rail, tabs, fleet, attachments) | none | none | none |
| Transcript rows | one `--dur-fast` fade on first appearance, never replayed | — | none |
| Streaming text | the jitter buffer (lib/smoothText); words fade `--dur-base` in `StreamingText` | — | none |
| Composer send | the bubble glides up 16px, `--dur-slow` `--ease-drawer` | — | fade, `--dur-fast` |

Rules: animate `transform` and `opacity` (and height only through the
collapsible); every animation is interruptible and starts from the current
value; nothing animates on a keystroke; nothing overshoots without a
gesture; every animated class carries its `motion-reduce:` guard.

## The transcript

The target is Claude desktop's transcript with our tool icons and
humanized names kept (the plan at .temp-code/plan-h5M-bmLmzYd4.md fixes the
rows). The person's message is a right-aligned bubble (`card`, `rounded-xl`,
15px) with no avatar or timestamp. The model's prose is plain 15px text.
Between paragraphs, the actions since the last paragraph are one muted line
("Created diag.ts, ran a command  +46 ▾") that opens into one thin-bordered
`card` listing one row per action ("Created  diag.ts  +46 ▸", "Ran  npx
convex dev…  ▸", "Read  types.ts ▸"), verb muted, object in foreground,
counts green and red, a caret per row. A lone command opens a card headed by
its tool name with the command in mono and its output under it. File changes
keep their counts on the line and their diff behind the caret. No background-
task lines: live work is the right panel's Activity section. No timestamps
in the flow; the closing line says what the turn took and nothing else. A
live turn's state is the strip's: the transcript draws the closing line
once the turn is over, and a paused turn is not over (only a surface with
no strip, the fleet's agent detail, draws the live state as its last row).
An approval card carries the amber glyph and its two buttons, not the
word. A thought is one row
of that list: "Thinking" shimmering with its newest sentence while it
streams, then "Thought for 4s ▸", which opens the text. The closing line
reads "Worked for 2m 4s", its copy, note, hand-off and second-opinion
buttons showing on hover. Every notice (a gate, a review, a compaction, a
pass, a batch, a second opinion asked of another harness) is one muted
line with a glyph, a lead and its details; only a held review and a failure
are cards. A handoff keeps its bubble: its text is the person's brief. A
question card sets the sans face; mono is for code inside it. Every action
row ends in a caret: it turns on a row that opens a body and stays still on
one that opens its file.

## Restraint

No cards within cards. No glows. No decorative badges or chips. No
repeating the same data twice. No over-explaining: states are shown, not
narrated. No colour without meaning. No shadows on docked UI. No left colour
bar for focus or selection (a focused or selected row is a `muted` fill).
No bullet points in the UI. A toast never covers a control: the stack sits
8px above the focused thread's strip, 16px inside its column's right edge
(`toastInset` in components/ui/toaster.tsx, measured from the footer
`ChatFooter` registers in lib/toastAnchor.ts), and 16px from the window's
corner where no thread is focused. Confirmation dialogs only for destructive,
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
is in the first paint (the tooltip defers its primitive, menus and select ride the
search, inbox and notes chunks).
