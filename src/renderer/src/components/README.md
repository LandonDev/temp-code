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
| Any button, icon button, row action | `Button` (button.tsx) | Flat. `default` is the one primary per surface; `secondary` gray; `ghost` for icon and row buttons; `outline` only inside forms; `destructive` red; `link` inline. Never a raw `<button>` with classes. |
| A toggle button, a segmented bar | `Toggle`, `ToggleGroup` (toggle.tsx, toggle-group.tsx) | `spacing={0}` joins a group into one bar. |
| A modal | `Dialog` (dialog.tsx) | Centred, `size` sm/default/md/lg. CRUD and every form opens in one. |
| A confirm | `AlertDialog*` (dialog.tsx) | Only for destructive, irreversible actions. One title, one line, Cancel + the verb. |
| A side form, a long picker | `Sheet` (sheet.tsx) | Enters from an edge. The right panel is not a Sheet. |
| A menu from a trigger | `DropdownMenu` (dropdown-menu.tsx) | `size="sm"` in dense chrome. Rows: glyph, label, shortcut. |
| A right-click menu | `ContextMenu` (context-menu.tsx) | Same rows at the `sm` size, opened at the pointer. |
| Floating content from a trigger | `Popover` (popover.tsx) | Pickers, account lists, previews. Scales from its anchor. |
| A label on hover | `Tooltip` (tooltip.tsx) | Replaces every `title=`. Each carries its delay; a `TooltipProvider` around a toolbar lets neighbours share one. |
| An option picker | `Select` (select.tsx) | Bordered trigger, list aligned on the chosen item. |
| An option picker from a list | `ChoiceSelect` (../choice-select.tsx) | The one adapter from `{ value, label }[]` to `Select`; an empty value (Auto) round-trips. Nothing maps `SelectItem`s by hand. |
| A settings or app page | `Page`, `PageSection`, `PageRow` (../page.tsx) | 672px column, 24px inset, one 16px title; sections 24px apart under a 12px muted heading; rows with a hairline between neighbours. A page never draws its own header or section heading. |
| A text field | `Input`, `Textarea` (input.tsx, textarea.tsx) | 32px, hairline border, ring inside. |
| A setting on or off | `Switch` (switch.tsx) | The only toggle for a setting. |
| A choice in a list | `Checkbox` (checkbox.tsx) | |
| Tabs, a segmented control | `Tabs` (tabs.tsx) | `variant="default"` segmented, `variant="line"` underlined. |
| A list row, a settings row | `Item` (item.tsx) | Media, title + description, actions. Settings pages are columns of these. |
| A divider | `Separator` (separator.tsx) | Spacing first; a separator only where spacing cannot tell groups apart. |
| A disclosure | `Collapsible` (collapsible.tsx) | Height eases through `.collapsible-resize`. |
| A scrolling panel | `ScrollArea` (scroll-area.tsx) | Panels and lists; the transcript keeps its native scroller. |
| A determinate bar | `Progress` (progress.tsx) | Usage meter, tallies. |
| Loading, indeterminate | `Spinner` (spinner.tsx) | 16px arc, with a word. The nine other spinners are retired. |
| Loading, a shape | `Skeleton` (skeleton.tsx) | Shaped like what it stands in for. |
| Something is happening (text) | `TextShimmer` (text-shimmer.tsx) | The one shimmer. |
| Nothing here | `Empty` (empty.tsx) | Title, one line, at most one action. |
| An inline callout | `Alert` (alert.tsx) | Tinted by tone. Not for transcript notices. |
| A thread's state | `StatusMark` (status.tsx) | One glyph, one word, one tone per state. The only status-to-colour map. |
| A key cap | `Kbd` (kbd.tsx) | In menus, tooltips, buttons. |
| A toast | sonner `toast()`; one `<Toaster>` (toaster.tsx) mounted lazily in main.tsx | The four custom toast stacks are retired. |
| A question from the agent | `QuestionCard` (question-card.tsx) | Lettered options, free-form field, ⌘⏎. |
| A plan to approve | `PlanCard` (plan-card.tsx) | To-dos, Approve ⌘⏎, optional countdown. |
| Tasks the agent works through | `TaskList` (task-list.tsx) | Donut header, marks that draw their check. |
| A live short line | `StreamingText` (streaming-text.tsx) | Words fade in. Not the transcript's prose. |
| A file in or on a turn | `Attachment` (attachment.tsx) | Media, name, one line, an action. |
| The frame of one message | `Message` (message.tsx) | The user bubble itself is the transcript's. |

Hand-made and staying hand-made (they are the product, not a primitive):
the transcript's rows and its markdown pipeline (streamdown, the worker,
the Shiki code block, DiffBody), the composer field, the rail, the tab
strip, the editor (CodeMirror), the terminal (xterm), the charts (recharts
in Aliax). Each is built from the components above wherever it has a
button, a menu, a field or a state word.

## Icons

`@renderer/chrome/icons` is the one icon module (Hugeicons under lucide
names). Components import from it; never from `lucide-react` or
`@tabler/icons-react` in the main app. A missing glyph is added there once.

## Tokens and CSS

Colour, radius, shadow and motion names are in `src/renderer/src/index.css`
(the token layer at the top); the parts utilities cannot express
(`focus-field`, `shimmer`, the switch and checkbox transitions, the
collapsible height, the task list) are in `src/renderer/src/assets/components.css`.
A component never writes a literal colour, duration or curve.

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
   - motion: literal `duration-[280ms]`/`ease-[cubic-bezier(…)]` → the
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
