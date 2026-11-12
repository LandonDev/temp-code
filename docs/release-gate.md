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

The `computer` lane starts only once the `build` lane has finished
(`LANE_AFTER` in scripts/gate.ts), so the four renderer soaks and the
computer rows never share the screen: the soaks open windowed instances that
come forward and quit, and v1.0.340 and v1.0.341's publishes failed
e2e-tc-computer with a soak window over TC Probe (2026-11-11). The other
lanes still run beside the soaks; a soak that fails leaves the computer rows
not run. The cost is the soak lane's length, measured on the Mac in a
publish-shaped run (the soak and computer rows of `--tier publish`, a scratch
clone, 2026-11-11): the soaks took 202 s (63, 63, 47 and 29 s), and the
computer rows then reached the end of e2e-computer-preview at 507 s, against
308 s for the same rows side by side, 199 s more, about the soak lane's own
202 s. Three such runs on 2026-11-11 (507, 414 and 515 s) were not green: the
soaks passed each time; e2e-tc-computer passed in the first and third with one
flake each named by the rerun (fewer 3, then web: a refused select), and the
second failed fewer 3 on both tries beside a web flake. The bridge passed in
the first and failed its away check in the third, and the preview failed its
4 ± 1 fps in the first, each with the soaks done and the person's full-screen
window over TC Probe.

