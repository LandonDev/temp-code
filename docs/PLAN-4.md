# temp-code — the IntelliJ engine: implementation plan

The editor already wears IntelliJ's clothes (Darcula, JetBrains Mono,
semantic colors, Alt+Enter, the IDEA-style completion popup). This plan
swaps in IntelliJ's brain. JetBrains now ships **intellij-server** —
IDEA's Java/Kotlin engine as a standalone LSP server ("IntelliJ IDEA
Goes LSP", Aug 2026) — and we verified tonight, on this machine, that it
serves nearly the entire LSP surface with IDEA's real ranking, IDEA's
error recovery, refactoring code actions, and a DAP debug endpoint.

The goal: use **everything it offers**, so the editor behaves like
IntelliJ, not like an editor imitating one. Eclipse JDT LS (jdtls)
stays, demoted to what it is good at being — an instant-start fallback
that keeps every capability alive while IntelliJ is cold, absent, or
broken.

## Evidence (spike, 2026-08-15, this machine)

Dist `intellij-server-263.2689.0-aarch64.sit` (386 MB, sha256 verified
against JetBrains' Open VSX `server-bundle.json`), run over stdio with
`--system-path`, `initializationOptions: { eulaHash, defaultSdk }`:

- **Ranking is real.** On `hello.` inside a *broken statement* — the
  exact context where jdtls returns project-wide garbage — the server
  returned 25 relevance-ranked members: `length` first, `isEmpty`
  second, `sortText` `0000000000, 0000000001, …`. jdtls returns ~100
  items, all with the same sortText, alphabetical.
- **Fast.** Warm completion 24–41 ms (first request 632 ms). Fixture
  import-to-first-real-completions ≈ 14 s cold; the index persists in
  `~/Library/Caches/JetBrains/analyzer/workspaces/<md5>/` so restarts
  are warm. RSS is JVM-sized; we cap heap via `IJ_JAVA_OPTIONS`.
- **Items are LSP-clean.** `labelDetails` columns, real `textEdit`s
  (build ≥ 263.2689.0), and `editor.action.triggerParameterHints`
  commands — our renderer consumes all three today, unchanged.
- **The capability dump** (recorded from `initialize`): completion
  (resolve), hover, signatureHelp, definition, typeDefinition,
  implementation, references, documentSymbol, codeAction with kinds
  `quickfix, refactor, source.organizeImports, refactor.extract.
  {variable,function,field,constant}, refactor.inline.variable`,
  codeLens, formatting, rename, foldingRange, semanticTokens
  (full+range, spec legend, `declaration` modifier first), call and
  type hierarchy, inlayHint (resolve), **pull diagnostics**
  (`textDocument/diagnostic`, interFileDependencies), workspaceSymbol
  (2,014 symbols on the tiny fixture — it indexes the JDK),
  `workspace/fileOperations.willRename`, and `executeCommandProvider`
  with `start_debug_server`, `decompile`, `java.organize.imports`,
  `refactor.extract.*`, `jetbrains.java.completion.apply`,
  `intellij.java.resolveClasspath/resolveJavaExecutable/
  resolveWorkingDirectory`, `exportWorkspace`, `interpolateFileTemplate`.
- Verified by direct request: rename works, signature help works
  (triggers `(` `,`), pull diagnostics return items, `$/progress` and a
  custom `intellij/importLog` notification arrive during import.
- Settings are pulled via `workspace/configuration` section
  `jetbrains.java` (schema to be discovered as we go; `null` is
  accepted).

## Ground rules

1. **Nothing ever goes dark.** Every capability has a live fallback:
   jdtls answers while IntelliJ is cold, missing, expired, or crashed.
   Fallback is silent; the user sees a quiet status line, never a hole.
2. **One source at a time per capability.** No merged completion lists,
   no double squiggles. A health-gated switch decides; hysteresis stops
   flapping (2 consecutive failures degrade instantly; 2 successful
   10 s probes restore).
3. **Honest preview handling.** The server is a preview: builds expire
   in ~30 days and 1.0 will want an IDEA Ultimate subscription (the
   user has one). First run shows the EULA (its sha256 prefix IS the
   acceptance handshake) in Settings before anything downloads or
   spawns; acceptance is stored per build. Expiry surfaces as a doctor
   row with a one-click "update engine", never a silent failure.
4. **Budget.** One intellij-server process (pool cap 1, LRU), heap
   capped at 3 GB, 60-minute idle stop (vs 10 for the others — boot is
   the expensive part), `INTELLIJ_DATA_SHARING=none`.

## Architecture

### Pool (main process, `src/main/server/lsp.ts`)
`LspLang` gains `'idea'`. `ensureIdeaDist()` mirrors `ensureJdtlsDist()`:
fetch JetBrains' per-platform `server-bundle.json` (Open VSX; gives URL +
sha256), download to `~/.temp-code/intellij-server/dist-<build>`, verify
sha, atomic rename; pinned build constant `263.2689.0` as the floor.
`spawnIdea()`: `bin/intellij-server --stdio --system-path
~/.temp-code/intellij-server/system/<projectId>` — same StdioFrames
tunnel, crash policy, and status rows as jdtls; per-lang idle table.
`lsp.ensure` response carries `eulaHash` (computed from the dist's
EULA.txt) and `defaultSdk` (existing `discoverJdks()`), and a
`needsEula: true` flag until the user has accepted that build's EULA
(acceptance stored in the app DB).

