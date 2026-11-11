# Computer use: the Mac's apps from any thread

docs/computer-protocol.md is the contract and the long account, by
section; docs/box.md "Computer use: the Mac's apps from any thread" has
why and the measured headline.
- **The service.** `tc-computer`, a Swift binary in native/tc-computer,
  one process per app instance. scripts/lib/tcComputerBuild.ts builds it
  on macOS into resources/native/tc-computer beside a content stamp
  (`TEMP_CODE_SKIP_NATIVE=1` skips it; `TEMP_CODE_REQUIRE_NATIVE=1`, which
  release-publish.sh sets, makes a failure stop the publish, and the
  publish checks the signed copy with `codesign --verify --strict`).
  native/tc-computer/README.md lists the targets, the one private symbol
  and what the service refuses. A launch, an open and every `ax` or
  `process` step run under the front guard (docs/computer-protocol.md
  §23): an app that takes the front anyway is put back within 400 ms
  unless the person chose it, a third steal hides it, and every result
  says `raised`; a steal after the call answered is `apps/frontRestored`,
  said once in that thread's next result.
- **The contract.** The zod in src/shared/computer/ (protocol.ts,
  observation.ts, tools.ts) is the one source; `bun run gen:swift-computer`
  writes the Swift under each target's Generated/, and
  `check:swift-computer` runs inside `bun run typecheck`. Coordinates stay
  integers: proofs use scripts/lib/computerPoint.ts `intPoint` to round
  both axes after bounds or scale arithmetic, including capture corners.
  The host forwards validated actions and element IDs without deriving
  points from bounds or zoom. The parts:
  Capture (§6, §7: one window, never the desktop; screenshots, the preview
  stream, the pixel signal), Input (§14: the `ax`, `process` and `session`
  tiers, the paste under the clipboard lock; in the background a step first
  tries the AX route that does the same thing, §24: a shortcut's menu item,
  the element under a click, the caret, the scroll bar, an AX insert for a
  text paste; a menu item the background disables runs at `front`, and the
  host runs the routes an app ignored last), the AX reader (§15: pure
  `AXText`, tested on the box with `sh scripts/computer-text-test.sh`, and
  the Mac's walk), the service shell (§16: the router, the locks, the
  held-input ledger, the exit codes). `bun run computer:test` builds and
  tests the package on the Mac. The window's title-bar buttons are always in
  the tree, the capture badge never (docs/computer-protocol.md §22): closing
  and minimizing are clicks at `ax`; restoring is `perform raise`, at the
  session tier.