With TC Probe floating (computer-protocol.md §15, "The live proofs"), the
selection notices (§7) and the guard's order undo waiting for the step's
own input (§23.3), three publish-shaped runs followed on 2026-11-11 at
a384f5aa (then 410b51c0 and its neighbours on master), the computer lane
after the soaks, load 5 to 26: the first passed whole in 676 s (soaks 202 s,
e2e-tc-computer 194 s, bridge 85 s, preview 24 s at 4.00 fps, computer-bench
169 s, no flakes); the second passed every row but the preview, whose one
VOID was the person's pointer moving during the run (its frame rate read 4.00
fps); the third failed e2e-tc-computer's active leg, active 9 (save_as) and
then active 4 (a pop-up's menu noted in the closing read) on its rerun, at a
load of 26 with the person at the Mac. Those last two were not run again: the
person was in a call with the camera on, and the proofs, which float TC Probe
over the screen, were held.

At 26ceaf74 (the cover check ignoring the Dock by owner name; the Dock's
window read as owner "Dock", pid 742, layer 20), three publish-shaped runs in a
row passed whole with no flake on 2026-11-11: 666 s, 685 s and 657 s, load 4.3
to 12.8, each the four soaks, e2e-tc-computer (194 to 196 s), the bridge, the
preview (4.00 fps) and computer-bench. The full `--tier publish` in the
scratch clone then ran four times: the first stopped at hub, since the clone
had no infra/hub dependencies (`npm --prefix infra/hub ci`; the person's
checkout has them from an install by hand); the second passed 15 of 17 rows
and the preview voided two checks while the person moved the pointer (the
preview now runs once more when it only voided checks, `needsVoidRerun`); the
third failed e2e-addons' "ready again within 5 s" at 5115 ms with the load at
179 from another app's build; the fourth passed every row before
e2e-tc-computer, which failed active 9 on both tries: after save_as, a session
step, TC Probe kept the front from the person's app (Aside), though the front
hold read restored. So the full publish gate in the scratch clone was not
green in its four tries: the last failed e2e-tc-computer's active 9 (save_as)
on both tries, TC Probe keeping the front from the person's app, and that is
not traced yet. The real v1.0.343 publish gate then passed whole on the Mac.

Active 9 (save_as) failed twice in full publish gates on 2026-11-11 with "the
scratch app kept the front" from the person's Aside. The trace: save_as's
Go to Folder confirm runs at `session` (725 ms on the session lock), and its
put-back, `restoreSession`, took the lock for 2 ms and activated nothing,
since the person was at the Mac (a call) and the ledger gives the front app
back only when nobody used the Mac since the step (§20.3, computer-protocol.md
26.7). With nobody at the Mac the same put-back activates the person's app at
once; runs that passed had also leaned on macOS handing the front back as the
panel's service closed. The proof now follows a call that touched the session
tier with `input.restoreSession` as the host does, voids and reruns at once a
check whose put-back gave way to the person, and still fails a scratch app left
in front with no input; the put-back tries a missed activation once more. The
active leg alone then passed three times in a row at e2ea05ac plus the fixes
(37 checks each, active 9 at `session` with the person untouched, TextEdit's
save_as and ⌘S and Finder's rename and New Folder at the front and session
tiers each putting the person's app back), with the person at the Mac between
runs and Aside, Chrome for Testing and Finder in front at their ends. No
such rerun has run yet, and as written it cannot pass: the first save_as of
active 9 (and of TextEdit 1) goes again to the file the first try wrote,
without `replace`, so it refuses with `file_exists` and the check fails red.

The rows `e2e-tc-computer` and `e2e-computer-bridge` start through
`scripts/proof-bun.ts`: `bun run` puts every ancestor's node_modules/.bin on
PATH, so the package script's `bun` can be any old copy (a 1.3.5 in
`~/node_modules/.bin` on the person's Mac, with no `node:sqlite`). The
launcher runs the proof under the first of `~/.bun/bin/bun`, the running
Bun, `/opt/homebrew/bin/bun` and `/usr/local/bin/bun` that loads
`node:sqlite` (`sqliteProofBun` in scripts/lib/proofBun.ts), and fails by
name when none does.

The four rows `e2e-tc-computer`, `e2e-computer-bridge`,
`e2e-computer-preview` and `computer-bench` also have `screen: true`.
When the selection includes a screen row, the gate checks the Mac's screen
once before starting any lane. A screen saver that needs no password is not a
lock (src/shared/screenState.ts): the check dismisses it (`caffeinate -u`, as a
key press) and reads again for up to 3 s (`readyMacScreen`,
scripts/lib/macScreen.ts); a dark display is woken only when the app's Keep
awake setting is While threads work (`TEMP_CODE_KEEP_AWAKE`). A locked,
still-sleeping or unreadable screen skips those rows with
`skipped  the Mac is locked or asleep; run it by hand when unlocked`;
`computer-swift` still compiles and tests. The check uses the proof's
CoreGraphics rule in a tiny Swift binary cached in the gate's log dir
(1.8 s compile cap, at most 400 ms to read, sharing a 1.95 s budget), and on a
covered session reads the idle time and `sysadminctl -screenLock status`.
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
  a read failure skips them too. A passwordless screen saver does not: it is
  dismissed and the rows run. Until 2026-11-11 every check read the session's
  `CGSSessionScreenIsLocked` as a lock, and it is true while any saver is up:
  a whole night of rows said "not run: the Mac was locked" on a Mac that needed
  no password and never slept. A proof that loses the screen after it
  starts still fails as inconclusive: its checks did not run whole.
- **One rerun for an e2e-tc-computer leg** (scripts/lib/legRerun.ts), under
  `--gate` only: a leg with a failed step runs once more from a clean launch,
  judged by the same checks. The row stays green only when every step the
  first run failed passes on the rerun; those failures are then flakes, named
  in report.json (`flakes`, `reruns`), on `flake:` lines in the step's log,
  under the gate's row and in last-run.json. A rerun that fails a step, or
  skips or never reaches the one that failed, is red. A hand run never
  reruns: its first failure stands. e2e-computer-preview has its own rule
  (`needsVoidRerun`): under `--gate`, a run whose only shortfalls are voided
  checks runs once more at once and names them as flakes when that passes; a
  failed check never reruns, and a rerun that voids again stays red.
- **Three greens.** A proof joined the gate only after three green `--gate`
  runs in a row on each host it runs on (the sweep of 2026-11-09, below).

| row | lane | host | boots | `--gate` leaves out | box | Mac | cap |
| --- | --- | --- | --- | --- | --- | --- | --- |
| e2e-addons | `e2e` | both | two paired headless instances, fake MCP servers | leg 4, the real claude-haiku-5-5 thread on this user's HOME | 22 s, 20 s, 22 s | 23 s, 22 s, 22 s | 12 min |
| e2e-addon-grants | `e2e` | both | two paired headless instances, scripts/lib/fakeOAuthServer.ts | nothing (no model) | 133 s, 134 s, 134 s | 134 s, 134 s, 134 s | 17 min |
| e2e-skills-store | `e2e` | both | two paired headless instances | nothing (no model) | 13 s, 15 s, 15 s | 13 s, 13 s, 13 s | 11 min |
| e2e-skills-drivers | `e2e` | both | one headless instance, the real CLIs against scripts/lib/spikeFakes.ts | the real-model legs (`--host box\|mac`) | 10 s, 10 s, 10 s | 29 s, 28 s, 29 s | 12 min |
| e2e-tc-computer | `computer` | Mac | the service, TC Probe (five instances: plain, `--windows`, `--fallbacks`, `--active`, `--fewer`) and scratch Chrome for Testing (`webLeg`) | the TextEdit legs and the paste | n/a | 19 s, 19 s, 19 s, measured before the fallbacks leg (docs/computer-protocol.md §24.11), the web leg (§25.11), the active leg (§26.15), the fewer leg (§27.15) and the stealer (§23.9). At d24b29c7b the whole row ran 91 s and failed fallbacks 3, the web page wait and active 1 (.temp-code/findings/computer-gate-proofs-2026-11-10.md). On 2026-11-11, with the person at the Mac: the base steps, the window leg (16.3 s), the fallbacks leg (28.6 s), the fewer leg (14.9 s) and the web leg (27.3 s) passed whole. Later that day, with the fewer leg's probe under the person's front window, the fewer leg (7 steps, 14.4 to 18.6 s) and the stealer (6 steps, 7.2 to 8.0 s) passed whole in five of six runs; the sixth failed the stealer's launch at a 642 ms restore while another agent's scratch TC Probe activated (computer-protocol.md §23.9, §27.15); the active leg passed whole, 20 of 20 in about 70 s (§26.15: `save_as` confirms Go to Folder at `session`, Finder's rename commits through its own editor; every front hold 94–477 ms, restored). By hand: `TC_PROOF_UNGATED=1 TC_PROOF_LEGS=<leg> bun run script:e2e-tc-computer -- --gate` ("The unattended proof modes") The final check (2026-11-11, 387f2be8 with three fixes: the web scroll's effect, Chrome's late front after the launch, ScreenCaptureKit's unanswered window list): the whole row passed twice in a row, 193 to 201 s (base 19.8 s, windows 17.0, fallbacks 26.7, web 33.3, active 69.8, fewer 14.3, stealer 8.7 s), the TextEdit legs skipped as hand runs. Under load (2026-11-11, 55351169, the first build of its InputEngine change, on a scratch clone, with `yes` holding the 1-minute load at about 20 to 25 to match v1.0.339's publish, which failed active Finder 2 at load 17 to 32): three runs in a row passed whole, 83 passed and 10 hand-run skips each, 200 s, 202 s and 209 s, load 18.9 to 45.0 (a 30 s overshoot as the first run began), 19.9 to 24.7 and 20.2 to 25.5; active Finder 2 took 1987, 2286 and 2281 ms. | 11 min |
| e2e-computer-bridge | `computer` | Mac | two headless instances (the box half seamed linux), the service, TC Probe | the SSH pair | n/a | 95 s original timing run; 96 s for 60/60 before the schema rebase; 90 s for 59/60 after it (one stale note check, since corrected); 90 s for 60/60 at 652f9dac with the gate-r2 fixes (2026-11-11); under load at 55351169 (2026-11-11), 60/60 in 293 s, load 18.2 to 40.1 (21.2 at the start, 18.5 at the end): the two instances' start lifted the load past 32, so the product's load admission (twice the 16 cores) held its threads six times; added p50/p90 4/24 ms observe, -9/23 ms observe-shot, 8/35 ms set-value, within the gate bound | 12 min |
| e2e-computer-preview | `computer` | Mac | the service and TC Probe | leg 4, the Escape tap, which takes the person's Escape | n/a | 24 s, 23 s, 23 s; 24.7 s for 17/17 at 7e6d5588 with the ScreenWatch import fixed (2026-11-11; computer-protocol.md "The live proofs on the Mac"); under load at 55351169 (2026-11-11), 17/17 in 27 s, load 20.6 to 23.3 | 12 min |

Bridge timing on loopback, added p50/p90 ms for observe, with a picture,
and `set_value`, respectively: the original run measured 3/19, 9/24,
10/42; the pre-schema 60/60 run measured 13/32, 14/29, 2/33; the
post-schema 59/60 run measured 4/11, 2/28, 9/25; the 2026-11-11 60/60
run measured 1/21, 5/31, −13/29. All four timing legs
passed the unchanged +40/+100 ms bound. The one stale check expected the
remote note on every tool; the corrected proof requires it on
`computer_apps` alone. Later attempts on that fix stopped after 45 passes
in a load hold, then finished 56/60 under high load (timing and three cap
checks failed). Those failures remain recorded. On 2026-11-11 the row
passed 60/60 in 90 s at 652f9dac with the gate-r2 fixes.
[computer-protocol.md §18](computer-protocol.md#18-the-bridge) lists every
run, timing table and evidence folder.

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
| `script:e2e-computer-bridge` over SSH | Mac and box | both clones built at one commit | — | SSH full mode has not run; its bound is the run's own round trip plus 40 ms median without a picture, with picture bytes and upload rate reported. The separate loopback `--gate` timing passed on 2026-11-10: added p50 3–10 ms, p90 19–42 ms; 95 s overall |
| `script:e2e-computer-ax` | Mac | the person away; IntelliJ only with `TC_AX_INTELLIJ=1` | — | not run: the Mac was locked, the person away (2026-11-09) |
| `script:e2e-computer-input -- --session` | Mac | the person away | — | not run: the Mac was locked, the person away (2026-11-09) |
| `script:e2e-computer-capture -- --keep <dir>` | Mac | Screen Recording; minutes of watch scenes on its own inert windows | — | not run: the Mac was locked, the person away (2026-11-09) |
| `script:e2e-computer-schedule` | Mac | the session tier: its scratch TextEdits come forward | — | not run: the Mac was locked, the person away (2026-11-09) |
| `script:e2e-person-guard` | Mac | a person at the keys, an unlocked screen; its two scratch TextEdits come forward | — | not run: built 2026-11-10 with the Mac locked; on 2026-11-11 not run again, since it asks the person to type words on cue in a terminal and the run had no terminal with them (the in-gate person checks of e2e-tc-computer did run, §27.15); it records the drop window, the HID idle reading after a dropped key and `rearmed` for docs/computer-protocol.md §14.9 |
| `script:e2e-computer-preview` (whole) | Mac | it takes Escape for about two seconds | 3 s | inconclusive: the Mac locked before its live legs (2026-11-09) |
| `script:e2e-computer-ui` | Mac | a real Sonnet thread, 5 idle minutes | — | not run: the Mac was locked, the person away (2026-11-09). Since 2026-11-11 it reads the title-bar cue and the Computer section (its session row, the frames and marks on the viewport, its steps) in place of the Activity row; the new selectors have never run |
| The Computer section, by eye | Mac | a real thread using TextEdit with the panel open on Computer | — | not run (built 2026-11-11 on the box, nothing run on the Mac): the frames, the click ring, steps landing, Stop, Go live, a step pinned by a click and by the arrow keys |
| The journal's kept picture | Mac | the real service, Screen Recording on | — | not run (2026-11-11): that `capture.screenshot` with a whole-window region leaves the coordinate space alone (a coordinate click right after it lands where it should), what it costs a call, and what a minimized window, a window on another Space and a browser tab give |
| A box thread's history | Mac and box | a box thread driving the Mac through the bridge | — | not run (2026-11-11): its steps and pictures in the Mac's Computer section, the bridge's timing line as it was |
| A held session-tier step in the section | Mac | the person at the Mac, so the step waits | — | not run (2026-11-11): the held line beside the card, Run now, Esc |
| `script:compare-computer-words` | Mac | real model runs; the scratch windows come forward | 23 min for the 48 runs, then the policy check (the instructions build's run, 13:35 to 13:58 UTC, not repeated) | Opus 5.5 and Muse Wonder 1.0 passed every task on both words, GPT-6.1 Sol two of three; the cua words ship for Anthropic and OpenAI, the anthropic words for Meta (docs/computer-protocol.md §19.6) |
| `script:measure-front-guard` | Mac | 5 idle minutes, aborting at the person's first input; TextEdit, Chrome (scratch profile), Finder, Calculator and IntelliJ come forward | about 2 min after the idle wait | 2026-11-10, ungated, the person away: Finder and Calculator ran and never raised; TextEdit, Chrome and IntelliJ skipped because the person's own copies were running (docs/computer-protocol.md §23.9) |
| `TC_PROOF_SET=perf bun scripts/ios-sim-proof-local.ts` | Mac | Xcode and an iPhone 17 Pro simulator of its own (`TC_SIM_UDID`); headless, so no idle wait unless Simulator.app is already open; nothing else measuring beside it; `TC_PERF_APP` and `TC_PERF_BASELINE` for the frame gates' baseline | 7 min a pass | 2026-11-11: three passes of master against three of the baseline app, in turn; the six gates that are on pass in every pass (load-only, bodies-per-batch, refolds, rows-built, keystroke-bodies, scale); the others miss their targets and stay off (docs/IOS-DESIGN.md "Performance", "Measured"). A run now and then writes "the transcript did not load" on either app and measures when run again alone |
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
  keyboard. A scratch app launches only after 5 s with no input; for 3 s
  after its launch the person's app and window are put back by pid each
  time it comes forward (never by bundle id, which a second Chrome or an
  Electron shares); a run that leaves it in front fails. Codex threads run
  with the person's plugins off (`TEMP_CODE_CODEX_PLUGINS=off`), so their
  own computer use (`cua_repl`) is not in the thread. A task whose end state needs the session tier is skipped and kept
  for the hand run, and so is the System Settings task while System
  Settings is open.
- **What fails.** A task's end state; its median computer calls above
  max(1.5 × baseline, baseline + 2); its median host time per task (the
  sum over a run's computer calls) or per action step (a batch of n counts
  n, an observe one) above max(1.3 × baseline, baseline + 150 ms)
  (`BENCH_RULE`), both judged. A row written before 2026-11-11 holds only
  per-call figures, so its task figure is its calls times its host ms per
  call and its step figure its host ms per call (`baseHost`); a new row
  stores both. A run that goes off
  route (any tool but the computer tools, `ToolSearch`, `update_notes`,
  `TodoWrite`, `update_plan`) or past its step budget fails its end state. A
  gate task the bench's own budget never reached fails, unless the scheduler
  held the runs. Wall time, think time, screenshots, tiers and tokens are
  reported, never judged.
- **Reruns.** One run per task; a run that breaks the rule earns two more,
  and then the end state must pass in two of three, the medians over the
  three.
- **Never failed**: a lane whose model this Mac cannot run (a Muse lane
  whose host withholds the app's MCP server is one, named by its preflight:
  computer-protocol.md §21.2), a task skipped
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
- **v1.0.338's publish, 2026-11-11.** The row failed in 500 s on the
  rig's own faults; the product's background route was not one of them (a
  solo devapp-form run took the front 0 times in 2, and every failed
  step was `ax`). Runs that "took the front · 0 calls, 0 s" were the
  rig's launch: it checked the front once after a fixed sleep and put the
  person back by bundle id, which another lane's scratch Chrome or
  Electron shares, and with the lanes side by side it often saved such an
  app as the person's (now `keepFrontAfterLaunch`, by pid and window, the
  person's front tracked across lanes). GPT-6.1 Sol's "off-route: js" was
  the person's Codex computer-use plugin in the thread (`cua_repl.js`;
  now `TEMP_CODE_CODEX_PLUGINS=off`). Opus's "the delete ran unflagged"
  was the check reading Claude's first, empty row of the call
  (`callRecords`). Muse 1.4.15 withholds the app's MCP server in a
  workspace it does not trust, so its threads had no computer tool and
  spent their runs on Bash until the budget ran out; its lane is now
  skipped by its preflight, named in the report. The scratch Chrome now
  launches with the web leg's switches. The baseline was not touched.
  Then two `--gate` runs in a row on a scratch clone at origin/master
  9a47aec4 plus the fix (1fae26a29 on master) passed: 219 s and 167 s, Opus 5 of 5
  tasks and GPT-6.1 Sol 5 of 5 each time, no run took the front (3
  launches per model put back each time), Muse skipped by its preflight,
  settings-toggle skipped (System Settings open) and save-dialog the hand
  run's.
- **Under load and after it, 2026-11-11 (55351169, a scratch clone, the
  baseline copied in and restored before each run).** Two `--gate` runs
  failed one cell, GPT-6.1 Sol chrome-form's median host ms per call
  against 1134 (the row's 872, from 7 calls on 2026-11-09): 1636 at load
  19.9 to 51.3 (26.2 at the start; `yes` holding about 20 to 25, the
  bench's own start pushing past 50 for 30 s) in 165 s, and 1634 at load
  5.1 to 6.9 with no generator in 166 s. Every end state passed both
  times, no run took the front and nothing else failed; settings-toggle was
  skipped (System Settings open) and save-dialog left for the hand run.
  The cause was the model's call shape, not load or a slower host: GPT now
  does the form as an observe and one batch of five or six actions (the
  batching of computer-protocol.md §27), often with the final click inside,
  so a two-call run's median per call is the mean of the observe (494 to
  803 ms) and the batch (2461 to 3117 ms loaded, 2657 to 2837 ms unloaded),
  while its host time for the whole task fell to about 3.3 s from the
  row's 6.1 s (7 × 872). So the master, ruling in the person's place on
  2026-11-11, replaced the per-call cell with two, both judged, the margins
  unchanged: host ms per task and host ms per action step. Per step alone
  would not do: its fixed 150 ms floor counts for more against a smaller
  unit, so a 500 ms observe and a batch of five slowed from 1000 to 1500 ms
  passes per step (300 against 975) and fails per task (2000 against 1950).
  The baseline was not re-recorded; its rows' task and step figures come
  from their per-call ones. Against the 7-call row the two-call shape has
  room for about twice its host time per task until a green run writes a
  row of its own shape. Judged by the new rule, the two red runs pass
  (GPT chrome-form 3920 and 3268 ms a task against 7935, 492 and 451 ms a
  step against 1134), and two `--gate` runs in a row at a6c07ccaf with no
  generator passed whole: 179 s at load 7.1 to 9.3 and 192 s at load 4.5
  to 7.8, Opus and GPT-6.1 Sol every task they ran, GPT chrome-form 3260
  and 4183 ms a task, 457 and 506 ms a step, none taking the front, Muse
  skipped by its preflight, settings-toggle skipped (System Settings open),
  save-dialog the hand run's, the person's baseline copied in before each
  and left as it was.
- **Can the publish load it?** The gate's lanes run at once
  (scripts/gate.ts) beside the build and the sign (release-publish.sh), and
  the bench is the computer lane's last row, after e2e-tc-computer (200 to
  255 s), the bridge (90 s) and the preview (25 s). In v1.0.339's publish
  the other lanes were done within 255 s (the soaks 255 s, the e2e lane
  255 s, the Swift lane 79 s) and the sign ends about 3.5 minutes in, so
  the bench starts on a Mac the publish has mostly left: its report's
  `load1` read 6.5 in v1.0.338's publish and 8.4 and 6.8 in the two gate
  runs after its fix (16.1 for the run that wrote the baseline). Load a
  sibling thread brings (a simulator boot reached 100 to 400 the same
  morning) is not the publish's.
- **A gap it does not cover**: the person's own Chrome, covered by their
  windows, may show the service no page, since no launch switch reaches a
  Chrome they started and Chrome 156 builds no page tree for an outside
  reader while covered (computer-protocol.md §25.10 M2). The one lever
  the service has, `AXEnhancedUserInterface`, built the tree once in two
  tries and changes how the app's windows move for the person, so it stays
  unset; the field run (§21.7) measures that case.

## The web proof and covered field run

`bun run script:e2e-tc-computer -- --gate` runs `webLeg` after the fallbacks leg. The `--fewer` leg (docs/computer-protocol.md §27.15) runs on TC Probe's `--fewer` window: a pop up's item picked by `named`, `menu: "Probe > New Note"` following the new window, a rename by Return, a no-change click stopping the keys after it, and the opened-menu block, one call each. On 2026-11-11 it passed in 14.9 s (computer-protocol.md §27.15 has each step). `scripts/lib/chromiumForTests.ts` uses `TEMP_CODE_TEST_CHROMIUM` (an app bundle path), else Chrome for Testing in `~/Library/Caches/ms-playwright`. If absent it records `skipped: Chrome for Testing is not installed (bunx playwright install chromium)`. It installs nothing.

The leg launches three local tabs on its own profile with `--disable-backgrounding-occluded-windows --disable-renderer-backgrounding --force-renderer-accessibility`, since the person's windows cover it and Chrome 156 then draws and builds no page (computer-protocol.md §25.10 C1, M2), after five seconds without input (at most 60 seconds waiting). It puts the saved front app and window back if launch took them. Reads and actions target the recorded pid; actions use `ax` and `process` only. The checks cover page wait, background-tab selection, 40 rows in one read, a 300-row table subtree, AX scrolling, field values, select pick and menu closure, refused values, the checkbox, the page's confirmation, and key focus. Each call checks the saved front app and window. Cleanup checks the exact profile argument before each signal and leaves other Chrome instances alone.

**Timing:** on 2026-11-11 the leg passed in 27.3 s on the Mac, with the person at it (computer-protocol.md §25.11 has each step). Each `web:` step records its elapsed milliseconds in `/tmp/tc-computer-proof/report.json`.

The covered hand run and its two-of-three bar are in [computer-protocol.md §21.7](computer-protocol.md#217-the-field-suite). Run both commands there on the Mac, with all three default field models. The next hand check also reruns `~/tc-cu-test/suite.py` T2/T3 from one box thread and one Mac thread (Opus 5.5, then GPT-6.1 Sol), under the idle gate, checking the report's staged data and form code. Record those live findings separately; this change supplies the rig, not those measurements.

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
| e2e-tc-computer | 19 s (three runs) | | n/a | 11 min | Mac only; the `computer` lane, before the bench; whole row 200, 202 and 209 s under load 19 to 25 (2026-11-11) |
| e2e-computer-bridge | 96 s, 60/60 before the schema rebase; 90 s, 59/60 after it (stale check since corrected); final commit not run: the Mac was locked; 293 s for 60/60 under load 18 to 40 at 55351169 (2026-11-11) | | n/a | 12 min | Mac only; both halves on the Mac; proof record in §18 |
| e2e-computer-preview | 23 to 24 s (three runs); 24.7 s on 2026-11-11; 27 s under load 21 to 23 | | n/a | 12 min | Mac only; the Escape leg skipped |
| computer-bench | 511 s, one run (2026-11-09, ungated, before the codex route fix; failed: see "The bench's hand run"); `--gate` passed twice on 2026-11-11 after the rig fix, 219 s and 167 s: Opus 5/5, GPT-6.1 Sol 5/5, took the front 0, Muse skipped by its preflight, baseline unchanged; on 2026-11-11 at 55351169 it failed GPT-6.1 Sol chrome-form's host ms per call twice, 1636 of 1134 at load 19.9 to 51.3 (165 s) and 1634 of 1134 at load 5.1 to 6.9 (166 s), every end state passing: the model's two-call shape, not load; with the cell made per task and per step, `--gate` passed twice in a row at a6c07ccaf, 179 s and 192 s at load 4.5 to 9.3 ("The computer bench") | | n/a | 15 min | Mac only; three model lanes in its own lane, beside the build |

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
