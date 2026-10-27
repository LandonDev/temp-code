# Research list status (draft, box-side evidence)

Code read on master a55789b5; the box's live host runs release 300 (stability fixes not deployed there), so host behaviour was judged from master's code, its tests and the in-process proofs, plus the Mac instance (today's code).

| # | Item (findings) | Status | Evidence |
| --- | --- | --- | --- |
| 1 | Follow-ups into a waiting thread (F1, F2) | fixed in code | S1 56948409 (MID_TURN_DEFAULT steer, queue.add → queued/steered, resolveSteerWaiters), S2 fba9f68a (drainSettled); wait_for_agent returns steered/watching/stopped (orchestration.ts 1109); orchestration.test.ts 40 green; Mac M5 measures the live steer |
| 2 | Watching rows that never move (F8–F13) | fixed in code | S4 b796ed2a (sweepLiveness takes watching, stopped + Resume, resumeStopped), stopWatching one-shot (sessions.ts 521), checkForgottenTasks while watching (claude.ts 272); batch.ts resumeAfterBoot fails any running step but a followable deploy, blocked why paused/no-turn; sessions-liveness, sessions-watching (16), batch (68) green; no batch stall watchdog (N minutes with no child movement) found in batch.ts; Mac M5 kills a harness live |
| 3 | The strip's project (F14) | fixed in code | 21f36fa7 (a changed active pane wins), aliasKeys in projectContext.ts 140/219/232, tab keyed by its focused pane (workspaceTabGroups.ts 69–78); Mac M1/M5 count mismatches live |
| 4 | The tab right-click (F18) | fixed in code | 9bc00f92; ThreadHeaderStrip.tsx 275 `event.button !== 0 || event.ctrlKey`, drag-region false on both rows (142, 247); Mac M1 and M5 try it 20× each |
| 5 | Blank or stuck pages (F15–F17, F19) | fixed in code | S5b 5c5817fb: ChunkBoundary (lazyChunk.tsx), root boundary "Reload window" + onUncaughtError (main.tsx 134–137), menuTree reload role, markdownParse deadline (REQUEST_MS), SessionGone "No longer on <host>", .board-parked |
| 6 | Say what the turn is doing (F3, F12, F25, F28) | fixed in code | S3 8eb2f67b (phase events cli-starting/initializing/retrying, providerRequest, FIRST_OUTPUT_MS watchdog), decorate's "Blocked: <who> <why>" (sessions.ts 4490) and lastEventAt (5004); d672b1a9 timeout stages in failure kinds; Mac M5 samples the strip's words |
| 7 | The app's own turns and the steer ack (F4, F5) | fixed in code | S2 drainSettled (one turn per settle, person's text last); commands.ts steer() reads queued vs steered (186–204) |
| 8 | Clock-hour storm and the list (F31, F32) | fixed in code | S6 c8bb124a (pickableChange, re-pick by changed set, list from sessionIndex); stall lines tag the producer (stalls.ts 127–130) |
| 9 | Gateway deadlines and routing (F26–F29) | mostly fixed | d672b1a9 (gateway control 30 s, upstream headers/body-idle/total, codex RPC timers), one `eligible()` (accountRouting.ts 94, accounts.ts 516), per-model cooldown attribution (quota proof's last check); NOT done: the bounded refresh that releases the profile lock (aliax-core change deferred by the master's decision) |
| 10 | Main-loop work that is not a request (F33–F36) | mostly fixed | ac5bd9b5 (persisted fold flags, SQL limits, reader restarts, shared mirror index writes, launch summaries in batches, socket shedding), c220e39b (events page off the loop, port ledger sweeps gated); lane.ts BULK_MAX_WAIT_MS 20 s; NOT verified: a hard cap on expired bulk entries, a shorter pipelined ticket mint (auth.ts mintTicket unchanged) |
| 11 | Renderer re-render path and memory (F20–F24) | partly fixed | S9 1bf43ec0 (one merge + one schedule per list push, idle loops), markdownParse LRU ready set, KEEP_RECENT 6 transcripts, paneVisibility.tsx gates TerminalView/Inbox/ComposerRunner; NOT verified: per-workspace projections for the rail and header, a byte budget for cold transcripts; Mac M5 reads RSS over an hour |
| 12 | Instrumentation | fixed in code | S0 effe7ae2 send spans (sendSpans.ts, 6 tests), firstPaint armed only with persisted rows, meta push producer tags; gateway-limits.jsonl present on the box |

