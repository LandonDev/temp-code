# Launch-time code caches: boot.js, the compile cache, the app scheme

- `package.json` `main` is `out/main/boot.js` (src/main/boot.ts), a second
  main entry that in a packaged app enables Node's compile cache at
  `$TMPDIR/temp-code/compile-cache` (macOS purges it after three idle days)
  and then requires `out/main/index.js` through it; index.ts flushes the
  cache 10 s after boot and in `before-quit`, because Electron's quit never
  reaches Node's exit-time write. `TEMP_CODE_COMPILE_CACHE` points an
  isolated copy elsewhere. The first `[boot]` line of a launch reads
  `index <ms> start=<epoch> compile-cache=on|off`; dev runs say `off`.
- The packaged renderer loads from `tempcode-app://renderer/index.html`
  (src/main/appScheme.ts), a privileged scheme with `codeCache: true`, so
  Chromium keeps a V8 code cache for the index chunk and every lazy chunk
  under `assets/`; `file://` never gets one. Both schemes register in one
  `registerSchemes()` call (assets.ts). First boot on the new origin copies
  the `file://` localStorage over once (src/main/originMigration.ts, marker
  `<userData>/localstorage-migrated`).
- Monaco file and review panes use `surfaces/FileHeader.tsx` for the folder
  and review stepper. A Monaco review tab opens on its first change, and
  the header's Revert change and Stage change act on the change the caret
  is in (Stage only for a review against HEAD, built on the index; editorGit
  reached through `import()`, line helpers in surfaces/monaco/diffActions.ts).
  CodeMirror mounts `surfaces/HunkBar.tsx` for Stage and Revert with shared
  buttons and tooltips. `lib/colourGuard.test.ts`
  checks literal renderer colours against the token layer and counted
  palette exceptions; the counts only shrink.
- The renderer is split (docs/bundle-split.md): the index chunk carries
  only the first paint (rail, transcript, composer, thread header; 4,891.7
  kB on 2026-11-05, once Base UI's menu and popover left it, under the
  5,136.0 kB budget)
  and every other surface is a
  lazy chunk behind
  `defineChunk` (src/renderer/src/lib/lazyChunk.tsx), listed in
  `src/renderer/src/surfaces/chunks.ts`: Settings, the Aliax pages
  (recharts), the edit row's diff body, the CodeMirror
  editor with its find keys and git helpers, the terminal (xterm), the
  non-chat thread views (board, plan, research, fleet), the HTML render
  frame, the media viewer, the lightbox, the release notes with the
  changelog parser, the action-opened dialogs (`dialogsChunk` over
  chrome/dialogs.ts, each mounted only while open, the thread menu's
  Resources, Archive, Mac bridge, Rename and Goal, its Recent and Archived lists
  (`ThreadListPopover`), the plan chip's options and the branch picker's
  switch confirm among them), the failure card's account list (`accountsChunk`),
  the transcript's message list rows under their chevron (`messageListChunk`),
  a workspace's threads beside the rail (`workspaceThreadsChunk`), the
  file and symbol pickers (`pickersChunk`, mounted while open), the
  composer's slash and @ menu (`commandMenuChunk`, mounted from a
  composer's first `/` or `@` on), a box
  thread's waiting Mac bridge card (`macBridgeChunk`), the return from Away
  (`awayReturnChunk`: chrome/AwayReturn.tsx, mounted at boot, loaded after
  the first paint), a review's notice
  (`reviewChunk`, ReviewCard and GateCard behind a 28px skeleton line, warmed with the
  first thread's chunks) and the
  rail's virtualizer (`virtualChunk`; the rail lists its cards plainly until it
  lands, chrome/railRows.tsx). A mount
  point calls `chunk.surface(name, <SurfaceSkeleton kind=… />)`, which
  sits in a `ChunkBoundary` (a failed import or a render throw holds the
  skeleton with "Couldn't load" and Retry, which replaces the lazy and the
  chunk's promise; the rail and the other panes stay); a trigger
  spreads `chunk.intent` (hover or focus warms the chunk, so a click on a
  warm machine never shows the skeleton); the first thread on screen warms
  the diff and thread-view chunks in an idle slot (`preloadWhenIdle`).
  A module in a lazy chunk must never be imported statically from the main
  chunk (the right panel's Changes section and App.tsx's editor find keys reach the
  editor chunk through `import()` and `surfaces/editorFind.ts`); the
  transcript's highlighter loads each grammar's chunk on first use
  (lib/highlightLanguages.ts). `electron-vite build` writes the chunk map to
  `out/bundle-map.json` (`bun run bundle:map` prints it) and
  `scripts/check-bundle-size.ts` (`bun run check:bundle`, in `bun run
  build` and the release gate) fails when the index chunk's static closure
  passes 5 MiB + 16 KiB or holds one of the lazy modules (the Base UI primitives
  stay out of the entry: the tooltip defers its primitive, the menus and
  popovers ride menuChunk (a first-paint surface that draws a menu or a
  popover by its parts imports them from components/ui/lazy-menus.tsx: a cold
  trigger of the same element until the chunk lands, no content), the branch
  picker's list with them (chrome/BranchRows.tsx), every select rides
  selectChunk: the composer's
  permission, thread type and model setting pickers and every ChoiceSelect
  (asking for the chunk as it mounts) draw a cold trigger of the same
  classes, size and width until it lands, components/lazy-select.tsx; only the dialog is in the first paint). It also fails when a chunk renders a string tag that is no HTML, SVG or custom element: the React Compiler inlines a lowercase component alias into the JSX tag (`jsx("current")`, an empty element), which only the built bundle shows.
  `/ui` serves the chunks
  as immutable module scripts behind the cookie (remote/ui.ts).
- Proof: `bun run script:e2e-launch-timing` (scripts/e2e-launch-timing.ts)
  packs an isolated copy under /private/tmp/tc-launch-timing and launches it
  four times with Chromium's startup trace on; the report shows the `index`
  mark, `tc:ready`, and the index bundle's `consumedCacheSize`. On the box,
  `bun scripts/launch-timing-linux.ts --tree <checkout>` runs a built tree
  under xvfb-run with a window and reads `tc:ready` over CDP (it pre-sets
  the migration marker: on Linux with a display the migration's hidden
  window closing is window-all-closed, and the app quits before the first
  real window opens).