### Renderer (`src/renderer/src/components/editor/lsp.ts`)
A second `LspConnection` per project — key `${projectId}:idea` — owning
java (later kotlin) models with normal didOpen/didChange sync, so buffer
state is exact by construction. Routing generalizes from "connFor(model)
returns the one connection" to a small per-capability router:

| Capability | Primary | Fallback | Mode |
|---|---|---|---|
| completion + resolve | idea | jdtls | race, 300 ms budget |
| diagnostics | idea (pull loop) | jdtls (push) | health switch |
| code actions (Alt+Enter) | idea | jdtls | health switch |
| hover, signature, definition, typeDef, implementation, references, documentSymbol | idea | jdtls | per-request: try idea, fall back on error/timeout (800 ms) |
| semantic tokens | idea | jdtls | health switch (same theme trie; `declaration`-first modifier order — rules already cover it) |
| inlay hints, folding, formatting, rename, workspaceSymbol (⌘O) | idea | jdtls | health switch |
| call/type hierarchy, codeLens, decompile | idea | — (new features, no jdtls equivalent) | idea-only |
| willRenameFiles | idea | — | idea-only |
| debugging (DAP) | idea | — | idea-only |

The completion race keeps the discipline from the completions work: both
fire, IDEA wins if it answers ≤ 300 ms with items, jdtls (already in
flight) fills otherwise; suggestions remember their source connection so
resolve routes correctly. Health state is per-project, renderer-side,
driven by actual request outcomes.

Diagnostics move from push to **pull**: a debounced loop (on didChange +
idle, ~500 ms) calls `textDocument/diagnostic` on the idea connection
and writes markers under the existing stable owner; jdtls diagnostics
are suppressed while idea is healthy and resume on degrade
(`removeAllMarkers` swap, both directions). IDEA's list is the
inspection engine — expect strictly better squiggles.

Items whose only insert mechanism is a `jetbrains.*.completion.apply`
command (VS-Code-era postfix leftovers) are filtered defensively; the
spike showed real textEdits everywhere that matters.

### Status & UX
- `$/progress` + `intellij/importLog` drive the existing `lspBusy` line
  ("IntelliJ importing…") — the plumbing from the jdtls work.
- Settings → Editor gains an "IntelliJ engine" block: state (off /
  downloading / importing / serving / expired / error), EULA gate with
  the license text, engine version + update button, and the same
  RSS/idle rows the pool already reports.
- Doctor: `java.ideaServer` row (dist present, EULA accepted, build age).

## Milestones

### M15 — Engine online: pool, EULA gate, completion race
Pool integration (dist ensure via server-bundle.json + sha verify, spawn,
per-lang idle), EULA acceptance flow in Settings, renderer idea
connection (diagnostics suppressed for now), `toSuggestions` extraction,
completion race + hysteresis, resolve routing by source, warm-ahead on
`ensureForModel`. **Exit**: e2e boots the real server, asserts ranked
completion (`length` before `charAt`) over the tunnel and jdtls fallback
when the idea server is killed mid-run; CDP smoke on CosmicPrisons shows
IDEA-ranked popup; kill-server drill shows no popup gap. Record cold
import time for CosmicPrisons here.

