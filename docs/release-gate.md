# The release gate: two tiers, one runner

`bun run gate` (scripts/gate.ts) is the one implementation behind both the
post-commit train (scripts/release.ts, run by .githooks/auto-release.sh) and
`bun run release:publish` (scripts/release-publish.sh). It reads one `STEPS`
array, each step tagged with a tier, and one `TIER_PATHS` map, both in that
file. A sibling change that needs a new check (the bundle-size check after
`build`, a new proof) adds a row to `STEPS` and nothing else.

## Tiers

| tier | steps | runs |
| --- | --- | --- |
| `commit` | typecheck, vitest, build, bundle-size | in the post-commit hook, on every commit on master; vitest holds the prompt budgets too (scripts/claudeMdBudget.test.ts: CLAUDE.md at most 40,000 bytes with every docs/agents file linked once; src/main/server/promptBudget.test.ts: the host-written prompt parts against src/shared/promptBudget.ts) |
| `publish` | renderer-soak, renderer-soak-chat, renderer-soak-typing, renderer-soak-scroll, e2e-remote-fence, e2e-addons, e2e-addon-grants, e2e-skills-store, e2e-skills-drivers, hub, ios, ios-client, computer-swift, e2e-tc-computer, e2e-computer-bridge, e2e-computer-preview, computer-bench | before signing in `release:publish`; and in the hook when a commit touches a guarded path, all but computer-bench. The four soaks, hub, ios, ios-client, computer-swift, e2e-tc-computer, e2e-computer-bridge, e2e-computer-preview and computer-bench are `mac: true`: a host off macOS (the box's merge gate) skips them with a note, since `release:publish` runs them on the Mac before anything ships; the four store proofs run on both hosts |

The four rows `e2e-tc-computer`, `e2e-computer-bridge`,
`e2e-computer-preview` and `computer-bench` also have `screen: true`.
When the selection includes a screen row, the gate checks the Mac's screen
once before starting any lane. A locked, sleeping or unreadable screen skips those rows with
`skipped  the Mac is locked or asleep; run it by hand when unlocked`;
`computer-swift` still compiles and tests. The check uses the proof's
CoreGraphics rule in a tiny Swift binary cached in the gate's log dir
(1.8 s compile cap, at most 400 ms to read, sharing a 1.95 s budget).
It never checks off macOS or for a commit-only run. Direct `--gate` proof and bench runs make the same check
before work and exit 0 with `skipped: the Mac is locked or asleep`.

Guarded paths (`TIER_PATHS`): `ios/**`, `scripts/gen-swift-contract.ts`,
`src/shared/wireSchemas.ts`, `src/shared/contract*.ts`,
`src/main/server/remote/**`, `infra/hub/**`, `scripts/e2e-remote-fence.ts`,
`scripts/ios-*`, `native/tc-computer/**`, `src/shared/computer/**`,
`scripts/gen-swift-computer.ts`, `scripts/computer-test.sh`, the add-on,
skills and computer host code (`src/main/server/addons/**`,
`src/main/server/skills/**`, `src/main/server/computer/**`,
`src/main/server/addonStore.ts`, `skillStore.ts`, `skillFiles.ts`,
`storeRpc.ts`, `museConfigDirs.ts`, `src/shared/addons.ts`,
`src/shared/skills.ts`, `src/shared/addonGrant*.ts`,
`src/main/addonHostProcess.ts`, `src/main/addonHostSpawn.ts`,
`scripts/app-mcp-bridge.mjs`) and the proofs and helpers
(`scripts/e2e-addon*.ts`, `scripts/e2e-skills-*.ts`, `scripts/e2e-computer*.ts`,
`scripts/e2e-tc-computer.ts`, `scripts/lib/gateBuild.ts`,
`scripts/lib/tcComputerBuild.ts`, `scripts/lib/proofOrder.ts`). The drivers
(src/main/server/drivers/claude.ts, codex.ts) stay out: nearly every commit
touches them. The train runs `gate --tier commit --since release-N`
(N from release.json; `HEAD~1` when the tag is missing), and any changed
path since that ref that hits the map pulls its tier in, so a contract change
still cannot land stale Swift between publishes. A proof that boots an
instance belongs in `publish`.

A step marked `onlyAtPublish` runs only when its tier was asked for
(`--tier publish` or `all`), never when changed paths alone pulled the tier
in: the report says `– computer-bench skipped: runs at publish`
(`atPublishSkips`). computer-bench is the one such step, since it starts
real model threads for minutes, and a commit on the Mac that touches
`src/shared/computer/**` must not do that in its hook.

## The renderer soak

Three steps, one scene each. The first two share their window and bounds
with a CPU bound of their own; the third types. `renderer-soak` runs `bun scripts/measure-renderer-soak.ts
--gate`: the production build's window, inactive and unthrottled, under the
synthetic host's load (scripts/lib/soakHost.ts: a pinned master, sixteen
batch children, streaming text and a running shell step) with the board and
a streaming transcript side by side. `renderer-soak-chat` runs the same with
`--scene chat`: one plain chat thread with the focused child's load alone
(20 text deltas a second, a tool call every 5 s, no board, no batch, no
spinner but the thread's own), shown as a stream. Each takes ten seconds to
warm up, then a 50 s window sampled every 10 s, inside a hard 90 s from
launch to teardown. A step passes when heap after GC grows at most 6 MB and
renderer RSS after GC at most 30 MB across the window, no long task passes
200 ms, long tasks take at most 250 ms of any second, and the renderer's CPU
stays under its scene's bound (scripts/lib/soakJudge.ts `GATE_RULE`,
`GATE_CPU_PCT`). The memory bounds are sized to catch a leak of the
2026-11-01 class (the dev build's +66 MB a minute fails the 30 MB rule in
under a minute) and a main thread that never rests, not small drifts. No
bound is ever raised to make a run pass.