- **Web content** (docs/computer-protocol.md §25). A Chromium process is
  known by its bundle (`ChromiumBundle`), never by `AXManualAccessibility`,
  which Chrome refuses. `window` may name a browser tab, which a call selects
  over AX under the app's action slot (`TabSelect`; the person's own front
  window answers `tab_in_use`, which a read words and an act takes to the tier
  gate); the observation carries `page` (loaded, loading, not drawn: the
  header's ` · page not drawn`) and `selectedTab`; a web area reads one screen
  above and three below; a web pop up's `set_value` is `pick`, every web
  `set_value` is read back (`value_not_taken`); `key` and `hold_key` take
  `element`, and keys never go into the browser's own fields
  (`focus_moved`, with the host's `expectFocus` from the model's last read);
  a page scrolls by `scroll-into-view`. The gate's `webLeg` runs it on Chrome
  for Testing; field hand runs use plain Chrome with `--cover`.
- **Steps that need the app active** (docs/computer-protocol.md §26, plan
  .temp-code/plan-CAMMKRiJRhhu.md). The `front` tier sits between `process`
  and `session` (`TIER_ORDER`): one bounded hold brings the app forward,
  acts through AX or events posted to its pid, never the pointer or the HID
  tap, and gives the person's app and key window back (`FRONT` timings in
  protocol.ts, `step.front`); it serves Save, Move to Trash, New Folder, an
  inline rename's commit and the key-window retry. `save_as { path,
  replace? }` saves through the save panel, its folder confirmed in front,
  and proves the file. The commit check stats the file or folder behind the
  window around each acting step (`step.disk`): a step expected to reach the
  disk that changed only the screen reads `uncommitted`, "on screen only,
  not on disk", with the step that commits it, and counts as a miss; the
  observation's document line names the file, its write time and `edited`.
  A menu a call opened is closed at its end, else named (`menu left open:`).
  `initialize` carries `features` both ways, so an older peer never sees
  what it cannot parse (`HostFeatures`, `ComputerService.serves`, the
  bridge's `features: ['front']` and `rowForPeer`).
- **Fewer calls** (docs/computer-protocol.md §27). A step may name its
  target by its name (`named`) or a menu-bar item by its path (`menu: "File
  > Save…"`), resolved when it runs. A menu a step opens comes back in the
  result (`+ menu opened by step n`), and a window it opens moves the call
  there (`opened`). Text and keys with no target go to the live focus only
  when a step of the call aimed there or the step before moved it there,
  never into a password field (`focus_moved` `unplanned`, `secure`); keys
  after a step that changed nothing do not run (`stopped`). The host carries
  these facts across its segments as `prior` (src/shared/computer/batchStop.ts,
  the shared table fixtures/batch-stop.json). Every wait reports its first
  change and its gaps; `axAction` and `axStep` rows wait after ax steps
  (seam `TEMP_CODE_COMPUTER_WAIT_AX`, JSON rows, isolated instances only).
- **The host** (src/main/server/computer/, §17). On a Mac with a screen,
  one `ComputerService` (binary.ts; respawned with backoff, down five
  minutes after five crashes in two, shut down after ten idle minutes).
  `ComputerSessions` (sessions.ts) keeps one session per thread: its calls
  one at a time, the bound window, the element book, a live row from a
  turn's first call to its settle. The tier verdicts live in
  `computer.tiers.<bundleId>`, probed once per app. Stop on the Activity
  row (`computer.stop`) ends computer use for the turn.
- **The app tools.** The four `computer_*` tools on every Mac thread,
  subagents too: deferred on Claude (computer/mcp.ts) unless the thread is
  bridged to a Mac with computer use on or has acted before
  (`computer.used.<threadId>`, §27.11), then loaded at spawn, through the bridge
  on codex and Muse behind a per-thread token. The bridge also lists
  `computer_result`: a Codex or Muse call held 20 s answers with an id and
  waits, running nothing unread, until `computer_result` reads or cancels it
  (computer/pending.ts, the lines and timings in
  src/shared/computer/heldCalls.ts; a box thread's call on the Mac through
  `mac.computerReader`); 60 s unread or the thread's next computer call
  cancels it. Seam `TEMP_CODE_COMPUTER_HELD_MS=<answer>,<wait>,<unread>`
  (isolated instances only); docs/computer-protocol.md §17.8. `offersComputerTools` and
  `computerMechanicsFor` (apptools.ts) decide who gets them and
  COMPUTER_MECHANICS (computer/prompts.ts); a cursor thread gets neither.
  The words come in two shapes by the model's maker
  (src/shared/computer/descriptions.ts, §19). `computer_apps` takes
  `open`: files, folders and web pages into the named app, never programs
  (http, https, file URLs and absolute paths, at most 8; the service
  refuses a missing or executable item and a refused app before anything
  opens); it asks a card in safe and edits and takes `confirm`.
- **Confirmations** (§19, src/shared/computer/policy.ts). In safe and
  edits every act that sends input asks one card naming the app, the
  window and each action; reads never ask. Full access asks only for an
  act the model flagged (`confirm: { kind, what }`) and before text goes
  into a password field. Away allows every card but a `pay` or
  `subscribe` act's, which it denies. Every call's app is pinned to a pid
  first (`TargetResolver`), and TempCode itself and the system's password
  and Touch ID prompts are refused (`refused_app`). Service errors read
  through `errorLine` (src/shared/computer/errorWords.ts).
