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
| Any button, icon button, row action | `Button` (button.tsx) | Flat. `default` is the one primary per surface; `secondary` gray; `ghost` for icon and row buttons; `outline` only inside forms; `destructive` red; `link` inline. Never a raw button element with classes. |
| A toggle button, a segmented bar | `Toggle`, `ToggleGroup` (toggle.tsx, toggle-group.tsx) | `spacing={0}` joins a group into one bar. |
| A modal | `Dialog` (dialog.tsx) | Centred, `size` sm/default/md/lg; `full` for a viewer (an image, a rendered page). CRUD and every form opens in one. |
| A confirm | `AlertDialog*` (dialog.tsx); from code, `useConfirm()` (chrome/ConfirmDialog.tsx) | Only for destructive, irreversible actions. One title, one line, Cancel + the verb. Never `window.confirm`. |
| A side form, a long picker | `Sheet` (sheet.tsx) | Enters from an edge; `width` in px on a side sheet (440 by default). The right panel is not a Sheet. |
| A menu from a trigger | `RowsMenu` (chrome/menuRows.tsx) over `DropdownMenu` (dropdown-menu.tsx) | Rows are `MenuRow[]` data, rendered by the one `MenuRows` (chrome/menuBody.tsx): the 14px glyph, the label, the key cap from `shortcutFor`. The body loads in `menuChunk`, out of the first paint. |
| A right-click menu | `RowsContextMenu` (chrome/menuRows.tsx) over `ContextMenu` (context-menu.tsx) | Same rows, at the pointer. One around a list; each row carries `data-menu-id`. |
| Content floating from a control (a picker, a list of accounts) | `LazyPopover` (chrome/menuRows.tsx) over `Popover` (popover.tsx) | Content, never verbs. |
| A thread's menu, on any surface | `threadMenuRows` (lib/threadMenu.ts) with `useThreadMenu` (chrome/useThreadMenu.tsx) | One list everywhere (tab chip, ⋯, title-bar tab, rail row, board row, subagent line); a surface adds only Open, New pass… or Start now. The hook runs every pick and mounts the dialogs. |
| A project's or tab group's look | `CustomizeGroupDialog` (chrome/CustomizeGroupDialog.tsx), from `groupMenuRows`' Customize… | Name, logo, colour, mascot; applied on Save. |
| Floating content from a trigger | `Popover` (popover.tsx) | Pickers, account lists, previews. Scales from its anchor. |
| A label on hover | `Tip` / `TruncateTip` (../tip.tsx) over `Tooltip` (tooltip.tsx) | `Tip` names an icon-only control, with its binding's `Kbd`; `TruncateTip` shows cut-off text whole, only while it is cut. |
| The tooltip itself | `Tooltip` (tooltip.tsx) | Replaces every `title=`. Each carries its delay; a `TooltipProvider` around a toolbar lets neighbours share one. `TOOLTIP_DELAY` and `TOOLTIP_CLOSE_DELAY` are the numbers a hover popover reuses. |
| An option picker | `Select` (select.tsx) | Bordered trigger, list aligned on the chosen item. |
| An option picker from a list | `ChoiceSelect` (../choice-select.tsx) | The one adapter from `{ value, label }[]` to `Select`; an empty value (Auto) round-trips; an option's `group` lists it under that heading (a provider). Nothing maps `SelectItem`s by hand. |
| A settings or app page | `Page`, `PageSection`, `PageRow` (../page.tsx) | 672px column, 24px inset, one 16px title; sections 24px apart under a 12px muted heading; rows with a hairline between neighbours. A page never draws its own header or section heading. |
| A single choice of a few, shown at once | `ChoiceToggle` (../choice-toggle.tsx) | The one adapter from `{ value, label, disabled?, note? }[]` to a single-choice `ToggleGroup` on a bordered track; one is always chosen; a disabled choice's `note` is its Tooltip. |
| A text field | `Input`, `Textarea` (input.tsx, textarea.tsx) | 32px, hairline border, ring inside. A field with a glyph or buttons in it (search) is `InputGroup` with `leading`/`trailing` around a `GroupInput`. |
| A labelled field in a dialog or sheet | `Field`, `FieldRow`, `CheckRow` (chrome/DialogField.tsx) | `Field`: the 12px muted label, the control, a hint or a red error line under it. `FieldRow`: an Item row, the label (and description, error) at its start and the choice at its end. `CheckRow`: one decision in a confirm, a Checkbox named by its label. |
| A setting on or off | `Switch` (switch.tsx); `SettingSwitch` (../setting-switch.tsx) in a settings row | The only toggle for a setting. `SettingSwitch` names it and plays the switch cue. |
| A choice in a list | `Checkbox` (checkbox.tsx) | |
| Tabs, a segmented control | `Tabs` (tabs.tsx) | `variant="default"` segmented, `variant="line"` underlined. The file and terminal strip (chrome/SurfaceTabs.tsx) is a line `Tabs` of 28px chips: icon, name, and a 16px slot whose unsaved dot turns into close on hover (a clean active tab shows close). |
| Rows and columns of structured data | `Table` (table.tsx) | Flat: hairline rows, no box, no column rules, first and last columns on the inset. No hover fill; the cells hold the controls. |
| A list row, a settings row | `Item` (item.tsx) | Media, title + description, actions. Settings pages are columns of these. |
| A list row the whole of which acts (open, pick, restore) | `ItemButton` (item.tsx) | The `Item` row as one button element (type button), with Item's variants and sizes; the caller names its hover fill. Never an `Item` turned into a button through its `render` prop. |
| A divider | `Separator` (separator.tsx) | Spacing first; a separator only where spacing cannot tell groups apart. |
| A disclosure | `Collapsible` (collapsible.tsx) | Height eases through `.collapsible-resize`. A fold with no trigger of its own is the same panel, opened by `open`. |
| An icon replacing another (Copy → Check) | `SwapIcon` (../../motion/IconSwap.tsx) | The new glyph grows from a quarter size on `SPRING_LAYOUT`; reduced motion cross-fades. |
| A scrolling panel | `ScrollArea` (scroll-area.tsx) | Panels and lists; the transcript keeps its native scroller. |
| A determinate bar | `Progress` (progress.tsx) | Usage meter, tallies. `fill` is foreground, muted or warning; the fill is a transform, so a live update never relayouts. |
| Loading, indeterminate | `Spinner` (spinner.tsx) | 16px arc, with a word. The nine other spinners are retired. A small section's wait is `LoadingLine` (surfaces/SurfaceSkeleton.tsx). |
| Loading, a shape | `Skeleton` (skeleton.tsx) | Shaped like what it stands in for; still. A whole surface is `SurfaceSkeleton` (surfaces/SurfaceSkeleton.tsx) by kind. |
| Something is happening (text) | `TextShimmer` (text-shimmer.tsx) | The one shimmer. |
| Nothing here | `Empty` (empty.tsx) | Title, one line, at most one action, through `EmptyState` (surfaces/SurfaceSkeleton.tsx). A picker's no match is one muted row. |
| An inline callout | `Alert` (alert.tsx) | Tinted by tone. Not for transcript notices. |
| A thread's state | `StatusMark` (status.tsx) | One glyph, one word, one tone per state; `detail` is what it is about, muted after the word ("Working  typecheck", a tally). The only status-to-colour map; `threadStateOf(status, { settled, planReady })` turns a session's wire status into the state (a written plan is `plan-ready`, muted), `linkMarkOf(transport)` a host link into its state and word. A thread's row reads `threadStatus` (lib/threadStripModel.ts: the state with the tree's overrides, the detail and the tally) and draws it with `ThreadStatusMark` (chrome/TabIndicator.tsx); `marksAtRest` leaves idle and done unmarked. |
| A key cap | `Kbd` (kbd.tsx) | In menus, tooltips, buttons. |
| A toast | sonner `toast()`; one `<Toaster>` (toaster.tsx) mounted lazily in main.tsx | The four custom toast stacks are retired. |
| A question from the agent | `QuestionCard` (question-card.tsx) | Lettered options, free-form field, `multiSelect` for several picks, ⌘⏎ (keys only while focus is inside the card). |
| A plan to approve | `PlanCard` (plan-card.tsx) | To-dos, Approve ⌘⏎, optional countdown. |
| Tasks the agent works through | `TaskList` (task-list.tsx) | Donut header, marks that draw their check. |
| A live short line | `StreamingText` (streaming-text.tsx) | Words fade in. Not the transcript's prose. |
| A file in or on a turn | `Attachment` (attachment.tsx) | Media, name, one line, an action. |
| The frame of one message | `Message` (message.tsx) | The user bubble itself is the transcript's. |

