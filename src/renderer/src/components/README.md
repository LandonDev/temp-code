# components/ui — the one component per class of UI element

Every piece of UI in `src/renderer` is one of the components in this
directory, or a composition of them. The source is [Kobra](https://kobra.systems)
(Base UI underneath), adapted once at install time to our tokens, our icon
module and our motion values, so nothing on screen says where it came from.
docs/DESIGN.md is the standard; this file is the map. When they disagree,
DESIGN.md wins.

## The map

| Class of element | Component (file) | Rule |
| --- | --- | --- |
| Any button, icon button, row action | `Button` (button.tsx) | `default` is the one primary per surface; `secondary` gray; `destructive` red: the three are raised (`t-raise`, a shadowed fill layer behind the label that lightens on hover and presses in to 0.985; never inside an `overflow-hidden` box). `ghost` for icon and row buttons, `outline` only inside forms, `link` inline: flat, and a press steps their fill to `foreground/12` at once with nothing scaling, as every row does. Its words are 13px on 20px lines; an icon at its start or end takes 8px on that side. A busy button says its state through `BusyLabel` (the widest state's width held at rest, the spinner beside the word); a spinner in a button takes the icon's size (12px in xs, 14px in sm). Never a raw button element with classes. |
| A toggle button, a segmented bar | `Toggle`, `ToggleGroup` (toggle.tsx, toggle-group.tsx) | `spacing={0}` joins a group into one bar. |
| A modal | `Dialog` (dialog.tsx) | Centred, `size` sm/default/md/lg; `full` for a viewer (an image, a rendered page). CRUD and every form opens in one. It moves on transitions (the entry is CSS `@starting-style`, which a dialog mounted open gets too; the exit is `data-ending-style`), so a close mid-open turns back from where it is; `instant` for one a keystroke opened (the pickers). The title is 16px semibold on a 24px line at -0.01em, the body 14px on 22px lines; the built-in close is the ghost `icon-sm` button 18px down at the 16px end, on the title's line; the dim behind it is the `scrim` token. |
| A confirm | `AlertDialog*` (dialog.tsx); from code, `useConfirm()` (chrome/ConfirmDialog.tsx) | Only for destructive, irreversible actions. One title, one line, Cancel + the verb. Never `window.confirm`. |
| A side form, a long picker | `Sheet` (sheet.tsx) | Enters from an edge and leaves by it, on transitions like the dialog's, with its title, close and scrim; `width` in px on a side sheet (440 by default). The right panel is not a Sheet. |
| A menu from a trigger | `RowsMenu` (chrome/menuRows.tsx) over `DropdownMenu` (dropdown-menu.tsx) | Rows are `MenuRow[]` data, rendered by the one `MenuRows` (chrome/menuBody.tsx): the 14px glyph, the label, the key cap from `shortcutFor`. The glyph is muted unless it names its own `text-` colour, which the row keeps (a type's `THREAD_MENU_ICONS`). A disabled row's `reason` ("Send a message first", "The box is offline") is its tooltip and accessible description, never a second line, so the row stays 28px; only a `description` (a recent project's parent folder) adds a line. The body loads in `menuChunk`, out of the first paint. The popup, like every popup, moves on transitions from its trigger. |
| A right-click menu | `RowsContextMenu` (chrome/menuRows.tsx) over `ContextMenu` (context-menu.tsx) | Same rows, at the pointer. One around a list; each row carries `data-menu-id`. |
| Content floating from a control (a picker, a list of accounts) | `LazyPopover` (chrome/menuRows.tsx) over `Popover` (popover.tsx) | Content, never verbs. Moves on transitions from its trigger. |
| A thread's menu, on any surface | `threadMenuRows` (lib/threadMenu.ts) with `useThreadMenu` (chrome/useThreadMenu.tsx) | One list everywhere (tab chip, ⋯, title-bar tab, rail row, board row, subagent line); a surface adds only Open, New pass… or Start now. The hook runs every pick and mounts the dialogs. |
| A project's or tab group's look | `CustomizeGroupDialog` (chrome/CustomizeGroupDialog.tsx), from `groupMenuRows`' Customize… | Name, logo, colour, mascot; applied on Save. |
| Floating content from a trigger | `Popover` (popover.tsx) | Pickers, account lists, previews. Scales from its anchor. |
| A label on hover | `Tip` / `TruncateTip` (../tip.tsx) over `Tooltip` (tooltip.tsx) | `Tip` names an icon-only control, with its binding's `Kbd`; `TruncateTip` shows cut-off text whole, only while it is cut. |
| The tooltip itself | `Tooltip` (tooltip.tsx) | Replaces every `title=`. Each carries its delay; a `TooltipProvider` around a toolbar lets neighbours share one. `TOOLTIP_DELAY` and `TOOLTIP_CLOSE_DELAY` are the numbers a hover popover reuses. |
| An option picker | `Select` (select.tsx) | Bordered trigger, list aligned on the chosen item (laid over its trigger, it opens without a zoom; on transitions like every popup). Lives in the select chunk: a picker in the first paint draws `ColdSelectTrigger` (../lazy-select.tsx) and its real select from `selectChunk` (../select-body.ts), never `Select` itself. |
| An option picker from a list | `ChoiceSelect` (../choice-select.tsx) | The one adapter from `{ value, label }[]` to `Select`; an empty value (Auto) round-trips; an option's `group` lists it under that heading (a provider). Nothing maps `SelectItem`s by hand. |
| A settings or app page | `Page`, `PageSection`, `PageRow` (../page.tsx) | 672px column, 24px inset, one 16px title; sections 24px apart under a 12px muted heading; rows with a hairline between neighbours. A page never draws its own header or section heading. |
| A page section with nothing in it | `PageEmpty` (../page.tsx) | One muted 12px line in a row's place ("No clients", "None running"), no trailing period; never `Empty`, since the section's heading is already the title. |
| A single choice of a few, shown at once | `ChoiceToggle` (../choice-toggle.tsx) | The one adapter from `{ value, label, disabled?, note? }[]` to a single-choice `ToggleGroup` on a bordered track; one is always chosen; a disabled choice's `note` is its Tooltip. |
| A text field | `Input`, `Textarea` (input.tsx, textarea.tsx) | 32px, hairline border, ring inside. A field with a glyph or buttons in it (search) is `InputGroup` with `leading`/`trailing` around a `GroupInput`. |
| A labelled field in a dialog or sheet | `Field`, `FieldRow`, `CheckRow` (chrome/DialogField.tsx) | `Field`: the 12px muted label, the control, a hint or a red error line under it. `FieldRow`: an Item row, the label (and description, error) at its start and the choice at its end. `CheckRow`: one decision in a confirm, a Checkbox named by its label. |
| A setting on or off | `Switch` (switch.tsx); `SettingSwitch` (../setting-switch.tsx) in a settings row | The only toggle for a setting. `SettingSwitch` names it and plays the switch cue. |
| A choice in a list | `Checkbox` (checkbox.tsx) | |
| Tabs, a segmented control | `Tabs` (tabs.tsx) | `variant="default"` segmented, `variant="line"` underlined. A segmented control whose pill glides puts `TabsIndicator` first in its list and gives the triggers `TABS_PILL_TRIGGER`; one of icon segments names each by its `aria-label` and a `Tooltip` (the right panel's `PanelSections`). The file and terminal strip (chrome/SurfaceTabs.tsx) is a line `Tabs` of 28px chips: icon, name, and a 16px slot whose unsaved dot turns into close on hover (a clean active tab shows close). |
| Rows and columns of structured data | `Table` (table.tsx) | Flat: hairline rows, no box, no column rules, first and last columns on the inset. No hover fill; the cells hold the controls. |
| A list of places to jump to beside a document (the plan's headings, the transcript's messages) | `JumpList` (chrome/JumpList.tsx) | A `nav` of ghost rows with one tab stop, arrows and Home/End, Enter or Space landing at once, the row being read in foreground with `aria-current`, optional day headings and a trailing time. No motion. |
| A list row, a settings row | `Item` (item.tsx) | Media, title + description, actions. Settings pages are columns of these. |
| A list row the whole of which acts (open, pick, restore) | `ItemButton` (item.tsx) | The `Item` row as one button element (type button), with Item's variants and sizes; the caller names its hover fill, and a press steps it to `foreground/12`. A row highlights at once (no background transition). Never an `Item` turned into a button through its `render` prop. |
| A divider | `Separator` (separator.tsx) | Spacing first; a separator only where spacing cannot tell groups apart. |
| A disclosure | `Collapsible` (collapsible.tsx) | Height eases through `.collapsible-resize`. A fold with no trigger of its own is the same panel, opened by `open`; one that opens and shuts on its own adds `.collapsible-auto` (height on the layout spring and opacity, the same both ways), and a step landing in it `.step-land`. Its chevron is one ChevronRight on `DISCLOSURE_CHEVRON` (components/ui/disclosure.ts, plain so the first paint can use it), turning `rotate-90` while open; never a glyph swap. |
| An icon replacing another (Copy → Check) | `SwapIcon` (../../motion/IconSwap.tsx) | The new glyph grows from a quarter size on `SPRING_LAYOUT`; reduced motion cross-fades. `on` swaps between two glyphs; `state={key}` swaps whenever the key changes, for more than two (a tool row's waiting, working, failed and icon), in one fixed box. |
| A label changing its words (a row's verb, a group's phrase changing tense, the working line's phases) | `MorphText` (../../motion/MorphText.tsx) | Keyed by `state`: the old words lift 3px and leave over `--dur-swap-out`, and only then do the new rise from 3px below over `--dur-base`, both on `--ease-swap`, while the box glides its width (a Web Animation from its live width); never two words in one place; nothing on mount; new words under the same key draw at once. Reduced motion fades out, then in. Only for a change of state, never for streamed text. |
| A scroller | a native element with `overflow-*-auto` | Drawn by the scrollbar rule in index.css (docs/DESIGN.md "Scrolling"); a rounded one sets `--scrollbar-inset` to its radius. A list that can run to thousands of rows virtualizes on its native element with the rail's `VirtualRows` (chrome/railVirtualRows.tsx: the rail, the Changes section). |
| How full a thread's context window is | `ContextMeter` (chrome/ContextMeter.tsx) on `Button`, `Spinner`, `Tip`, `LazyPopover` and `Skeleton` | One per composer, in the row under the box before the permission mode: the 14px ring and the percent, muted then amber from 85% (`contextTone`, never red), a `Spinner` while compacting; its popover is the breakdown with Compact under `canCompact`. Nothing for a harness that reports no window. |
| A determinate bar | `Progress` (progress.tsx) | Usage meter, tallies. `fill` is foreground, muted or warning; the fill is a transform, so a live update never relayouts. |
| Loading, indeterminate | `Spinner` (spinner.tsx) | 16px arc, with a word, turning on the document timeline from 0 so every spinner turns in phase. The nine other spinners are retired. A small section's wait is `LoadingLine` (surfaces/SurfaceSkeleton.tsx). |
| Loading, a shape | `Skeleton` (skeleton.tsx) | Shaped like what it stands in for; still. A whole surface is `SurfaceSkeleton` (surfaces/SurfaceSkeleton.tsx) by kind; an edit's diff waiting for its chunk is the `diff-rows` kind in its card: one 20px line per row it will show (at most 8), each a still bar where the code starts, no header, no border. An html page waiting for its chunk is `HtmlPagePlaceholder` (transcript/TranscriptBlock.tsx): the frame's reserved height, full width, `rounded-lg`. |
| Words being produced (the working line, a compaction, a handoff being prepared) | `WorkingText` (working-text.tsx) | Muted words with a bright band crossing them every 3s (`SHIMMER`): a masked band and its `::before` copy of the words (`words`, else the string child) moved by transform alone; not mounted under reduced motion or while hidden. Aligned to its line's top (`align-top`): a clipped inline-block's baseline is its bottom edge, which would lift its words 3px above a neighbour's. |
| The transcript's working line's glyph | `WorkingMark` (working-mark.tsx) | Three 3px dots in the working tone that gather and part (`MARK`), transform only, phase-locked on the document timeline; still under reduced motion and while hidden. The working line only: the spinner stays the working glyph everywhere else. |
| Nothing here | `Empty` (empty.tsx) | Title, one line, at most one action, through `EmptyState` (surfaces/SurfaceSkeleton.tsx). A picker's no match is one muted row. |
| An inline callout | `Alert` (alert.tsx) | Tinted by tone. Not for transcript notices. |
| A thread's state | `StatusMark` (status.tsx) | One glyph, one word, one tone per state; `detail` is what it is about, muted 4px after the word (the glyph 8px before it), a tally or time 4px after the detail. The only status-to-colour map; `threadStateOf(status, { settled, planReady })` turns a session's wire status into the state (a written plan is `plan-ready`, muted), `linkMarkOf(transport)` a host link into its state and word. A thread's row reads `threadStatus` (lib/threadStripModel.ts: the state with the tree's overrides, the detail and the tally) and draws it with `ThreadStatusMark` (chrome/TabIndicator.tsx); `marksAtRest` leaves idle and done unmarked. |
| The model a thread runs on, at a row's end | `ModelMark` (surfaces/threads/ModelMark.tsx) | The provider's mark, the short model name (`modelMarkName`) and, with `effort`, the effort in the composer's words (`effortWord` in lib/models.ts), 12px muted, the effort 4px after the name; the row's title gives its width up first, then the name truncates, never the effort (`nameClassName`, `effortClassName` let a container query hide them). The tooltip names the model, effort and context, after a `lead` word when given (a subagent's role). The master board's rows and the right panel's Agents rows; the host glyph beside it comes through `HostGlyphOf`. |
| Live subagents of the thread on screen, seen from anywhere | `AgentsCue` (chrome/AgentsCue.tsx, `AgentsCueView` its pure view) | A 28px ghost chip in the title bar's end group, left of ⋯, only while a subagent works, watches, waits or is queued (`useAgentsCue` in lib/threads/agents.ts, woken only for that thread's tree): the loudest state's `StatusMark` glyph (working still while the thread's own turn runs) and "3 agents"; a click opens or closes the right panel on Agents. |
| A subagent in the right panel | `AgentRowView` (surfaces/threads/fleet/AgentRow.tsx) in `FleetSectionsView` (fleet/FleetPanel.tsx) | Two lines live, one settled; the state's glyph leading, `ModelMark` with its effort at line one's end (the title gives way first; under 13rem the logo alone), the word only where the section heading does not say it, the tally and `agentTime` at the end; Open and Stop revealed on hover. docs/LAYOUT.md "Orchestration". |
| A thread's type | `TypeGlyph` (surfaces/threads/TypeGlyph.tsx); `THREAD_MENU_ICONS` (surfaces/threads/threadTypes.ts) for a menu row's icon | The type's glyph in its tint (`typeTint`, `text-type-<type>`; docs/DESIGN.md "Type tints"), the one coloured glyph besides `StatusMark`. The caller sets the size; an absent type draws chat. Glyph only: never a title, a fill or a border. A subagent's role glyph (`AGENT_GLYPHS`) stays uncoloured. |
| A key cap | `Kbd` (kbd.tsx) | In menus, tooltips, buttons. |
| The model's markdown | `AgentMarkdown` (surfaces/AgentMarkdown.tsx) | `size` prose (14/22, the transcript), compact (14/22, a narrow column), document (15/24, a plan, a board's plan, a report: its headings scaled above the body, `.is-document` in transcript/markdown.css). Classes join through `cn()`. |
| A drag's physics | lib/drag.ts | `rubber` past a bound, `releaseVelocity` (the pointer's px/s over its last 100ms) handed to the `SPRING_GLIDE` settle, `suppressTextSelection` while it drags. Every sash and the reorder use them. |
| A toast | sonner `toast()`; one `<Toaster>` (toaster.tsx) mounted lazily in main.tsx | The four custom toast stacks are retired. The stack sits above the focused thread's strip and inside its column, or above a master board's foot while its chat is folded (`toastInset`, lib/toastAnchor.ts). Its action and cancel are our raised primary and secondary (`buttonVariants` at xs, sonner's own button reset), and index.css puts it on `--layer-toast` and the motion tokens. Its title is 13/20 medium, its description 12/16 muted, its glyph on the title's first line. |
| A bounded log or text region (a batch step's console, a job's log, a licence) | a `pre` with `CONSOLE` (components/ui/console.ts) and `tabIndex={0}` | The card fill, 12 by 8 inside an 8px radius, 12px mono on 20px lines, muted, the focus ring; the caller adds its height cap, overflow and wrapping. |
| A question from the agent | `QuestionCard` (question-card.tsx) | Lettered options, each with an optional `description` line under its label; the free-form field; `multiSelect` for several picks; `showProgress` (the donut and its reset, on for more than one question); the caller's status glyph flat in `icon` (the transcript's is the amber Needs you); ⌘⏎ and the letters only while focus is inside the card. The prompt sits at the prose's 14px on 22px lines, options in 28px rows at 14px. The transcript's frame is `CARD_SHAPE` (surfaces/QuestionCard.tsx), shared with the held review. |
| Tasks the agent works through | `TaskList` (task-list.tsx) | Donut header, marks that draw their check; one line per task cut to its column, the running task whole, each task's time at the end. A task's `detail` (the running task's steps, `TaskSteps`) opens under its label, which becomes its trigger; `onFitWidth` reports the width the widest task needs (lib/taskListWidth.ts). `TaskRows` is its rows and cursor alone; `size="compact"` (20px rows, 12px labels and marks, one cut line each, no time, detail or share) is the master board's task fold. |
| A file in or on a turn | `Attachment` (attachment.tsx) | Media, name, one line, an action. |

Hand-made and staying hand-made (they are the product, not a primitive):
the transcript's rows and its markdown pipeline (streamdown, the worker,
the Shiki code block, DiffBody), the composer field, the rail, the tab
strip, the editor (CodeMirror), the terminal (xterm), the charts
(`aliax/charts`: the grid, axes, marks, legend and tooltip every Stats
chart shares, on recharts and the `--chart-1..4` tokens). Each is built
from the components above wherever it has a button, a menu, a field or a state word. The rail's one row is `RailRow`
(chrome/RailRow.tsx, with `RailHeading`): a 28px ghost `Button`, a 16px
glyph only when it has one, a 13px label, one trailing mark and at most two
`hoverActions` (24px icon `Button`s with their Tooltips at the row's end on
hover and focus, as a workspace's Pin and ⋯), with `surface="group"` for a
container on the `sidebar-group` fills (a workspace), used by the rail, its
foot and the settings list.

## Icons

`@renderer/chrome/icons` is the one icon module (Hugeicons under lucide
names). Components import from it; never from `lucide-react` or
`@tabler/icons-react` in the main app. A missing glyph is added there once.

## Tokens and CSS

Colour, radius, shadow and motion names are in `src/renderer/src/index.css`
(the token layer at the top); the parts utilities cannot express
(`focus-field`, the switch and checkbox transitions, the
collapsible height, the task list) are in `src/renderer/src/assets/components.css`.
A component never writes a literal colour, duration or curve;
`lib/motionGuard.test.ts` fails on a new literal timing and lists, by owning
area, the sites still open. `lib/colourGuard.test.ts` checks literal colours
beside motionGuard and counts each named palette exception.

## Installing another Kobra component

1. Prefer the registry: `KOBRA_TOKEN=… npx shadcn@latest add @kobra/<name>`
   (components.json has the `@kobra` entry). Without a token the paid
   components answer 401; the `kobra` MCP tool `get_component` returns the
   same source and CSS, which you write by hand.
2. Adapt before the first use, in this order:
   - imports: `@/lib/utils` → `@renderer/lib/cn`; `@/components/ui/x` → `./x`;
     `@tabler/icons-react` → `@renderer/chrome/icons` (lucide names: IconX →
     X, IconChevronRight → ChevronRight …); drop `'use client'`.
   - look: no `t-raise`/`t-push` classes (flat), `bg-accent` hover fills →
     `bg-muted` (our `accent` is the blue), `rounded-2xl` cards → `rounded-xl`,
     `text-base` → `text-sm`, `text-[0.9375rem]` → `text-[13px]`,
     `dark:` tweaks dropped where the tokens already differ.
   - motion: a literal duration or curve in Tailwind's bracket form → the
     tokens (`duration-(--dur-slow) ease-(--ease-out)`); exits at
     `--dur-fast`; every animated class carries its `motion-reduce:` guard.
   - z-index: `z-50` → `z-(--layer-popover)` / `z-(--layer-dialog)`.
   - drop `data-sound` attributes and the Sound layer; keep `data-slot`.
   - no `torph` (TextMorph: plain text instead), no `kmenu`.
3. Add its CSS to `assets/components.css` with a comment naming the
   component; tokens it introduces go to the token layer, not beside it.
4. Add a row to the map above and a case to `ui.dom.test.tsx`.

Not installed on purpose: `toast` (892 lines plus a canvas dissolve; sonner
instead), `code-block` (five languages; we have Shiki) and `file-diff`
(DiffBody), `reasoning-steps` (demo-timed; the thinking row stays one line),
`chat-input` (ElevenLabs voice, faked uploads, brand logos; the composer's
field stays hand-made), `composer` (an email draft card with versions),
`message-scroller` (it owns the scroller and uses `content-visibility`, both
of which the transcript window forbids), `chat-history` (the transcript's own
list of the person's messages runs on `scrollToRow`), `inline-citations` (we
cite files, not web sources, and it fetches favicons from a third party),
`trace-waterfall` (a timeline tool on a literal palette), `marker` (it would
only re-skin the notice line), `hover-card` (no caller), `conversation`
(iMessage bubbles), `morphing-icons` (looping glyphs, against the motion
rules), `command-menu` (kmenu), `resizable` (our pane tree), `sidebar`,
`card`, `badge`, `sound`, `orb`. Removed for want of a caller: `plan-card`
(no surface asks to approve a plan) and `message` (layout divs the
transcript's rows already are).

## Verification

Run `bun run typecheck` and the component's DOM tests with `NODE_ENV=test`.
For a static view, run this from the repo root:

```sh
bun run ui:preview src/renderer/src/components/ui/button.tsx#Button --props '{"children":"Save"}' --width 480
```

The harness (`scripts/ui-preview.ts`) writes `/tmp/ui-preview/Button.html`
and `/tmp/ui-preview/Button.light.html`. Show each file with `html_preview`.
Each page links to the other theme; separate documents preserve both
`html.theme-light` and `dark:` selectors. `--width` sets the render column
in pixels (default 480).

The pages embed `out/renderer/assets/*.css` from an existing build. If none
exists, the script prints one line and still writes both pages without the
built stylesheet. It does not build the app. CSS imports in a component are
stubbed; styles come from the build.

Place `button.fixtures.tsx` beside `button.tsx` to preview all its fixtures:

```tsx
export default [
  { name: 'Default', props: { children: 'Save' } },
  { name: 'Disabled', props: { children: 'Save', disabled: true } }
]
```

The same command renders each fixture under an 11px muted label. Fixture
props override `--props`. For required callbacks, pass `"fn"`, such as
`--props '{"children":"Save","onClick":"fn"}'`; the harness replaces that
string with a noop, including in nested props. Rendering needs no `window`.
Static markup does not run effects or events and does not show portals;
check those with a DOM test.

Test the harness with `NODE_ENV=test bunx vitest run scripts/ui-preview.test.ts`.