- **The page.** Settings → Computer use (surfaces/settings/Computer.tsx;
  Mac desktop only, `macOnly` in lib/settings.ts): the service with Try
  again while down, Take the screen after (`computer.sessionIdleMs`, in
  minutes), When a step needs the app in front (`computer.activeApp`: Bring
  it forward for a moment, or Wait until I'm away; §26.6), the two grants with Grant…, the learned apps (`verdictWords`)
  with Forget; `computer.settings.get/set`, `computer.verdicts.forget`,
  `computer.permissions`, `computer.service.retry`, all `local`
  (computer/settingsRpc.ts); the `computer-settings` push.
- **The session tier** (§20, computer/schedule.ts,
  src/shared/computer/scheduleRules.ts) takes the person's pointer and
  keyboard only while they are away: no input for `computer.sessionIdleMs`
  (120 s), or the Away switch and 10 s of quiet; locked or asleep refuses.
  A held step says "Waiting for the Mac to be free" and asks one card with
  Run now and Skip (at once in safe and edits, after 3 minutes in full
  access; answered Run now while Away is on). One session call at a time per host; the person's app and
  pointer go back after it. A paste waits out the person's copy
  (`RECENT_COPY_MS`). main feeds it `PersonIdle` (src/main/personIdle.ts).
  The `front` tier runs at once by default, the person present or not
  (`computer.activeApp` `brief`); `away` makes it wait as the session tier
  does, with the card "Bring TextEdit forward for a moment to …"
  (`frontFreedom`, `SessionScheduler.frontAdmitted`). A hold's span leaves
  the person's idle time like a session step's.
  The service's hold (native/tc-computer Input/FrontTier.swift) waits for
  the person's keyboard to be quiet (a listen-only key monitor run while
  any computer session is open), takes the
  session lock, arms the person guard below for the hold (their keys,
  clicks and wheel dropped, Escape stopping the step and restoring at
  once; with no tap, their first key, click or wheel does the same) and
  gives their app and window back; a batch's consecutive `front` steps
  share one hold while it has time left, and a paste's pasteboard work
  stays outside it (docs/computer-protocol.md §26.2, §26.3, §26.16).
  From a session step's start until the restore after it, the person
  guard (an active session tap, `PersonTap.swift`) drops the person's keys,
  clicks and wheel and lets pointer moves through, so nothing they do lands
  in the raised window; a person who was typing when the step began gets
  their plain typing back in the field they were in, never a shortcut,
  Return or Escape (docs/computer-protocol.md §14.9).
- **What the person sees** (§8 "What the person sees"). A Computer row per
  live session in the right panel's Activity section
  (src/renderer/src/lib/computerSessions.ts, the tier in
  `COMPUTER_TIER_WORDS`: in the background, to the app, in front, on the
  screen), opening on the Mac's desktop onto the live
  preview (computer/preview.ts at 4 fps, the `local` RPCs
  `computer.preview.start/ack/stop`;
  src/renderer/src/surfaces/threads/ComputerPreview.tsx); a picture the
  model asked for as its own transcript row
  (src/renderer/src/surfaces/transcript/ComputerShotRow.tsx); and, while
  the session tier holds the Mac, the banner "TempCode is using your Mac"
  (computer/hold.ts `SessionHolds`, src/main/computerBanner.ts), with "Esc
  to stop" once `escape.watch` answered. Claude and Muse get a call's
  pictures as image parts, codex too (`codexComputerImages()` in
  drivers/codex.ts).
