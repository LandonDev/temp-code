# The renderer's chunk split

The renderer used to ship one 8 MB index bundle, parsed whole at every
launch (the V8 code cache on the `tempcode-app://` scheme made that cheaper,
not smaller). Since 2026-10-21 the index chunk carries only what the first
paint uses: the rail, the transcript, the composer and the thread header.
Every other surface is a lazy chunk that lands with its first use, warmed
on intent so the skeleton is rarely seen.

## The mechanism

- `src/renderer/src/lib/lazyChunk.tsx` — `defineChunk(name, () => import(…))`
  returns a chunk: `load()` (the import, once), `preload()` (the import with
  the promise dropped), `loaded()`, `intent` (`onPointerEnter` / `onFocus`
  handlers for a trigger), and `surface(name, fallback)`: the module's
  component behind `React.lazy` and a Suspense boundary. Once the module
  has landed the lazy initializer gets a settled thenable, so the first
  mount after a preload commits in one pass with no fallback at all.
  `preloadWhenIdle(chunk)` runs the import in a `requestIdleCallback` slot.
- `src/renderer/src/surfaces/chunks.ts` — the registry, one `defineChunk`
  per chunk; `allChunks` for the tests. Where a chunk is more than one
  module the import target is a barrel (`diffChunk.ts`, `editorChunk.ts`,
  `threads/threadViews.ts`).
- `src/renderer/src/surfaces/SurfaceSkeleton.tsx` — the fallbacks, one
  outline per kind (`page`, `pane`, `diff`, `terminal`, `frame`), the
  surface's own shape in faint bars so the frame around it never jumps.

