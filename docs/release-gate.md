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
| `publish` | e2e-remote-fence, hub, ios, ios-client | before signing in `release:publish`; and in the hook when a commit touches a guarded path. hub, ios and ios-client are `mac: true`: a host off macOS (the box's merge gate) skips them with a note, since `release:publish` runs them on the Mac before anything ships |

Guarded paths (`TIER_PATHS`): `ios/**`, `scripts/gen-swift-contract.ts`,
`src/shared/wireSchemas.ts`, `src/shared/contract*.ts`,
`src/main/server/remote/**`, `infra/hub/**`, `scripts/e2e-remote-fence.ts`,
`scripts/ios-*`. The train runs `gate --tier commit --since release-N`
(N from release.json; `HEAD~1` when the tag is missing), and any changed
path since that ref that hits the map pulls its tier in, so a contract change
still cannot land stale Swift between publishes. A proof that boots an
instance belongs in `publish`.

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
- **vitest** keeps its cache in `node_modules/.vite/vitest`; the gate never
  passes `--no-cache` or clears it.
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

With the three commit lanes at once on the box, vitest finished at 42 s
and typecheck at 43 s while the build was still running, so the commit
tier's wall time is the build's: about 2.5 minutes on the box, against
3.5 minutes for the three in a row. On the Mac the commit tier is bounded
by the build as well, with typecheck (11 s) and vitest (19 s) inside it.

Before this change the hook ran all seven steps one after another on every
commit; the iOS packages and the fence proof now wait for publish, or for a
commit that touches what they guard. Re-measure with `bun run gate --tier
all --full` on the Mac and read `.git/temp-code-gate/last-run.json`.