Box proofs run 2026-10-27 16:25–16:40 (one at a time):
- `bun run script:e2e-queue` — ALL PASS (no cap: six at once; after: queued until the sibling settles; cap 2: peak 2, oldest first, Start now past the cap, one user row each).
- `bun run script:e2e-quota-routing` — all checks passed (429 keeps the account out for its retry-after, ten turns over ten accounts, the replay under another account, per-model attribution, headroom.json).
- vitest single fork: sessions-liveness, sessions-watching (16), processGuard (15), sendSpans (6), scheduler — 76 passed; batch (68), orchestration (40), sessions-resume-after-boot (17) — 125 passed.
- Stall log: the box's live stalls.log (release 300) has 0 `send session=` lines; the format is sendSpans.ts `send session=<id> accepted=0 prepared=12 handle=340(warm) delivered=… init=… first-message=… first-content=2100` (a phase never reached reads `-`), flushed at first content or 15 s. The live log's last lines show git.diffIndex requests of 81 s in flight on release 300 (F36 still visible on the box until it is deployed).
- Side finding: the quota proof's fake-provider and server ports were filed as dev servers and forwarded to the Mac by the box's release-300 host (hook lines "Forwarded to http://localhost:34529 on the Mac" ×4); master's devServerRules.ts (NOT_DEV_RUNNER) excludes test runs and the gate but has no rule for an e2e proof script's own listeners under a shell call.

# M1 raw findings (Mac wave 1, instance temp-code-verify at a55789b5, 2026-10-27 ~16:30–17:20 box time)
Seed: alpha (Verify chat, Verify tools, Verify research, Verify build, Verify fleet + explorer child, Verify project plan settled; Verify plan and Verify master empty), beta (Beta chat); snapshot temp-code-verify-seed. M1 could not reach Settings → Appearance (body blank) so "light" = the theme class applied over CDP.
- First run · dark 1280 · the clone appears as a workspace already; no Add workspace… row · wrong by the standard · /tmp/tc-verify/first-run/01-as-opened.png (likely the dev-launch cwd workspace; check whether a packaged first run is empty)
- Settings · both · 1440/1000 · Appearance, General, Thread defaults: body blank, no controls · broken · first-run/settings-dark-1440.png, settings-light-1000.png (M2 triages)
- Settings · both · temp-code-verify listed twice with no host distinction · wrong · first-run/settings-light-1440.png
- Thread views · dark · settled research, implementation, orchestration, project-plan threads show a blank main view · broken · seed/04-research-blank.png, 05-build-blank.png, 06-project-plan-blank.png (M2 triages)
- Rail · workspace menu → New project: no form · broken · seed/07-new-project-blank.png, seed/new-project-blank-light-1000.png (M2 triages)
- Rail · right-click a thread row: no context menu (More opens one) · broken · rail/right-click-dark-1440.png, rail/right-click-light-1000.png (M2 triages)
- Rail · thread rows 32px, explorer child 28px against the 36px rule · wrong · rail/matrix-light-1000.png
- Rail · a clipped explorer title shows no TruncateTip after 900 ms hover · wrong · rail/long-child-no-tooltip-dark-1440.png
- Rail foot · light 1000 · refill label clips to "in und…" · polish · tabs/title-menu-light-1000.png
- Rail · dark 1440 · after repeated Settings visits the whole thread column disappeared; reload restored it · broken, seen once · rail/blank-after-settings-dark-1440.png (M2 re-tries ten visits)
- Tab strip · both · six threads opened, zero chips, only New thread · broken · tabs/matrix-dark-1440.png, tabs/matrix-light-1000.png (M2 triages)
- Title bar · both · ⋯ on Verify chat shows only cost and Terminal · broken · tabs/title-menu-dark-1440.png, title-menu-light-1000.png (M2 triages)
- Title bar · both · workspace button at y=5.5 vs strip controls at y=6 · polish · tabs/matrix-light-1000.png
- OK: alpha/beta switching showed the right workspace; settled rows had no marks; the fleet child sat under its parent; usage popovers named no account; Hosts absent with one host.
- Limit: M5's computer-use input landed in M1's composer (two agents on one screen); later waves use CDP-only input.