### M16 — IDEA squiggles and Alt+Enter intentions
Pull-diagnostic loop with marker-source switching; code actions routed to
idea (intentions + `refactor.extract.*` kinds appear in the Alt+Enter
menu; `applyModCommand`/`workspace/executeCommand` apply path; organize
imports via `java.organize.imports`). Extend the code-action UI only if
kinds warrant grouping (IDEA groups quickfix vs refactor). **Exit**:
inspection-grade warning (e.g. "condition is always true") appears that
jdtls cannot produce; extract-variable from Alt+Enter round-trips; source
switch drill (kill idea → jdtls squiggles return).

### M17 — Full read-side switchover
Hover, signature help, navigation (definition/typeDefinition/
implementation/references), documentSymbol (⌘⇧O), workspaceSymbol (⌘O —
IDEA's index instead of jdtls's), semantic tokens, inlay hints (with
resolve), folding, formatting (IDEA code style), rename. Files-panel
rename/move sends `workspace/willRenameFiles` and applies the returned
edit (imports update on file move — IDEA behavior). Probe codeLens
content on a real project and wire it only if it carries value (run
markers/usages). **Exit**: capability-by-capability parity checklist in
the live app; formatting matches IDEA's output for the project; file
rename fixes imports.

### M18 — Beyond LSP: hierarchies and decompiled sources
Call hierarchy and type hierarchy served by the engine, surfaced in a
peek-style panel (same UI family as the existing references peek — no
new chrome invented). `decompile` command wired to a read-only surface
so go-to-definition into a library lands in decompiled source instead of
nothing. **Exit**: hierarchy on a Bukkit listener method shows callers;
definition into `org.bukkit.Material` opens decompiled source.

### M19 — Kotlin
Language mapping (`.kt`/`.kts` → kotlin → idea connection; no jdtls
fallback exists — health gate degrades to plain editing), shiki grammar
already bundled, `kotlin.organize.imports`. **Exit**: completion +
diagnostics + semantic colors in a Kotlin fixture.