- **Box threads** drive the Mac's apps through the Mac bridge: the
  `mac.computer` call, run on the Mac by remote/macComputer.ts and queued
  per thread by computer/bridge.ts on the box, while the host's switch
  `macBridge.computer.<envId>` is on (off by default), under
  `macBridge.maxComputer.<envId>` (2) live sessions. A call the Mac holds
  (`running.held` on its row) is the box thread's tool hold, so its status
  says the Mac's line ("Waiting for the Mac, load 12.3 of 8, 3rd in line").
  The bridge costs about one round trip a call and is held there: the Mac
  sends its legs with each answer (`timing`, src/shared/computer/
  bridgeTiming.ts), the box joins them with its own into one
  `[computer-bridge] thread=<id> timing total=… queue=… box=… transit=…
  mac=… run=…` line under `TEMP_CODE_COMPUTER_TRACE=1` (a Mac thread's call:
  `[computer] thread=<id> timing …`), and a call whose bridge part passes
  250 ms writes a `computer-bridge` line to stalls.log with the loop's lag.
  The bridge proof's timing leg (scripts/lib/computerBridgeTiming.ts
  `BRIDGE_TIMING_RULE`) judges ten interleaved pairs: box minus Mac at most
  40 ms median and 100 ms p90 on loopback, at most the run's round trip
  plus 40 ms over the network. A reply past 2 MiB sends its chunks two at a
  time. §18 "What the bridge costs" and docs/box.md "Computer use from a box
  thread".