| Chunk | Holds | Mount point | Warmed by |
| --- | --- | --- | --- |
| settings | SettingsView and every pane (Hosts, Appshots…), qrcode | App.tsx | the Settings buttons (title bar, rail, sidebar, environment switcher, connection line) |
| aliax | AliaxPagesView, the Accounts and Stats pages, recharts, lucide | App.tsx | the Accounts and Stats rail actions |
| diff | DiffPane (GitChangesPanel) and the edit row's DiffBody | App.tsx, EditRow.tsx | the changes toggles (title bar diff stats, file tree); the first thread on screen, after idle |
| editor | FileEditor, CodeMirror and its language packages, editorSearch (the find keys), editorGit | FilePane.tsx; App.tsx through `surfaces/editorFind.ts` | hovering the file tree |
| terminal | TerminalView, xterm | FilePane.tsx, ProjectTerminalDock.tsx | the New Terminal button and the cwd picker's row |
| threadViews | ImplementationView (the board), PlanView, ResearchView, OrchestrationView and the fleet rows | threads/ThreadView.tsx | the first thread on screen, after idle |
| htmlRender | HtmlRenderRow and HtmlRenderDocument (an agent's HTML page) | AgentTranscript.tsx, HtmlRenderOverlay.tsx | the row's own mount |
| media | MediaGate and MediaReview (images, media, review) | FilePane.tsx | hovering the file tree |
| lightbox | the Lightbox component (its store is `chrome/lightboxStore.ts`, in the main chunk) | Composer.tsx | hovering an attachment thumbnail |
| releaseNotes | ReleaseNotesSurface | FilePane.tsx | the What's new button in Settings |

Two things had to move for the boundaries to hold: the rail's
`ChangesPanel` reached CodeMirror's diff (`@codemirror/merge`) and
`editorGit` statically, which would have folded CodeMirror back into the
first paint, so `loadHunks` and `stageHunk` import them when a file is
expanded; and App.tsx's find keys (`handleEditorFindKey`,
`openFindInActiveEditor`) go through `surfaces/editorFind.ts`, which asks
the editor chunk only when it is loaded (an editor can only be mounted
once it is, so before that no key is an editor's). The bundled changelog
text (`CHANGELOG.md?raw`, 34 kB) stays in the main chunk: App.tsx reads it
synchronously to open a What's new tab.

The transcript's highlighter (`lib/highlight.worker.ts`) starts with no
grammar and loads each language's chunk on first use
(`lib/highlightLanguages.ts`: aliases, one in-flight load per grammar, plain
text for a grammar whose chunk does not land). Monaco's shiki grammars stay
eager inside the Monaco chunk, which is lazy as a whole: `@shikijs/monaco`
registers a tokens provider per loaded language at setup.

Shared code between lazy chunks (the fleet rows, the markdown stack where it
is not already in the main chunk) is hoisted by Rollup into chunks of its own
and fetched once.

## The budget

`electron-vite build` writes `out/bundle-map.json` (the `bundleMap` plugin in
electron.vite.config.ts: every chunk's size, imports, dynamic imports and
module sizes; excluded from the packaged app in electron-builder.yml).
`bun run bundle:map` prints the entry chunk, its static closure, the biggest
lazy chunks and the top contributors. `bun run check:bundle`
(scripts/check-bundle-size.ts) fails when the index chunk's static closure
passes 5 MiB (measured 4.56 MiB; the budget leaves about 10% for the
surfaces that belong in the first paint, not a chunk's worth: xterm alone is
0.3 MiB, CodeMirror 0.8, recharts 0.9) or when any module of
`NEVER_IN_ENTRY` (the packages and surfaces above) is in that closure — a
single static import from the main chunk would fold a chunk back in long
before the budget noticed. It runs in `bun run build` and in the release
gate (scripts/release.ts) right after the build.

## Serving

The packaged app serves every chunk from `tempcode-app://renderer/assets/…`
(src/main/appScheme.ts, `text/javascript`), the scheme Chromium keeps a V8
code cache for; `/ui` serves them as immutable module scripts behind the
session cookie (src/main/server/remote/ui.ts). Both have unit tests
(appScheme.test.ts, ui.test.ts). The index.html CSP's `script-src 'self'`
covers the chunks and Vite's modulepreload links on both origins.

## Numbers

Sizes, from the bundle map (`bun run bundle:map`):

| | before | after |
| --- | --- | --- |
| index chunk (the first paint's static closure) | 8,266 kB (1,762 modules) | 4,666 kB (1,111 modules) |
| renderer code cache after three launches (box) | 2.8 MB | 1.5 MB |
| lazy chunks the entry can reach | 24 | 31 |

Where the 3.6 MB went, by top contributor to the old entry chunk: recharts
921 kB, the Aliax pages 474 kB, CodeMirror 801 kB (`@codemirror/view` 459,
state 144, autocomplete 82, language 73, commands 68, search 41, lezer
110), xterm 326 kB, qrcode 80 kB, SettingsView and its panes 150 kB, the
thread views, diff pane, editor, media viewer, terminal and release notes
surfaces together 250 kB. What stays is the transcript's markdown stack
(parse5 268 kB, micromark and friends 300 kB, streamdown 80 kB), react-dom
548 kB, motion 435 kB, zod 170 kB, tailwind-merge 100 kB, the icons 90 kB
and the renderer's own chrome, lib and transcript code (2.2 MB).

Launch on the box (`bun scripts/launch-timing-linux.ts`, a built tree under
xvfb-run with a window, `tc:ready` over CDP; the box was running other
threads' builds, so two rounds of five launches each; launch 1 has no code
cache, 2 produces it, 3+ consume it):

| tc:ready, ms after the renderer's navigation | before | after |
| --- | --- | --- |
| round 1, launches 1–5 | 710, 810, 844, 1039, 1100 | 778, 694, 559, 524, 510 |
| round 2, launches 1–5 | 558, 711, 437, 426, 496 | 407, 423, 362, 345, 566 |
| warm (launches 3–5 of both rounds), median | 670 | 517 |
| warm, best | 426 | 345 |
| warm, ms after the process spawn, median | 1,763 | 1,215 |

On the Mac the launch-timing proof (`bun run script:e2e-launch-timing`,
a packaged copy with Chromium's startup trace) is run from a scratch clone
under /Users/landon/IdeaProjects/tc-perf, never the user's checkout; its
report is recorded below when it has run.

### Mac launch-timing report

Run 2026-10-21 from a scratch clone under /Users/landon/IdeaProjects/tc-perf
at master f8deb17 (the split plus the morning's sibling merges; the index
chunk there is 4,861,232 bytes, `index-MTCtBREj.js`), packed as 1.0.273 with
Chromium's startup trace, four launches. `index` is the main process's
compile of out/main/index.js, `tc:ready` the UI on screen, both ms after
the process spawn; `consumed` is the index chunk's V8 code cache read on
launches 3 and 4 (none on 1, produced on 2).

| launch | index | ready-to-show | tc:ready | bundle compile | consumed | Code Cache |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 235 | 790 | 993 | 0.0 (streamed) | – | 2 KB |
| 2 | 163 | 585 | 790 | 0.0 (streamed) | – (produced) | 2,784 KB |
| 3 | 198 | 579 | 781 | 3.1 | 1,618,872, rejected false | 2,784 KB |
| 4 | 237 | 630 | 821 | 3.2 | 1,618,872, rejected false | 2,784 KB |

Every launch booted to `tc:ready`, quit cleanly and logged no console
error; the proof's one red check that run was the main process's `index`
mark on launch 4 (237 ms against 235 on launch 1), a coin flip in Node's
compile cache that the renderer split does not touch. The earlier proof of
the code caches (plan kzTjVxj7h35M) consumed a cache of the whole 8 MB
bundle; it now covers the 4.9 MB index chunk, with each lazy chunk cached
on its own the first time it loads.

## Adding a surface

1. Put the import behind `defineChunk` in `surfaces/chunks.ts` (a barrel if
   it is several modules) and add its modules to `NEVER_IN_ENTRY`.
2. At the mount point: `const X = chunk.surface("X", <SurfaceSkeleton kind="…" />)`.
3. On the trigger: spread `chunk.intent` (IconButton and RailRow take an
   `intent` prop), or `preloadWhenIdle(chunk)` where a click is not the way in.
4. Never import a module of the chunk statically from the main chunk;
   `bun run check:bundle` says so when it happens, `bun run bundle:map`
   shows which import did it.
5. A dom test in `surfaces/chunks.dom.test.tsx` asserts every chunk's
   barrel exposes what the mount points ask for.