# ROOT CAUSE of the wave-1 "broken" set (found 2026-10-27 ~17:35 box time)
The built renderer's lazy surfaces render as an empty DOM element `<current>`: out/renderer/assets/index-*.js has `jsxRuntimeExports.jsx(reactExports.Suspense, { fallback, children: jsx("current", { ...props }) })`. lazyChunk.tsx (S5b 5c5817fb) keeps the React.lazy in `let current = makeLazy()` and renders `const Lazy = current; <Lazy/>`; babel-plugin-react-compiler (electron.vite.config.ts) inlines the alias into the JSX tag and the lowercase identifier becomes the string tag "current". Dev server and jsdom tests never run the compiler. Affects every chunk.surface: Settings, non-chat thread views and the master board, the dialogs chunk, the editor body, the HTML frame, the lightbox, the terminal dock and dev servers pane, the rail virtualizer (the rail empties once it lands), the release notes, the Aliax pages. Release-blocking. Planner started: "V1 fix: every lazy surface renders as an empty <current> element in the built app" (Opus 5.5 high 1M) with the fix (capitalized binding) + a build-output guard in scripts/check-bundle-size.ts.

# M2 raw findings (summary from its reply; full list /tmp/tc-verify/m2-findings.md on the Mac, 36 defects)
- Triage: all six M1 items CONFIRMED (empty <current>, zero-height settings column, missing tab/menu nodes; no console exception); ⌘1…⌘6 still switches threads with zero visible chips (the virtual/strip? to check); the first Settings visit empties the rail to zero rows, reload restores.
- Right panel: the panel toggle turns pressed and shows no panel (alpha and beta) · broken; Notes: "Save as note" says "Saved to Notes" but no Notes section shows · broken (panel).
- Transcript: grouped command opens inside one action card (OK); the read row opens a split file pane whose editor body is blank (lazy editor) · broken; image thumbnail's Preview opens no lightbox (lazy) · broken; html_render frame absent (lazy) · broken; the question card: two lettered options, a lettered Skip row, Continue, a free-form field in 13px MONOSPACE (wrong: should be the field's sans), "Needs you" appears in both the transcript and the composer area (duplicated) · wrong; the second-opinion intro renders as a provider card in a right-aligned bubble (a notice should be one muted line) · wrong; hand-off opens a new draft beside it (OK).
- Toast: an approval notice (sonner) for another thread overlaps the composer's right-side controls; the hit test at Send's centre resolves to the toast · broken (toast placement vs the composer).
- Strip: after Stop, "Stopped" appears in the transcript but NO Resume control above the composer · wrong by the standard (stopped → Resume); Pause shows Stop/Continue in two places (strip and ?) and a "Worked for…" closing line while paused · wrong (duplicate, misleading line).
- Approval: a thread in "Supervised" mode ran `ls` with no approval card · to check (mode words; what Supervised means).
- Dialogs: Thread Resources opens as a dialog with a 16px header inset (standard 20px) · polish; Rename is an inline rail field and Escape leaves focus on the document body · wrong (focus); Resources and Delete close on Escape and return focus to More (OK); Remove workspace confirm OK; Preamble and Workspace settings blank (lazy).
- Model menu: Claude menu shows 17% context and 200k; the Codex menu omits context usage though the session has 28,052 tokens in a 475,000 window · wrong (missing data); no account chip in the composer bar (A10 said the bar has model/mode/send; the account chip location to check).
- Composer: bar 32px, field 15px/24px line height, grows to 160px and scrolls, Shift+Enter newline, Enter and ⌘Enter send (OK). In split panes the composer's controls clip · wrong.
- Menus: rows 27.5px with 6px padding and a 6px icon gap (standard 28px, 12px, 8px) · polish; icon tooltips show with key caps (OK); a clipped explorer title has no TruncateTip after 1.1 s (86px of a 298px label) · wrong.
- Rail: the rail's More menu has no "Make master thread" because the threads have no named project (threads sit in the workspace's Chats group; New project is a lazy dialog) · consequence of the lazy bug; chat threads in a workspace without a project cannot become masters (by design: facts.projectId).
- Dialog motion matches the 4px rise + fade (OK); scrolling the transcript shows no jump (OK). Codex turn settled ("Understood."), no token_expired.
- Main log: SDK warnings and a MaxListenersExceeded-style listener-count warning in the preview's main log · to check (host).

