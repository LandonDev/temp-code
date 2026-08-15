# temp-code — file viewer, editor, and the dev loop: implementation plan

Four milestones, in dependency order:

- **M11 — File surfaces**: a real file tree, a Monaco viewer/editor as a
  first-class surface in the strip, autosave, and live reconciliation with
  agent edits on disk.
- **M12 — Git flow**: commit and push from the app, per project, to the
  project's own branch — untouched by whatever the user has checked out
  anywhere else. Branch-aware project creation; cheap project switching.
- **M13 — Language intelligence**: an LSP pool in main — vtsls for the web
  workflow, Eclipse JDT LS for the Java workflow — bridged into Monaco.
  Method completion, diagnostics, go-to-definition, hover, rename.
- **M14 — Editor finish**: diff surfaces, format-on-save, symbol search,
  and a pluggable AI ghost-text provider.

M11 is the substrate; M12 needs only M11's rail touchpoints; M13 mounts
onto M11's editor; M14 decorates both. Design rules carried forward: the
event log stays the source of truth for threads; **disk is the source of
truth for files** — the editor is a view over the working tree, never a
private copy. That one rule is what makes agent edits, autosave, git, and
(later) in-thread diff editing all coherent.

## Decision: Monaco, superseding LAYOUT.md's CodeMirror note

LAYOUT.md sketched CodeMirror 6 for the ADE phase ("lighter than Monaco").
That was right for a plan-file editor; it is wrong for the brief now on the
table — a full Java workflow with method completion against a
Maven/Gradle classpath. That is LSP work, and Monaco +
`monaco-languageclient` is the assembled, proven path (it is literally the
VS Code editor plus the protocol VS Code speaks); CodeMirror LSP support
is DIY glue we would own forever. Costs we accept knowingly:

- **Bundle/startup**: Monaco is heavy. It loads lazily — the chunk is
  imported the first time a file surface opens, never on app start.
- **Theming**: Monaco themes are not CSS. We generate its theme object
  from our tokens at runtime (both modes) and use `@shikijs/monaco` so
  TextMate grammars — the same ones our transcript code blocks use —
  paint the buffer. One highlighting system, two hosts.
- **Workers**: Monaco's language workers need explicit wiring under
  electron-vite (`?worker` imports, `MonacoEnvironment.getWorker`). Known
  wrinkle, contained in one module.

CodeMirror stays out entirely; one editor, one code path, viewer = editor
with `readOnly: true`.

---

## M11 — File surfaces

### The file service (`src/main/server/files.ts`, new)

All file access goes through main over the existing WS contract — the
renderer never touches `node:fs`. New methods, all project-scoped and
**jailed to the project cwd** (resolve, then require the result under
`cwd`; refuse `.git/` writes):

```
fs.list   { projectId, dir? }        → entries: { name, kind: file|dir, size }[]
                                       (one level; tree fetches lazily on expand;
                                        .temp-code/ and .git/ hidden)
fs.read   { projectId, path }        → { content, mtimeMs, tooLarge? }
                                       (>2 MB or binary → tooLarge, viewer shows
                                        a stub instead of the buffer)
fs.write  { projectId, path, content } → { mtimeMs }   (atomic: tmp + rename)
fs.create / fs.rename / fs.delete    → tree CRUD; delete → confirm dialog
fs.watch  { projectId, subscribe }   → push { push:'file-event', projectId,
                                       path, kind: changed|created|deleted }
```

One chokidar watcher per project with at least one open surface, debounced
~100 ms, ignoring `.git/**` and `.temp-code/**`. The watcher is the spine
of the whole feature: it is how agent edits reach open buffers, how the
tree stays live, and (M12) how the Changes rail goes push-driven instead
of polled.

### Surface host (renderer)

LAYOUT.md's reserved frame gets built: the thread strip becomes the
**surface strip**. A surface is `{ kind: 'thread' | 'file' | 'diff', … }`;
same tabs component, same selection model, same `SPRING_LAYOUT` indicator.
File tabs render filename + a dot while a save is pending. Surfaces are
per-project state in the store; switching projects swaps the whole set and
restores it on return (persisted with the project, like thread state).

Open paths: click in the Files tree; `⌘P` quick-open (reuses the
`project.files` list and the PromptBar's existing `rankFiles` ranking —
one ranking function, two menus); file mentions in transcripts become
clickable later.

