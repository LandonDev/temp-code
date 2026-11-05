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
| `commit` | typecheck, vitest, build, bundle-size | in the post-commit hook, on every commit on master |
| `publish` | renderer-soak, renderer-soak-chat, renderer-soak-typing, e2e-remote-fence, hub, ios, ios-client | before signing in `release:publish`; and in the hook when a commit touches a guarded path. The three soaks, hub, ios and ios-client are `mac: true`: a host off macOS (the box's merge gate) skips them with a note, since `release:publish` runs them on the Mac before anything ships |

Guarded paths (`TIER_PATHS`): `ios/**`, `scripts/gen-swift-contract.ts`,
`src/shared/wireSchemas.ts`, `src/shared/contract*.ts`,
`src/main/server/remote/**`, `infra/hub/**`, `scripts/e2e-remote-fence.ts`,
`scripts/ios-*`. The train runs `gate --tier commit --since release-N`
(N from release.json; `HEAD~1` when the tag is missing), and any changed
path since that ref that hits the map pulls its tier in, so a contract change
still cannot land stale Swift between publishes. A proof that boots an
instance belongs in `publish`.

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

## The command

```
bun run gate [--tier commit|publish|all] [--since <ref>] [--full]
             [--only a,b] [--skip a,b] [--verbose]
```

- Steps in one lane run in array order, one at a time; lanes run at once.
  `commit` has three lanes (typecheck, vitest, build), so the three run
  together; the bundle-size check (scripts/check-bundle-size.ts, which
  reads `out/`) follows the build in its lane. `publish` runs the fence, the hub and the two Swift packages in
  parallel lanes; `ios` and `ios-client` share the `swift` lane because the
  client package depends on the contract package.
- On a terminal one status line shows what is running and for how long; in
  a log (the hook's /tmp/temp-code-auto-release.log) each step prints
  `HH:MM:SS › name` when it starts and `HH:MM:SS ✓ name 12s passed` when it
  ends, then a per-step table.
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

| step | Mac cold | Mac warm | box | notes |
| --- | --- | --- | --- | --- |
| typecheck | 11.2 s | 10.8 s | 25 s | skipped by the hash when no input changed |
| vitest | 18.9 s | 18.6 s | 33 s | box: gateway.test.ts is the one known Linux failure |
| build | not measured (link dropped) | | 156 s | electron-vite build into out/ |
| bundle-size | | | under 0.1 s | reads out/bundle-map.json after the build |
| e2e-remote-fence | not measured (link dropped) | | 2.4 s | node, not Electron: boots the server in-process |
| hub | not measured (link dropped) | | n/a | infra/hub's npm install writes nothing on the box; Mac only |
| ios | 12 s (earlier note in release.ts) | 2 s (same note) | n/a | SwiftPM, Mac only |
| ios-client | not measured (link dropped) | | n/a | SwiftPM plus a live test server, Mac only |
| renderer-soak | 64.1 s, 64.6 s (2026-11-01, a fresh clone) | 62.6 s, 63.1 s | 62 s by hand | Mac only; a 50 s window inside its 90 s |
| renderer-soak-chat | about 63 s (2026-11-02, by hand) | | 62 s by hand | Mac only; the same window, after the board scene |
| renderer-soak-typing | 47.8 s, 55.4 s (2026-11-05, a fresh clone) | | 62 s (2026-11-05, load 34) | Mac only; its phases, after the chat scene |

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
25 s). Beside the electron-vite build it took 59 s.

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
