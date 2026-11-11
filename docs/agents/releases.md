# Releases: the local train tags, `release:publish` ships

Two separate steps, on purpose, over one gate.

- **The gate is `bun run gate`** (scripts/gate.ts): one `STEPS` array, each
  step tagged `commit` or `publish`, and one `TIER_PATHS` map in the same
  file. `--tier commit|publish|all` picks the tier; `--since <ref>` adds
  the tiers that the paths changed since `<ref>` pull in; `--full` forces
  everything; `--only a,b` / `--skip a,b` / `--verbose` for a hand run.
  - `commit`: typecheck, vitest, the electron-vite build and, after it in
    the same lane, the bundle-size check (scripts/check-bundle-size.ts).
    `publish`: renderer-soak, renderer-soak-chat, renderer-soak-typing and
    renderer-soak-scroll (the build lane, after the build, one after the
    other; Mac only), e2e-remote-fence, hub:test, ios:test, ios:test:client,
    computer:test (native/tc-computer, the computer-use service's package),
    the store proofs e2e-addons, e2e-addon-grants, e2e-skills-store and
    e2e-skills-drivers (the `e2e` lane after the fence, one at a time, two
    headless instances each, both hosts), and in the `computer` lane (Mac
    only) e2e-tc-computer, e2e-computer-bridge and e2e-computer-preview on
    TC Probe, then computer-bench (the computer task benchmark,
    `onlyAtPublish`: never when changed paths alone pulled the tier into a
    commit's hook). Each proof row runs its script entry with `--gate`
    ("Add-ons", "Skills" and "Computer use" below). A step's `capMs` is its
    hard cap, past which the gate kills it and fails it "passed its cap":
    the soaks 12 minutes, the bench 15, a proof row the 10-minute build
    wait plus three times its measured time (`proofCap`). A proof that
    boots an instance belongs in `publish`.
  - The build barrier: a run that selects `build` removes
    `<git-dir>/temp-code-gate/build.done` at its start, touches it once
    bundle-size passes and names it to every step as
    TEMP_CODE_SOAK_BUILD_DONE, so no proof reads an `out/` the build is
    rewriting (a retry at the same HEAD finds last run's valid stamp
    there). A proof waits through scripts/lib/gateBuild.ts
    `waitForGateBuild`: the done file when one is named, else HEAD's stamp
    in out/bundle-map.json, 10 minutes at most. It never builds; the soaks
    alone build a stale tree on a hand run.
  - Steps in one lane run in array order, one at a time; lanes run at
    once (typecheck, vitest and build + bundle-size together), with a combined status
    line on a terminal and `✓ step 12s` lines plus a per-step time table
    in a log. The first failure stops the rest; the failed step's log
    tail is printed and every step's full output is in
    `<git-dir>/temp-code-gate/logs/<step>.log`, the times in
    `last-run.json` beside it. docs/release-gate.md has the measured
    times on the Mac and the box.
  - Publish rows e2e-tc-computer, e2e-computer-bridge, e2e-computer-preview
    and computer-bench need the screen: the gate checks once on macOS and
    skips them if locked, asleep or unreadable; computer-swift still runs.
    Direct `--gate` runs also skip with exit 0 before work; run the skipped
    proofs by hand when unlocked (scripts/lib/macScreen.ts).
  - vitest runs one bounded forks pool (vitest.config.ts: four forks on
    Linux, half the cores on the Mac; the box's pids budget counts threads)
    and the gate's step writes the JSON report beside its log and reads it
    when the exit and the output disagree (`judgeReport` in scripts/gate.ts;
    docs/release-gate.md).
  - Caches: vitest keeps node_modules/.vite/vitest and SwiftPM each
    package's `.build`; the gate never cleans either. typecheck is skipped
    when no .ts/.tsx/.json (or generated Swift) file changed since the
    last green run, by a hash of that set stored in
    `<git-dir>/temp-code-gate/typecheck`; `--full` runs it anyway.
  - The path map: a commit touching `ios/**`, scripts/gen-swift-contract.ts,
    src/shared/wireSchemas.ts, `src/shared/contract*.ts`,
    `src/main/server/remote/**`, `infra/hub/**`, the fence proof, the iOS
    runners, `native/tc-computer/**`, `src/shared/computer/**`, the computer
    generator, the add-on, skills and computer host code
    (`src/main/server/{addons,skills,computer}/**`, the store files, the
    add-on host's process and spawn, src/shared/addons.ts, skills.ts and
    `addonGrant*.ts`, museConfigDirs.ts, the app-tools bridge) or their
    proofs and helpers pulls the `publish` tier into the hook as well, so a
    contract change still cannot land stale Swift. The drivers stay out:
    nearly every commit touches them.

1. **Every green commit tags locally.** A post-commit hook on master
   (.githooks/, wired via core.hooksPath) runs `bun scripts/release.ts`
   after every commit: it gates on a clean tree + `gate --tier commit
   --since release-N` (the commits since the last release decide whether
   the `publish` tier joins), bumps release.json to N and package.json to
   `1.0.N`, commits both, and tags `release-N`, using your commit subject
   as the release notes. That is bookkeeping: no user sees it. With nothing
   new since `release-N` (HEAD is the tagged commit, or only release
   bookkeeping follows it; scripts/releaseCheck.ts) it prints "nothing to
   release since release-N" and exits 0 with no bump, commit or tag.
   - If the hook skipped (tree was dirty at commit time, or the gate was
     red), the next green commit releases everything since; you can also
     run `bun scripts/release.ts "notes"` yourself (`--full` to run the
     typecheck the hash would skip). `--notes-file <path>` in the notes'
     place reads them from a file: the batch's release step and the
     Publish button pass theirs that way, since Linux refuses one argv or
     environment string over 128 KiB (a batch of forty landings once failed
     with `spawn E2BIG`).
   - Worker log: /tmp/temp-code-auto-release.log, with the per-step times.
   - Never commit with a broken typecheck "to fix later" — that blocks the
     train.
   - Commit messages carry no `Co-Authored-By` or other AI attribution
     trailers: GitHub renders them as a second contributor on every commit.
     `.claude/settings.json` turns the trailer off; do not add one by hand.
2. **`bun run release:publish` publishes HEAD's 1.0.N** (scripts/
   release-publish.sh): the fast path, about five minutes on the Mac. A
   clean tree on master; master and the `v1.0.N` tag pushed and a draft
   release opened first (its notes are the commit subjects since the last
   `v1.0.*` tag, newest first, cut at whole lines to 100,000 characters
   with "… and N more commits since vPREV" last: scripts/lib/release-notes.sh,
   since GitHub refuses a body over 125,000); then `gate --tier publish` runs BESIDE the
   electron-vite build (they share nothing; a red gate still stops the
   upload and deletes the draft; `GATE_SKIP=1` only to retry a failed
   upload). Before either starts, the `install` phase runs `bun install --frozen-lockfile`
   unless the SHA-256 of `bun.lock` matches `node_modules/.tc-installed-lock`, written only
   after a successful install. ONE electron-builder call (`--mac zip`, the `sign` phase)
   packs, signs with the Developer ID Application identity in the login
   Keychain and zips, writing `Contents/Resources/app-update.yml` (the
   feed config electron-updater reads; electron-builder writes it only in
   a pack whose targets include zip or dmg, so a `--dir` pack plus a
   `--prepackaged` zip ships an app that fails every update check with
   ENOENT, as 1.0.278 did), latest-mac.yml and the blockmap; and the box's
   `temp-code-out-1.0.N.tar.gz` + `.sha256` (scripts/release-pack-out.sh:
   the same `out/`, package.json with `tempcodeBuild.sha`, release.json,
   bun.lock, scripts/box, a build-manifest.json) is packed from `out/` the
   moment the build is done and uploaded to the draft while the app is
   still being signed. The zip is checked the way Squirrel's ShipIt will
   (against /Applications/TempCode.app when it is there) and refused
   without an app-update.yml naming github LandonDev/temp-code; a bundle
   that still lacks the file sets that feed itself (update.ts
   `applyFeedFallback`, `feedFallback` in updateInstall.ts). Then the zip (and
   its blockmap), latest-mac.yml and the tarball are the whole upload, the
   draft goes live, the feed is verified. One line per phase with its
   duration (`phase › gate`, `phase ✓ gate 1m11s`, `phase ✗ build 12s`,
   `phase – gate skipped`, `phase ✓ total 4m12s 1.0.N`; the parser is
   src/shared/releasePhases.ts; the phases are gate, build, sign, pack,
   upload and feed). Not notarized by default: Squirrel
   validates an update against the installed app's designated requirement,
   so the signature is what makes updates install, and Gatekeeper reads a
   notarization ticket only on a quarantined (browser-downloaded) bundle.
   `--notarize` (or `TEMP_CODE_NOTARIZE=1`) notarizes through the `aliax`
   notarytool Keychain profile, checked only then; `--dmg` (or
   `TEMP_CODE_DMG=1`) builds and uploads the dmg too, for a fresh install;
   both for a release someone else will download. `--dry-run` runs every
   local phase with its timing on any commit and pushes, releases and
   uploads nothing; `--pack-only [dir]` is the tarball alone. It refuses a
   version the feed already serves. Apple silicon only; Intel is out of
   scope for now. The box's `box-update v1.0.N` lays that tarball in
   instead of building (docs/box.md "Build once"). docs/release-gate.md
   has the phase times.

3. **Both are buttons in the app too, still pressed by the user** (Settings →
   Hosts: a box's Deploy row and This Mac's Release group;
   src/main/server/hostJobs.ts, src/shared/contract-host.ts,
   src/renderer/src/surfaces/settings/hosts/Deploy.tsx).
   Publish… on This Mac's Mac release row runs `bun scripts/release.ts
   --notes-file <tmp>` (the notes in a file under the tmp dir, named by
   `TC_RELEASE_NOTES_FILE` and removed when the scripts close; a peer's
   publish with the train off carries no notes) then `bun run
   release:publish` through the login shell in the
   checkout the `release.checkout` setting names (default
   ~/IdeaProjects/temp-code, the field beside the button), the notes
   prefilled from the commit subjects since the last `v1.0.*` tag; it refuses
   a dirty tree, a branch other than master and a version the feed already
   serves before starting, and the scripts' own refusals come through as the
   log's last lines. The log folds open under its row (last 40 lines,
   following, Stop kills the scripts' process group; one line once it passed). When the script
   exits green the Publisher adds the `update` phase itself: the installed
   app it runs in fetches the version the total line names (`selfUpdate`)
   and the log ends `phase ✓ update 31s` once "Restart to update" is there,
   `phase – update skipped (current)` on a dev instance or an old version.
   `host.publish*` is local-only: no key ever reaches it. "Deploy master…" on a
   box's Deploy row is `host.deploy` (admin, over the box's link) and the root-owned
   trigger of docs/box.md "Deploy from the app"; its confirm names the
   versions ("v1.0.270 → v1.0.273, 3 releases").

The batch publish peer modules are `remote/peerPublish.ts` (box) and
`remote/macPublish.ts` (Mac), with the `publish` offer and `publish.start` /
`publish.stop` contract in `src/shared/contract-publish.ts`. The box has
already cut and pushed the release: the Mac fetches origin, pulls the named
branch with `--ff-only`, checks HEAD against the requested SHA and HEAD's
package.json against the requested `1.0.N`, then calls
`Publisher.publish(notes, { train: false })`. That mode runs only
`bun run release:publish`; the button still cuts then publishes. Progress
streams over `peer.progress`, the call returns the exit and a one-line
outcome ("Published 1.0.N in 4m12s"), and Stop kills the Publisher's
process group. Only a saved host whose caller id matches the link may ask.
The box picks the thread's live bridge peer with the offer, else the sole
registered publisher; a dropped link fails the call. The batch engine
(batch.ts) drives it as the `publish` step; `batch.stopStep` stops it. When
the master thread lives on the Mac the same engine runs there: the publish
step is `LocalPublish` (macPublish.ts, the same `run` with no link) and the
deploy step reaches the box as `host.deploy` + `host.log` over the Mac's
link (`remote/peerDeploy.ts`, which re-asks the log when the link comes
back after the box restarted into the new build). A green publish, or a
green deploy of a v1.0.N, is announced (src/main/server/releaseAnnounce.ts):
the box pushes `release-available { version }` down every registered Mac's
socket and the Mac's updater fetches it; on the Mac the announcer is the
local updater itself.

Never build into or swap /Applications/TempCode.app yourself: the installed
app replaces itself from the feed, and only from the feed.