`renderer-soak-typing` runs `--gate --scene typing`: the master's board and
chat under the board scene's load, the master's own churn and a 3,000-edit
live-edit flood every 10 s, its composer typed into in phases (100 keys with
the load paused, 200 under it, 100 at key repeat speed, a 1,000-key burst
and a 2,000-character paste; never sent). It passes when a keystroke
reaches its frame within 16 ms at p95 with the load paused and within 33 ms
under it, paced or fast, no long task passes 100 ms while typing paced or
fast, and every phase's text is exact (scripts/lib/soakJudge.ts
`TYPING_RULE`); CPU and memory are reported, not judged. It runs about 65 s
from launch to teardown inside the same 90 s, so the publish's soak lane
runs about 25 s longer than with two scenes. The store's old per-item
live-edit fold fails it (busy p95 near 500 ms on the box's flood); docs/box.md
"Typing on a busy master" has the runs.

`renderer-soak-scroll` runs `--gate --scene scroll`: the master's
transcript, its board, the rail's workspaces and the workspace column, each
turned by the wheel at 60 Hz for 4 s and flung once under the board's load.
It passes when every surface and every stretch moves and no long task runs
while it does; the frame rate (90% of the display's) and the longest frame
(32 ms) are the target and are reported against it, not judged, until a run
on the Mac sizes them there (scripts/lib/soakJudge.ts `SCROLL_RULE`,
`framesReportOnly`). It runs about 40 s from launch to teardown inside the
same 90 s. docs/box.md "Scrolling while threads work" has the runs.

The CPU bounds are regression guards, each the scene's highest figure on
the Mac (M4 Max, the window on a 144 Hz screen) plus a margin. The same code
reads up to 1.4 times higher on a quiet Mac than on one busy with other
apps (load 8-9), at the same 104 main-thread frames a second, so a bound
covers the quiet figure:

| scene | before (a3bf7355) | after | bound |
|---|---|---|---|
| board: the master's board beside a streaming child | 33.7, 32.9 on a quiet Mac; 27.1 on a busy one | 29.2, 29.3, 29.6 quiet; 20.1, 20.3, 21.6 busy | 33% |
| chat: one plain chat streaming | 17.7 busy | 14.6, 14.7, 15.0 busy | 22% |

The chat scene reads 15% on a busy Mac, so it cannot meet 12% either; its
quiet figure was not caught, and by the board's ratio it is about 21%,
which its 22% covers. The board scene cannot come down to the 12% the soak
first asked for
without changing the design UI-13 landed, which the user chose knowing the
cost. The trace (`--trace 5`, scripts/lib/soakTrace.ts) names where it goes:
each streamed phrase starts and ends one compositor animation (the phrase
fade), and that asks the main thread for about 57 more frames a second
(about 105 a second against 48 with the fade off); Blink then re-samples
every turning spinner on each of those frames (about 16 µs of style and
12 µs of prepaint per spinner per frame on the box). With the fade off and
every spinner held still the board still reads 16%, and either alone takes
about 6 points. docs/box.md "The soak's two scenes" has the experiments.

A hand run reads CPU without failing on it with `--cpu-report-only`
(`! renderer CPU, % of one core: 34 (limit 33, reported only)`, "over,
reported" in the table), and `--trace 5` adds the frame attribution to the
report.

All three read `out/`, so they sit in the `build` lane after the build and
the bundle-size check, the board scene first, then the chat and the typing
scenes, one instance at a time. In
`release:publish` the gate runs beside the build, so the script touches
`$STAGE/build.done` once its build and size check pass and starts the gate
with `TEMP_CODE_SOAK_BUILD_DONE` naming that file; each soak waits for it
(at most 10 minutes) and then runs its 90 s at most while the app signs.
Anywhere else each reads the
stamp the bundle-map plugin writes into `out/bundle-map.json` (`head`:
HEAD's commit and whether the tracked tree was clean) and builds first
when `out/` is not HEAD's clean build. The gate forwards SIGTERM and
SIGINT to its steps' process groups, so the publish's exit trap after a
failed build stops the soak, which kills every process carrying its
instance's TEMP_CODE_USER_DATA.

## The store and computer proofs

Seven publish rows prove the add-on registry, the skills store and computer
use with nothing a person or a model has to do. Each runs its script entry
with `--gate` (`bun run script:<name> -- --gate`), and every `--gate` keeps
one contract:

- **It never builds.** It waits for `out/` through scripts/lib/gateBuild.ts
  (`waitForGateBuild`): the done file the gate names when it runs the build
  beside it (`<git-dir>/temp-code-gate/build.done`, the build barrier in
  "Tiers" above; release-publish's own stage file under `release:publish`),
  else HEAD's stamp in out/bundle-map.json, 10 minutes at most. After the
  wait it may compile its own scratch helpers (TC Probe, the probe binary)
  and call `buildTcComputer({ require: true })`, a no-op when the stamp
  matches.
- **Two app instances at most**, and it kills what it started on any exit
  (scripts/lib/proofCleanup.ts for the store proofs).
  The process scan in `scripts/lib/procScan.ts` allows 64 MiB of output on
  macOS, where `ps` includes every process's environment. A scan failure
  still fails the proof, with only its error code or exit status in the
  error; captured environments and stderr never enter that error.
- **It finds its CLIs the way the app does** (scripts/lib/gateCli.ts: the
  real user's login shell, then PATH, then the usual user bin dirs), never
  by the caller's PATH alone: the gate's children inherit a sparse one, and
  the drivers row's first gate run passed judging nothing. A row whose
  required leg cannot judge fails (the drivers row's Claude leg).
  The grants, skills-store and computer-bridge proofs launch the clone's
  Electron binary through `scripts/lib/proofElectron.ts`, so their sparse
  PATH does not need a `node` entry. The drivers gate uses the user's
  `~/.bun/bin/bun` through `scripts/lib/proofBun.ts` before it creates its rig:
  `bun run` can otherwise select another Bun from an ancestor npm `.bin`.
  The runtime child receives termination signals and returns its exit code.
- **It skips, with one line each**, a leg that spends a real model, needs
  the person away, or opens an app other than TC Probe. Those legs are the
  hand runs below.
- **Off its host** it prints `skipped: <why>` and exits 0; its exit is the
  verdict.
- **A Mac row waits its turn** (scripts/lib/proofOrder.ts `otherProof()`:
  no older computer proof running, within its cap), sets `TC_PROOF_UNGATED=1`
  itself (TC Probe's window is never key and takes no keystrokes, so nothing
  it opens can come forward or take input), and fails without Accessibility,
  naming the grant and the app that holds the session: TempCode.app when the
  Publish button runs it. A publish from a terminal needs that terminal
  granted, or the rows fail by name. Without Screen Recording a row asks for
  no picture and seeds its own instance with `computer.prompted.screenRecording`,
  so no prompt can go out; its picture checks read skipped.
- **A proof leaves no scratch process behind.** After its turn arrives,
  `scripts/lib/computerProofProcesses.ts` ends leftover TC Probe copies and
  proof-owned `tc-computer` services (including lock holders). New services
  carry `TEMP_CODE_COMPUTER_PROOF=1`; older gate services carry
  `TC_PROOF_UNGATED=1` or the bridge's scratch HOME. The sweep excludes the
  installed TempCode service and descendants of another live proof. An
  orphaned scratch app never blocks the turn order. Every proof cleans up
  in `finally`, even when launch fails before returning a pid; probe cleanup
  matches all copies of its binary, including `/private/tmp` spellings.
- **A bridge call may wait for the Mac.** The proof waits at most two minutes
  per call, logging the load/cap standing while held; at the bound it fails
  with that standing and cleans up its isolated hosts. `session.markStatus`
  creates a synthetic turn with no harness, so the missing-harness sweep
  leaves it running until the proof settles it. The normal liveness check
  still stops a real turn whose harness is gone.
- **A locked or sleeping screen at entry** skips the four screen rows;
  a read failure skips them too. A proof that loses the screen after it
  starts still fails as inconclusive: its checks did not run whole.
- **Three greens.** A proof joined the gate only after three green `--gate`
  runs in a row on each host it runs on (the sweep of 2026-11-09, below).

| row | lane | host | boots | `--gate` leaves out | box | Mac | cap |
| --- | --- | --- | --- | --- | --- | --- | --- |
| e2e-addons | `e2e` | both | two paired headless instances, fake MCP servers | leg 4, the real claude-haiku-5-5 thread on this user's HOME | 22 s, 20 s, 22 s | 23 s, 22 s, 22 s | 12 min |
| e2e-addon-grants | `e2e` | both | two paired headless instances, scripts/lib/fakeOAuthServer.ts | nothing (no model) | 133 s, 134 s, 134 s | 134 s, 134 s, 134 s | 17 min |
| e2e-skills-store | `e2e` | both | two paired headless instances | nothing (no model) | 13 s, 15 s, 15 s | 13 s, 13 s, 13 s | 11 min |
| e2e-skills-drivers | `e2e` | both | one headless instance, the real CLIs against scripts/lib/spikeFakes.ts | the real-model legs (`--host box\|mac`) | 10 s, 10 s, 10 s | 29 s, 28 s, 29 s | 12 min |
| e2e-tc-computer | `computer` | Mac | the service and TC Probe (three instances: plain, `--windows`, `--fallbacks`) | the TextEdit legs and the paste | n/a | 19 s, 19 s, 19 s, measured before the fallbacks leg (docs/computer-protocol.md §24.11), whose time is not yet measured: its first run failed at step 3 on the proof's own expectation (§24.9), and the fixed leg is not run, the Mac was locked (2026-11-10) | 11 min |
| e2e-computer-bridge | `computer` | Mac | two headless instances (the box half seamed linux), the service, TC Probe | the SSH pair | n/a | 28 s, 29 s, 28 s, measured before the timing leg (ten interleaved pairs of three kinds, judged by `BRIDGE_TIMING_RULE`: box minus Mac at most 40 ms median and 100 ms p90, the box's own legs at most 25 ms median), whose time and numbers are to measure: the Mac was locked (2026-11-10) | 12 min |
| e2e-computer-preview | `computer` | Mac | the service and TC Probe | leg 4, the Escape tap, which takes the person's Escape | n/a | 24 s, 23 s, 23 s | 12 min |

The four store rows run one at a time in the `e2e` lane after the fence;
the three Mac rows run before `computer-bench` in its lane, so a cheap
failure stops the gate before the models run. A row's cap is the build wait
plus three times its slower host's time, rounded up to the minute
(`proofCap`, `STORE_MEASURED_MS` and `COMPUTER_MEASURED_MS` in
scripts/gate.ts).

The drivers row judges the store's skill reaching each CLI and a rewrite
reaching the next turn, and that Claude and Codex never list a home skill.
Muse Code 1.4.14 lists skills from other harnesses' home folders
(`~/.agents/skills`, `$CODEX_HOME/skills`): the row prints that as
`KNOWN GAP` without failing, and fails with `KNOWN GAP CLOSED` once Muse
stops, so the check is made strict then. e2e-addons' leg 8 times the codex
first-turn gate with and without add-ons wherever codex is installed: on the
box (codex 0.163.0, `~/.npm-global/bin/codex`) the medians were 517 ms with
add-ons and 516 ms without.

### The sweep of 2026-11-09

Each row above was green three times in a row on each host it runs on (the
store rows on the box and the Mac, sparse-PATH runs among them; the Mac rows
on the reviewed tip, after the screen unlocked). On the box `bun run gate
--tier all --skip typecheck,vitest` passed three times (205 s, 218 s,
218 s). The Mac's one whole `bun run gate --tier publish` stopped after 37 s
on a fault the gate found: under the full tier's process count, `ps -axwwE`
passed spawnSync's 1 MiB buffer, so e2e-addons failed, and the thrown error
carried every process's environment into the step's log. scripts/lib/procScan.ts
now allows 64 MiB and fails with the error code alone; e2e-addons then passed
three times on the Mac (22 to 23 s). The whole tier was not run again, and so
the soak check (a soak failing its CPU bound beside the `e2e` lane) is not
measured: the board soak was stopped, not judged, and the Mac then locked
with the person away. The `e2e` lane stays beside the soaks, the layout the
person chose; if a soak breaks its CPU bound beside it at a publish, the
store rows move behind the soaks in the build lane.

## Hand runs

The proofs the gate cannot run: each spends a real model, needs the person
away from the Mac, or drives an app other than TC Probe. Run each by hand
after a change it covers. "Last" is the sweep of 2026-11-09 unless it says
otherwise.

| proof | host | needs | last time | last result |
| --- | --- | --- | --- | --- |
| `script:e2e-addons` (whole) | box | a Claude login on this user's HOME | 42 s | passed, 46 checks |
| `script:e2e-skills-drivers -- --host box` | box | real Claude, Codex and Muse logins | 75 s | passed, 21 checks, codex 0.163.0 included; Muse's catalog listed 51 home skills on the real HOME (the known gap) |
| `script:e2e-skills-drivers -- --host mac` | Mac | the same, codex 0.164 or newer | about 155 s | passed, 18 checks, 3 skipped (the warm leg: an isolated instance on the Mac routes Claude through the installed app's shim) |
| `script:spike-config-dirs -- --host box` | box | the CLIs (a probe, rerun after a CLI update) | 109 s | 27 ok, 10 partial, 2 fail, 1 skip; the secret sweep clean |
| `script:spike-config-dirs -- --host mac` | Mac | the same | 298 s | 26 ok, 11 partial, 2 fail (C2a found no credential to start a turn, X5 no custom-prompt expansion), 1 skip (M0b needs `--upstream`); the secret sweep clean |
| `script:e2e-harness-sync` | box | none | 8 s | failed 3 of 40: its expectations predate Codex regenerating `.codex/skills/.system` and Muse writing `serve-exit.jsonl` in the scratch HOME; the fix is the drivers build's |
| `script:e2e-computer-images` | box | real Claude and Codex turns (a fake service) | 82 s | passed, 8 cases |
| `script:e2e-computer-images` | Mac | the same on the real service | — | not run: the Mac was locked, the person away (2026-11-09) |
| `script:e2e-tc-computer` (whole) | Mac | 5 idle minutes (TextEdit and the paste come forward) | — | not run: the Mac was locked, the person away (2026-11-09) |
| `script:e2e-computer` | Mac | real Sonnet turns | — | not run: the Mac was locked, the person away (2026-11-09) |
| `script:e2e-computer-bridge` over SSH | Mac and box | both clones built at one commit | — | not run: the Mac was locked, the person away (2026-11-09); its timing leg (the full mode: a call without a picture adds at most the run's own round trip plus 40 ms, median; pictures reported with their bytes and the upload rate) is to measure |
| `script:e2e-computer-ax` | Mac | the person away; IntelliJ only with `TC_AX_INTELLIJ=1` | — | not run: the Mac was locked, the person away (2026-11-09) |
| `script:e2e-computer-input -- --session` | Mac | the person away | — | not run: the Mac was locked, the person away (2026-11-09) |
| `script:e2e-computer-capture -- --keep <dir>` | Mac | Screen Recording; minutes of watch scenes on its own inert windows | — | not run: the Mac was locked, the person away (2026-11-09) |
| `script:e2e-computer-schedule` | Mac | the session tier: its scratch TextEdits come forward | — | not run: the Mac was locked, the person away (2026-11-09) |
| `script:e2e-person-guard` | Mac | a person at the keys, an unlocked screen; its two scratch TextEdits come forward | — | not run: built 2026-11-10 with the Mac locked; it records the drop window, the HID idle reading after a dropped key and `rearmed` for docs/computer-protocol.md §14.9 |
| `script:e2e-computer-preview` (whole) | Mac | it takes Escape for about two seconds | 3 s | inconclusive: the Mac locked before its live legs (2026-11-09) |
| `script:e2e-computer-ui` | Mac | a real Sonnet thread, 5 idle minutes | — | not run: the Mac was locked, the person away (2026-11-09) |
| `script:compare-computer-words` | Mac | real model runs; the scratch windows come forward | 23 min for the 48 runs, then the policy check (the instructions build's run, 13:35 to 13:58 UTC, not repeated) | Opus 5.5 and Muse Wonder 1.0 passed every task on both words, GPT-6.1 Sol two of three; the cua words ship for Anthropic and OpenAI, the anthropic words for Meta (docs/computer-protocol.md §19.6) |
| `script:measure-front-guard` | Mac | 5 idle minutes, aborting at the person's first input; TextEdit, Chrome (scratch profile), Finder, Calculator and IntelliJ come forward | about 2 min after the idle wait | 2026-11-10, ungated, the person away: Finder and Calculator ran and never raised; TextEdit, Chrome and IntelliJ skipped because the person's own copies were running (docs/computer-protocol.md §23.9) |
| `script:e2e-computer-bench` | Mac | "The bench's hand run" below | | |
| `script:e2e-computer-bench -- --set field [--host box \| --reference codex] --round <r>` | Mac (the box run needs the branch's built clone on the box, `TC_BOX_CLONE`, and SSH) | the field suite (docs/computer-protocol.md §21.7): 14 tasks × 3 models, real turns; the person away, `TC_BENCH_UNGATED=1` as their leave (the session-tier tasks take the pointer); Chrome, TextEdit, Calculator, Finder; roughly 30–60 min per host run | — | not yet run: built 2026-11-10, after the field test; judge the three saved reports with `--judge-field` on any host |

## The computer bench

`computer-bench` runs `bun run script:e2e-computer-bench -- --gate`
(scripts/e2e-computer-bench.ts, judged by scripts/lib/computerBench.ts;
docs/computer-protocol.md "The benchmark"): real desktop tasks through the
computer tools and `tc-computer`, one real thread per task on each of
`claude-opus-5-5`, `gpt-6.1-sol` and `muse-wonder-1.0`, the three lanes side
by side. Every end state is read through the accessibility tree or the file
system, never the model's word.

- **The person keeps the Mac.** The gate runs in the background tiers alone
  (`ax`, `process`), which never take the screen, the pointer or the
  keyboard. A scratch app launches only after 5 s with no input, and one
  that comes forward is sent back at once; a run that leaves it in front
  fails. A task whose end state needs the session tier is skipped and kept
  for the hand run, and so is the System Settings task while System
  Settings is open.
- **What fails.** A task's end state; its median computer calls above
  max(1.5 × baseline, baseline + 2); its median host time per call above
  max(1.3 × baseline, baseline + 150 ms) (`BENCH_RULE`). A run that goes off
  route (any tool but the computer tools, `ToolSearch`, `update_notes`,
  `TodoWrite`, `update_plan`) or past its step budget fails its end state. A
  gate task the bench's own budget never reached fails, unless the scheduler
  held the runs. Wall time, think time, screenshots, tiers and tokens are
  reported, never judged.
- **Reruns.** One run per task; a run that breaks the rule earns two more,
  and then the end state must pass in two of three, the medians over the
  three.
- **Never failed**: a lane whose model this Mac cannot run, a task skipped
  (the session tier, System Settings open, the person never pausing 5 s
  before a launch), a thread the scheduler held queued past 5 minutes.
- **Ungated** (`TC_BENCH_UNGATED=1`, the person's leave for a hand run):
  no idle wait before a launch, the front not judged; a locked or dark
  screen still holds a launch.
- **One proof at a time**: a run waits while an older computer proof runs on
  the Mac (one started first; two never wait on each other), at most 30
  minutes and never past the step's budget, else it is skipped.
- **A locked or dark screen** skips a `--gate` run at entry. Other runs
  hold each launch: AX sees no windows then.
- **The baseline** is `<git-dir>/temp-code-gate/computer-bench/baseline.json`
  in the checkout that publishes, one row per model, task and task version.
  A gate run that finds no baseline at all passes with "no baseline, first
  run writes it" and writes the rows of the tasks that passed; after that a
  gate run writes the rows it lacks only when green. A row of another task
  version is ignored, so a changed task starts over; `--rebaseline` replaces
  the rows of every task that passed. A file that exists but cannot be read
  fails the step, naming its path and `--rebaseline`. `--report-only` and
  `--judge <report.json>` never write it.
- **Time.** About 6 minutes, in its own `computer` lane beside the build,
  the sign and the soaks; the script stops itself at 14 minutes
  (`BENCH_TIMING.budgetMs`) and the gate kills it at 15. Its report is the
  step's log, and `last.json` and `runs/` beside the baseline.

## The bench's hand run

A record the judge never reads. On 2026-11-09 (macOS 27.2, M4 Max, load 6
to 9, `TC_BENCH_UNGATED=1`) one gate run finished whole in 511 s, and the
`--runs 3 --report-only` table finished every Opus and GPT-6.1 Sol task
before the Mac was yielded to another proof. Then the Mac locked with the
person away, and the person decided to land. **Not run: the Mac was locked,
the person away**:
`TC_BENCH_UNGATED=1 bun run script:e2e-computer-bench -- --runs 3 --report-only`,
the second `--gate`, `--reference codex` and `bun run gate --tier publish
--only computer-bench`.

| Task | claude-opus-5-5 | gpt-6.1-sol | muse-wonder-1.0 |
|---|---|---|---|
| textedit-write | 4/4, 2 calls, 760 ms a call | 0/5, no call | 0/1, Reminder |
| chrome-read | 0/6, the check's read missed the page | 0/4, no call | 0/1, Reminder |
| chrome-form | 0/6, status null; took the front | 0/6, no call | not reached |
| chrome-delete | 0/6, status null; took the front | 0/6, no call | not reached |
| devapp-form | 4/4, 8 calls, 845 ms a call | 0/6, no call | 0/4, Reminder |
| settings-toggle | 2/2, 4 calls, 910 ms a call | 0/2, no call | 0/4, Reminder |
| save-dialog | 0/6, target unchanged; over budget | 0/6, no call | 0/4, Reminder |

The run's faults are fixed since: GPT-6.1 Sol never reached a tool (codex
refused the rig's plain-http gateway; the rig now stops it), Muse's own
reminder child counted as off route, an ungated run judged the front, and the
check's read of a background Chrome came back without its page (now read
again while thin, not yet proven on the Mac). `save-dialog` moved to the
session tier. There is no baseline yet: the first gate run writes it from what
passes, and passes with "no baseline, first run writes it". The plan's
Findings (`.temp-code/plan-bXciwrVNLfYK.md`) has the rest.

## The command

```
bun run gate [--tier commit|publish|all] [--since <ref>] [--full]
             [--only a,b] [--skip a,b] [--verbose]
```

- Steps in one lane run in array order, one at a time; lanes run at once.
  `commit` has three lanes (typecheck, vitest, build), so the three run
  together; the bundle-size check (scripts/check-bundle-size.ts, which
  reads `out/`) follows the build in its lane. `publish` runs the fence, the hub, the three Swift packages and the
  computer bench in parallel lanes; `ios`, `ios-client` and `computer-swift`
  share the `swift` lane, one after another (the client package depends on
  the contract package), and `computer-bench` has the `computer` lane alone.
- On a terminal one status line shows what is running and for how long; in
  a log (the hook's /tmp/temp-code-auto-release.log) each step prints
  `HH:MM:SS › name` when it starts and `HH:MM:SS ✓ name 12s passed` when it
  ends, then a per-step table.
- A step with an outer limit names it as `capMs`, its hard cap from its
  start: past it the gate kills the step's process group (SIGTERM, then
  SIGKILL 5 s later) and fails it, `✗ computer-bench  900s  failed  passed
  its 15m cap`. The four soaks have 12 minutes (the 10 they may wait for the
  build, their 90 s, and teardown) and computer-bench 15.
- The first failure stops the gate: nothing more starts, the running steps
  are killed (their whole process group), and the report marks them
  `stopped`, the rest `not run`, and prints the failed step's last 60 lines.
  Every step's full output is in `<git-dir>/temp-code-gate/logs/<step>.log`
  (`.git/temp-code-gate/` in the main checkout, `.git/worktrees/<name>/
  temp-code-gate/` in a worktree); `last-run.json` beside it has the times.
- Children get a plain environment: the hook's `GIT_*` variables are
  stripped (they made every git command in a test act as the hook's own
  commit), `NO_COLOR=1`, and `NODE_ENV=test` for vitest.

## Caches

- **typecheck** is skipped when the tree hash of its inputs equals the one
  stored by the last green run in `<git-dir>/temp-code-gate/typecheck`. The
  inputs are every tracked or untracked `*.ts`, `*.tsx`, `*.json` and the
  generated Swift under `ios/TempCodeContract/Sources/TempCodeContract/
  Generated/` (the Swift contract check compares against them): the index's
  blob id for a clean file, the file's own hash for a modified one, the path
  for a deleted one. `--full` runs it regardless, and the hash is stored
  only when typecheck itself passed.
- **vitest** runs one bounded forks pool (vitest.config.ts: four forks on
  Linux, half the cores on the Mac): the box shares one pids budget, counted
  in threads, across every thread's test runs, and the default pool (a fork
  per core, 31 on the box) could not spawn its workers under the cap and
  exited 1 with nothing printed (2026-10-27). The gate's step adds the JSON
  reporter beside the default one (`<git-dir>/temp-code-gate/logs/vitest.json`)
  and reads it when the exit and the output disagree (scripts/gate.ts
  `judgeReport`): a reporter that died before its summary after a green run
  passes the step, a red report names its failures when nothing was printed,
  no report with no output says the workers never started, and an output
  that ends in vitest's own summary keeps its exit (the JSON `success`
  counts failed tests alone, never an unhandled error).
- **vitest** keeps its cache in `node_modules/.vite/vitest`; the gate never
  passes `--no-cache` or clears it.
- **The Xcode** for `ios` and `ios-client` is scripts/ios-xcode.sh's pick
  (the highest-versioned `/Applications/Xcode*.app`, `TC_XCODE_MIN=0` for
  the packages; `DEVELOPER_DIR` passes through), the same picker the
  simulator proof and the device build use with a 27.1 minimum.
- **SwiftPM** keeps each package's `.build` (gitignored); `ios:test` runs
  `swift build` then `swift test` incrementally, and the gate never cleans
  them.

## Measured times

Wall time of each step, run once alone. The Mac is the user's laptop that
runs the hook (Apple M4 Max, 48 GB, macOS 27.2; numbers over the Mac bridge
from a detached worktree at origin/master d5787ec on 2026-10-21; the link
dropped on every longer call after that, so the other cells say so rather
than guess). The box is the Linux agent
host (32 cores, 123 GB), shared with a dozen other threads' builds while
these ran, so its numbers moved by up to 40 % between runs.

| step | Mac cold | Mac warm | box | cap | notes |
| --- | --- | --- | --- | --- | --- |
| typecheck | 11.2 s | 10.8 s | 25 s | | skipped by the hash when no input changed |
| vitest | 18.9 s | 18.6 s | 33 s | | box: gateway.test.ts is the one known Linux failure |
| build | not measured (link dropped) | | 156 s | | electron-vite build into out/ |
| bundle-size | | | under 0.1 s | | reads out/bundle-map.json after the build |
| e2e-remote-fence | not measured (link dropped) | | 2.4 s | | node, not Electron: boots the server in-process |
| hub | not measured (link dropped) | | n/a | | infra/hub's npm install writes nothing on the box; Mac only |
| ios | 12 s (earlier note in release.ts) | 2 s (same note) | n/a | | SwiftPM, Mac only |
| ios-client | not measured (link dropped) | | n/a | | SwiftPM plus a live test server, Mac only |
| renderer-soak | 64.1 s, 64.6 s (2026-11-01, a fresh clone) | 62.6 s, 63.1 s | 62 s by hand | 12 min | Mac only; a 50 s window inside its 90 s |
| renderer-soak-chat | about 63 s (2026-11-02, by hand) | | 62 s by hand | 12 min | Mac only; the same window, after the board scene |
| renderer-soak-typing | 47.8 s, 55.4 s (2026-11-05, a fresh clone) | | 62 s (2026-11-05, load 34) | 12 min | Mac only; its phases, after the chat scene |
| renderer-soak-scroll | not measured (no Mac linked) | | about 40 s (2026-11-05, load 86) | 12 min | Mac only; four surfaces, after the typing scene |
| e2e-addons | 22 s (2026-11-09, three runs) | | 20 to 22 s alone; 55 to 60 s in the gate, the build wait included | 12 min | the `e2e` lane after the fence; the real-Claude leg skipped |
| e2e-addon-grants | 134 s (three runs) | | 133 s | 17 min | the same lane, after e2e-addons |
| e2e-skills-store | 13 s (three runs) | | 12 to 15 s | 11 min | the same lane |
| e2e-skills-drivers | 28 to 29 s (three runs) | | 10 s | 12 min | the same lane, last; the real CLIs against fakes |
| e2e-tc-computer | 19 s (three runs) | | n/a | 11 min | Mac only; the `computer` lane, before the bench |
| e2e-computer-bridge | 28 to 29 s (three runs, before the timing leg; with it, to measure) | | n/a | 12 min | Mac only; both halves on the Mac |
| e2e-computer-preview | 23 to 24 s (three runs) | | n/a | 12 min | Mac only; the Escape leg skipped |
| computer-bench | 511 s, one run (2026-11-09, ungated, before the codex route fix; failed: see "The bench's hand run") | | n/a | 15 min | Mac only; three model lanes in its own lane, beside the build |

The box's share of the publish tier with the store rows (2026-11-09,
`bun run gate --tier all --skip typecheck,vitest`, three runs: 205 s, 218 s
and 218 s): the build (41 s) and bundle-size beside the `e2e` lane, whose
store rows waited on `build.done` and then took about 3.5 minutes one after
another (e2e-addon-grants 133 s of it); before them the box's publish tier
was the fence's 2 s.

With the three commit lanes at once on the box, vitest finished at 42 s
and typecheck at 43 s while the build was still running, so the commit
tier's wall time is the build's: about 2.5 minutes on the box, against
3.5 minutes for the three in a row. On the Mac the commit tier is bounded
by the build as well, with typecheck (11 s) and vitest (19 s) inside it.

Before this change the hook ran all seven steps one after another on every
commit; the iOS packages and the fence proof now wait for publish, or for a
commit that touches what they guard. Re-measure with `bun run gate --tier
all --full` on the Mac and read `.git/temp-code-gate/last-run.json`.

The publish tier alone on the Mac (2026-10-21, the same M4 Max at a load
of 15 from other work, a fresh clone with `infra/hub` installed): 22 s,
with the fence 3.9 s, hub 12 s, ios 4.0 s and ios-client 18 s in their
lanes; 37 s on a colder run (fence 3.1 s, hub 4.1 s, ios 12 s, ios-client
25 s). Beside the electron-vite build it took 59 s. With the store and
computer rows, the Mac's whole publish tier is not measured yet (2026-11-09:
its one run stopped at e2e-addons' fixed process-scan fault, "The sweep of
2026-11-09" above). The rows' own times add about 3.5 minutes to the `e2e`
lane and about 70 s before the bench in the `computer` lane, both beside the
build lane's soaks.

## The publish, phase by phase

`bun run release:publish` (scripts/release-publish.sh) prints one line per
phase (`phase ✓ gate 59s`; the parser is src/shared/releasePhases.ts) and
the app's publish job counts them for the master board. Before 2026-10-21
the script ran the publish gate, then electron-builder's build + sign +
zip + dmg, then notarization, then the ShipIt-style check, then the
upload, one after another, and the installed app noticed on a 30-minute
poll. Now the gate runs beside the build, the box tarball is packed and
uploaded while the app is signed, there is no dmg and no notarization
unless asked, the bundle leaves `ios/`, `infra/` and `docs/` out, and the
app that ran the script fetches the release the second it lands.
Before the gate and build, the `install` phase runs `bun install --frozen-lockfile`
unless the SHA-256 of `bun.lock` matches `node_modules/.tc-installed-lock`, which the
publish script writes only after a successful install.

| stretch | before (button to a running app) | now | measured how |
| --- | --- | --- | --- |
| publish gate (fence, hub, ios, ios-client) | 1 to 3 min, before electron-builder | 48 s, beside the build (22 to 37 s alone) | `--dry-run` on the Mac, 2026-10-21 |
| electron-vite build + bundle-size | inside electron-builder's 4 to 6 min | 55 s beside the gate (26 s alone) | same |
| sign (one electron-builder `--mac zip` call: pack + codesign, 37,000 files, then the zip, latest-mac.yml and the blockmap) | inside the 4 to 6 min, with `ios/` in the bundle | 2m2s to sign plus 38 s to zip (311 MB) as two calls on 2026-10-21; one call since 2026-10-22 | same |
| pack the box tarball | after the build, in line | 2 s, beside the sign (10.9 MB) | same |
| notarization | 3 min on a good day, 35 on a bad one | none (`--notarize` brings it back) | |
| ShipIt-style check | 1 to 2 min with the dmg mount | seconds, against /Applications/TempCode.app | same |
| upload | zip + dmg + tarball, 2 to 5 min | zip + blockmap + latest-mac.yml; the tarball went up earlier | not run in a dry run |
| feed check | 5 s sleep + one fetch | the same | |
| the installed app noticing | up to 30 min, then a click to download | at once: the script's own app fetches it (`phase ✓ update`), a box deploy pushes `release-available`; the poll is 5 min | GitHub served the 1.0.277 zip at 70 MB/s here: 311 MB in about 5 s |
| total, trigger to "Restart to update" | about 45 to 70 min | 3m51s to the end of the ShipIt check, plus the upload and the app's own download | the dry run's `phase ✓ total 3m51s`, 2026-10-21 |

Three things the dry runs found on the way. The script once signed with
`--dir` and zipped with `--prepackaged`: electron-builder writes
`Contents/Resources/app-update.yml`, the feed config electron-updater
reads at every check, in an afterPack hook that runs only when the pack's
targets include zip or dmg, so 1.0.278 shipped without it and the
installed app failed every check with ENOENT. The two calls are one
`--mac zip` call now, the ShipIt-style check refuses a zip without the
file, and a bundle that still lacks it sets the github feed itself
(update.ts). Before that, electron-builder took `--prepackaged` as the
path to the `.app` itself: given its folder, the zip carried a
`mac-arm64/` level and ShipIt would have found no app (the script's own
check refused it). And the bundle used to carry the whole
`ios/` tree: the gate's SwiftPM `.build` output is thousands of files
that electron-builder copied in and signed one by one, so a signing of
2m7s on a clean clone became 11m35s with the gate's output beside it, and
the zip 312 MB to 381 MB (the published 1.0.277 zip was 425 MB for the
same reason). electron-builder.yml now leaves `ios/`, `infra/` and
`docs/` out.

The proofs: `bun run script:e2e-updater` (two signed, un-notarized copies,
check → download → restart over CDP) passed against this script's output
on 2026-10-21; `scripts/release-publish.sh --pack-only` and `--dry-run`
ran green on a fresh clone of master at 1.0.277.