### Files panel (right rail)

The rail's panel registry gains **Files**: ReUI tree + `@headless-tree`
over `fs.list`, lazy per directory, live via `file-event` pushes. Rows are
13 px, type glyph, muted dir chevrons — no file-size column, no badges.
Context menu: new file, new folder, rename, delete, reveal in Finder.

### The editor surface (`components/editor/`, new)

- `EditorSurface.tsx` mounts one Monaco editor per open file surface;
  models are keyed by absolute path in a shared `ModelRegistry` so the
  same file opened from two projects' views is still one buffer.
- Read path: `fs.read` → create model → attach. Viewer mode (read-only)
  is the same component for files the user opens from transcripts or
  diffs; an "Edit" affordance flips the flag.
- Theme: `tokensToMonacoTheme()` builds light/dark themes from
  `main.css` variables at startup and on theme flip; `@shikijs/monaco`
  registers TS/TSX/JS/JSON/CSS/HTML/Java/XML/YAML/Markdown/properties
  grammars (covers web + Maven/Gradle projects; `pom.xml` is XML,
  `build.gradle` is groovy — include groovy/kotlin grammars for it).
- Fonts and type follow DESIGN.md: SF Mono stack, 12 px, no minimap, no
  glyph margin decoration noise. Quiet chrome — the buffer is the hero.

### Autosave (the policy, precisely)

- Debounced write ~800 ms after the last keystroke; immediate flush on
  tab switch, surface close, window blur, project switch, and `⌘S`
  (⌘S exists for muscle memory; it just flushes early).
- Because writes are frequent and disk is truth, there is no "dirty since
  save" concept in the UI beyond the transient pending dot. There is no
  "unsaved changes" dialog anywhere.
- Undo history is per-model, in-memory, unaffected by autosave.
- `.temp-code/plan-*.md` files opened as surfaces autosave the same way —
  the plan view's polling picks changes up for free.

### External changes (agents, terminals, other tools)

On `file-event: changed` for an open model:

- Buffer has no edits newer than last write → recompute: read the file,
  diff old→new content, apply as model edits (not `setValue`) so cursor,
  scroll, folding, and the undo stack survive. This is the "watch an
  agent edit the file live" experience.
- Buffer has pending (not-yet-flushed) keystrokes → the window is ≤800 ms
  wide; queue the reload until the flush lands, then re-read. If the disk
  content differs from what we flushed (true concurrent write), show a
  one-line bar over the buffer: "Changed on disk while you were typing —
  reload · keep mine". No modal, no merge UI; with sub-second autosave
  this is a rare race, not a workflow.

### Exit test (`scripts/e2e-files`)

Against a live server, no UI: `fs.list`/`read`/`write` round-trip;
write is atomic (no partial read mid-write); path escape (`../`) refused;
`.git/` write refused; watcher push arrives on an external `echo >>`;
oversized file returns `tooLarge`. Renderer: typecheck; manual pass —
open, type, watch autosave land (`git status` shows it), have a thread's
agent edit the same file and watch the buffer update in place. Relaunch.

---

## M12 — Git flow: commit, push, and cheap project switching

### Why this is easy here, said once

A worktree project **is** a checkout of its own branch. Nothing the user
has open in IntelliJ, no branch they have checked out in the workspace
repo, no other worktree, is involved when we run git with `-C <project
cwd>`. The isolation the user asked for is already the architecture; this
milestone is UI + four server methods.

### Server (`git.ts`)

```
project.commit { projectId, message, paths? }   → { sha, summary }
    git add -A (or the given paths) + git commit, in project cwd.
project.push   { projectId, targetBranch? }     → { remote, branch }
    git push -u origin <project branch>, or HEAD:<targetBranch> when the
    user wants the same work landing on a different remote branch.
project.log    { projectId, limit }             → recent commits on the
    project branch (null-separated --format parse) — the rail's history.
project.branches { workspaceId }                → local + remote branch
    names (for pickers), current checkout marked.
```

Commit identity, hooks, signing all come from the user's normal git
config — we shell out to the system git, so nothing to build. Errors
(hook rejection, non-fast-forward, no remote) surface verbatim in the
rail; no retry magic. `.temp-code/` stays excluded (already handled by
`ensureLocalExclude`).

### Changes rail becomes the commit surface