Hand-made and staying hand-made (they are the product, not a primitive):
the transcript's rows and its markdown pipeline (streamdown, the worker,
the Shiki code block, DiffBody), the composer field, the rail, the tab
strip, the editor (CodeMirror), the terminal (xterm), the charts
(`aliax/charts`: the grid, axes, marks, legend and tooltip every Stats
chart shares, on recharts and the `--chart-1..4` tokens). Each is built
from the components above wherever it has a button, a menu, a field or a state word. The rail's one row is `RailRow`
(chrome/RailRow.tsx, with `RailHeading`): a ghost `Button`, a 16px glyph, a
13px label, one trailing mark and one hover action, used by the rail, its
foot and the settings list.

## Icons

`@renderer/chrome/icons` is the one icon module (Hugeicons under lucide
names). Components import from it; never from `lucide-react` or
`@tabler/icons-react` in the main app. A missing glyph is added there once.

## Tokens and CSS

Colour, radius, shadow and motion names are in `src/renderer/src/index.css`
(the token layer at the top); the parts utilities cannot express
(`focus-field`, `shimmer`, the switch and checkbox transitions, the
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
instead), `code-block` and `file-diff` (we have Shiki and DiffBody),
`reasoning-steps` (demo-timed), `chat-input` (ElevenLabs and voice deps),
`conversation` (iMessage bubbles), `command-menu` (kmenu), `resizable`
(our pane tree), `sidebar`, `card`, `badge`, `sound`, `orb`.

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