# M4 raw findings (thread views, master, liveness, tabs; on the rebuilt clone d441068d; full /tmp/tc-verify/m4-findings.md)
- Thread views render after the fix. Project switching: 0 wrong headers in 40 checks. Console: 0 exceptions, 0 errors, 0 warnings.
- Master board · dead master: kill -9 the watching master's harness → Failed persisted >70 s with Retry/Continue; never Stopped/Resume · broken (host) · m4/master/dead/dark-1440.png, dead-second-light-1000.png
- Master board · Continue after the kill → the strip's elapsed reads 2m 8s / 11m 11s at once (counts from the old turn) · polish · m4/master/continue.png
- Master board · an empty master has no "+ Thread"; the first child needed a master message · wrong · m4/master/no-first-child-controls.png
- Master board · the board's New thread dialog offers five types but no Chat · wrong · m4/master/add-dialog.png
- Master board · rules dialog lets Gate move before Land but the summary (and the engine: land is always first) keep Land first · wrong · m4/master/rules-reordered/light-1440.png
- Master board · settled Done rows keep their check marks at rest (standard: no mark at rest for idle/done) · wrong · m4/master/row-hover/light-1000.png
- Master board · Add existing thread… is a centred dialog (docs say sheet; DESIGN allows a dialog for a picker) · note
- Master board · a sleeping child's strip says "Watching a command" while its board row names the sleep · wrong · m4/master/live-child-after-6500ms.png
- Batch foot: Land "nothing landed" 0s; Gate failed 0s "Module not found scripts/gate.ts"; Release stayed queued; the master's notice reads "Gate failed  master" (the detail names nothing useful) · polish · m4/master/row-hover/light-1000.png, gate-notice-found.png
- The master's list_agents called the UI-started implementation child "not part of my batch" though the board houses it · to check (host: supervisedBy vs an inherited masterId)
- Plan · fold the chat → the outline overlaps the document by 14 px (outline ends x=652, heading starts x=638) · polish · m4/plan/outline-measured.png
- Plan · plan complete → the page glyph on the tab only; no Plan ready mark in the rail or state in the header · wrong · m4/plan/ready/light-1440.png
- Plan · checkbox steps render a bullet before each checkbox · wrong · m4/plan/ready/light-1000.png
- Research · with no board yet the view is chat alone, no sources hero (LAYOUT permits) · note · m4/research/settled/light-1000.png
- Project plan · the frontmatter `status: complete completed: …` renders as a large heading · wrong · m4/project-plan/pinned-zero/light-1000.png
- Project plan · tick milestone one → header/chip 1/2 but the outline still says `[ ] 1. Milestone one`; raw backticks around `main` in the details · polish · m4/project-plan/ticked.png
- Implementation · opening a live child from the board: Back + blank content, strip and composer for ~350 ms, no loading state (TaskList 2/2 once done) · wrong · m4/implementation/dark-1440.png
- Fleet · a child watching sleep: the parent has no watching mark or strip; the header says "1 working, 1 done" while Agents says Watching · broken · m4/fleet/watching/light-1000.png
- Fleet · 1000 wide, Agents open → the composer's controls overflow into the panel by 163 px (Send right edge 837 vs composer 674) · broken · m4/fleet/composer-overflow-dark-1000.png, -light-1000.png
- Agent detail: no defect (right sheet, plain header, one metrics line, transcript, field, Close) · m4/agent-detail/light-1000.png
- Tabs · cycling ⌘1…⌘6 resets a view's fold state (the plan's Conversation fold) on 42/80 switches · broken · m4/tabs/switches-dark-1000.png
- Tabs · loose chats (Beta chat, alpha's loose Verify chat) have zero chips; project threads get chips · wrong (the on-screen thread has no chip) · m4/rail/beta-light-1000.png, m4/tabs/loose-chat.png
- Rail · transient: after Settings/back the thread column had 0 rows once (no loading state); beta→alpha restored 31 rows; four later checks fine · broken, transient · m4/setup/final-followup-state.png
- Limits: chip reorder (drag is a pane drop), close/reopen (chips expose Archive, not Close), queued/needs-you children, Stopped/Resume unreachable.

# M3 raw findings, part 2 (the tail of its reply; head requested; full /tmp/tc-verify/m3-findings.md)
- Dialogs · What's new: one short paragraph in a fixed-height dialog, mostly empty · polish · m3/dialogs/whats-new-light-1440.png
- Dialogs · Resources: a read-only list/empty state in a modal (the standard puts lists in a panel) · wrong · m3/dialogs/resources-light-1000.png
- Dialogs · the project settings SHEET enters at full opacity with no slide or fade (exit animates), normal and reduced motion · wrong · m3/dialogs/motion-sheet-normal.png, motion-sheet-reduced.png
- Menus · context menu rows 27.5px, padding 8/6px, glyph gap 6px (standard 28/12/8) · wrong · m3/dialogs/menu-measures.png
- Dialogs · Preamble: the empty editor's placeholder is three literal dash bullets · wrong · m3/dialogs/preamble-placeholder.png
- Dialogs · Add workspace… opens a native panel titled "Open project" · polish · m3/dialogs/add-workspace-native.png
- Menus · Goal… absent from the More menus of Verify tools and Verify activity (loose chats) · broken · m3/dialogs/activity-menu-now.png
- Overlays · the saved html_render page's frame and expanded view say another host is unreachable though the URL says host=local · broken · m3/overlays/html-light-1000.png
- Overlays · HTML overlay: Escape fails twice with the error iframe focused; Close works · broken · m3/overlays/html-escape-failed.png
- Overlays · the expanded HTML overlay is 80vw (1152px at 1440), not the full window · polish · m3/overlays/html-dark-1440.png
- Overlays · the PNG attachment is a non-interactive filename chip; clicking opens nothing (no thumbnail, no lightbox) · broken · m3/overlays/image-light-1000.png
- Right panel · a loose chat in a dirty workspace offers only Notes; Changes/Files appear only once the thread has project metadata · broken · m3/panel/activity-initial.png
- Right panel · the header is line tabs, not a segmented control; tablist 32px in a 35px scroll box → a vertical scrollbar · wrong · m3/panel/Verify-tools-light-1000-Changes.png
- Right panel · at 1000 the panel leaves a 220px thread: words split, the composer's mode/Send clip; opening a diff can collapse the thread behind the panel (also at 1440 with a diff) · broken · m3/panel/Verify-activity-light-1000-Activity.png, m3/panel/diff-light-1000.png
- Strip · "Watching a command" though the task's label is "Sleep 600 seconds in the background" · wrong · m3/panel/Verify-activity-light-1000-Activity.png
- Activity · the shell row's command starts with the exported TEMP_CODE_THREAD/TEMP_CODE_CALL wrapper; truncation hides `sleep 600` · wrong (host: the guard's wrapper leaks into the task's command) · m3/panel/activity-fold-light-1000.png
- Changes (beta, clean master) · "No changes" beside a red "unknown branch: main" and Choose a branch · broken · m3/panel/Beta-chat-light-1000-Changes.png
- Agents · a 305px agent title truncates to 143px with no tooltip after 800 ms · wrong · m3/panel/agent-title-hover.png
- Agents · settled agent rows keep Done check marks at rest · wrong · m3/panel/Verify-fleet-light-1000-Agents.png
- Agent detail · the header says "3s" and the turn's closing line repeats "Worked for 3s" · wrong · m3/dialogs/agent-detail-light-1000.png
- Notes · Copy as brief on a custom note adds instructions naming State, Open questions and Pointers sections that do not exist · wrong · m3/panel/notes-light-1000.png, notes-diff.json
- Changes · "Against <branch>", zero ahead/behind and "Up to date with" repeat the branch and sync facts · wrong · m3/panel/Verify-tools-light-1000-Changes.png
- Console: no renderer errors; three "focused content beneath aria-hidden" warnings (m3/console.log:1727, 1785, 1786); main log MaxListenersExceededWarning (m3/instance.log:61).
- Pairing: did not redeem on load; /api/hello exposes only environmentId and contract; the test key was revoked.
- Settings: all pages captured; 672px column, 24px inset, typography and hairlines matched; theme persisted across reload; no mixed-theme frame. Limits: native menu screenshots failed twice; Stats first-open skeleton not verified (only Reindex available); plans auto-implement persistence blocked by S6 (head pending).

# M3 raw findings, part 1 (S9 onward; S1–S8 pending)
- Settings · Hosts · Devices: several iPhone rows repeat the exact model in title and detail · wrong · m3/settings/Hosts-light-1440-bottom.png
- Settings · Appshots · Shutter sound off → after a reload it is On again (no save error) · broken · m3/settings/shutter-off-before-reload.png, shutter-final-read.png
- Settings · Archive · rows offer Restore and a direct Delete…, no ⋯ menu (A15's plan said Restore + ⋯) · wrong · m3/settings/Archive-light-1000.png
- Settings · first pointer click on the rail's Settings row after a fresh launch does nothing; the second opens it (M1 saw the same) · broken · m3/settings/first-click-miss.png
- Accounts · the page title has no muted line under it · wrong · m3/accounts/light-1000.png
- Accounts · the Rate popover says "No answer yet" then "No answer seen from this account yet" · wrong (twice) · m3/accounts/popover-dark-1000.png
- Accounts · the SurfaceSkeleton for the Aliax pages draws a 208px nav column and divider the finished page lacks; the layout then jumps · wrong · m3/accounts/early-dark-1440.png
- Stats · opening Stats after scrolling Accounts inherits the scroll (page y −278 at 1440, −478 at 1000): the title and first chart start above the viewport · wrong · m3/stats/light-1000.png
- Stats · eight chart sections (two Codex limits, Daily output, Model mix, Top projects, Cache hit rate, heatmap, Tools used); the decision said seven · wrong · m3/stats/final-top.png
- Stats · "1 hours left" · polish · m3/stats/dark-1440.png
- Pairing · no CSP header; the meta policy has a script nonce but style-src unsafe-inline · wrong · m3/pair/headers.txt, page.html
- Pairing · a bad code answers two sentences (invalid/expired, then make a new code in Settings); the rule is one · wrong · m3/pair/invalid-400.png
- Menu bar · View has Reload Window but no Force Reload (S5b said both) · wrong · m3/menus/view.txt
- Menu bar · Help lacks What's new · wrong · m3/menus/help.txt
- Dialogs · New project, Preamble, Customize, Research options, Resources, What's new and the project settings sheet inset 16px (confirms 20px) · wrong · m3/dialogs/new-project-light-1000.png, project-settings-dark-1440.png
- Dialogs · project Rename edits inline in the rail; Escape leaves focus on body · wrong · m3/dialogs/rename-project-light-1000.png
- Dialogs · Customize…: a generic title, no muted line naming its scope · wrong · m3/dialogs/customize-light-1000.png
- Dialogs · Delete project… confirm carries three checkboxes (worktree, local branch, origin branch) · wrong (a confirm is one line and two buttons; a form is a dialog) · m3/dialogs/delete-project-light-1000.png
- Dialogs · root workspace: the menu says Delete, the dialog and button say Remove, the body says "saved conversations" · polish · m3/dialogs/root-project-menu.png, root-delete-light-1000.png

# M3 raw findings, part 0 (S1–S8; tested build d441068d)
- Settings · Appearance → Back: the thread rail has zero rows; alpha's header stays; switching beta → alpha restores it (ON THE FIXED BUILD) · broken · m3/settings/rail-removed.png
- Settings · the page column shifts 7.5px when a page gains a scrollbar (x 264 → 256.5 at 1000) · polish · m3/settings/Appearance-light-1000.png, General-light-1000.png
- Settings · reload: a pale splash and a near-white loader at 80 ms, no shell or shaped skeleton · wrong · m3/settings/reload-80ms.png
- Settings · General: the API key row holds an Input and a Connect button; the Release row holds What's new and Check for updates (two controls per row) · wrong · m3/settings/General-light-1000-bottom.png
- Settings · General, Thread defaults, Editor, Orchestration, Reviews: labels are verbs ("Anchor prompts to top", "Start the build on its own", "Format Java on save", "Run shell commands itself", "Hold the merge on") · wrong (labels are nouns) · m3/settings/General-dark-1440.png, Thread-defaults-light-1440.png, Editor-light-1000.png, Orchestration-light-1000.png, Reviews-enabled.png
- Settings · Thread defaults: after a reload the Plans section stays five Skeleton rows past 6 s, twice; no error, no recovery; later navigation loads it · broken · m3/settings/Thread-defaults-load-5000.png
- Settings · Editor's Language servers, Hosts' Clients, Archive's Archived projects: empty groups are one plain line ("None running", "No clients", "No archived projects") · polish (Empty is title + line) · m3/settings/Editor-light-1000-bottom.png, Hosts-light-1000.png, Archive-light-1000.png
- Settings · Providers: CLI paths and shell install commands, "Run settings.json hooks", model picker switches (A14: CLIs and versions only) · wrong · m3/settings/Providers-light-1000-bottom.png

# M6 raw findings (diff, editor, dock, dev servers, inbox, search, checkpoints; build d441068d; full /tmp/tc-verify/m6-findings.md, 19 findings)
- Dev-server ledger: Run → one "Bun server" row under M6 dev, Resources lists it once; Stop → the row gone in 202 ms, absent at 30 s, port 5199 clear; a second Run offers Replace / Start another / Cancel; `bun test` → no row; an agent's background `bun run dev` → one row with localhost:5199 and the shell result links it; Stop → clear. FIXED.
- Diff pane · Monaco diff view with no hunk Stage/Revert controls (Changes offers "Stage lines 4–7"); the stepper first shows 0/1 · wrong · m6/
- Changes · the panel and the composer's controls clip in split panes · broken (same family as M2/M3/M4's width findings)
- Editor · the conflict bar's message truncates to "Change…" at 1000 · polish
- Find bar · CodeMirror's find field collapses at 1000 and its count overlaps the toggles; Escape returns focus (OK); Monaco's find bar works · wrong
- Terminal · closing a busy terminal uses a NATIVE confirm (the rule: never window.confirm; AlertDialog through useConfirm) · wrong
- Terminal · sash arrows (220→224), drag (300), double-click reset, Hide/⌘J and thread/project switches keep the dock state (OK)
- Dev servers · Stop is icon-only; the Dev server row is in the title menu but not the rail row's menu (menus differ); the console shows the raw task-output path above the log; the agent-started row says "Dev server" where the pane's own says "Bun server"; the thread's strip says "Watching a command" · wrong
- Inbox · lists GitHub/Linear work items (by design); the waiting approval shows in the workspace's Needs you popover instead; the empty state has no supporting line · polish
- Search · README matches fold wrongly: `return type:file` shows two rows for src/app.ts; the foot shows "This Mac: 11 ms" with one host (the rule: skipped); bare `type:note`, `type:file`, `project:alpha` leave the result area blank (no no-result row); a filename repeats in its row; Enter opens a file, ⌘↩ a thread beside (OK); rows have no animation (OK) · wrong
- Checkpoint strip · after an Edit turn appended `// m6` to src/app.ts no strip appeared (both themes, both widths, after a reload); the checkpoint manifest lists the Edit tool's temporary write file as touched, not src/app.ts · broken (host: checkpointTurns)
- Shell · the thread column went empty again, then clicks on alpha left the header on tc-verify-perf (the wrong project's header) · broken · m6/ (trace saved)
- Panel · "Verify tools" (a loose chat) offers only Notes though src/app.ts is changed on disk (same as M3 R1)
- Limits: the native folder panel (computer use picked the other verifier's window, so no input was sent), the native busy-close confirm, checkpoint Undo/Keep.

# M7 raw findings, part 2 (fixed build; C2 onward; full /tmp/tc-verify/m7-findings.md)
- Composer · 1000 wide, Fleet alone → Panel → Agents: the composer box is 208px wide (right edge 674) and Send ends at 878.82 (204.82px outside); Mode enters the panel · broken · m7/composer/agents-light-1000.png, composer-split-panel.json
- Model menu · Codex: Effort and Speed rows but no Context or usage percent (Claude shows 18%/200k) · wrong · m7/composer/model-Verify-codex-light-1000.png
- Composer · the default-on pixel mascot and coin keep moving along the composer while a question waits (ComposerRunner) · wrong (nothing loops) · m7/transcript/needs-you-light-1000.png, mascot-facts.json
- Permission mode · Supervised: a direct `ls` runs without approval while an `sh -c` wrapper gates; the mode's wording says "Ask before commands and file changes" · wrong (host rules vs wording) · m7/toast/exact-source-thread.png, composer/permission-wording-light-1000.png
- Model menu · trigger → Escape → focus lands on the Message field, not the trigger · polish · m7/first-run/model-escape-light-1000.png
- Right panel · Agents: line tabs with a vertical scrollbar (segmented control expected) · wrong · m7/composer/agents-light-1000.png
- Right panel · Agents: a settled child row keeps check + Done at rest · wrong
- Toast · an approval toast (another thread) sits over the composer's Send in all four cases: 1440 toast (1084,793.6,340×90.4) vs Send (1355,849,28×28); 1000 toast (644,593.6,340×90.4) vs Send (957,649,28×28); pointer clicks leave the draft unsent · broken · m7/toast/exact-light-1000.png, approval-exact.json
- Strip · a working strip has no Stop (Stop only in the thread menu); after Stop the transcript reads "Stopped / Worked for 1s" with NO Stopped/Resume strip or Resume button · broken · m7/strip/stop-exact-light-1000.png
- Strip · Pause → Stop/Continue twice (the top banner and the composer strip) · wrong · m7/strip/pause-exact-light-1000.png
- Strip · while paused the transcript already says "Worked for 1s" with Continue live · wrong · m7/strip/pause-exact-dark-1440.png
- Strip · "Needs you" in the transcript and the strip; a running turn repeats Working in both · wrong · m7/transcript/needs-you-light-1000.png
- Strip · "Watching a command" while Activity names "Sleep 45 seconds in the background" · wrong · m7/strip/watching-light-1000.png
- Re-checks on the fixed build: first-run auto-added workspace PERSISTS (F1); blank Settings/New project FIXED; duplicate Settings scopes seen once (F2); blank thread views FIXED; rail context menu, row sizes, clipped-title tip PERSIST (R3–R5); rail disappearing after Settings persists for loose chats, project chats lose their scroll (R1–R2); chips/title actions fixed for project roots, loose chats still chipless (T1/H1); the Read row's editor FIXED; the HTML frame exists but the saved local page still fails (X4); image/question font/read caret/provenance persist (X1–X5); the right panel renders, narrow controls overflow; toast/Stop-Resume/duplicated states/paused closing line/clipping persist; account chip absent by design; rename/model focus, menu spacing, header alignment persist (R6/C6/R7/H2); ⌘W does nothing and chips have no Close (Archive only); chips 28px; at 1000 the strip is 454px for 720px of chips and wheel-scrolls.
- OK: project folds survive reload; hover/selection muted fills, one More action, no bar; settled rows unmarked; 20/20 chip context menus; user bubbles 15px/24px; grouped actions; Bash output; four closing-line hover actions; no timestamps or avatars; console clean.

# M7 raw findings, part 1 (fixed build d441068d; checkout then bd535f86)
- First run · the preview's cwd (the clone) is added as a workspace without input; no Add workspace… row; the draft shows Fable 5.1 / Medium / Supervised, branch ios/contract-catchup, Chat · wrong · m7/first-run/as-opened.png, final-light-1000.png
- First run · Settings → Appearance once listed two Workspaces rows both "temp-code-verify" with no path or host; a fresh profile showed one · wrong, seen once · m7/first-run/appearance.png
- Rail · loose chat selected, scrolled midway, Settings → Appearance → Back: the list goes 40 → 0 rows on the FIRST return in every case, zero after all 40 returns; header and transcript stay; no skeleton; beta → alpha restores · broken · m7/rail/loose-cycle-light-1000-1.png, rail-settings-loose-cycles.json
- Rail · the same with a project chat: 40/40 rows survive but the scroll resets 248 → 0 (1440) and 348 → 0 (1000) · broken · m7/rail/cycle-light-1000-1.png, rail-settings-overflow-cycles.json
- Rail · right-click a thread row (trusted button-2 event reaching the label, and a dispatched contextmenu): zero menu rows; More works · broken · m7/rail/right-light-1000.png, rail-context-exact.json
- Rail · roots and projects 32px, child 28px, label 13px, gap 8px (DESIGN says 36px; LAYOUT says 32/28) · wrong · m7/rail/light-1000.png, rail-matrix.json
- Rail · a clipped child title (298px text in a 71–86px label) shows no tooltip after 1.5 s · wrong · m7/rail/truncate-light-1000.png
- Rail · More → Rename → Escape: focus goes inline input → body, never back to More · wrong · m7/rail/rename-escape-light-1000.png, rename-trusted.json
- Rail menus · More's items 27.5px high, 6px padding, 6px gap (28/12/8) · wrong · m7/rail/menu-measured-light-1000.png
- Tab strip · a loose chat (Verify chat, Beta chat) on screen has no chip; the strip says New thread; project chats have chips · broken · m7/transcript/Verify-chat-light-1000.png, rail/pinned-light-1000.png
- Title bar · a loose chat's ⋯ offers only "$0.01" and Terminal; no thread-header ⋯ supplies the thread's actions; project roots' title menus work · broken · m7/tabs/loose-title-light-1000.png
- Title bar · New thread at y 5.5, Thread menu and Panel at y 6 (all 28px) · polish · m7/pin-header-metrics.json
- Transcript · the question card's question (14px) and options (13px) inherit ui-monospace · wrong · m7/transcript/needs-you-light-1000.png, question-font.json
- Transcript · in the opened action group the Read README.md row has a glyph and label but no caret (it opens a populated file pane now) · wrong · m7/transcript/action-group-light-1000.png
- Transcript · Second opinion → the review starts with a right-aligned bubble holding "Second opinion" and provider logos/names (clipping at 1000) · wrong · m7/transcript/opinion-light-1000.png
- Transcript · the html_render iframe exists but says the page is on another unreachable host while its URL carries host=local · broken · m7/transcript/page-frame-light-1000.png, page-visible.json
- Transcript · the PNG attachment is a non-interactive title span: no thumbnail, no Preview, two clicks open nothing · broken · m7/transcript/image-click-light-1000.png
- Composer · Open to the side at 1000: each box 258px; Send ends 154.82px past each box's edge, the second beyond the window · broken · m7/composer/split-light-1000.png, composer-split-panel.json
