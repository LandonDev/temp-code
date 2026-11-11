# UI standard: Kobra on Base UI, docs/DESIGN.md wins

- docs/DESIGN.md is the standard every renderer change follows and wins
  every conflict with a skill, a library default or a brief;
  `src/renderer/src/components/README.md` maps each class of UI element to
  the one component under `src/renderer/src/components/ui` that renders it
  (Kobra on Base UI, adapted flat to the tokens at the top of
  `src/renderer/src/index.css`, to `chrome/icons` and to the motion tokens;
  `StatusMark` is the one status vocabulary, drawn as two spans (the word
  medium in its tone, the detail regular and muted; `still` (working as a
  dot) for a line under a row that already spins, so a row has one moving
  mark), a plain
  string only as "Word: Detail" (`plainStatus`), never a run of spaces
  (`lib/spaceGuard.test.ts`), `threadStateOf` turns a wire
  status into its state; `TypeGlyph` (surfaces/threads/TypeGlyph.tsx) is
  the one coloured type glyph, each type's tint a `--type-*` token on the
  glyph alone, `THREAD_MENU_ICONS` its menu-row form, a test in
  threadTypes.test.ts refusing any other read of `THREAD_GLYPHS` and
  lib/typeTint.test.ts holding the tints to 3:1 and 30° from amber and red;
  sonner is the one toast stack, seated 8px above the
  focused thread's strip and inside its column (no wider than it less 16px
  a side, so a master's chat beside its board holds it), above the board's
  foot while a master's chat is folded, `toastInset` in
  components/ui/toaster.tsx). Nothing in
  src/renderer writes a literal colour, duration or curve, and no bullet
  lists appear in the UI. The motion guard has no application timing
  exceptions: CSS uses the motion tokens, JavaScript uses `lib/ease.ts`,
  the spinner's turn is `SPINNER_TURN`, the working mark's dots `MARK`, the
  working words' shimmer `SHIMMER` and the word morph `--dur-swap-out` and
  `--ease-swap` (`EASE_SWAP`), all in lib/ease.ts and the token layer.
  The springs are `SPRING_LAYOUT` and `SPRING_GLIDE`; a drag settles from
  where it is drawn with the pointer's speed (lib/drag.ts `releaseVelocity`,
  `rubber`). Every popup moves on transitions, its entry CSS `@starting-style`
  (Base UI sets no starting status on a popup mounted open), its exit
  `data-ending-style`; a dialog or sheet dims behind it with the `scrim`
  token. A plan, a board's plan and a report read at `AgentMarkdown`'s
  document size (15/24).
- Settings rows and sections use `components/page.tsx` (`PageRow`,
  `PageSection`), which pass native props and data attributes to their roots;
  Hosts exports these as `Row` and `Group` without copying their markup.
  A section's failure is `PageError` and its empty state `PageEmpty`, one
  line in a row's place (`lib/pageLineGuard.test.ts` refuses a hand-built
  one); its wait is `PageRowsSkeleton` in its rows' shape; a page reads its
  host through `useHostRead` (lib/connection/hostRead.ts: waits for the
  socket, a deadline, Retry, never a value made up from a failure); facts
  on one line are `Facts` (4px apart, commas between, `lib/factsGuard.test.ts`).
- Use `text-xs` for 12px. `lib/typeScaleGuard.test.ts` refuses the literal
  `text-[12px]` in renderer source.
- Every `overflow-y-auto` class string names its horizontal policy:
  `overflow-x-hidden` for lists or `overflow-x-auto` for content that needs
  both axes. `lib/scrollerGuard.test.ts` enforces this without exceptions.
- Cut text uses `TruncateTip`; fitted text mounts no tooltip trigger.
  It measures truncating text inside a status line too.
- Agent details use `ModelLine` before their host, branch and numbers.
  Queue effort names use `effortWord` from lib/models.ts.
- File headers, file previews and implementation tallies use `Counts` from
  `chrome/rail/changeRows.tsx`: sans, tabular numbers at the line's size,
  4px between values; it shares the transcript's numeric renderer.
- A busy button uses `BusyLabel` to hold both widths at rest.
  `lib/busyLabelGuard.test.ts` refuses bare Spinner children, including
  render slots; icon buttons keep their name on the button.