### M20 — The debugger (DAP)
`start_debug_server` returns a per-session port; main process hosts a
DAP client (the protocol is LSP's sibling — same framing) and a new
contract slice; launch configs resolved via `intellij.java.
resolveClasspath/resolveJavaExecutable/resolveWorkingDirectory` +
`exportWorkspace`. UI: breakpoint gutter in Monaco (glyph margin turns
on for the occasion), a debug rail panel (threads/stack/variables/watch),
run/stop/step controls, console. This is the largest single milestone
and starts with its own one-day spike (launch the fixture's main, hit a
breakpoint, read a variable) before UI work. **Exit**: set a breakpoint
in the app, launch a main class, hit it, inspect locals, step, resume.

### M21 — Hardening and the long tail
Update channel automation (expiry-driven re-check of server-bundle.json,
one-click update, keep-last-good dist), memory/idle tuning against real
usage, worktree-project coverage, `scripts/e2e-ij.ts` covering the
routing table + failure drills with a stub server for determinism,
PLAN-4 amendments section documenting deviations.

## Order, size, risks

M15 → M16 → M17 are strictly ordered (each reuses the previous layer's
routing). M18/M19 are independent after M17. M20 is independent of
M16–M19 and can start any time after M15; it is roughly the size of
M15–M17 combined. M21 closes.

Risks, with mitigations:
- **Preview churn**: builds expire ~30 days; API surface may shift.
  Pinned build + manifest-driven update + jdtls fallback mean the app
  never breaks outright; the doctor row nags instead.
- **Licensing at 1.0**: Ultimate subscription required eventually; the
  user has one. The EULA/licensing UX is built in M15, not bolted on.
- **RAM**: a third JVM. Caps: one instance, 3 GB heap, 60-min idle
  stop, and jdtls's own caps unchanged. If pressure shows up, the
  follow-up lever is dropping jdtls to on-demand once IDEA is warm.
- **Unknowns until real-project scale**: codeLens content, inlay-hint
  volume, pull-diagnostic cost on a 3k-file project, DAP fidelity.
  Each has a probe step inside its milestone before UI commitment.
- **Cold import on big projects** (minutes, once per project): the
  busy line + full jdtls service make it a non-event; `bin/warmup.py`
  exists if we ever want pre-warming.

## Decision log

- **intellij-server over a custom IDEA plugin**: JetBrains productized
  exactly this (researched alternatives: plugin in interactive IDEA via
  the bundled MCP server EP, headless ApplicationStarter instance —
  both shelved; the git history of `~/.claude/plans` holds the design).
- **jdtls kept, not deleted**: instant start, no EULA, no expiry, and
  it already works — the perfect fallback. Cost is RAM, addressed above.
- **Pull diagnostics for IDEA** (not push): it's what the server
  advertises (`diagnosticProvider`), and pulling lets us debounce and
  swap marker sources cleanly.

## Amendments from implementation (M15–M21 landed)

- **EULA before run, not before download.** The license text lives inside
  the archive, so the Settings gate downloads first (with an honest
  spinner), shows the text, and gates the first *run* on acceptance —
  stored per build in `~/.temp-code/intellij-server/eula-accepted.json`.
- **Semantic tokens stayed on jdtls** (M17 deviation). The visual result
  is identical through the theme trie, and swapping provider legends per
  connection is risk without reward. Kotlin therefore renders TextMate
  colors only, no semantic layer, until a dedicated registration lands.
- **Hierarchies live in the quick-open overlay**, not a peek panel —
  same rows, same jump behavior as ⌘O, zero new chrome. ⌃⌥H callers,
  ⌃H types. The toy fixture returns null for prepare; verified shapes
  against the engine's capability dump, live verification on real
  projects.
- **codeLens left unwired.** The engine advertises it; what the lenses
  carry is unprobed. Revisit when a concrete use shows up.
- **Debugger schema facts** (bytecode-verified, `language-server.dap.*`
  jars): launch args are `LaunchRequestArguments { mainClass, javaExec,
  classPaths, modulePaths, vmArgs, args, env, cwd, projectName }` — no
  `stopOnEntry`; breakpoint sources resolve `Source.path` through
  `toRealPath()` + VFS `findFileByPath`, so symlinked roots (macOS /tmp)
  never verify — real project paths do. `start_debug_server` takes no
  args and returns a bare port; resolve commands take `[{ uri }]`.
- **Update channel** reads Open VSX metadata → VSIX → embedded
  `server-bundle.json` (the `/file/server-bundle.json` endpoint 404s);
  `current.json` repoints the active build, and a new build re-arms the
  EULA gate. Triggered from Settings, not on a timer — the doctor row
  is the nag.
- **Renderer-side hysteresis is the health machine** (2 misses park, two
  10 s-spaced hits restore); the pool contributes only its crash policy.
  Kill-drills are a live-app exercise; the e2e covers the pool, EULA
  gate, and ranked completion over the tunnel.
- **jdtls suppression is per-file, trust-gated**: the engine's pull
  diagnostics take a file's markers only after its first non-empty
  answer for the project, and hand them back on disconnect — a cold
  engine can never blank real squiggles.

### Post-verification amendments (live drills, 2026-08-16)

- **The pool speaks a little LSP for the engine.** Two dumb-pipe
  assumptions broke on page reloads: (1) intellij-server refuses a
  second `initialize`, so the pool caches the first `InitializeResult`
  and replays it to reconnecting clients; (2) a server→client request
  fired while no client is attached hangs the awaiting coroutine
  forever — import stalls, templates-only completions — so the pool
  answers `workspace/configuration`, progress-create, capability
  registrations, and `window/showMessageRequest` itself.
- **Repos with a checked-in `.idea` silently skip import** (A/B-tested:
  same fixture imports without `.idea`, skips with it). The cure is the
  undocumented `initializationOptions.buildTools: { <folderUri>:
  'maven' | 'gradle' }` (found via `InitializeOptions` bytecode); main
  detects the build file and forces the importer. Poisoned analyzer
  caches from stalled imports must be deleted
  (`~/Library/Caches/JetBrains/analyzer/workspaces/<md5>`).
- **A latent M13 off-by-one in COMPLETION_KINDS** (duplicated leading
  Text entry) shifted every completion kind by one — invisible until
  the IDEA badges made kinds visible. Fixed; methods are methods now.
- **Templates-only lists must not win the race**: a cold engine serves
  postfix templates before members; the race now requires at least one
  substantive (non-snippet/text) item to beat jdtls.
- **jdtls autobuild writes ECJ error-stub classes** for broken sources
  into target/classes; debugging a file with compile errors throws
  `Unresolved compilation problems` at entry. Expected Eclipse
  behavior, noted for debugging UX.
- **The IDEA popup look** ships as CSS over monaco's suggest widget:
  #2B2D30 panel (10px radius), #393B40 selection, letter-badge icons
  per kind, bold matched letters, solid-gray inline signatures and
  right-aligned types, footer tip bar, 26px rows.