The Changes panel (exists) gains a footer: a one-line message input and a
split **Commit** / **Commit & Push** button (BeUI StatefulButton — the
async state is real). Above it, the file rows get checkboxes defaulting to
all-on — partial commits are path-level, not hunk-level (hunk staging is
not this milestone). Under the footer, a quiet history list from
`project.log`: sha, first line, relative time. Push state shows as
`↑n` next to the branch name in the meta row; after push it fades.

The rail also switches from polling `project.changes` to invalidating on
M11's `file-event` pushes — cheaper and instant.

### Branch-aware project creation

`project.create` grows options (NewProjectDialog gains one section):

- **baseRef** — what the new branch forks from: default the workspace's
  current HEAD (today's behavior), or any pick from `project.branches`
  (typically `origin/main`). Implementation: `git worktree add <dir> -b
  tc/<slug> <baseRef>`.
- **existingBranch** — adopt a branch instead of creating one: `git
  worktree add <dir> <branch>`. The project's branch is then that branch;
  push omits `-b` semantics. This is "open my PR branch as a project".

`ProjectMeta` already carries `branch`; no schema change beyond the two
create params.

### Cheap switching

Worktrees share the object store, so a new project costs one checkout of
the tree — seconds, once. Switching costs nearly nothing by construction:

- Editor surfaces, rail state, and thread selection are per-project in
  the store; switching swaps pointers, no I/O.
- Watchers stop when a project has no open surfaces and no visible rail.
- The heavy per-project state is M13's LSP servers; their lifecycle
  (lazy start, LRU stop, warm caches) is designed there so switching
  stays light even with Java in play.
- Local-mode projects keep working, but the commit UI shows an honest
  meta line ("commits go to <branch> in your checkout") — worktree mode
  is the recommended default and the dialog says so.

### Exit test (`scripts/e2e-git-flow`)

Scratch repo: create worktree project off a chosen baseRef → branch and
fork point correct; write a file via `fs.write` → `project.changes` shows
it → `project.commit` with a path subset commits exactly that subset →
`project.push` to a bare "origin" lands `tc/<slug>` upstream;
`targetBranch` push lands `HEAD:<other>`; meanwhile the workspace repo's
checked-out branch and index are bit-identical before/after (the
isolation claim, asserted). Adopt an existing branch as a project and
commit to it. Typecheck; relaunch.

---

## M13 — Language intelligence: the LSP pool

### Shape: servers in main, protocol tunneled, Monaco as the client

One new module `src/main/server/lsp.ts` owns every language server as a
child process. The renderer speaks LSP through Monaco via
`monaco-languageclient`; the wire between renderer and main is a
dedicated WS path (`/lsp/<serverId>`) on the server we already run — raw
JSON-RPC frames, no zod schema in the hot path, `vscode-ws-jsonrpc` on
both ends. The typed contract gains only lifecycle:

```
lsp.ensure { projectId, lang: 'java' | 'web' } → { serverId, wsPath, status }
lsp.status { }                                 → running servers, memory,
                                                 project, idle time (Settings/debug)
```

`lsp.ensure` is idempotent — called when the first relevant file surface
opens (`.java` → java; ts/tsx/js/json → web). Keyed by (projectId, lang):
**each project gets its own server instance rooted at its worktree**, so
cross-file intelligence — and therefore completion against the project's
real dependency graph — is per-project correct by construction.

### Web workflow: vtsls

- `vtsls` (VS Code's TS extension wrapped as an LSP) spawned per project,
  using the **project's own TypeScript** (`node_modules/typescript`) when
  present, falling back to a bundled one. This gives cross-file
  completion, imports, refactors, rename, and diagnostics that match what
  `tsc` will say.
- ESLint and Tailwind language servers are deliberately out of v1 —
  vtsls is the workflow; linters can join the pool later with zero new
  architecture (same `lsp.ensure` shape).

### Java workflow: Eclipse JDT Language Server

- **jdtls**, the engine inside VS Code's Java support. It reads
  `pom.xml`/`build.gradle` itself, resolves the classpath through
  embedded m2e/Buildship, and provides method completion, diagnostics,
  navigation, rename, organize imports, and formatting. We host it; we
  implement zero Java understanding.
- **Runtime**: jdtls needs a JDK (21+) to run. Discovery order:
  `JAVA_HOME`, `/usr/libexec/java_home`, PATH. Projects may *target* any
  Java version — jdtls's `java.configuration.runtimes` is fed with every
  JDK discovery finds. `doctor.get` (exists) gains a Java row: JDK found,
  version, jdtls downloaded — surfaced in Settings exactly like provider
  binaries are today.
- **Distribution**: not bundled in the app (it is ~100 MB and updates on
  its own cadence). First `lsp.ensure` for java downloads a pinned
  release to `~/.temp-code/jdtls/dist/<version>` with a visible progress
  state in the rail; offline with no cached dist → honest error row.
- **Workspace data**: jdtls's `-data` dir (its index) lives at
  `~/.temp-code/jdtls/data/<projectId>` and **persists across restarts**
  — first open of a big Maven project pays the import once; every later
  open is warm. This is the piece that keeps "switch projects freely"
  true for Java.
- **Build tools**: no embedded Maven/Gradle. jdtls owns the project
  model; actual builds/tests run in the project cwd (today: a thread's
  agent or an external terminal; the terminal surface is its own future
  plan). One nicety ships now because jdtls gives it away: compile
  diagnostics appear in the editor as you type, before any build runs.

### Client side

`monaco-languageclient` per (project, lang), attached to the models by
language id. Features on by default: completion (with signatures), hover,
diagnostics squiggles + a quiet per-file problem count in the tab,
go-to-definition (`⌘`-click; cross-file jumps open a new file surface),
find references, rename (`F2`), document symbols (`⌘⇧O` popover). All
UI is Monaco-native — we style it with the generated theme and accept
its widgets rather than rebuilding them.

### Lifecycle (the "not much load" contract)

- Lazy: nothing starts until a matching file surface opens.
- LRU: at most **2 jdtls** and **3 vtsls** instances alive; least
  recently used stops first (SIGTERM, then kill). Switching back
  restarts against the warm `-data`/`tsbuildinfo` caches.
- Idle stop: any server with no open matching surfaces for 10 minutes
  stops.
- Crash: one silent restart per file-save burst; repeated crashes flip
  the doctor row to error and stop retrying — squiggles disappear, the
  editor keeps working. LSP is enhancement, never a dependency of
  editing.

### Exit test (`scripts/e2e-lsp`)

Headless where possible, manual where not: `lsp.ensure` twice returns one
server; fixture Maven project → completion request over the tunnel
returns members of a dependency class (proves classpath import); fixture
TS workspace → cross-file rename touches both files; LRU eviction kills
the oldest at cap; jdtls data dir survives restart (second import
measurably instant — assert the ready signal, not wall time); doctor
reports a missing JDK correctly. Typecheck; relaunch and hand-verify
completion/hover/go-to-def in both a Java and a TS project.

---

## M14 — Editor finish

- **Diff surfaces.** A `diff` surface kind: Monaco's diff editor, given
  `git show HEAD:<path>` vs disk. Clicking a row in the Changes rail
  opens one (replacing the read-only BUI Diff Table view there). The
  right side is the live editable model — the user's "edit the agent's
  change as I review it" loop, in the rail today, in the transcript when
  the in-thread feature lands (it will reuse this exact surface).
- **Format-on-save.** Flush → `textDocument/formatting` when the server
  offers it (jdtls: Eclipse formatter; vtsls: TS formatter; Prettier
  arrives only if we later add its LSP — not v1) → write. Off by
  default per language; a Settings toggle, honored by autosave flushes.
- **Symbol search.** `⌘T` workspace symbols over the pool
  (`workspace/symbol` to every running server of the project).
- **AI ghost text, pluggable and off by default.** Monaco's inline
  completions API calling a provider interface in main. v1 ships the
  interface with a single implementation: fill-in-the-middle via
  the Claude Agent SDK against the user's existing auth (the app still
  holds no credentials). Debounced ≥400 ms idle, cancelled on keystroke,
  cache by (prefix-hash, suffix-hash). If real-world latency makes it
  feel bad, it stays off — LSP completion is the workflow feature;
  ghost text is a bonus, and shipping it dishonestly fast is worse than
  not shipping it.
- **Restraint pass** (DESIGN.md rules): no breadcrumbs bar, no sticky
  scopes, no inline blame, no lightbulb until an action exists behind
  it. Everything added must earn its pixels.

### Exit test

Diff surface shows/edits/saves; format-on-save round-trips through jdtls
on a fixture; `⌘T` finds a symbol from a dependency-free fixture in both
languages; ghost text: provider called once per idle pause, never blocks
typing (assert ordering, not latency). Typecheck; relaunch.

---

## Order, size, risks

**M11 → M12 → M13 → M14.** M11 is the big lift (file service + surface
host + Monaco integration); M12 is small and lands the user-visible git
win early; M13 is medium-mechanical for vtsls and the real work for
jdtls (download, JDK discovery, data dirs); M14 is a set of independent
finishers that can land piecemeal.

Risks and their answers:

- **Monaco under electron-vite** (workers, CSP) → known territory;
  isolate all wiring in one `editor/monaco.ts` module; fall back to
  `@shikijs/monaco` for highlighting so even a worker failure never
  blanks a buffer.
- **jdtls memory** (500 MB+ on big projects) → the LRU cap of 2 plus
  idle stop is the ceiling; `lsp.status` makes usage visible in
  Settings instead of mysterious.
- **Autosave commits half-thoughts** → commits are explicit and
  message-gated in the rail; autosave only ever touches the working
  tree, which is exactly what a worktree is for.
- **Watcher storms** (branch switch, `mvn package` writing `target/`) →
  chokidar ignores build-output dirs (`target/`, `build/`, `dist/`,
  `node_modules/`, `.git/`); events debounce per path; the tree updates
  lazily per expanded dir.
- **Two writers, one file** (agent + user) → disk-is-truth plus the
  ≤800 ms flush window bounds the race; the reload bar is the honest
  escape hatch; asserted in the M11 e2e.
- **`git add -A` sweeping agent debris into commits** → the checkbox
  list is the commit, not the working tree; unchecked stays uncommitted.
  If debris is chronic, a per-project commit-exclude list is ten lines.
- **LSP tunnel auth** → same localhost-only, single-user WS server as
  everything else; `/lsp/*` paths validate serverId against the pool.

---

## Amendments from implementation (M11–M14 landed)

Deviations from the letter of the plan above, each with its reason:

- **Hand-rolled LSP client instead of `monaco-languageclient` +
  `vscode-ws-jsonrpc`.** Monaco 0.56 restructured its ESM surface, and
  `monaco-languageclient` only works against the `@codingame` fork of the
  editor — adopting it means replacing `monaco-editor` and ~50 transitive
  service packages. Monaco 0.56 also ships an experimental built-in LSP
  client, but it pins `rootUri: null`, takes no initialization options,
  and syncs every model to every server — unusable for jdtls and a
  multi-project pool. `src/renderer/src/components/editor/lsp.ts` speaks
  JSON-RPC directly (one WS text frame per LSP message; main re-frames to
  Content-Length stdio) and registers plain Monaco providers: completion
  (+resolve), hover, signature help, definition, references, rename
  (cross-file, unopened files edited through the fs service), document
  symbols, formatting, workspace symbols, publishDiagnostics,
  workspace/applyEdit and workspace/configuration handling.
- **No Monaco language services shipped** (ts/json/css/html workers) — the
  LSP pool is the single source of language smarts, so the only worker is
  the base editor worker. `json`, `tsx`, `jsx`, and `groovy` are
  registered as bare language ids; shiki paints them.
- **`worker: { format: 'es' }`** in the renderer vite config: the lazy
  editor chunk makes the build code-splitting, which IIFE workers reject.
- **Shiki runs on its JavaScript regex engine, not oniguruma.** The
  renderer CSP (`script-src 'self'`) blocks `WebAssembly.instantiate`, so
  the WASM engine never loads — in the editor *or* in the transcript's
  highlight worker, which had been failing silently to plaintext. Both now
  pass `createJavaScriptRegexEngine({ forgiving: true })`; CSP stays
  wasm-free.
- **`project.show`** (git show HEAD:path) joined the contract for the
  diff surface's left side.
- **jdtls pinned to 1.60.0**, resolved through the milestone's
  `latest.txt`; per-project copies of the OSGi config area so two
  parallel instances (cap 2) never fight over locks.
- **Exit tests**: `script:e2e-files`, `script:e2e-git-flow`,
  `script:e2e-lsp` (drives the real server + tunnel; vtsls cross-file
  rename, LRU eviction, jdtls Maven import + completion, warm `-data`),
  `script:e2e-editor-finish` (project.show + fim.complete).