- Buttons and focus: the solid `Button` variants (default, secondary,
  destructive) are raised, Kobra's `t-raise` on the `--raise-*` tokens in
  index.css (a shadowed fill layer behind the label, pressing in to 0.985);
  ghost, outline, link and every row are flat and press by stepping their
  fill to `foreground/12` at once, never by scaling (a row drawn by hand
  takes `ROW_PRESS`, components/ui/press.ts: `/5` on hover over
  `--dur-hover`, `/12` on a press; the composer's quiet controls and every
  draft-row picker `ROW_CONTROL`; a pressed toggle is `muted`). There is one focus
  ring, index.css's inset outline, which an element outside its selector
  list joins with `focus-ring`; `lib/focusGuard.test.ts` refuses any
  `focus-visible:ring`. Neighbouring tooltips share one `TooltipProvider`
  (delays in `TOOLTIP`, lib/ease.ts), never around a scroller, the rail's
  nav or a virtual list (the lazy provider remounts what it wraps). A
  hover reveal is `reveal(group)` on a wrapper (components/ui/reveal.ts;
  what it covers `yields(group)`; lib/revealGuard.test.ts refuses a reveal
  without `--delay-hover` or on focus-within), a
  disclosure chevron is a ChevronRight turning `rotate-90` on
  `DISCLOSURE_CHEVRON` (components/ui/disclosure.ts), with no timing of its
  own beside it and never a 180° turn (`lib/disclosureGuard.test.ts`; a menu
  trigger's chevron is a still `ChevronDown`), a bounded log is a `pre` on `CONSOLE` (components/ui/
  console.ts), no icon takes a `strokeWidth` prop, and a solid red button
  never sits in a list row (a row's remove is a ghost that turns red on hover;
  `lib/redButtonGuard.test.ts` allows a destructive `Button` only inside a
  dialog's footer).
- Every resize handle uses `hooks/useSashKeys.ts` for focus,
  separator ARIA, axis arrows (2% of the container, Shift 10%) and a
  double-click reset. Keyboard resize commits at once; `useDragResize`
  exposes `resizeTo` and `reset` to clamp, paint and save without a spring.
- The right side of a thread is one panel (`lib/rightPanel.ts`,
  `surfaces/RightPanel.tsx`; docs/LAYOUT.md "The right side"): Agents first
  and its default whenever the thread has subagents, Activity only with rows
  of the thread's own; it follows the thread its pane SHOWS
  (`rightPanel.showThread`, set by MasterView while a batch child or a
  subagent line is open in the board's place: that thread's sections and
  section memory on the pane's open state and width, read on its own host,
  the child's own view `bare`; Back hands it back to the master; an
  `AgentDetail` inside Agents moves nothing), and a master's empty Agents
  says "Batch threads are on the board"; a toggle in place slides it in from the edge or back
  out over the thread on transform and opacity (`usePaneMotion` in
  surfaces/threads/ThreadView.tsx), the thread taking its width at once;
  the composer's slash menu moves on the popup recipe (`POPUP_MOTION`,
  chrome/CommandPopover.tsx). Modal and
  ConfirmDialog ride `components/ui/dialog.tsx`, and every form dialog is
  Modal + ModalBody + DialogFooter (`lib/dialogShapeGuard.test.ts`). Its Changes section is one
  virtual list (`chrome/rail/changesItems.ts` through the rail's
  `VirtualRows` on a native scroller whose size comes from the
  ResizeObserver, starting from the last one seen (`sizeKey`), so a cold
  mount forces no layout; one `RowsContextMenu` for its rows, a fold's `Collapsible`
  only once it opens; `useAgainst` holds the Against group's state), so its
  cost follows the viewport in every warm tab; the host never lists the
  app's `.temp-code/` there (`APP_DIR_PATHSPEC` in
  src/main/server/appDir.ts on git status, the numstats, Stage all, Stash
  and the commit draft; a call carrying it runs without
  GIT_LITERAL_PATHSPECS).
- Verification for a renderer change: `bun run typecheck`, the tests you
  touched (every new behaviour gets a jsdom test), and a static render
  through `bun run ui:preview <module>#<Export> --props '<json>'`
  (scripts/ui-preview.ts: the component rendered by the client renderer in a
  jsdom document and read once its markup settles (400ms at most, so a count
  ticking up shows where it lands), under tsconfig.web.json so every renderer alias resolves,
  inside the built stylesheet in dark and light, written to /tmp/ui-preview
  or `--out <dir>`, `--shot` adding PNGs at 864 and 400px through headless
  Chrome (`TEMP_CODE_CHROME`, else Playwright's cached chrome-headless-shell),
  shown with `html_preview` or read as images; a `*.fixtures.tsx` beside the
  component renders each fixture); one
  electron-vite build per branch for `bun run check:bundle`, never the
  full suite or a dev instance. The renderer's prettier style differs from
  the root config: never run prettier or `--fix` on src/renderer.