- **Seams.** `TEMP_CODE_COMPUTER=0` (off; `=1` serves a headless Mac
  instance), `TEMP_CODE_COMPUTER_BIN` (the binary),
  `TEMP_CODE_COMPUTER_TRACE=1` (every frame and every call's timing line), `TEMP_CODE_COMPUTER_PIN`
  ("TextEdit=<pid>", isolated instances only), `TEMP_CODE_SKIP_NATIVE`,
  `TEMP_CODE_REQUIRE_NATIVE`, `TC_PROOF_UNGATED=1` (a Mac proof without its
  idle wait, for a run the person sits beside or one on TC Probe alone).
- **The proofs.** Every one needs an unlocked, awake screen, and only one
  runs on the Mac at a time (scripts/lib/proofOrder.ts: a proof waits for
  an older one, judged by its `bun run` wrapper). The publish gate's rows,
  unattended on TC Probe (scripts/mac/computer-probe-app.swift: its window
  is never key and takes no keystrokes): `computer-swift`, `bun run
  script:e2e-tc-computer -- --gate`, `bun run script:e2e-computer-bridge
  -- --gate` (both halves on the Mac, the box half seamed linux) and `bun
  run script:e2e-computer-preview -- --gate` (the Escape leg skipped), then
  `computer-bench`. Their shared rule (no picture and no prompt without
  Screen Recording, a named failure without Accessibility) is
  scripts/lib/computerProofGate.ts; scripts/lib/macScreen.ts skips their
  `--gate` runs at entry if the screen is locked, asleep or unreadable
  (docs/computer-protocol.md "The unattended proof modes"). Each proof's
  startup sweep (scripts/lib/computerProofProcesses.ts) ends leftover TC Probe
  copies and proof-owned services after taking its turn. Services carry
  `TEMP_CODE_COMPUTER_PROOF=1`; the sweep also recognises older gate services
  and the bridge's scratch HOME, and excludes installed TempCode and other
  live proofs. Orphaned scratch apps never count as proof runners. Cleanup
  in `finally` ends the probe by binary path even if launch never returned a
  pid, and closes each proof service. The bridge proof waits up to two minutes
  per call and logs the Mac's held standing. Its `session.markStatus` turns
  have no harness; the liveness sweep leaves them running until the proof
  settles them. Real turns keep their missing-harness check. The preview's
  scratch copy of TC Probe draws no highlight on Ping (scripts/lib/previewProbeApp.ts), so its second click
  changes no pixel and the no-frame check holds. The hand runs, each with what it needs:
  `script:e2e-tc-computer` whole (TextEdit and the paste: 5 idle minutes),
  `script:e2e-computer` (real Sonnet turns), `script:e2e-computer-bridge`
  over SSH (the real pair), `script:e2e-computer-ax` and
  `script:e2e-computer-input` (the person away), `script:e2e-computer-capture`
  (Screen Recording), `script:e2e-computer-schedule` (the session tier),
  `script:e2e-person-guard` (a person's real keys, clicks and Escape
  during a session step; a person at the keys),
  `script:e2e-computer-preview` whole (it takes Escape for two seconds),
  `script:e2e-computer-images` and `script:e2e-computer-ui` (real model
  turns), `script:compare-computer-words` (48 model runs, about 25 minutes)
  and `script:measure-front-guard` (scripts/mac/front-guard-measure.ts:
  the front guard against TextEdit, Chrome on a scratch profile, Finder,
  Calculator and IntelliJ, after 5 idle minutes, aborting at the person's
  first input; §23.9). The gate's tc-computer row also launches "TC Probe
  Steal", the probe built to activate itself, and checks the guard put the
  front back. docs/release-gate.md "Hand runs" has each one's host, needs
  and last time.
- **The bench** (§21). `bun run script:e2e-computer-bench` runs seven real
  desktop tasks on Opus 5.5, GPT-6.1 Sol and Muse Wonder 1.0 side by side
  in the background tiers, each end state read through the AX tree, the
  files or `defaults`; `BENCH_RULE` (scripts/lib/computerBench.ts) judges
  it against `<git-dir>/temp-code-gate/computer-bench/baseline.json`.
  docs/release-gate.md "The computer bench". `--set field` (§21.7, hand run
  only; scripts/lib/fieldTasks.ts) is the 2026-11-10 field test as 14 tasks
  on Opus, Sonnet and GPT-6.1 Sol, run three ways — `--host mac`, `--host
  box` (threads on an isolated box instance over the Mac bridge, both
  clocks recorded) and `--reference codex` — one run at a time, Away on
  (session holds inside the wall, their own column), one off-route rule
  for both sides and no step budgets — judged across saved reports by
  `--judge-field` (scripts/lib/fieldBar.ts: parity with Codex, medians at
  or under its, the box within 15% of the Mac, a hole in a report a named
  miss). With no Codex report it judges seconds and calls against
  `FIELD_TARGETS` (scripts/lib/fieldTargets.ts, never a full pass), and every
  report prints a waste table per model (scripts/lib/fieldWaste.ts).
- **Fixtures.** src/main/server/computer/fixtures/ (its README): wire
  frames, observation texts and app trees recorded from scratch content
  only (scripts/mac/record-computer-fixtures.sh), held to their schemas
  and the privacy guard by computerFixtures.test.ts.

The bridge gate (`scripts/e2e-computer-bridge.ts --gate`) checks the Mac’s
short hostname and the remote note on `computer_apps` alone (§27.12),
uses a full TC Probe tree for held-click indices and rejects
missing indices or held ids. Its scratch app launches without the agent’s
process-guard marks: Launch Services gives it PID 1 as parent, and the
proof owns its PID cleanup. A cancellation notice passes only when the
observation that follows it also succeeds. Proof ordering counts real
runners by executable/script operand, including Bun wrappers and preload
flags; generic wrappers, trailing arguments and inline shell text do not
claim a turn. A later actual child takes its own age. Away allows the ordinary click and records an
allowed notice, but refuses a `pay`-flagged click before it runs. The
2026-11-10 timing leg added 3–10 ms at p50 and 19–42 ms at p90 on loopback
(§18); it passed while the old proof’s other checks failed.

After the proof fixes, all 60 checks passed on the Mac in 96 s: added
p50/p90 13/32 ms observe, 14/29 ms with a picture, 2/33 ms `set_value`,
with the same bounds. The probe survived past the orphan grace and exited
in its own runner’s cleanup. Evidence lives under
`.temp-code/findings/computer-bridge-gate-fixed-2026-11-10/attempt2-4b6e6a4a7/`.
