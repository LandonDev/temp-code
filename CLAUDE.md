# temp-code — instructions for AI sessions

## One line: prod runs the newest published GitHub release
- `/Applications/TempCode.app` runs the newest `v1.0.N` release on
  github.com/LandonDev/temp-code (public). It updates itself through
  electron-updater: at launch, every 5 minutes, and when a window comes
  forward after 15 idle minutes it reads the feed's latest-mac.yml, offers
  the release, downloads only when asked, and restarts on request. A
  release it is TOLD about skips the wait: the Publish button's script
  exiting green inside the app, or the box's `release-available` push over
  the peer link after its deploy, makes it fetch that second and offer
  "Restart to update" (src/main/update.ts `selfUpdate`, the rules in
  updateTrigger.ts: a version it already runs or holds is ignored, and
  nothing installs without the restart click). Its data
  lives in `~/Library/Application Support/TempCode/` (`dev:prod` still runs
  on the older `temp-code/` dir).
- Nothing reaches users until `bun run release:publish` runs (see below).
  Every green commit on master is still tagged locally, so commit only
  finished, verified slices: the next publish ships everything since.
- `stable` is a pointer the updater no longer reads; it is moved onto
  master at each cutover (`git branch -f stable master`) and otherwise
  left alone. The pre-MonoCode line (v96) lives on in the reflog only.

## The user lives in the installed app — never touch it
Do not launch anything against the prod userData (that means never
`bun run dev` without TEMP_CODE_USER_DATA, and never `bun run dev:prod`
from an AI session), do not send messages into the user's threads, and
do not kill or restart the installed app.

## Testing: spawn an isolated dev instance
```bash
env -u ELECTRON_RUN_AS_NODE \
  TEMP_CODE_USER_DATA="$HOME/Library/Application Support/temp-code-dev" \
  TEMP_CODE_DEBUG_PORT=9224 bun run dev
```
- Own database, own window; CDP on 9224 for driving and screenshots
  (`window.__app` exposes the store in dev builds). A fresh userData starts
  with an empty rail, wherever it was launched from: add the folder with
  Add workspace….
- These are ENFORCED in code: a dev build without TEMP_CODE_USER_DATA
  exits immediately (it would open the installed app's database — a
  second SQLite writer there freezes the user's live threads), and each
  userData dir takes a single-instance lock. If several sessions test at
  once, each needs its OWN userData dir and debug port (temp-code-dev2 /
  9226, …).
- `env -u ELECTRON_RUN_AS_NODE` is required — the variable leaks into
  agent shells and breaks Electron.
- Renderer must be on port 5173; a different port means a stale dev
  server from another session is holding it. Kill it (`pkill -f
  electron-vite`) and relaunch — electron-vite never restarts the main
  process on its own, so main-process changes always need a relaunch.
  When another app's dev server holds 5173 (lifeos sits on `[::1]:5173`,
  and the window would load it in the renderer's place), set
  `TEMP_CODE_RENDERER_PORT=5177` (electron.vite.config.ts: that port,
  strict) and check `document.title` over CDP before trusting the window.
- Kill your dev instance when the pass is done.
- Updater end to end: `bun run script:e2e-updater` (scripts/e2e-updater.ts)
  builds two signed, un-notarized copies of the tree (1.0.N-1 and 1.0.N) with
  their own bundle id and product name, serves the newer one from a local
  feed, and drives the older copy under /private/tmp/tc-updater-e2e through
  check → download → restart over CDP (port 9230) until the bundle on disk
  is 1.0.N and the relaunched app answers. The hooks it uses:
  `TEMP_CODE_UPDATE_FEED=<url>` makes a packaged copy that also has
  `TEMP_CODE_USER_DATA` read a generic feed (latest-mac.yml + zip) at that
  URL, with its downloads under `~/Library/Caches/temp-code-harness-updater`;
  and a `tempcodeHarness` block in the bundled package.json (electron-builder
  extraMetadata) carries the same three TEMP_CODE_* keys into an app that
  Squirrel's ShipIt relaunches without our environment (src/main/harness.ts).
  Its Squirrel state lives in `~/Library/Caches/dev.landon.tempcode.e2e.ShipIt`.
  Nothing of this touches /Applications/TempCode.app or its caches.

## Project preambles: the house rules once per project
- Every brief for a project used to open with the same rules (worktree,
  gate, merge rule, what never to touch, which skills to use for UI). They
  are a **preamble** now: markdown on the project row (`projects.preamble`,
  `preamble_enabled`) edited from the project header menu → "Preamble…"
  (src/renderer/src/chrome/PreambleDialog.tsx, a large dialog: the editor
  and its word count beside a live preview, the switch under both, the
  variables in one mono line with their meanings on tooltips), and a
  workspace default (`workspaces.preamble`, the workspace menu → "Preamble…")
  for projects without their own. A project switched off carries nothing,
  whatever the workspace says. RPCs `project.setPreamble` and
  `workspace.setPreamble` (admin). The temp-code workspace's default is
  seeded once from the old house-rules block (`HOUSE_PREAMBLE`,
  `seedHousePreamble` at boot; marker setting `preamble-seeded:house`), so
  a cleared default stays cleared.
- Application: `decidePreamble` (src/main/server/projectPreamble.ts) runs
  in `SessionRegistry.send` on the FIRST message of a thread in a project,
  which every start path ends in: the composer, plan → build,
  app_start_thread (including on another host), spawn_agent children
  (`preamble: false` on the spec opts a child out; a child of a parent that
  opened without one opens without one; a parent on another host is
  unknown, so its child follows the project), a thread started over the
  cross-host `thread.start`, and the phone's New thread. The harness reads
  `## Project rules` + the text + `## The task` + what the person wrote,
  after the thread instructions and the project context. `{{worktree}}` (a
  slug from the thread title, or the first line of an untitled thread's
  message), `{{project}}` and `{{host}}` (the machine name) are substituted
  then; an unknown `{{name}}` stays as written.
- Display: the user-text row keeps the person's text as `text` and the
  rules as `preamble: { text, words }` (the stamp), so the transcript shows
  the brief with "Project rules 212 words" (the lead medium) folded above it
  (src/renderer/src/surfaces/PreambleRow.tsx; click opens the text). The
  thread keeps the text it started with: edits reach new threads only, and
  a first message held back by a failed boot reaches the harness with the
  block its row carries (`store.firstUserPreamble`). The pure parts live in
  src/shared/preamble.ts; proof is src/main/server/projectPreamble.test.ts
  (one test per start path).

## The user dogfoods master on the prod data
`bun run dev:prod` runs master against the prod userData (CDP on 9220).
It is the user's command, not ours. The single-instance lock keeps it and
the installed app from running at once: quit one before opening the
other. Master only adds to the database (new tables, defaulted columns),
so the two apps can take turns on it. Unread marks and layout live in
localStorage, which differs by origin, so they do not carry across.

## Releases: the local train tags, `release:publish` ships
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

## UI standard: Kobra on Base UI, docs/DESIGN.md wins
- docs/DESIGN.md is the standard every renderer change follows and wins
  every conflict with a skill, a library default or a brief;
  `src/renderer/src/components/README.md` maps each class of UI element to
  the one component under `src/renderer/src/components/ui` that renders it
  (Kobra on Base UI, adapted flat to the tokens at the top of
  `src/renderer/src/index.css`, to `chrome/icons` and to the motion tokens;
  `StatusMark` is the one status vocabulary, drawn as two spans (the word
  medium in its tone, the detail regular and muted; `still` (working as a
  dot) for a line under a row that already spins, so a row has one moving
  mark), a plain
  string only as "Word: Detail" (`plainStatus`), never a run of spaces
  (`lib/spaceGuard.test.ts`), `threadStateOf` turns a wire
  status into its state; `TypeGlyph` (surfaces/threads/TypeGlyph.tsx) is
  the one coloured type glyph, each type's tint a `--type-*` token on the
  glyph alone, `THREAD_MENU_ICONS` its menu-row form, a test in
  threadTypes.test.ts refusing any other read of `THREAD_GLYPHS` and
  lib/typeTint.test.ts holding the tints to 3:1 and 30° from amber and red;
  sonner is the one toast stack, seated 8px above the
  focused thread's strip and inside its column (no wider than it less 16px
  a side, so a master's chat beside its board holds it), above the board's
  foot while a master's chat is folded, `toastInset` in
  components/ui/toaster.tsx). Nothing in
  src/renderer writes a literal colour, duration or curve, and no bullet
  lists appear in the UI. The motion guard has no application timing
  exceptions: CSS uses the motion tokens, JavaScript uses `lib/ease.ts`,
  the spinner's turn is `SPINNER_TURN`, the working mark's dots `MARK`, the
  working words' shimmer `SHIMMER` and the word morph `--dur-swap-out` and
  `--ease-swap` (`EASE_SWAP`), all in lib/ease.ts and the token layer.
  The springs are `SPRING_LAYOUT` and `SPRING_GLIDE`; a drag settles from
  where it is drawn with the pointer's speed (lib/drag.ts `releaseVelocity`,
  `rubber`). Every popup moves on transitions, its entry CSS `@starting-style`
  (Base UI sets no starting status on a popup mounted open), its exit
  `data-ending-style`; a dialog or sheet dims behind it with the `scrim`
  token. A plan, a board's plan and a report read at `AgentMarkdown`'s
  document size (15/24).
- Settings rows and sections use `components/page.tsx` (`PageRow`,
  `PageSection`), which pass native props and data attributes to their roots;
  Hosts exports these as `Row` and `Group` without copying their markup.
  A section's failure is `PageError` and its empty state `PageEmpty`, one
  line in a row's place (`lib/pageLineGuard.test.ts` refuses a hand-built
  one); its wait is `PageRowsSkeleton` in its rows' shape; a page reads its
  host through `useHostRead` (lib/connection/hostRead.ts: waits for the
  socket, a deadline, Retry, never a value made up from a failure); facts
  on one line are `Facts` (4px apart, commas between, `lib/factsGuard.test.ts`).
- Use `text-xs` for 12px. `lib/typeScaleGuard.test.ts` refuses the literal
  `text-[12px]` in renderer source.
- Every `overflow-y-auto` class string names its horizontal policy:
  `overflow-x-hidden` for lists or `overflow-x-auto` for content that needs
  both axes. `lib/scrollerGuard.test.ts` enforces this without exceptions.
- Cut text uses `TruncateTip`; fitted text mounts no tooltip trigger.
  It measures truncating text inside a status line too.
- Agent details use `ModelLine` before their host, branch and numbers.
  Queue effort names use `effortWord` from lib/models.ts.
- File headers, file previews and implementation tallies use `Counts` from
  `chrome/rail/changeRows.tsx`: sans, tabular numbers at the line's size,
  4px between values; it shares the transcript's numeric renderer.
- A busy button uses `BusyLabel` to hold both widths at rest.
  `lib/busyLabelGuard.test.ts` refuses bare Spinner children, including
  render slots; icon buttons keep their name on the button.
- Buttons and focus: the solid `Button` variants (default, secondary,
  destructive) are raised, Kobra's `t-raise` on the `--raise-*` tokens in
  index.css (a shadowed fill layer behind the label, pressing in to 0.985);
  ghost, outline, link and every row are flat and press by stepping their
  fill to `foreground/12` at once, never by scaling (a row drawn by hand
  takes `ROW_PRESS`, components/ui/press.ts: `/5` on hover over
  `--dur-hover`, `/12` on a press; the composer's quiet controls and every
  draft-row picker `ROW_CONTROL`; a pressed toggle is `muted`). There is one focus
  ring, index.css's inset outline, which an element outside its selector
  list joins with `focus-ring`; `lib/focusGuard.test.ts` refuses any
  `focus-visible:ring`. Neighbouring tooltips share one `TooltipProvider`
  (delays in `TOOLTIP`, lib/ease.ts), never around a scroller, the rail's
  nav or a virtual list (the lazy provider remounts what it wraps). A
  hover reveal is `reveal(group)` on a wrapper (components/ui/reveal.ts;
  what it covers `yields(group)`; lib/revealGuard.test.ts refuses a reveal
  without `--delay-hover` or on focus-within), a
  disclosure chevron is a ChevronRight turning `rotate-90` on
  `DISCLOSURE_CHEVRON` (components/ui/disclosure.ts), with no timing of its
  own beside it and never a 180° turn (`lib/disclosureGuard.test.ts`; a menu
  trigger's chevron is a still `ChevronDown`), a bounded log is a `pre` on `CONSOLE` (components/ui/
  console.ts), no icon takes a `strokeWidth` prop, and a solid red button
  never sits in a list row (a row's remove is a ghost that turns red on hover;
  `lib/redButtonGuard.test.ts` allows a destructive `Button` only inside a
  dialog's footer).
- Every resize handle uses `hooks/useSashKeys.ts` for focus,
  separator ARIA, axis arrows (2% of the container, Shift 10%) and a
  double-click reset. Keyboard resize commits at once; `useDragResize`
  exposes `resizeTo` and `reset` to clamp, paint and save without a spring.
- The right side of a thread is one panel (`lib/rightPanel.ts`,
  `surfaces/RightPanel.tsx`; docs/LAYOUT.md "The right side"): Agents first
  and its default whenever the thread has subagents, Activity only with rows
  of the thread's own; it follows the thread its pane SHOWS
  (`rightPanel.showThread`, set by MasterView while a batch child or a
  subagent line is open in the board's place: that thread's sections and
  section memory on the pane's open state and width, read on its own host,
  the child's own view `bare`; Back hands it back to the master; an
  `AgentDetail` inside Agents moves nothing), and a master's empty Agents
  says "Batch threads are on the board"; a toggle in place slides it in from the edge or back
  out over the thread on transform and opacity (`usePaneMotion` in
  surfaces/threads/ThreadView.tsx), the thread taking its width at once;
  the composer's slash menu moves on the popup recipe (`POPUP_MOTION`,
  chrome/CommandPopover.tsx). Modal and
  ConfirmDialog ride `components/ui/dialog.tsx`, and every form dialog is
  Modal + ModalBody + DialogFooter (`lib/dialogShapeGuard.test.ts`). Its Changes section is one
  virtual list (`chrome/rail/changesItems.ts` through the rail's
  `VirtualRows` on a native scroller whose size comes from the
  ResizeObserver, starting from the last one seen (`sizeKey`), so a cold
  mount forces no layout; one `RowsContextMenu` for its rows, a fold's `Collapsible`
  only once it opens; `useAgainst` holds the Against group's state), so its
  cost follows the viewport in every warm tab; the host never lists the
  app's `.temp-code/` there (`APP_DIR_PATHSPEC` in
  src/main/server/appDir.ts on git status, the numstats, Stage all, Stash
  and the commit draft; a call carrying it runs without
  GIT_LITERAL_PATHSPECS).
- Verification for a renderer change: `bun run typecheck`, the tests you
  touched (every new behaviour gets a jsdom test), and a static render
  through `bun run ui:preview <module>#<Export> --props '<json>'`
  (scripts/ui-preview.ts: the component rendered by the client renderer in a
  jsdom document and read once its markup settles (400ms at most, so a count
  ticking up shows where it lands), under tsconfig.web.json so every renderer alias resolves,
  inside the built stylesheet in dark and light, written to /tmp/ui-preview
  or `--out <dir>`, `--shot` adding PNGs at 864 and 400px through headless
  Chrome (`TEMP_CODE_CHROME`, else Playwright's cached chrome-headless-shell),
  shown with `html_preview` or read as images; a `*.fixtures.tsx` beside the
  component renders each fixture); one
  electron-vite build per branch for `bun run check:bundle`, never the
  full suite or a dev instance. The renderer's prettier style differs from
  the root config: never run prettier or `--fix` on src/renderer.

## Launch-time code caches: boot.js, the compile cache, the app scheme
- `package.json` `main` is `out/main/boot.js` (src/main/boot.ts), a second
  main entry that in a packaged app enables Node's compile cache at
  `$TMPDIR/temp-code/compile-cache` (macOS purges it after three idle days)
  and then requires `out/main/index.js` through it; index.ts flushes the
  cache 10 s after boot and in `before-quit`, because Electron's quit never
  reaches Node's exit-time write. `TEMP_CODE_COMPILE_CACHE` points an
  isolated copy elsewhere. The first `[boot]` line of a launch reads
  `index <ms> start=<epoch> compile-cache=on|off`; dev runs say `off`.
- The packaged renderer loads from `tempcode-app://renderer/index.html`
  (src/main/appScheme.ts), a privileged scheme with `codeCache: true`, so
  Chromium keeps a V8 code cache for the index chunk and every lazy chunk
  under `assets/`; `file://` never gets one. Both schemes register in one
  `registerSchemes()` call (assets.ts). First boot on the new origin copies
  the `file://` localStorage over once (src/main/originMigration.ts, marker
  `<userData>/localstorage-migrated`).
- Monaco file and review panes use `surfaces/FileHeader.tsx` for the folder
  and review stepper. A Monaco review tab opens on its first change, and
  the header's Revert change and Stage change act on the change the caret
  is in (Stage only for a review against HEAD, built on the index; editorGit
  reached through `import()`, line helpers in surfaces/monaco/diffActions.ts).
  CodeMirror mounts `surfaces/HunkBar.tsx` for Stage and Revert with shared
  buttons and tooltips. `lib/colourGuard.test.ts`
  checks literal renderer colours against the token layer and counted
  palette exceptions; the counts only shrink.
- The renderer is split (docs/bundle-split.md): the index chunk carries
  only the first paint (rail, transcript, composer, thread header; 4,891.7
  kB on 2026-11-05, once Base UI's menu and popover left it, under the
  5,136.0 kB budget)
  and every other surface is a
  lazy chunk behind
  `defineChunk` (src/renderer/src/lib/lazyChunk.tsx), listed in
  `src/renderer/src/surfaces/chunks.ts`: Settings, the Aliax pages
  (recharts), the edit row's diff body, the CodeMirror
  editor with its find keys and git helpers, the terminal (xterm), the
  non-chat thread views (board, plan, research, fleet), the HTML render
  frame, the media viewer, the lightbox, the release notes with the
  changelog parser, the action-opened dialogs (`dialogsChunk` over
  chrome/dialogs.ts, each mounted only while open, the thread menu's
  Resources, Archive, Mac bridge, Rename and Goal, its Recent and Archived lists
  (`ThreadListPopover`), the plan chip's options and the branch picker's
  switch confirm among them), the failure card's account list (`accountsChunk`),
  the transcript's message list rows under their chevron (`messageListChunk`),
  a workspace's threads beside the rail (`workspaceThreadsChunk`), the
  file and symbol pickers (`pickersChunk`, mounted while open), the
  composer's slash and @ menu (`commandMenuChunk`, mounted from a
  composer's first `/` or `@` on), a box
  thread's waiting Mac bridge card (`macBridgeChunk`), the return from Away
  (`awayReturnChunk`: chrome/AwayReturn.tsx, mounted at boot, loaded after
  the first paint), a review's notice
  (`reviewChunk`, ReviewCard and GateCard behind a 28px skeleton line, warmed with the
  first thread's chunks) and the
  rail's virtualizer (`virtualChunk`; the rail lists its cards plainly until it
  lands, chrome/railRows.tsx). A mount
  point calls `chunk.surface(name, <SurfaceSkeleton kind=… />)`, which
  sits in a `ChunkBoundary` (a failed import or a render throw holds the
  skeleton with "Couldn't load" and Retry, which replaces the lazy and the
  chunk's promise; the rail and the other panes stay); a trigger
  spreads `chunk.intent` (hover or focus warms the chunk, so a click on a
  warm machine never shows the skeleton); the first thread on screen warms
  the diff and thread-view chunks in an idle slot (`preloadWhenIdle`).
  A module in a lazy chunk must never be imported statically from the main
  chunk (the right panel's Changes section and App.tsx's editor find keys reach the
  editor chunk through `import()` and `surfaces/editorFind.ts`); the
  transcript's highlighter loads each grammar's chunk on first use
  (lib/highlightLanguages.ts). `electron-vite build` writes the chunk map to
  `out/bundle-map.json` (`bun run bundle:map` prints it) and
  `scripts/check-bundle-size.ts` (`bun run check:bundle`, in `bun run
  build` and the release gate) fails when the index chunk's static closure
  passes 5 MiB + 16 KiB or holds one of the lazy modules (the Base UI primitives
  stay out of the entry: the tooltip defers its primitive, the menus and
  popovers ride menuChunk (a first-paint surface that draws a menu or a
  popover by its parts imports them from components/ui/lazy-menus.tsx: a cold
  trigger of the same element until the chunk lands, no content), the branch
  picker's list with them (chrome/BranchRows.tsx), every select rides
  selectChunk: the composer's
  permission, thread type and model setting pickers and every ChoiceSelect
  (asking for the chunk as it mounts) draw a cold trigger of the same
  classes, size and width until it lands, components/lazy-select.tsx; only the dialog is in the first paint). It also fails when a chunk renders a string tag that is no HTML, SVG or custom element: the React Compiler inlines a lowercase component alias into the JSX tag (`jsx("current")`, an empty element), which only the built bundle shows.
  `/ui` serves the chunks
  as immutable module scripts behind the cookie (remote/ui.ts).
- Proof: `bun run script:e2e-launch-timing` (scripts/e2e-launch-timing.ts)
  packs an isolated copy under /private/tmp/tc-launch-timing and launches it
  four times with Chromium's startup trace on; the report shows the `index`
  mark, `tc:ready`, and the index bundle's `consumedCacheSize`. On the box,
  `bun scripts/launch-timing-linux.ts --tree <checkout>` runs a built tree
  under xvfb-run with a window and reads `tc:ready` over CDP (it pre-sets
  the migration marker: on Linux with a display the migration's hidden
  window closing is window-all-closed, and the app quits before the first
  real window opens).

## Launch: the rail paints from the launch mirror
- The desktop no longer waits for every host's `session.list` before the
  rail is whole. The main process keeps a launch mirror in the app database
  (src/main/server/launchMirror.ts: `launch_mirror_hosts`,
  `launch_mirror_sessions`): per host (`local` and every saved environment)
  the session SUMMARIES the renderer last saw (a SessionMeta minus
  `activity`/`activityKind`), the workspace and project lists, and the list
  cursor. Summaries only, never transcript rows; capped at
  `MIRROR_MAX_SESSIONS` (2,000) per host, newest kept, and archived threads
  older than 30 days leave the mirror (the host still has them).
- Boot (src/renderer/src/main.tsx → lib/tcserver/launchMirror.ts): before
  environment zero and before the first render, `hydrateFromLaunchMirror`
  reads the mirror synchronously through preload (`launch-mirror:read`,
  `ipcRenderer.sendSync`; the /ui page has none), registers the saved hosts
  in the registry so the rail has their sections from the first frame, and
  seeds the session and workspace stores. A key route whose ticket mint
  needs the local link waits for it (`registry.primaryOpen`) instead of
  failing its first attempt into a backoff. Then the sockets open and each
  host reconciles: `session.changes { afterSeq, generation }` (contract.ts;
  capability read) answers the metas that changed and the ids that left
  since the cursor from the server's in-memory change log
  (src/main/server/listChanges.ts: one slot per id, a 5,000-entry window,
  a generation per server run), or `reset`, on which the store lists whole
  as before. A changed row is updated in place, a gone one dropped, an
  untouched one is the same object (nothing re-enters: the rail has no
  enter animation, and reconcile is a high-frequency event). The boot prune
  of the seen map (`stores/subscriptions.ts`) waits `BOOT_SETTLE_MS` (2 s)
  for the lists and then takes the mirror's rows for a host that has not
  answered; its rows show under that host's existing offline tint. A saved
  host with neither a list nor a mirror still holds the prune. The main
  process logs the one synchronous read as `[boot] launch-mirror read <ms>
  hosts=<n> bytes=<b>`, and the renderer measures the hydrate as
  `tc:launch-mirror` (performance marks around it).
- The writer (`installLaunchMirrorWriter`) follows `onMetaChange` and the
  workspace catalog, diffs each LISTED host's rows against what it last
  wrote (object identity), and sends the difference over
  `launch-mirror:write` after a 750 ms quiet period or when the page hides,
  landed in batches of 200 rows on the host;
  the first write per host is `full`. A host still painted from the mirror
  is never written (it would be rewritten from itself). The cursor saved
  with the host is the `session.changes` head the next boot resumes from.
- Seam: `TEMP_CODE_PEER_DELAY_MS=<ms>` (src/main/server/peerDelay.ts) holds
  every request a REMOTE principal makes on that host before handling it;
  local sockets never wait. Proof: `bun run script:e2e-launch-mirror`
  (scripts/e2e-launch-mirror.ts): a headless slow box and a windowed
  desktop under xvfb, paired; a cold start with the host saved and no
  mirror, then one with the mirror after the box renamed, archived, deleted
  and added a thread while the desktop was down. Measured tc:ready → the
  rail's first full paint (`tc:rail-complete`, marked once every host has
  listed or was painted from the mirror), peer delay 3 s, 12 threads:
  before 6,026 ms, after 11 ms (docs/box.md "The launch
  mirror against a slow box").

## Provider traffic: the gateway, and Codex needs 0.162.1+
Every Claude and Codex child sends its API traffic to a loopback gateway
(src/main/server/gateway.ts) that swaps in the account the thread is
routed to (aliax-core's `forward`). Two listeners:
- **One plain-http port** is the marker's `url`. Aliax's shim (8787, TLS on
  8789) forwards terminal traffic here when we own the marker, and Claude
  children carry their `~t=<thread>;a=<account>[;pin=1]` scope on this
  port's path (endpoint.ts `routeUrl`), after a `scoped-routes` feature
  probe of whoever answers.
- **One https port per codex thread.** Codex 0.158+ refuses an http
  `chatgpt_base_url` and keeps only the ORIGIN of an https one for the
  sampling call (`<origin>/backend-api/codex/responses`), so a path scope is
  lost. Instead `routedEndpointFor('codex')` asks the gateway for a port of
  the thread's own (`scopedCodexUrl`); the listener rewrites `/backend-api/*`
  and `/codex/*` into the scoped path core parses (`scopedCodexPath`) and
  refuses WebSocket upgrades so codex drops to its HTTP stream at once.
  Codex children never use the shim. The certificate is Aliax's pair in
  ~/.aliax/tls when present, else an app-owned CA + leaf under
  `<userData>/tls` (src/main/server/tls.ts); children trust it through
  `CODEX_CA_CERTIFICATE` (harnessEnv), so no Keychain step is needed.
  `TEMP_CODE_GATEWAY_TRACE=1` logs one line per forwarded request (its
  finish ends `client hung up` when the CLI left before the answer was whole).
- **The byte path runs in its own process.** On the Mac and the box the
  listeners, the forward, the SSE relay and the upstream pools run in an
  Electron utility process (`out/main/gateway.js`: src/main/gatewayProcess.ts
  → server/gatewayChild.ts, forked by src/main/gatewaySpawn.ts), not on the
  main process's one JavaScript thread. `GatewayCore` (server/gatewayCore.ts)
  is the byte path wherever it runs and asks a `ControlPlane` for accounts:
  `InProcessControl` (gatewayControl.ts: aliax-core's own reads and the
  server's hooks) in main, `PortControl` over a MessagePortMain in the child
  (protocol in gatewayWire.ts). Main (`GatewayHost`, gatewayHost.ts) keeps
  the marker (main's pid, the child's port), the TLS pair, the vault, the
  Keychain, every refresh and `askOwner`, the routing hooks, and mirrors of
  `url()`, `status()`, the codex ports and the warm map; it pushes the
  accounts the forward reads (names, pins, usage reports, the out marks)
  when the pickable set moves (`AccountsService.onPickable`; the out marks
  also after every 401 and answer), answers credential misses (the child keeps a credential until a
  minute before its token ends; a vault save or a 401 drops it), and gets
  one `response` message per answer with the limit headers. aliax-core's
  `ForwardHooks.accounts` is what keeps the child's copy of core off the
  vault. `adoptWarm` resolves on the child's word and the adopted CLI's
  stdin waits for it (`holdStdin`). A child that exits is respawned on the
  same ports (streams in flight are cut; the SDKs retry); three exits in a
  minute and the gateway runs in main (GatewayCore + InProcessControl), as
  it always does in tests and the in-process proofs. Child log lines read
  `[gateway:<pid>]`; `doctor.get` names the mode, pid and restarts.
  Proof: `bun run script:e2e-gateway-process`.
- The installed codex version is read once at boot (drivers/codexVersion.ts)
  and catalog rows with `minCodexVersion` above it are hidden everywhere
  (picker, spawn table, app tools). GPT-6.1 Sol and GPT-6 Sol need 0.162.1.
- Vendor rows: Meta's `muse-wonder-1.0` and `muse-spark-1.3` sit in the
  catalog under both the claude and codex harnesses with `vendor: 'meta'`
  (`isMetaModel`) and a native 1,048,576-token window, so
  `supportsContext1m` is false and `[1m]` is never appended. The effort
  ladder (`REASONING_LEVELS` in src/shared/catalog.ts, the one list every
  reasoning enum reads) starts at `minimal`, which only the codex Meta rows
  list (the Claude CLI takes low..max); `fitReasoning` moves a rung a model
  lacks to its nearest, so minimal lands on low. The picker groups them
  under a "Meta" heading with Meta's mark (chrome/HarnessIcon.tsx `MarkId`;
  no model row draws a glyph, and out of its tab, in search and favorites,
  a row ends its name with its harness, since one model is offered under
  several), only
  while the thread's host holds a Meta key (`useAccounts`: no key, no rows
  in the Claude and Codex tabs, favorites or search; the Muse harness's own
  rows ride the subscription and never hide), and the
  board row's model mark draws it.
- The Meta Model API (Muse Wonder 1.0, Muse Spark 1.3) is the third
  upstream, behind the same two lanes. A Meta key is an account of the
  `meta` service in aliax-core (`accounts.saveApiKey`: the `LLM_<id>_…`
  shape checked, the key presented to `GET /v1/models` once, saved as a
  static ownerless profile whose account is the numeric id in the key, so
  the same key twice is one row; its usage report is that probe: "pay as
  you go", or "key revoked" with `expired`); it syncs like a one-year token
  (every host holds it, a tombstone removes it). A thread's accounts come
  from `routedProviderOf(provider, model)` (src/shared/accounts.ts): `meta`
  for a vendor row under any harness, else the harness; chooseAccount,
  resolvePin, the registry's expectAccount/liveLoad/refreshAccounts, the
  pins, the chip and the failure kinds all read it, and the route carries
  `service: 'meta'`, which `routeUrl` writes as `;s=meta` after the model
  (the codex https port's scope carries it too). The gateway reads the
  scope's service for the upstream (`https://api.meta.ai`, the lane's own
  path: `/v1/messages` or `/v1/responses`), the credential (`Bearer
  LLM_…`, no x-api-key, the CLI's chatgpt-account-id dropped), the limit
  classifier (a Meta 429 is transient with Retry-After: never replayed onto
  another key, since two keys of one team share the bucket; the host's
  headroom cooldown moves the NEXT turn) and the trace line (`service=meta`);
  every answer reaches the host with its `serviceId`, so headroom and the
  out marks land on the keys (Meta's `x-ratelimit-{limit,remaining}-
  {requests,tokens}` set is the one headroom.ts already parses; no reset).
  The key never reaches a child: the claude driver runs a Meta row in token
  mode (`metaClaudeEnv`: `ANTHROPIC_AUTH_TOKEN=routed` for the gateway to
  swap, haiku and sonnet pinned to Spark 1.3, opus and the subagent model to
  the thread's own, tool search on, never `[1m]`), the codex driver writes
  `model_providers.meta` on the thread's scoped https port plus `/v1` with
  the Responses wire and `TEMP_CODE_META_KEY=routed` as its `env_key`, the
  native window and reasoning summaries, no `chatgpt_base_url` and no
  `service_tier` (`metaCodexConfig`). A Meta model with no key on the host
  is refused at the send with "No Meta Model API key on this host"
  (`NO_META_KEY_MESSAGE`, kind `account_unknown`, the card offers Add key…),
  never sent unscoped to Anthropic or OpenAI; a 401/403 on a Meta route is
  `key_invalid` (Open accounts), 402 or billing words `quota`, 429
  `rate_limited` with Retry-After's seconds. `api.meta.ai` stays on
  Electron's `net.fetch` (not pooled) until the live smoke's trace says
  undici reuses h2 there. Proof: `bun run script:e2e-meta-routing` (a fake
  api.meta.ai, two keys, a claude-lane and a codex-lane turn, the 429
  cooldown); docs/box.md "Meta Model API".
- Speed tiers come from each CLI, never assumed: codex's `model/list`
  serviceTiers (drivers/codexTiers.ts) and claude's `supportedModels()`
  supportsFastMode, asked on the first claude init of a boot and cached as
  `claude.speedTiers` (drivers/claudeTiers.ts); the model menu offers only
  the listed tiers, and the drivers send a tier only when it is listed.
- A dev instance is not the marker owner, so core does not refresh codex
  tokens there: an account whose stored token lapsed answers 401
  ("token_expired") until the owner uses it. Pin test threads to an account
  the installed app uses, or expect that failure (its card reads
  `token_expired`).
- Every error row carries the host's verdict (`failure` on the event and the
  session row: `failureKind.ts`, stamped in `Sessions.append` from the
  harness's words, the gateway's last refusal for the thread and the
  routing), except a stop: the row of a turn the person stopped is stamped
  `stopped: true` and never classified. A turn the CLI ended itself (its
  result's `error_*` subtype, the row `turn ended: <subtype>[: <the CLI's
  first error line>]`) is kind `turn_ended`, summary `TURN_ENDED_SUMMARY`
  (the fallback's words), cause the CLI's line or the subtype's meaning; a
  line naming a death or a network cut keeps that kind. The stop rule
  (`stopping` in sessions.ts): the flag survives the `running` a question's
  or an approval's cleanup emits and a `waiting`, clears on a settle, on
  `starting` and at the top of `send()`; a Stop while the harness boots
  (`stopBooting`) puts the handle down when it lands, writes the stopped
  row and idle, and delivers nothing; a Stop on a paused turn writes the
  stopped row the pause dropped (paused takes no error row), so the turn
  closes Stopped and a batch child blocks as "was stopped". The
  transcript's FailureCard prints
  its two lines and at most
  three actions that fit the kind, Retry last, for every failure (a row
  with no verdict reads `fallbackFailure`, src/shared/failureFallback.ts,
  never the harness's raw words; Retry only where the host can continue,
  `canRetryFrom`, which admits a watching thread whose own last turn
  failed through the row's `canContinue` while `treeCanContinue`, the
  flag the rail and the cards read, still waits for its work); the tab edge prints the
  summary instead of "Failed", and the workspace popover prints it under
  the thread's title. A cap (`rate_limited`, `quota` on a picked provider
  but Meta) carries `roomElsewhere` (`AccountsService.roomElsewhere`: the
  spawn's `eligible()` over every account but the refused one) and names
  the account the gateway saw refused: with room the card is Route
  automatically, Continue on another model, Retry; with none, Continue on
  another model, Retry (the phone: Retry and the note). Continue on another
  model opens the composer's picker (`requestModelPicker(id, { onPick })`,
  called once after the picker's own change) and continues on the pick
  (`session.continue` with the model). With no room the thread is
  cap-held (`capHolds`): report and batch wakes park until a model or
  account change, a continue, the person's message or the cooldown's lift
  (`capLiftsAt`). A live handle whose thread moved since its spawn (model,
  effort, pin, or an account the registry moved while it was live: a
  failover, Route automatically on a watching thread, both through
  `pendingReboot`) is rebooted at the next turn start, never mid-turn
  (`staleHandle`, `rebootIfStale`; `dropHandle({ replacing: true })`
  writes no idle under the turn starting). docs/box.md
  "A failed turn says what happened". Nothing in a renderer parses an error
  string; add a kind to `FailureKindSchema`, a rule to `failureKindOf`, its
  actions to `failureActions` and the phone's `FailureActions`, and run
  `bun run gen:swift`.
- Accounts across hosts (thread V): every profile in Aliax's `profiles.json`
  has an owner environment (absent = this machine) and only the owner ever
  presents a refresh token; other hosts hold access-only copies kept fresh
  over the main process's own peer links (`src/main/server/remote/peers.ts`,
  `accountSync.ts`; RPCs `accounts.push`/`accounts.pull`, admin only). The
  wire's `ServiceIdSchema` (src/shared/contract-m3a.ts) names every
  aliax-core service: claude-code, codex, cursor, meta, muse-code and addon
  (until 2026-11-08 it named the first three, so a Meta key or a Muse login
  sent to another host was refused at parse; contract-m3a.test.ts). A
  Claude "one-year token" is a static profile every host holds, with no
  owner: what `claude setup-token` makes, minted in-app (T1; aliax-core
  `src/mint.ts`, `src/main/aliax/{staticMint,staticTokens}.ts`) by adding
  `expires_in: 31536000` to the ordinary code exchange or to a refresh_token
  grant; the token response names its account and a token is filed only
  under that account. A Meta key is a key account (`kind: 'key'`, static, no
  owner, synced like a one-year token), added with the Meta section's Add key…
  (AddKeyDialog → `aliax:profiles:addKey` → core's `saveApiKey`) and shown as
  `LLM_1607…`; a refused key fails a turn as `key_invalid`. "Convert all to one-year tokens" in the Claude Code
  section's menu on the Accounts page converts every account; a grant
  another host refreshes (the box, from an
  earlier handoff) is taken back first over the peer link (`AccountSync.
  takeBack`: the takeOver pull `accounts.setHome` uses, provisional
  landing, `accounts.confirm`, the owner strips) and minted from here, a
  host out of reach leaves the session and the sign-in window to mint, and
  the row names that host when those fail too (never "convert it there");
  tokens inside their last 30 days renew on their
  own through the stored claude.ai session (6 h cadence, row + footer say
  "Sign in to renew" when the session is gone); the box's live sign-in is
  the first static token it got and follows that account's renewals; the
  host that mints a token for the account its CLI is signed in with
  installs that token as its live sign-in (the refresh route rotates the
  grant the CLI holds), and a lapsed live sign-in whose account holds a
  static token is repaired at boot and every six hours
  (`StaticTokens.repairLive`). The "Sign in to Claude" window
  (src/main/aliax/signInWindow.ts) appears once claude.ai has painted,
  closes the moment the code arrives, and a failure is one line in the
  app's sign-in dialog (src/shared/signInWords.ts). With no Claude
  or Codex account on this machine the rail's foot leads with "Sign in to
  Claude" (chrome/SignInRow.tsx), which leaves once a profile arrives
  (docs/LAYOUT.md "First run"). Sign
  in on the Mac; the box never does (docs/box.md "Accounts: sign in on the
  Mac once"). A handoff is
  two-phase under aliax-core's per-profile lock (`src/lock.ts`, shared with
  the token refresh): the receiver saves provisionally and echoes a digest
  of the refresh token, the sender strips only on that echo, then
  `accounts.released` makes the receiver the owner; a takeOver pull holds
  the grant out until `accounts.confirm` (30 s, else the owner keeps it);
  the next sync settles anything a lost message left half done. A peer's
  pushes and pull answers land only on accounts already on file here
  (`applyTransfer(..., 'peer')`); a grant the local CLI is signed in with
  (Claude's Keychain item, Codex's auth.json, Muse Code's auth.json) is never
  handed off; a Muse Code login is static (no refresh grant), so every host
  holds the copy and routes its threads by it ("Muse Code: a harness of its
  own" below). Removals
  follow the owner (`AccountSync.deleteProfile`, behind the `accounts.delete`
  RPC and the Accounts page's `aliax:profiles:delete`): the vault row goes,
  the snapshot rebuilds at once (`AccountsService.rebuildNow`, no debounce),
  and every peer hears, over the links as `accounts.removed` (admin) and to
  sockets that pulled as an `accounts-removed` push; every pull answer also
  carries the sender's whole file (`listed`) and its tombstones. The
  tombstone rule: a host that deletes a profile it refreshes or a static
  token keeps a tombstone (settings row `accounts.tombstones`, 30 days,
  void once a profile of that account is saved there again); a peer deletes
  an access-only copy whose owner is the sender when the sender's list no
  longer has the account, and a static one-year token only when a tombstone
  names it (absence from one host's list proves nothing for a token every
  host holds); never deleted on a peer's word: a profile this host
  refreshes, the one its CLI is signed in with, or a provisional copy (a
  handoff in flight). Routing follows (`chooseAccount` reports `vanished`):
  a thread whose pin or sticky account is no longer known routes
  automatically from its next turn, the project's or workspace's pin for
  that provider is cleared, and one `notice` row (`kind: 'account-gone'`,
  a plain system row, no Continue) says "Account <name> is gone from this
  host; routing automatically from here" with the time; the chip reads
  Auto until the next pick lands. Test
  seams for isolated instances: `TEMP_CODE_ALIAX_DATA_DIR` (own vault,
  key-file mode), `TEMP_CODE_FAKE_PROVIDERS=<origin>` (every provider call
  goes there), `TEMP_CODE_GATEWAY_ROLE=owner` (refresh without the marker),
  `TEMP_CODE_DROP_ANSWERS=method:count` (swallow answers, for a dropped
  response), `CODEX_HOME` (the adapter's auth.json), `ALIAX_CREDENTIAL_BACKEND=file`
  + `CLAUDE_CONFIG_DIR` (the Claude CLI's credentials in a file inside the
  instance's data, never the Keychain), `TEMP_CODE_STATIC_RENEW_FIRST_MS` /
  `_EVERY_MS` (the renewal cadence); proofs are `bun run script:e2e-accounts-sync`
  and `bun run script:e2e-static-tokens`.
- Routing by headroom (src/main/server/{headroom,accountScore}.ts): the
  gateway's response hook records, per account and per host, the
  per-request limit headers every answer carries (Anthropic's
  `anthropic-ratelimit-{requests,tokens,input-tokens,output-tokens}-*` and
  unified status/claim, OpenAI's `x-ratelimit-*`), the answers of the last
  minute (the rate) and every 429/529 with when it lifts (retry-after, else
  the exhausted field's reset, else the unified reset, else 60 s; an
  overloaded answer pauses 30 s), in memory with `<userData>/headroom.json`
  written 5 s after a change and on close so a relaunch is not blind. For an
  auto thread `chooseAccount` scores every known account with room that is
  not out and not inside a cooldown: 0.45 × the least room among the model's
  usage windows, 0.30 × the tightest per-request limit left (an account no
  host has heard from counts as full), 0.15 × live threads against the soft
  cap, 0.10 × the cross-host rate against 30/min, plus 0.15 for Opus on a
  Fable-spent account; the best wins a first spawn, and a sticky thread moves
  only when the best leads its own account by more than 0.10 plus 0.25 ×
  cache warmth (1 right after its last answer, 0 after the prompt cache's
  TTL, an hour: the CLI writes the 1-hour cache, `STICKY.cacheTtlMs`; a
  `fresh` pick keeps only the cache term). A pinned account is
  the route regardless. Picks read the store live; the rows' snapshot
  (`headroom` per provider, the bars on the account chip's menu and the
  Accounts page's Rate bars, reset in their popover) follows at most
  every 5 s. The Accounts page is the one page on the table width (`Page
  width="table"`, 1,152px): from 48rem of its container each account is a
  table line with one column per usage window, its bar over when it resets
  ("Resets 4:15 PM" today, "Resets Thu 9:00 AM" past it, `resetWords`; how
  long until then on hover), the columns shared by the whole page, and an
  account out of room says "Limited" in amber with its reset (`limitOf`);
  under 48rem the columns stack under the name, two to a line in a narrow
  window (docs/LAYOUT.md "The Accounts page"). The rail's foot
  names no account: each provider's row is the pooled share from
  `src/shared/usageMeter.ts` (`meterFor`: the mean room over routable
  accounts, each its tighter of 5h and week) with the next refill, or
  "Limited 3m" while every account is throttled, and its popover lists the
  windows and how many accounts have room; Meta, paid per token, has a row
  only while every key is throttled (Limited and the time, no bar). Each host pushes
  its own picture to its peers every 30 s and within a second of a 429
  (`accounts.headroom`, admin; the answer carries the peer's), merged under
  the sender's id, so the Mac and the box pick from one picture. Proof:
  `bun run script:e2e-quota-routing` (an in-process server over a fake
  Anthropic: one account throttled, ten turns spread over the other ten).

- Upstream connections (src/main/server/upstream.ts, the fetch aliax-core
  is configured with; core itself needed no change): api.anthropic.com rides
  undici pools, one per (origin, Authorization digest) so an account's turns
  share sockets, HTTP/2 when the API negotiates it (it does), 32 sockets per
  account, free sockets kept 90 s (the server's keep-alive hint lowers it),
  idle pools closed after 3 min. chatgpt.com stays on Electron's `net.fetch`
  (Cloudflare refuses Node's TLS there) with Chromium's own pool. Every
  TEMP_CODE_GATEWAY_TRACE line ends `reused=true|false h2|http/1.1`
  (`reused=n/a` on the Chromium path): undici publishes the request object
  and the socket it went on, and `upstreamTrace` ties them to the gateway's
  request. The fake provider (TEMP_CODE_FAKE_PROVIDERS) is pooled too, by
  the original origin.
- Deadlines (S7 of the stability sweep): a gateway control call (the
  child asking main for a credential, an account) times out at 30 s
  (gatewayWire.ts `GatewayControlTimeout`; a credential miss is
  `credential_timeout`, a 503 the failure kind reads as `network`); an
  upstream request on the pooled path has headers 60 s, body idle 120 s
  and total 10 min deadlines (upstream.ts; `TEMP_CODE_UPSTREAM_HEADERS_MS`
  and `_BODY_IDLE_MS` are the seams), the stage named in the failure; a
  codex app-server RPC past its timer (30 s, `turn/start` 60 s) fails the
  turn instead of hanging it, and one stalled at boot is released or
  retried. The gateway tells main when a forwarded request goes out and
  when it is done (`onRequestStart`/`onRequestEnd` on the control plane,
  the wire's `request` event); `chooseAccount` and `pickNext` share one
  `eligible()` rule, and a model's cooldown leaves the account's other
  models available.
- What a turn says while it waits (S3, Stability 3): a `phase` event is
  activity, never a row. The claude driver's spawn hook emits
  `cli-starting` for a cold spawn and `initializing` for an adopted warm
  process, until `system/init` (the boot's word is said again right after
  the send's `running`, `phaseAfterSend`, and nothing before the spawn, so
  a cold start never reads Initializing first; the registry keeps each
  session's live phase and a `starting` or `running` leaves its words as
  the activity; a phase that lands on an idle row is kept and surfaces at
  the send), then `waiting-provider` from init (or from the send on a live
  CLI) until the top lane's `message_start`, `retrying` on the CLI's own
  `api_retry` (attempt, delay, status); a thinking or text delta or a tool
  call clears any phase. Every claude spawn carries `--thinking-display
  summarized` (`claudeExtraArgs`): the SDK process otherwise asks the API to
  omit thinking text, and Fable and Opus thought for seconds over an empty
  row. The codex driver emits `retrying` on `willRetry`/`Reconnecting` and
  `initializing` while its first send waits on the MCP servers
  (`firstTurnGate`); sessions.ts words them ("Starting the CLI",
  "Initializing", "Waiting for the provider", "Rate limited, retry 3 in 32 s"; the vocabulary is
  src/shared/statusWords.ts: a comma before a phase's detail; a state word
  and its detail are two spans, or "Word: Detail" as one string
  (`plainStatus`); the host sends the detail as `SessionMeta.statusDetail`
  and keeps `activity` in its legacy two-space shape for old readers
  (`legacyActivity`), which `legacyDetail` reads with a capital) and folds them onto the
  meta like `context` (`phaseLine`). A provider request open past 15 s with
  nothing finer known (Thinking or the driver's own provider word) reads
  "Waiting for the provider, 25 s", re-pushed every 5 s (`providerRequest`,
  `PROVIDER_WAIT_MS`); only the turn's own requests count (a turn starting
  forgets those still open), and the gateway ends a request the moment its
  client hangs up, cutting the upstream (`RelayResponse` in gatewayCore.ts:
  codex closes its stream at `response.completed`, and core's relay once
  waited for a `drain` that never came; docs/box.md "The provider wait, and a
  client that hangs up"). The place these words show is the transcript's
  working line (`TurnLine` in surfaces/transcript/WorkingLine.tsx on
  `workingPhase` in workingPhase.ts): Sending while the person's row is
  still `pending` (not yet echoed), the meta's activity while the turn has
  nothing of its own, then the open wait on agents, the running call
  ("Reading format.ts", told by the line alone: `toldByWorkingLine`, no row
  until it settles), Thinking and then a streaming thought's newest sentence
  in its place (each sentence a phase of its own, `thought:<n>`, spoken as
  Thinking),
  the mark alone under streaming prose; a phase stays at least 300 ms once
  painted and one that came and went inside the hold is skipped
  (`useHeldPhase`, lib/heldWord.ts); a change of phase morphs the words
  (`MorphText`), and the line becomes the closing line when the turn ends,
  once every row of the turn has finished revealing its text (AgentMarkdown
  reports `!settled` through `useReportReveal`, surfaces/revealDrain.ts;
  TurnEnd keeps the mark till then). Once live the line is never unmounted:
  held (a card, a pause) it folds on `.collapsible-auto`, a Stop morphs it
  to Stopped at once, and the echo keeps the optimistic row's key
  (`Block.rowKey`). A refold from the rows alone (an older page on a remote
  host, the head of a local tail-first paint) runs `reconcilePending`
  (lib/tcserver/fold.ts): the optimistic row records the seq its send
  followed (`Block.pendingAfter`), and a persisted user row past it in the
  refolded log is its echo (same text first, else the next in order) and
  takes the row's key; one with no echo yet stays pending first when the
  loaded rows start past that seq, last otherwise. Before it the refold
  appended the pending row under the whole stream and the line read Sending
  for the rest of the turn (a box master on 2026-11-08, after a resume that
  reset to a tail behind the echo). A thought is no transcript row (a group opened by hand shows "Thought").
  The timer above the composer counts from the click: `appendOptimisticUser`
  stamps `sentAt` when no turn is open, `turnStartOf` prefers it over the
  host's later `busySince`, the settle clears it, and the slot shows at once
  for a send over a failed or stopped row. A compaction is
  activity "Compacting context" (`COMPACTING_WORDS`) from its start to its
  outcome or the turn's end, never replaced by the provider-wait line or a
  mid-compaction `running`; the CLI re-sends its compacting status every
  30 s and the claude driver emits one start (the stream state's
  `compacting` flag). A first-output
  watchdog (`FIRST_OUTPUT_MS`, 60 s after a send with nothing back at all)
  settles the turn with the silence error and puts the process down; the
  registry re-queues the message once at the front, and a second silence
  on the same message leaves the row errored `harness_crashed`
  (drivers/silence.ts). A CLI resumed on a transcript whose background
  task died answers the task's notification before the pending message:
  the driver takes a `task_notification` ahead of the send's own content
  as a notice turn, holds that turn's result for `NOTICE_RESULT_GRACE_MS`
  (10 s; the row stays running, the clock untouched) and drops it at the
  next message, replaying it as the turn's own only when nothing follows.
  Every `session.send` writes one span line to
  stalls.log (sendSpans.ts: `send session=<id> accepted=0 prepared=12
  handle=340(warm) delivered=… init=… first-message=… model=1900(miss 88k)
  first-content=2100`, flushed at the first content or 15 s in, a phase
  never reached `-`; `model` is the top lane's `message_start` with the
  cache's word; the first send after an eager or focus boot reports how the
  handle came up (`warm`, `cold`, `live boot=focus`), a later one `live`;
  codex notes its MCP gate on `delivered`, `mcp=1400`; `bun
  scripts/stalls-summary.ts --sends` tables the gaps per handle kind, the
  warm share and the cache miss rate), and
  a meta push names its producer in the loop line
  (`meta:4038/781ids(accounts:3900,status:138)`).
- Pre-connect (src/main/server/preconnect.ts): when a turn starts on an
  idle thread, and when the composer of an idle thread gains focus
  (`session.preconnect`, operate; the renderer asks once per thread per
  half minute), the socket the thread's account will ride is opened or its
  free one refreshed with a `GET /` (404 in one round trip), never more than
  once per account per minute (`Upstream.preconnect`). The codex origin gets
  Chromium's `ses.preconnect` under the same throttle. Boot on focus: the
  person's own pointer or keystroke in the composer (`Composer` `onGesture`,
  `askOnGesture` in lib/preconnect.ts; never a programmatic focus, so a tab
  switch boots nothing) asks with `boot`, and the host boots the harness of
  an idle or done thread with none up or booting, not archived or moving,
  once per thread per 30 s (`FOCUS_BOOT_EVERY_MS`, on the host), only while
  `ThreadScheduler.hasRoom` (under the cap, nothing queued, memory clear;
  never the focused send's exemption); nothing reaches the transcript and
  `reclaimIdle` may put it down (`SessionRegistry.focusBoot`). An unsent
  draft asks with `draft` (provider, model, project): the router's socket
  for a fresh thread of that project, and the warm shapes in its folder
  kept another retire period (`touchWarm`); no session is created.
- Warm harness (src/main/server/drivers/warm.ts; claudeWarm.ts and codexWarm
  in codex.ts): a pool by shape, one pre-spawned CLI for each of the last
  `WARM_SHAPES` (3) shapes started, per driver per host, each spawned from
  the exact spec (command, argv, cwd, env) of a thread that started, no
  session and no account. A new thread adopts the one of its shape when the
  SDK computes the same spec (model, cwd, tools, permission mode, settings and MCP server
  names are all in the argv; a resumed thread never matches); the Agent SDK
  sends the system prompt, hooks and in-process MCP servers at `initialize`
  over stdin, so the adopted CLI is initialized as if just spawned
  (`spawnClaudeCodeProcess`). Its base URL is the gateway's `~w=<id>` scope,
  rewritten per request into the adopting thread's scope (`rebindWarmPath`,
  unscoped until then); only a thread our own gateway routes (the owner's,
  or no shim) adopts or warms. Codex: the warm `app-server` is spawned and
  initialized, everything per thread arrives with `thread/start`, so it
  saves process start and the handshake only (MCP servers attach at
  thread/start). A shape's replacement spawns 3 s after its adoption or
  cold start, at once when the shape started twice inside `WARM_BURST_MS`
  (60 s, a burst); a fourth shape retires the one that started longest ago;
  each shape retires 10 min after its own last start
  (`TEMP_CODE_WARM_RETIRE_MS` for a proof); nothing warms while memory is
  under the admission floor (`setWarmMemoryFloor`, index.ts; the proof seam
  `TEMP_CODE_E2E_MEMORY_LOW=1` on an isolated instance); a start that finds
  nothing logs the first field it differs on (`[warm] claude: miss
  (tools) 2 warm`: model, effort, tools, permission, settings, cwd,
  skills (the Claude config dir of another scope), resume, empty,
  refilling, memory). A warm process is never a session
  (not listed, counted, capped or load-guarded). `harness.warm` (admin)
  lists the pools with each process's retirement and the `misses` by
  field, and `{retire: true}` empties them; `TEMP_CODE_WARM_HARNESS=0`
  turns warming off. Measured on the box
  (`bun run script:e2e-warm-start`, chat threads, one turn each, two runs):
  Send → first token 2.9 s and 2.1 s cold (medians of 4; 1.5–3.3 s) versus
  0.30 s and 0.17 s adopted (medians of 3; 0.15–0.47 s) against the fake
  provider; one real claude-haiku-5-5 thread, cold, 3.06 s over a
  pre-connected HTTP/2 socket (every request after the first reused it).
  Stability 3 (2026-11-01): every pool, focus and memory case passes; one
  shape adopted 67–68 ms to the first thought, alternating shapes and a
  burst all adopted (69–91 ms), cold 0.21 s with Starting the CLI at 35 ms,
  and a real low-effort Opus thread streamed its thought (model at 2.7 s,
  the summary at 5.2 s). docs/box.md "Warm start" has the tables.

## Muse Code: a harness of its own
Meta's Muse Code CLI is provider `muse` (`src/main/server/drivers/muse.ts`).
Meta brands it with the Meta symbol and publishes no Muse mark, so every
`muse` mark (HarnessIcon's `markDrawing`, the phone's `ProviderGlyph`) draws
Meta's, and its words tell the two apart (a model's tooltip ends "on Muse
Code"). `chrome/icons.test.ts` checks the distinct assets referenced by
`HARNESS_ICONS` against `assets/providers`; provider keys may share a file.
It runs
one `muse serve` per thread over the Muse Session Protocol (newline JSON-RPC
on stdio), spoken through Meta's `@muse-code/sdk` (pinned exactly, 1.4.14;
bundled into main like aliax-core, so electron.vite excludes it from the
externals). The spike's findings are `.temp-code/plan-R5k0vrmrvU4D/findings.md`
(F1–F10) and its recorded frames `src/main/server/drivers/fixtures/muse/`
(the README there); the SDK's schema fingerprint is the change detector and a
mismatch logs one `[muse]` line.
- `harness/museHost.ts` spawns the binary through the SDK's handshake and
  keeps the raw `Connection` (the facade drops `usage/changed` and lacks
  steer, cancel, `model/list`); `clientInfo.name` is `temp_code` (the wire
  refuses a hyphen); the environment is `harnessEnv()` plus the guard's marks,
  `MUSE_CONTRIBUTOR_MODE=0` (the person's code is not training data unless
  they turn it on) and `XDG_CONFIG_HOME` for the thread's config dir (one per
  account and skills scope, below). An account's dir also sets
  `TBH_CREDENTIAL_BACKEND=file`: the config-dir spike (M2; "Skills" below) found the
  dir's `auth.json` decides the login with it on both hosts, and without it
  only on Linux; the Mac's CLI may go to the Keychain first. The own dir
  (a thread on no account) does not. Both set `GH_CONFIG_DIR` to the
  person's gh dir when it is unset, since tool processes inherit the owned
  `XDG_CONFIG_HOME` and `gh` would lose its login (M6).
  `harness/museProtocol.ts` is the pure mapping: `safe` → `:ask-me` +
  `promptUnmatched`, `edits` → `:ask-me` + `onRequest`, `auto` →
  `:unrestricted` + `allowAll`; the app-tools bridge rides `session/start`'s
  `config.mcpServers.app` as a stdio server (the `sessionMcp` grant), so no
  settings file is generated; `turn/start` carries the effort on every turn
  (`minimal` joins the ladder with half 1; `none` is never sent); a steer is
  `turn/steer` on the live turn, received when the `userMessage` item with our
  `commandId` lands; Stop is `turn/cancel`; approvals answer `approval/decide`
  with the request's own `approved` choice, or `abort` (the wire offers no
  `denied`), never a session-wide or policy choice, and the app's own tools
  (`mcp__app__*`) are approved without a card; questions are
  `userInput/request` → the question card → `userInput/answer`;
  `session/contextUsage` is the context meter; `usage/changed` (the 5h and
  Weekly percent blocks) goes to `AccountsService.observeUsage` and a quota
  stop (`quota: tierLimit, resets …`, failureKind reads it as `rate_limited`
  on the 5h window) to `observeQuota`; the SDK's exit classification words the
  error row (`exited unexpectedly` keeps HARNESS_CRASHED); a Linux host whose
  `initialize` says the sandbox is unavailable restarts with
  `--disable-sandbox`; `TEMP_CODE_MUSE_TRACE=1` logs every frame.
- The catalog is probed at boot (`harness/museCatalog.ts`: `model/list`,
  `variants` the ladder, `isActive` the current pick and never a filter,
  labels from the ids: Muse Wonder 1.0, Muse Wonder Full 1.0, Muse Spark 1.3,
  1.2; the default is `isDefault`); it answers empty with no login, so the
  renderer's static rows stand in until then. Wonder Full
  (`muse-wonder-full-1.0`) is orchestrators-only by default
  (`defaultApproval` in rules.ts, which `withProbedDefaults` gives every
  probed row the rules never decided); Spark and Wonder are for everyone.
- Accounts: the login is static (`auth.json`: a device-code `access_token`,
  the minted `api_key` the model traffic presents, `user_email`,
  `subs_active`; no refresh, no expiry), aliax-core's `muse-code` service
  (adapters/muse.ts) captures the file whole and every host holds the copy
  (tombstones on delete). `src/main/server/museConfigDirs.ts` keeps one dir
  per (account, skills scope): `<userData>/muse-accounts/accounts/<account>/
  <scope>/muse/` with that `auth.json` (0600, by rename) and its digest in
  `.auth-seed`, or `<userData>/muse-accounts/own/<scope>/muse/` for a thread
  on no account, its `auth.json` a link to the person's own when they have
  one (`accounts/` and `own/` are fixed names, so no account collides with
  the own dir). In both, `skills` links the store's scope pointer ("Skills:
  one store, materialized per host"), which Muse reads at every call, and every
  other entry of the person's `~/.config/muse` (settings, hooks, trust) is a
  link; the driver hands the dir to `muse serve` as `XDG_CONFIG_HOME`.
  `migrateMuseDirs` at boot recaptures and removes the old
  `<root>/<account>/muse/` dirs. `isPickedProvider` (claude, codex, muse) is the gate for
  pins, the sticky account, the vanished rule and the chip
  (`isRoutedProvider` stays for what rides the gateway: headroom, 401 marks,
  the scope); a Muse pick lands at the next harness start, which the chip's
  menu says. Routing scores the observed windows and the live load alone;
  nothing polls Meta, and `muse usage` must never run against a copy (it
  rotates the access token in place; `recaptureMuseDir` on dispose saves only
  a scope's copy that differs from its own seed, the newest when several do,
  and seeds every copy it looked at with what it holds, so a scope's
  untouched copy is never saved over another's rotation). The Aliax app's Add account runs `muse
  login` (its CLAUDE.md). No gateway lane: `-c endpoint_transport.base_url`
  does carry every model call (findings F4) but no rate-limit headers were
  seen, so the lane buys nothing yet; warm start is left for later (the
  bridge binds at `session/start`, so a warm host can be rebound).
- On the box: `scripts/box/85-temp-code.sh` installs the CLI as agents; the
  harness set syncs `~/.config/muse/{settings.json,hooks}` and never
  `auth.json` (skills come from the store); account sync carries the login.
  Meta served the box's address an empty catalog in the spike (findings F2);
  on 2026-11-09 the catalog answered and the skills drivers proof ran Muse
  turns on the box, on an account and on the CLI's own login (docs/box.md
  "Muse Code on the box").
- Proof: `bun run script:e2e-muse` (scripts/e2e-muse.ts: an in-process
  registry on the real binary and the login its config dir holds; a shell
  call, a denied network approval, a steer received, a cancel; skips with one
  line where `muse` or the catalog is missing). Unit: muse.test.ts on
  `harness/museFakeServe.mjs`, museProtocol, museCatalog (the recorded
  `model-list.json`), museHost's exit words, museConfigDirs, museSettings,
  providerEnums, the rules, failureKind, binaries and sendSpans cases.

## Remote access: the fixed port behind the tunnel
- A second listener (src/main/server/remote/listener.ts) binds
  `127.0.0.1:7677` by default; the Cloudflare tunnel on the box maps
  `tempcode.landonhale.com` to it, TLS ends at Cloudflare, and
  `CF-Connecting-IP` / `X-Forwarded-Proto` are believed only from a loopback
  socket. The renderer's random-port loopback socket is unchanged and stays
  implicitly admin.
- `TEMP_CODE_REMOTE_PORT=<n>` overrides the port for a dev instance (so it
  never fights the installed app for 7677); `0` turns the listener off. The
  settings `remote.enabled`, `remote.port`, `remote.publicOrigin` live in the
  settings table and this machine's section of Settings → Hosts edits them. A port in
  use logs one `[remote]` line and leaves remote off; `remote.status` carries
  the error. `TEMP_CODE_REMOTE_TRACE=1` logs one line per request.
- Identity: `<userData>/environment.json` holds `env_<22 chars>`, created
  once and never copied with the database. Every socket's first frame is
  `{ push: 'hello', environmentId, contract, caps, key? }`.
- Keys (remote/auth.ts): `tc_<id>.<secret>`, scrypt at rest, each with an
  audience (`client` for phones, browsers and desktops on `/ws` and `/api/*`;
  `mcp` for bots on `/mcp`, capped at read,operate) and a capability set from
  read | operate | approve | admin. Every RPC has a row in
  src/shared/capabilities.ts (`local` rows, every `app.*`, lsp, dap, idea,
  providers.update, fim and stall.report, never run for a remote caller);
  `session.create` with `permission: 'auto'` and `session.permission` need
  approve. The gate runs in `attach()` before any handler.
- The path fence (remote/fence.ts, R2 H1/H2): for every remote principal,
  each method that names a path or cwd (`fs.*`, `git.*`, `github.*`,
  `search.project`, `workspace.create`, `session.create`'s cwd, logo and
  command-list paths) must point, by real path, under a project cwd, a
  workspace path or the configured/box work root (never the bare home
  directory); the refusal is `forbidden: <method> is outside app-managed
  roots` and never logs the path. The loopback socket is unfenced. Nothing
  was demoted to `local`: the /ui bundle and the desktop's remote-host
  flows call the whole donor family, and the phone calls `fs.readPreview`,
  `search.project` and `github.*`. `fence.test.ts` asserts every
  path-taking contract method has a row.
- Pairing: an admin makes a code (`XXXXX-XXXXX`, 10 minutes, single use) in
  the pane or over `POST /api/pairings`; the link is `<origin>/pair#<code>`.
  Redemption claims the row in one conditional UPDATE before minting, so
  concurrent redeems answer one key (R2 M1). The link's origin is learned
  only from an admin's own authenticated request, never from the Host of an
  anonymous loopback request (L1); `/api/hello` without a key answers only
  the environment id and contract (L2); the `/pair` page's script and style
  run under a per-response nonce, the policy on the meta tag and the
  response header alike (`pairPageCsp`), no `'unsafe-inline'` anywhere (L3).
  `POST /api/pair` with `kind: 'key'` answers the raw key once; with
  `kind: 'session'` it sets the HttpOnly `tc_session` cookie that `/ui` and
  cookie upgrades of `/ws` use. The page (remote/pairPage.ts, on the app's
  tokens: `PAIR_TOKENS`, held equal to index.css by its test) shows the
  link's code and one Pair button, redeems nothing on load and strips the
  fragment before its first request; a bot pairing is refused a session
  before its code is spent (`SESSION_NEEDS_CLIENT`, 400), so the page
  redeems it as a key and shows that once with Copy. Any 401 reads one
  sentence: the wire never says whether a code existed. Bearer clients mint a 30 s ticket at
  `POST /api/ticket` and upgrade `/ws?ticket=…`; nothing else ever rides in
  a socket URL. Revoking a key closes its sockets and sessions at once.
- `/ui` serves the BUILT renderer (out/renderer, so `electron-vite build`
  first in a dev tree) behind the cookie; the bundle detects a missing
  `window.api` and runs in web mode (src/renderer/src/lib/nativeWeb.ts: no
  terminal, no Aliax pages, its own `web` workspace slot). A desktop-only
  control goes through `desktopOnly(handler)` (undefined at /ui, so its row
  is not drawn: the terminal's entry points, Choose logo…, the Updates
  row, the rail's Accounts and Stats, every Reveal row; a settings section
  or keybinding group marked `desktopOnly` in lib/settings.ts, Appshots and
  Terminal, is left out of the list); a desktop-only surface reached anyway
  (a stored Appshots route) shows `DESKTOP_ONLY_LINE`
  ("Available in the desktop app") in `Empty`; Open project browses the
  host's folders (`folderPickOn` in lib/fs.ts); a native ask is the app's
  confirm dialog (`askRequest` → `confirmAction`) and a native message a
  sonner toast, never the browser's confirm or alert. A signed-out tab: `/ui`
  answers a refused cookie `302 /pair?signed-out` (no cookie: `/pair`), and
  the cookie route asks `/api/hello` before its socket (`checkCookie` in
  lib/connection/registry.ts; a hello without `key` is `unauthorized:
  signed out`), on which tcserver/link.ts replaces the page with
  `/pair?signed-out`. `/asset/<host>/…`
  mirrors `tempcode-asset://` for logos, media and agent pages.
- Webhook targets (remote/addressGuard.ts, R2 M3): a key's webhook URL and
  a hub subscription URL must be https to a public host; loopback, RFC 1918,
  CGNAT, link-local (169.254.169.254), v6 unique-local/link-local, `.internal`,
  `.local` and bare names are refused when made, the host is resolved then,
  and each delivery pins the socket's lookup to re-checked addresses (the hub
  resolves over DNS-over-HTTPS before every POST). `TEMP_CODE_WEBHOOK_ALLOW_LOOPBACK=1`
  admits a 127.0.0.1 receiver for a proof script; nothing else private, ever.
- Proof: `bun run script:e2e-remote` (the bearer flow against a temp
  server), `bun run script:e2e-remote-fence` (in the release gate: the fence
  for a read and an operate key on every path-taking method, the concurrent
  pairing redeem, refused webhook targets, the learned origin, the anonymous
  hello and the pair page CSP) and `bun scripts/e2e-remote-ui.ts` (an
  isolated preview instance plus a real Chrome profile over CDP through
  `/pair`, `/ui`, a thread, a reply, the cookie and the CSP rewrite).

## The Linux agent host: headless mode on the box
- `TEMP_CODE_HEADLESS=1` (src/main/headless.ts) runs the main process with no
  window, menu, dock or updater; the server, gateway, fixed-port listener and
  html preview's hidden window run as usual. A Linux process with no display
  is headless on its own; `TEMP_CODE_HEADLESS=0` asks for a window there (a
  proof's desktop under xvfb-run, as scripts/e2e-launch-mirror.ts does; an
  agent shell on the box inherits the service's `=1`). The last window
  closing quits only after the first user window has opened
  (`quitsOnAllClosed`): the origin migration's hidden helper closes before
  openSavedWindows runs, and on Linux that once quit the app at boot. In that mode the local socket's port is published
  in `<userData>/server.json` and `scripts/box/tc-local.mjs` speaks to it as
  the implicit admin (`tc-local remote.pairings.create …` on the box).
- The box (`ssh box`, docs/box.md) runs temp-code from
  `/srv/agents/temp-code-builds/current`
  as `temp-code.service` (agents user, agents.slice, Xvfb, a private D-Bus),
  data in `/srv/agents/temp-code-data`, env in `/etc/temp-code.env`; the
  tunnel maps `tempcode.landonhale.com` to its 7677. Deploy a ref with
  `ssh box 'box-update master'` (clone + build → trial → snapshot → commit,
  with rollback on failure) or `ssh box 'box-update v1.0.N'` (the release's
  prebuilt `temp-code-out-1.0.N.tar.gz`, verified against its sha256, no
  build); on both, node_modules are hardlinked from the current build when
  bun.lock is unchanged and installed otherwise (`BOX_UPDATE_FRESH_MODULES=1`
  forces the install); the build's `build-manifest.json` and the deploy log
  say which path ran (scripts/box/box-update-lib.sh, docs/box.md "Build
  once"); stage 85 installs the launcher and its library without
  restarting. Proof from the Mac is `bun scripts/e2e-box-remote.ts`.
- Deploy drift: every host's hello (and `/api/hello` for a known caller)
  carries `build` (release.json `n`, `1.0.N`, the commit, the platform;
  src/main/buildInfo.ts: the box's `.git/HEAD`, a published Mac build's
  `tempcodeBuild.sha` from release-publish.sh's extraMetadata). The Mac's
  main process reads master's release.json raw from GitHub every 10 minutes
  and on window focus after 15 idle minutes (src/main/deployDrift.ts; a
  failure keeps the last value; `deploy.master` RPC + `deploy-master` push,
  local only; headless hosts never fetch). `useDeployDrift(environmentId)`
  in the renderer's lib/deployDrift.ts gives `{behind, deployedVersion,
  masterVersion}`; chrome/DeployDrift.tsx is the muted tabular `+N` at the
  end of the host's submenu trigger in the rail's Hosts row and on its
  header on Settings → Hosts,
  tooltip naming both versions and the deploy (box) or publish (Mac)
  command; nothing when current or unknown. docs/box.md "Knowing the box
  is behind". Every "ask the login shell" call goes
  through src/main/server/loginShell.ts (`$SHELL`, else zsh on macOS, bash
  elsewhere): never hardcode /bin/zsh. `-lc` skips .zshrc and .bashrc,
  so a job that runs a tool by name there (the publish scripts, a batch
  shell step, a dev server, a project build) wraps its command in
  `withToolPath`, which puts `~/.bun/bin`, `/opt/homebrew/bin` and
  `/usr/local/bin` (macOS) or `~/.bun/bin` and `~/.local/bin` (elsewhere)
  first when the PATH lacks them; a publish once died `command not found:
  bun` without it.
- Harness config (commands, agents, `~/.claude/hooks`, settings.json,
  plugins, Codex prompts, config and `~/.codex/hooks.json`, Muse settings and
  hooks, two keys of ~/.claude.json) is mirrored Mac → box by the Mac's main
  process over the peer link (`src/main/server/remote/harnessSync.ts`,
  `harness.*` RPCs, admin; paths translated through `pathMap.ts`, so Codex's
  `[hooks.state."<home>/.codex/hooks.json:…"]` trust rows name the box's
  copy). Skills are the skills store's, not harness sync's: the four skill
  rules retired (`RETIRED_ROOTS`), the sender walks them no more, the
  receiver forgets what it landed under them at start and at each manifest
  (the files stay on disk) and counts an older sender's skill entries in one
  line. A dir that is a symlink lands as a copied tree, and a Mach-O file
  never crosses. The Sync row's tooltip names only the sets still carried
  (`HARNESS_SET_LABELS`, src/shared/harnessSets.ts). The set with its labels
  (`HARNESS_SET` in `harnessSet.ts`), the exclusions and the status line
  (each set with its file count) are in docs/box.md "Harness config: synced
  from the Mac". Proof: `bun run script:e2e-harness-sync`.
- Mobbin MCP (`mobbin`, `https://api.mobbin.com/mcp`) is set up globally
  for Claude Code and Codex on the Mac and box. Harness sync carries the
  server entries; each CLI on each host keeps its own OAuth grant, outside
  provider account sync. All four loaded Mobbin's eight tools on
  2026-10-24. Sign-in and SSH callback steps: docs/box.md "Mobbin MCP:
  Claude Code and Codex on both hosts". New sessions load the server;
  existing sessions may need an MCP reconnect.
- Memory goes both ways (`src/main/server/remote/{memorySet,memoryMerge,
  memorySync}.ts`, `memory.*` RPCs, admin): Claude Code's per-project memory
  (`.claude/projects/<encoded cwd>/memory/`, the encoded dir translated
  through the path map), plans and `~/.claude/CLAUDE.md`, Codex's
  `~/.codex/memories/` and `AGENTS.md`; never transcripts, secrets or
  `.git`. The host holding the link drives (`memory.exchange` →
  `memory.files`), the other decides: newer mtime wins, a content digest
  makes a no-op free, both-changed keeps the loser beside the winner as
  `<name>.conflict-<host>-<time>.md` on both hosts, a project `MEMORY.md`
  is unioned, deletions travel as 30-day tombstones. Runs on link-up,
  every 5 minutes, after a thread goes idle on either host (the box nudges
  over the Mac's link) and from Sync now. Each paired host's Sync group on
  Settings → Hosts shows files and time for both legs, and This Mac's Sync
  group folds the conflict copies open under its Memory switch. docs/box.md "Memory: synced both ways"; proof is
  the memory step of `bun run script:e2e-harness-sync`.
- Attachments on a remote thread: a file from another host (or a big paste)
  is uploaded to the thread's host before the turn names it
  (`attachment.begin/chunk/commit`, src/shared/contract-attachments.ts) into
  `attachmentDir(session)` (src/main/server/attachmentDir.ts: project cwd's
  `.temp-code/attachments/<sid>/`, else the workspace's, else
  `<userData>/attachments/<sid>/`); the fence checks turn attachment paths.
  docs/box.md "Attachments on a remote thread". Proof:
  `bun run script:e2e-attachments`.
- One thread moves Mac ↔ box from the thread menu's "Move to <host>…" rows (the ⋯ menu and the chip's right-click): the Mac's
  own `session.move` (local) pushes over `session.import.*` or pulls over
  `session.export.*` (admin, on the peer link) in hash-chained parts; the
  receiver lands it remapped and hidden, the source keeps a tombstone only
  on the echoed digest, and a link-up settles a half-done move
  (`src/main/server/{sessionMove,remote/sessionMover}.ts`,
  `src/shared/contract-session-move.ts`). The branch travels with it
  (`src/main/server/sessionMoveBranch.ts`): before any part, the source
  pushes the thread's branch to origin (else bundles the commits the
  receiver lacks over the link) and sends its uncommitted changes as a
  patch; the receiver checks the branch out at the same commit in the
  project (source on it directly, project clean on its default branch) or
  in `<project>/.claude/worktrees/<branch>`, reuses a checkout that has it,
  applies the patch with `git apply --3way` and keeps one that fails at
  `<cwd>/.temp-code/moved-changes.patch` with a row on the thread; the
  source keeps everything. The confirm says what travels
  (`session.move.preview`). Checkpoints stay on the source. docs/box.md
  "Moving a thread between hosts"; proof `bun run script:e2e-session-move`.
- Opening a box file on the Mac: the diff panel's rows, a transcript path's
  menu and the file tree's menu (`⌥⏎`) say "Open on the Mac" for a path on
  another host and "Open in <editor>" locally. `src/main/editorLaunch.ts`
  launches IDEA (`--line N path`), VS Code (`-g path:N`) or Xcode
  (`xed -l N path`) per the `editor.command` setting (Settings → Editor →
  Open files in; Auto = first installed; Swift under `ios/` prefers Xcode when it
  is chosen or IDEA is absent). A remote path is translated through the
  harness sync's path map inverted (`src/shared/openOnMac.ts`, box
  `/srv/agents/work/<X>` ↔ Mac `~/IdeaProjects/<X>`), both hosts hash the
  file (`fs.digest`), and only an identical Mac copy opens in the editor;
  otherwise the host's version opens in the app read-only with "Mac copy
  differs: on branch X here" / "No Mac copy" and "Open the Mac copy anyway"
  (lib/openInEditor.ts, surfaces/FileNoteBar.tsx). Web mode and a headless
  host hide the items (`editor.config()` is null). docs/box.md "Opening a
  box file on the Mac".
- A path a box thread's transcript names opens FROM THE BOX. The host of a
  path is never read off the path alone: `hostForPath` (src/renderer/src/
  lib/pathHost.ts; `hostOfPath(path, threadHost)` in lib/tcserver/projects.ts)
  takes a catalog root as the answer, else the host of the thread that
  named the path (`useTranscriptHost` in the transcript's chips, markdown
  links, edit rows and right-click menu → `OpenFileOptions.environmentId`
  → `FilePaneTab.environmentId`, read by MediaGate, FileEditor, Monaco and
  the mtime watcher), else this machine. `fs.media` stamps its host on every
  URL (`&host=<id>`, media.ts `setMediaHost`) and the Mac's asset handler
  streams another host's token over the admin peer link with `media.read`
  (2 MiB ranges, ids only; src/main/assets.ts `serveRemoteMedia`). A file
  missing on the host reads "No such file on <host>." docs/box.md "A box
  thread's files and images open from the box"; proof
  `bun run script:e2e-remote-media`.
- The Mac bridge: a box thread whose `macBridge.thread.<id>` setting names
  the Mac reads, lists and fetches Mac files and runs Mac commands
  (`mac_*` tools) over a reverse RPC on the Mac's peer link
  (`remote/peerCalls.ts`: `peer.register`, `peer.call` push, `peer.reply`,
  `peer.chunk`). The Mac decides everything in `remote/macBridge.ts`: a
  per-host policy (off by default), shared folders, and a Mac-local prompt
  for any other path and every command (`macBridge.decide` is local-only;
  a key sees what runs through `macBridge.activity`, read, and stops a
  running or held call through `macBridge.stop`, operate; the prompts and
  every setting stay the Mac's).
  Codex calls carry a per-thread token (`macTools.ts`). A thread in full
  access on its box (permission `auto`) is never prompted: the box sends its
  permission with every call and the Mac treats every call the policy admits
  as remembered. A card (above the thread's composer, a sonner toast for a
  thread off screen) is only ever a decision: a call that runs is a row of
  the thread's Activity section and of the host's Mac bridge list on
  Settings → Hosts, each with Stop, never a card. The cards are capped
  (`queueOf` in the renderer's lib/macBridge.ts): one waiting card per host
  with "and N more". The server still marks a call admitted without a prompt
  `quiet` while its `macBridge.showRunning.<envId>` is off
  (`runPresentation`); the desktop no longer reads or sets it. The load guard
  (`remote/macLoadGuard.ts`) sits between the decision and the spawn of
  every command, job and computer session the bridge admits, never a read,
  listing, fetch or write: `macBridge.maxRunning.<envId>` (default 4) caps
  a host's concurrent commands, jobs and live computer sessions together,
  `macBridge.maxComputer.<envId>` (default 2) caps its computer sessions
  alone (a command behind a session that cap holds still starts when it
  fits), and the load watch
  (os.loadavg every 15 s) holds every new one while the one-minute load is
  over `macBridge.loadLimit` (default 2 × cores) until it is back under
  0.75 × the limit. A held call is `status: 'held'` with its `held` standing
  (reason, position, load, limit), a row with Stop in the host's running
  list and the thread's Mac approvals dialog ("Waiting for the Mac, load
  12.3 of 8, 3rd in line"), never a card, and waits only within the call's
  own deadline. `macBridge.maxThreads.<envId>` (default 2) caps the
  Mac-local threads a host starts here: `MacBridge.admitThread(envId)`
  (also `macBridge.admitThread`, local) is asked by crossHostThreads.ts
  before every `thread.start` and `thread.spawn`. On Settings → Hosts a
  host's Mac bridge group holds its policy (a Select), its running and held
  calls with Stop and its forwarded ports; its caps with the live counts,
  forwarding and the shared folders are in the
  host's Mac bridge settings dialog (surfaces/settings/hosts/
  MacBridgeHostDialog.tsx); This Mac's section has the load with its limit. docs/box.md "The Mac bridge: what a box thread may touch on the
  Mac"; proof `bun run script:e2e-mac-bridge`. Computer use is one more
  class of call, off by default per host (`macBridge.computer.<envId>`):
  "Computer use: the Mac's apps from any thread" below and docs/box.md
  "Computer use from a box thread".
- Thread resources: what a thread created (git worktrees, simulators, dev
  instances), on its own host or on the Mac through the bridge, is on the
  host's `thread_resources` table (src/main/server/threadResources.ts; the
  parsers in threadResourcesParse.ts record nothing a command did not
  demonstrably create: git's `Preparing worktree` line, simctl's UDID,
  `TEMP_CODE_USER_DATA`), filed under the top-level thread with the id of the
  host the resource lives on. The thread menu's "Resources…" is a removal
  form (a checkbox per row, Remove N; disabled when the thread has nothing
  but dev servers, which Activity and the dev servers pane hold); archiving a thread with rows asks "and remove N resources on
  the Mac" (on by default; `session.archive { removeResources }` through
  the renderer's `archiveThread()` in lib/threadResources.ts; the fleet's
  Archive done goes through `session.batch { cleanup }` and the registry's
  `resourceCleanup`, which is `resources.remove`). Removal runs on
  the owning host through the bridge's runner as the thread
  (threadResourcesRemove.ts: `git worktree remove --force`, `git branch -D`
  only with nothing ahead of the upstream, else the branch stays and the row
  says so; `simctl shutdown` + `delete`), an offline Mac leaves the row
  waiting until it re-registers. RPCs `resources.list/listAll/remove` take
  ids only. docs/box.md "Thread resources"; the e2e-mac-bridge proof covers
  a bridged worktree's record and removal.
- Dev servers on the box reach the Mac's browser over the Mac's peer link.
  A dev server a thread opens is a `port` row on the ledger (pid, the call
  that opened it, and `what`, the listening process in plain words from
  `listenerWords` in src/shared/devServerWords.ts, "Bun server" for `bun
  src/server.ts`, which the Dev servers pane titles it by; src/main/server/threadPorts.ts): the server's own
  "Local: http://localhost:5173" line with a listener behind it, a listener
  new under the harness tree (`ss`/`lsof` + `ps`) while a shell call runs,
  or the host-wide sweep (portSweep.ts: 3 s after a shell call settles and
  every 15 s while a harness runs, only listeners not yet decided) that
  credits a background shell's server, reparented to init, by ancestry, the
  `~t=` scope or CLAUDE_PID in its environment, the output file a call
  named, or the thread folder holding its cwd, and skips databases,
  infrastructure, proxies, MCP servers, test runs, the gate's workers and
  the repository's own proofs (`scripts/e2e-*`, `scripts/.out/*.mjs`, the
  electron-stub preload)
  (src/shared/devServerRules.ts, which threadPorts.ts and the renderer apply
  too) and ports bound before a thread worked there
  (`bun scripts/port-sweep-dry-run.ts` prints its verdicts live); a sweep
  every 10 s, armed at boot, ends a row the moment nothing listens or its
  process is gone (a listener under the thread's own harness is followed as
  a watcher's restart), one live row per port on a host, and removal
  SIGTERMs then SIGKILLs the pid. The box sends its live ports (the ledger's and the Dev
  Server button's runs) to every registered Mac (`push: 'ports'`,
  remote/portForward.ts); the Mac binds 127.0.0.1 on the same number, else
  the next free one above (its own dev instance keeps 5173), answers
  `ports.bound`, and carries each connection as `ports.open/data/close`
  frames (remote/macPorts.ts, portStreams.ts: in order, paused while the
  link holds 1 MiB or 32 frames are unanswered); the box dials its loopback
  only. "Dev server forwarding" per host in its Mac bridge settings dialog
  (`ports.forward.<envId>`, on by default). The thread hears where its dev server is: "Forwarded to
  http://localhost:5174 on the Mac (5173 is taken there)" with a Mac, "The
  dev server (bun run dev) is listening on http://localhost:5173" without
  one (`devServerLine`, portTail.ts), in the shell call's result (claude's
  PostToolUse hook; a backgrounded call's listener is looked for through
  the hook's wait, `POLL_MS`) or whispered as a `<dev-server>` line once
  the row lands (a row the grace-period poll or the host-wide sweep records
  reaches the tail through `recorded(ids)`); the call's transcript row ends with "Open on the
  Mac :5174", and the Activity section and the dev servers pane have Open
  and Stop. The bottom dock's
  Dev servers tab starts one (its starter, surfaces/DevStarter.tsx):
  the host detects targets, only what a person would pick
  (devTargets.ts: the root's dev script with the lockfile's runner, then
  each workspace app by name, one script each; Expo and Xcode/XcodeGen apps
  Mac-only; each with `what`, a few words from src/shared/devServerWords.ts)
  and runs one in its own process group (devRuns.ts, `devServer.*`,
  `dev-run` pushes, `devServer.runs` for every running run) on this Mac or
  the box's copy of the project, for the thread on screen
  (`devServer.start { sessionId }`, `DevRun.sessionId`). One dev server per
  thread: Run for a thread that has one says "This thread already runs a
  dev server." over Replace and Start another (`runChoice`; Replace stops the first), the
  host holds the rule too (`devServer.start` for a thread with a live run
  or `port` row answers `{ replace: true, existing }` unless the request
  says `another` or `replace`, which stops the old ones first), and a
  thread's shell opening a second hears the same from the host's dev-server
  line (portTail.ts `oneServerLine`; a port the shared rules say is not a
  dev server, such as the gate's workers, is never announced). What runs
  lives in that ONE tab of the bottom dock (surfaces/DevServersPane.tsx on
  chrome/DockFrame.tsx; rules `liveServers` and `serverGroups` in
  lib/devServers.ts, state lib/devPane.ts): every server live on a
  connected host now (a running run, or a ledger `port` row still listening
  that passes the shared rules; a port a run holds is listed once), under
  the thread it belongs to, in plain words ("Vite dev server") with its
  address (the row's Open control, or "Open on the Mac :5174" for a server
  on another host) and the word Stop (chrome/DevServerRow.tsx), its
  console the server's log alone under its command (a ledger row's label, else the background task that shares its call); a row leaves the moment its host
  drops it. The dock
  is bottom only and has one bar (chrome/DockBar.tsx: the project's
  terminals and the Dev servers tab as line tabs, New terminal, Hide dock); the
  tab shows only when a host can serve the project, a server runs or the
  pane is open. Closed by default and never opened on its own (the Dev
  server row of every thread menu toggles it, lib/threadMenu.ts with
  `useThreadDevServer` in chrome/useThreadMenu.tsx; the bar's tab and a Run
  open it);
  while open it takes the terminals' place at the dock's height.
  Dev server consoles are never terminal tabs; old saved `devLog` tabs are
  dropped on load. docs/box.md "Dev servers on the box"; proof `bun run script:e2e-port-forward` (seam
  `session.proofShellCall`, `TEMP_CODE_E2E_STATUS=1`). The subdomain proxy
  for the phone is not built yet.
- Tool processes are guarded (src/main/server/processGuard.ts; docs/box.md
  "Tool processes: a mark per call, an orphan sweep, a memory cap"): a
  claude thread in full access runs every Bash call with `TEMP_CODE_THREAD`
  and `TEMP_CODE_CALL` exported into its shell (the driver's PreToolUse
  hook, `wrapBashCommand`; the approval card and the Activity row show the
  command as written, through `unwrapBashCommand` in src/shared/bashMarks.ts
  with the two marks),
  and the host SIGTERMs then SIGKILLs what still carries the call's mark
  when the call ends (never a harness, a ledger pid or a backgrounded
  call); the wrapped command also renices its own shell to 10 and idle
  I/O (`NICE_PRELUDE`; a codex app-server starts under `nice -n 10`), so
  tool builds never starve the server; every 10 s an orphan sweep (one read of /proc on Linux, one `ps`
  through the exec broker elsewhere, shared with a call end inside 2 s)
  kills a process of this user with no
  parent left that carries a thread's mark (`TEMP_CODE_THREAD`, `~t=`,
  CLAUDE_PID) 60 s after it was orphaned, one log line each, but only
  this instance's: the claude harness's environment and every wrapped
  call carry `TEMP_CODE_INSTANCE` (`guardInstanceOf`: a hash of the
  userData dir and a nonce in the `guard.instanceNonce` setting), a
  process marked by another instance is left alone, and one with no
  instance mark is swept only by the instance on the prod data dir
  (`isProdData`: Electron's default userData, or the box's
  /srv/agents/temp-code-data), so a dev instance never touches the
  installed app's processes; and a call
  whose processes pass `tools.memoryCapMb` (8 GiB) is killed with its tool
  result saying so. A codex app-server carries `TEMP_CODE_THREAD` alone.
- Pause and Stop reach the Mac
  (`src/main/server/macPause.ts`, every mac.* call passes its gate): a
  thread pausing (subagents with it, by the parentId chain) has its calls
  out on the Mac cancelled with the tool result "cancelled: the thread was
  paused" and one `mac.cancel` per thread, which the Mac answers as its Stop
  button would (deny a waiting card, kill a running command, end the jobs);
  while paused, commands, jobs and writes are held on the box in order and
  sent on Continue, or refused with "refused: the thread is paused" once the
  caller's timeoutMs would have passed; reads go through marked `paused` and
  only where they need no prompt. The Mac lists held calls (`mac.held`) as
  `paused` rows without Stop, the box pushes `macBridge.held` so the paused
  strip says "and N Mac jobs with it". docs/box.md "The Mac
  bridge: what a box thread may touch on the Mac"; proof
  `bun run script:e2e-mac-bridge` (its pause step uses the proof seam
  `session.markStatus`, `TEMP_CODE_E2E_STATUS=1` on an isolated instance).
- Threads across hosts, both ways: `app_start_thread` and `spawn_agent`
  take `environmentId` (`mac` for the thread's Mac or the only host
  registered here, `box` for the only host linked from here, or a host id),
  and the thread runs on that host as one of its ordinary threads; its id
  comes back as `<envId>:<sessionId>` and every supervision tool routes by
  it, `list_agents` with `host`, `app_read_thread` with the files it left
  there (`src/main/server/crossHostAgents.ts` asking, `remote/
  crossHostThreads.ts` serving, both built on every host; `src/shared/
  contract-crosshost.ts`). One transport abstraction (`remote/hostLinks.ts`):
  a host registered here with the `threads` offer is called by `peer.call`
  (the box → the Mac), a host linked from here by the same `thread.*`
  methods as admin requests on its listener (the Mac → the box; the caller
  is the socket's registration); the reports back (`crossHost.settled`,
  `crossHost.landing`) take the same road the other way. Path translation
  runs the map in both directions (`hostPathFor`). Admission on a Mac is the
  Mac bridge's thread cap, on the box `crossHost.maxThreads.<envId>`
  (default 4). A dropped link answers `linkDown` with the last state, never
  a hang. docs/box.md "Threads across hosts"; proof
  `bun run script:e2e-cross-host-threads`.
- The relay: a phone or bot paired with the box reaches the Mac's threads
  through the box. `/ws?ticket=…&host=<envId>` is a second socket under the
  Mac's id: the box answers the hello (the Mac's `environmentId`, `via` the
  box, `presence` the Mac's row), runs its own gate, refuses a method outside
  `RELAY_METHODS` and answers the key's `remote.push.*` itself, and forwards
  the rest over the Mac's link as `relay.frame`; the Mac serves the lane with
  its own `attach()` on a `RelaySocket` and sends its frames back as
  `relay.frames` (src/shared/contract-relay.ts; box side remote/relay.ts,
  Mac side remote/relayServe.ts). The Mac reports its screen and power
  (src/main/presence.ts: powerMonitor, `ioreg` at boot) in `peer.register`,
  on every change and every minute (`peer.presence`); the box keeps the rows
  (`relay.hosts`), lists them in the hello (`hosts`) and `/api/hello`, and
  pushes `presence` on a change. A state that forbids a call answers one line
  (`relayRefusal`): `unavailable: the Mac is locked` (the screen method
  only), `… asleep`, `… unreachable since HH:MM`; a drop mid-request is
  `linkDown: …` and closes the lane 4010; an unregistered host is 503 at the
  upgrade. `/mcp` takes `host` and `env_…:id` sessions (docs/remote-mcp.md
  "Hosts"). A Mac with no delivery of its own sends its notices as
  `relay.notice`. Seams: `TEMP_CODE_PRESENCE`, `presence.set` under
  `TEMP_CODE_E2E_PRESENCE=1`, the iOS test server's four relayed hosts
  (remote/relayLoopback.ts, `POST /presence`). docs/box.md "The relay";
  proof `bun run script:e2e-mac-relay`.
- Devices on the Mac: Settings → Hosts, a Devices group in the Mac's own
  section, lists this Mac's simulators and iPhones with their state words, the
  booted ones' CPU, the thread that holds each (the `thread_resources`
  ledger by UDID, "—" without it), the Xcode in use and the load; Shutdown,
  Delete (confirm names the holder) and Open in Xcode act locally. The
  Mac's main process gathers only while a viewer is open (`host.devices.
  watch`, a push every 30 s, `unwatch` or the socket closing stops it); a
  box's /ui and the phone read the same methods, forwarded to the Mac as
  `host.*` peer calls under the `devices` offer (`src/main/server/devices/`,
  `src/shared/contract-hostdevices.ts`, `surfaces/settings/hosts/Devices.tsx`).
  docs/box.md "Devices on the Mac".
- A restart mid-turn: `resume_after_boot` is a live ledger (a row per
  thread on every running status in `SessionRegistry.append`, cleared when
  the turn settles), and the signal handlers and `before-quit` stamp the
  shutdown time on it (`recordForResume`) when they get to run (under the
  box's `dbus-run-session` Chromium often aborts on the D-Bus disconnect
  first); after the servers and gateway are up
  `BootResumer` (src/main/server/resumeAfterBoot.ts) boots each one on its
  transcript with a "The host restarted during your turn at <time>; continue
  where you left off." nudge, four at a time, children first, paused ones
  left paused, and pushes one `boot-resume` (count, boot time) that the rail
  says once per boot as a sonner toast, "N threads resumed after restart"
  (`useBootResumeToasts`, chrome/HostRows.tsx). A running row
  with no live harness for 20 s flips to the `stopped` status (liveness sweep
  `sweepLiveness`, `DriverHandle.alive`); the held row above the composer says
  "Stopped  the harness is gone" with Resume, and `session.resume` on it calls
  `registry.resumeStopped`, the one resume path for a dead harness. A
  harness that dies with no turn open is settled at once by the driver's
  word (`DriverCtx.harnessGone` → `registry.settleGoneHarness`, the one
  rule the sweep is the fallback for): a thread watching its own
  background work idles with its tasks gone, a master kept watching by its
  batch reads stopped with Resume, an idle row only loses the dead handle;
  no error row either way, since the "died mid-turn" words are true only
  for a turn that was running, which keeps the error path. The clock: a
  turn that starts from a watching, error or stopped row counts from its
  own start (`append` stamps `busySince` fresh; a retry that queues after a
  failure from its queueing), a stopped watcher freezes nothing, and only a
  turn that died mid-stream carries its elapsed through Resume
  (`resumeStopped` anchors `busySince` once, before the boot, and appends
  `starting` then `running`, both keeping it); the transcript's closing
  line of a turn resumed from its failure or Stop row states the resumed
  stretch, and one resumed from the host's `stopped` row (the harness gone
  under it) carries its span on, so the line and the strip agree
  (`resumeTurnClock`, the block's `stoppedTs`). The boot reset idles only waiting and watching rows now.
  docs/box.md "Surviving a restart"; proof `bun scripts/e2e-survive-restart.ts`.
- Backups: restic to R2 bucket `tempcode-backups`, repo `box` from
  `box-backup.timer` (SQLite snapshotted with VACUUM INTO, never the live
  files) and repo `mac` from the launchd agent `dev.landon.tempcode.backup`
  (scripts/mac/backup.sh). Secrets are Keychain items `tempcode-restic` and
  `tempcode-r2-backups`, never files in this repo. docs/box.md "Backups".

## Search across hosts: one query, every host, an FTS5 index per host
- The search surface (src/renderer/src/surfaces/SearchView.tsx on
  src/renderer/src/lib/crossHostSearch.ts) asks every connected host the
  same query in parallel (threads by title and transcript, files by
  `search.project` in the host's copy of the paired project, notes by
  `notes.search`), streams each host's rows as it answers, ranks without
  looking at the host (match quality from the hosts' bm25 ranks plus
  recency), folds a file at the same relative path in both copies of a
  linked project (src/renderer/src/lib/projectPairs.ts: one `linkId`, else
  the linker's own rule of same GitHub repo, else same folder name, for rows
  it has not stamped yet) into one row on the newer copy (`search.project`
  matches carry `mtime`), folds each file's name and matching lines into
  one row (`foldFileHits`: the first line, `+N more` for the others; a name
  hit opens at its first line), leads a thread hit with its tinted type
  glyph (`ConversationHit.threadType`, chat when absent), marks each hit
  with the host glyph when more than one host is paired, and, with two or more hosts paired, says "box:
  1.2 s" per host at the foot (skipped when offline). Filters are typed in the box (`host:` and `type:` take a
  comma list, `project:` a name) or ticked in the field's filter menu
  (chrome/SearchFiltersMenu.tsx), which writes the same tokens
  (`setQueryToken`); no other chrome. Each host token first matches a whole
  name or id; `mac` on macOS names the local host alone. Substrings apply
  only when that token has no exact match. A command may open search with
  tokens already typed (`initialQuery`: `type:note`, `type:file`). A
  filter with no words lists its scope instead of searching (`browseHits`:
  the newest threads, this project's recent files, each online host's
  notes, the recent projects; no host search, spinner or foot). Enter
  opens where the hit lives, ⌘↩ in a new pane; nothing in the list
  animates.
- `session.search` runs on an FTS5 index per host (src/main/server/
  turnIndex.ts): `events_fts` / `cold.events_fts` over turn text, rowid
  `(ordinal << 32) | seq` through `turn_index`, filled on every event
  flush for ready sessions, backfilled newest first in the background after
  boot (`Store.backfillTurnIndex`, kicked after the cold mover and hourly),
  carried by the hot/cold moves, dropped on delete and `forgetSessions`,
  with a scan of the not-yet-ready sessions unioned in meanwhile and the
  old scan as the whole answer when SQLite lacks FTS5. Hits carry `rank`
  (bm25). On the box's database (426 MB hot, 3.9 GB cold) a query went from
  0.5 s / 5 s to 2-72 ms / 3-338 ms; the backfill took 15 s. Measure on a
  copy with `bun run script:measure-turn-index <copy>`; proof
  `bun run script:e2e-cross-host-search`. docs/box.md "Search across hosts".
- The phone runs the same fan-out, merge, fold and filters in
  `ios/TempCodeClient/Sources/TempCodeClient/Client/CrossHostSearch.swift`
  (pure, Swift Testing in CrossHostSearchTests.swift), emitting thread 4's
  row model (`SearchRows.swift`) as an `AsyncStream<SearchAnswer>` the
  Search tab iterates; `notes.search` is in the phone's subset for it.
## One project across hosts: linked projects, one rail, host glyphs

On each host, workspace creation matches real folder paths, so symlinks and
trailing slashes reuse one row; new rows keep the supplied path with trailing
slashes stripped. Once at boot (`workspaces-folded:v1`), old duplicates fold
into the oldest row with all project and session references and its link id
(or the oldest linked duplicate's id).

docs/box.md "One project across hosts" (five sections) and
docs/LAYOUT.md's sidebar rows are the long account; the proof is
`bun run script:e2e-linked-projects` (scripts/e2e-linked-projects.ts: two
headless instances; the linker stamps both copies, a far start into a
project with no copy creates and links it, a box edit reaches the Mac, a
Mac edit lands on the box, a Mac edit with the box down is refused, a
`@thread:` reference to a box thread yields its digest, `list_agents`
names the far child).
- **The link.** `workspaces.link_id` (`wl_…`) and `projects.link_id`
  (`pl_…`) are the ids a row shares with its copies on other hosts, on the
  wire as `linkId` on `WorkspaceMeta`/`ProjectMeta` (`projects.
  settings_updated_at` → `settingsUpdatedAt` beside it). Linking is automatic
  and has no UI: the linker (src/main/server/remote/projectLinks.ts) runs on
  the host holding the admin peer link (the Mac), on link-up, on the peer's
  `workspaces`/`projects` push, on a local catalog change and every 5 minutes,
  debounced; it pairs with the pure rules of src/shared/projectLinks.ts
  (workspaces by GitHub repo, else folder name; projects by name inside paired
  workspaces; the oldest row when a host has two of a key), decides with
  `decideLink` (one side's id adopted by the other, neither → mint, both
  different → the settings home's wins) and stamps through
  `registry.linkCatalog` here and `catalog.link` (admin) there. It never
  unlinks and never gives one id to a second row on a host; a wrong link is
  undone by deleting one copy, not by renaming it. The same run makes the
  copies still missing, both ways (`makeCopies`): a project with no link id,
  not archived, in a paired workspace whose other copy has no project of
  its name, gets a fresh id and `project.ensureLinked` there with
  `workspaceMustExist` (never a new workspace), and the source takes the id
  once the copy exists; so a project added on either host shows on the
  other within seconds, a host that was offline gets it at link-up, and an
  old one-host project on the next pass. A linked project's missing partner
  is one a person deleted and is never made again (no tombstone needed); an
  archived one gets none. A failed copy logs one line per new reason and
  leaves it on the source row (`ProjectMeta.linkNote`, `projects.link_note`,
  `catalog.link`'s `notes`), which the draft host picker shows on the other
  hosts, disabled; the next run retries. docs/box.md "One project across
  hosts: a new project gets its copies". `project.ensureLinked`
  (operate; src/main/server/projectLinks.ts) is the one function that finds
  or makes this host's copy: by link id, else the workspace by link id,
  mapped folder (`hostPathFor`) or repo, adopting a same-named unlinked
  project or creating one with the caller's name, branch and mode (a
  worktree on the caller's branch, a local copy with a note when that
  fails); no workspace → `cwd: null` and a note naming the folder; `dryRun`
  for the pickers. A cross-host `thread.start`/`thread.spawn` carries the
  caller's `project` facts (contract-crosshost.ts `ProjectLinkFactsSchema`,
  filled by crossHostAgents.ts from the project row, the ids minted once by
  `registry.projectLinkFacts`), `CrossHostThreads.place()` calls
  `ensureLinked` first, and `app_start_thread` with `environmentId` admits a
  `projectId` the far host lacks.
- **Settings live on the box.** The settings home of a link is its copy on
  the host whose hello `build.platform` is not `darwin` (two of one platform:
  the environment id sorting first; `settingsHomeOf`; `hostPlatform()` in
  src/main/buildInfo.ts is the one platform read, `TEMP_CODE_BUILD_PLATFORM`
  its seam for an isolated instance). `project.settings.get` (read) answers
  one bundle (name, archived, preamble, pins, review, plans, build, turn
  pass, `updatedAt`), `project.settings.set` (admin) writes it whole; every
  existing setter stamps `settings_updated_at` and pushes `projects`. The
  follower (src/main/server/remote/projectSettingsSync.ts, on the Mac) pulls
  a linked copy's bundle from its home when the home's stamp is newer, on
  link-up, the home's `projects` push and every 5 minutes; a settings write
  on a non-home host is forwarded to the home (then pulled back with the
  home's stamp) or refused with `refused: settings of <name> live on <host>;
  it is offline`. The dialogs (`lib/projectHome.ts`, ProjectSettingsDialog,
  PreambleDialog, rename, archive every copy, delete asking about the other
  copy) act on the home over its link, footer "Saved on <host>", Save off
  with the reason while the home is out of reach.
- **One rail.** `lib/linkedRail.ts` (`mergeRailSections`, restored from
  a39cc107 and keyed by `linkId`) joins copies into one row led by this
  machine's copy, the other copies aliased to the leader's keys
  (`aliasKeys`) so order, pins, recents, labels, logos, colours, mascots, the
  window folder and the selected-project memory (projectContext
  `folderKey`/`sameFolder`: a box copy's path reads and writes the
  leader's entry) keep theirs; one "Workspaces" section, no host headers, every copy's threads by
  recency, unread sums, Mark all read and the fleet switches over every
  copy, a down host's rows under the offline tint. A project card and the
  title bar's strip list the same roots of every copy: a thread is housed
  in a batch only under an unarchived pinned master the window knows
  (`batchHome` over `railMasters`, lib/threadStripModel.ts), and Archive
  dormant takes each master it archives with its settled batch
  (lib/archiveDormant.ts, loaded by `archiveDormantThreads` when the row
  is picked); docs/box.md "the card and the strip list the same threads".
  Host status is one Hosts
  row at the rail's foot (`HostsRow` in chrome/HostRows.tsx, two or more
  hosts only): a connection dot per host, coloured only in trouble, and a
  menu with a submenu per
  host (its state, the deploy drift, Switch to, Add workspace here, Mark
  all read, the fleet switches), then Host settings; a boot resume is a
  toast.
  `chrome/HostGlyph.tsx` (12 px, laptop for darwin, server otherwise, the
  name on hover, platform from the hello, remembered on the saved host row
  by `rememberPlatform`, preload for this machine; `lib/hostPlatform.ts`)
  marks every thread and agent row with two or more hosts: the rail, ChildRow,
  the right panel's Agents rows, the spawn row, the Inbox, search, the master board.
  `lib/projectHostChoice.ts` picks a new thread's host (`chooseCopy`: the
  thread on screen's when it is in the project, else the host "New threads
  start on" names when it has a copy and its link is open, else another
  connected host with a copy, else the named one offline; the draft
  rebuild's `preferredHost` reads the same). "New threads start on" is
  `box` (a host that is not a Mac, `startOnHostOf` in
  src/shared/projectLinks.ts, `settingsHomeOf`'s rule) or `mac`: the global
  value is `ThreadDefaults.startOn` (absent = the box; only the global set's
  counts; its row on Settings → Thread defaults shows with two or more
  hosts), a project's own is `ProjectMeta.startOn` (`projects.start_on`,
  `project.setStartOn`, admin, forwarded to the settings home, in the
  settings bundle; the project sheet's New threads section with "Use global
  setting", linked projects only); `startOnOf` takes the copy stamped last.
  No last-used host is remembered (`monocode.linkHosts` is gone):
  `chrome/DraftHostPicker.tsx` in the composer retargets one unsent draft,
  making the copy through `project.ensureLinked` on pick (a chat outside
  every workspace goes to the picked host's home, `retargetLooseDraft`); the master board's
  add sheet offers every host the same way and starts on the master's host
  (the thread on screen). The phone's draft row does not read the setting
  yet: it starts on the draft's saved host, else the project's lead copy.
- **Threads across copies.** `@thread:<env_…>:<id>` names a thread on
  another host (threadMentions.ts; the composer's picker emits the host's
  own id; the attachment carries `environmentId`); sessions.ts reads its
  digest over the new `thread.read` (admin, any thread of that host) into
  the same `.temp-code/refs/<id>.md`, or leaves one line `thread "<title>"
  on <host> is unreachable (<why>)`. The right panel's Agents rows already span hosts
  (the store is global; a far child keeps its parent's bare id).
- **Phone.** `ProjectPairs` folds by `linkId` alone, Home draws one row per
  linked project with the `HostGlyph`, the settings sheet saves on the home
  (`ProjectLinks.settingsHome`); the test server's `TC_IOS_SECOND_HOST=1`
  seeds the link; docs/IOS-DESIGN.md "Two hosts".
- **Tests.** shared/projectLinks.test.ts, remote/projectLinks.test.ts,
  server projectLinks.test.ts, crossHostThreads, crossHostAgents, apptools,
  projectSettingsSync, projectPreamble, sessions-mentions, threadMentions,
  mentionAttachments, agents; the renderer's linkedRail, MergedProjectRail,
  HostRows, BatchMenus, HostGlyph, HostGlyphRows, projectHostChoice,
  DraftHostPicker, AddThreadDialog, ProjectDialogs, projectHome,
  projectPairs; the phone's ProjectPairsTests,
  ProjectLinksTests, EnvironmentStoreTests, FixtureTests.

## Chats outside every workspace stay there
- A thread with neither a project nor a workspace is the home's, whatever
  its cwd, on the Mac or the box: the renderer places it by its ids
  (`workspacePathOfSession` answers "~"; only a path-only row from before ids
  whose cwd is a workspace's folder still sits in that workspace).
- `session.create { workspaceId: null }` creates a thread outside every
  workspace and the host never fills it from the cwd; an omitted
  `workspaceId` (an older or path-only caller) still takes the workspace
  whose folder is the cwd. A workspace made later claims no existing thread.
  The renderer's `ensureCreated` always sends the draft's own workspace,
  null for a home draft (lib/tcserver/commands.ts).
- A home draft runs at "~": `sessionFromDraft` puts a home record saved with
  a folder back at the home, and `newBootSeed` seeds the home when the
  window's last folder is no workspace the catalog knows. Showing a home
  thread moves the window to the home (`project.followSession`, from tab
  activation and opening a thread), so New chat never drafts in the
  window's last folder. The draft host picker moves a home draft to another
  host's home. The phone always names a workspace when it creates a thread.

## Thread notes: the document that survives a compaction
- Every root thread keeps `notes.md` at `attachmentDir(session)/notes.md`
  (the project's `.temp-code/attachments/<sid>/`, so the harness can read
  and write it with its own tools), mirrored in the `session_notes` table
  for the renderer, search and archived threads (src/main/server/
  threadNotes.ts; the text rules in src/shared/notes.ts). Five fixed
  headings: Goal, Decisions, State, Pointers, Open questions; the file
  keeps every heading, prompts and digests embed only the filled ones.
- The harness writes it with the `update_notes` app tool (apptools.ts;
  the codex bridge forwards it as `app.updateNotes`): one section per
  call, `replace` or `append`; the tool reads the file first, so a
  person's edit since the last call is never overwritten. Mechanics text
  (`NOTES_MECHANICS`, src/main/server/notesPrompts.ts) rides every claude
  system prompt through `orchestratorMechanics` and, for other harnesses,
  the first-message preamble's app-tools note.
- The app reminds the thread twice: a `<notes-reminder reason="context">`
  whispered into the live turn once per window when the context meter
  passes 0.7 of the window (reset below 0.5, or at a compaction), and a
  `<notes-reminder reason="commit">` as the app's own short turn (a
  `turn-pass` marker reading "Notes") when a root thread's turn committed
  or merged (`isCommitCall`) without an `update_notes` call; with a queued
  message the reminder rides ahead of it instead. `SessionRegistry.whisper`
  sends into a running turn or holds the line ahead of the next message.
- After a compaction (`compaction` phase `done`) the thread's notes go to
  the harness as a `<thread-notes>` block, into the live turn or ahead of
  the next message. Successors: a thread digest (`renderMirror`, so
  `app_read_thread`, `seedThreadIds` and `@thread:` references) carries
  `## Notes` verbatim between the frontmatter and `## Outcome`, and a build
  thread's first message carries its planning thread's notes
  (`<planning-notes>`) beside the plan seed.
- Wire: `session.notes.get` (read), `session.notes.set` (operate, the
  person's whole-text edit), the `notes` push to every client. The phone
  speaks all three (`ios/TempCode/Sources/Thread/NotesSheet.swift` on the
  client package's `notes` state, `Client/NotesState.swift`; the edit session is
  `Client/NotesEditor.swift`, the text port `Rendering/Notes.swift`; a
  waiting thread's needs-you row on Home reads its State line through
  `Shell/NeedsYouNotes.swift`). `session.search`
  folds notes hits in ahead of the rows (`source: 'notes'`, seq 0).
  Renderer: `lib/threadNotes.ts` (the store on the push) feeds the right
  panel's Notes section at every root thread's edge (`NotesBody` in
  surfaces/threads/NotesPanel.tsx: live markdown, edit with a debounced
  save, "Copy as brief" via `notesAsBrief`), the needs-you banner's State
  line, and the search icon.
- Proof: threadNotes.test.ts, sessions-notes.test.ts (reminders, whisper,
  compaction block, digests, plan hand-off), session-search.test.ts,
  app-bridge.test.ts, the renderer's threadNotes.test.ts,
  NotesPanel.dom.test.tsx and ThreadBanners.dom.test.tsx.
## Away from computer: threads finish without the person
- The state is the person's, one copy per host: `{ enabled, at, by }` and
  the stretch's tally of decisions per thread in the settings table
  (`away`, `away:decided`; src/main/server/away.ts `AwayService`,
  src/shared/away.ts). `away.get` (read), `away.set` (approve: it denies
  every thread's approvals), `away.apply` (admin, the peer leg) and the
  `away` push (src/shared/contract-away.ts). No home host: the Mac sends a
  flip to every link, applies the box's push when newer and never sends it
  back, and link-up settles both ways, newest wins
  (remote/awaySync.ts; docs/box.md "Away from computer: one state on every
  host"). Only a person turns it off.
- The words (src/main/server/awayPrompts.ts): `AWAY_MECHANICS` rides every
  prompt beside the steer rule (claude's system prompt through
  `mechanicsFor`, other harnesses' first message through threads.ts), with
  the `<away state="on">` block while away is on at spawn. The registry
  keeps what each live harness was told (`awayToldAs`): a flip whispers the
  block into every running or waiting turn (`awayChanged`), every other
  thread catches up ahead of its next turn (`takeNotices`: a send, the turn
  pass, a reports wake), so on and off again while idle tells it nothing.
  A master's report gathers its batch's decisions.
- The host backs the prompt up (sessions.ts `interceptAway`, in the emit
  path): while away, a question is answered with `AWAY_QUESTION_REPLY` as
  each question's typed answer and an approval is denied with
  `AWAY_APPROVAL_REPLY` (`DriverHandle.approve(…, reason)`; claude sends
  the reason, the other wires carry no text); the request's row, its
  `waiting` and its resolved row are never written, so nothing reads Needs
  you and the notifier stays quiet; a driver with no resolver yet gets the
  card as usual after one retry. Turning away on answers the cards already
  waiting (`Store.unresolvedRequests`, the newest rows only). The Mac
  bridge refuses a call that would ask its away person
  (`MAC_AWAY_REFUSAL`) and the box writes the row. Each of these, and each
  `note_decision` call (an app tool on every thread, `app.noteDecision`
  over the codex bridge), is one `notice` of kind `away`
  (`away: { kind: decision | question | approval, text }`) that counts
  toward the tally.
- The app: the rail foot's Away row above Settings (chrome/AwayRow.tsx, a
  switch on lib/away.ts, its track from components/ui/switch-track.ts),
  Threads → Away from Computer (a checkbox row, `MenuState.checked`), the
  away notice line folded into the run, and on the way back one toast
  "Decided without you in N threads" with Review (chrome/AwayReturn.tsx,
  AwayReviewDialog in the dialogs chunk). The phone only decodes the rows.
- Proof: `bun run script:e2e-away` (a haiku thread asks a question while
  away and finishes without a card; a flip off reaches a running turn);
  unit tests away, awaySync, sessions-away, macBridge, macTools, the
  drivers' answers and denials, AwayRow.dom, AwayReturn.dom.

## Add-ons: one registry, every harness
docs/box.md "Add-ons and skills: one copy, on the box", "Add-ons: the
add-on host and its tools" and "Add-on grants: signed in on the Mac,
refreshed on the box" are the long account; the plans are
.temp-code/plan-uv2o7r5RN64s.md (data), plan-L1Vrd-CMiZJ7.md (host),
plan-8YMm3ynnFZYs.md (grants) and plan-vJP8mPAPorvc.md (pages).
- **What one is.** An MCP server every harness reaches through the one
  `app` server: a stdio command each host runs, or an http address
  (`AddonSpec`, src/shared/contract-addons.ts). Global (`workspaceId:
  null`) or one workspace's, a workspace row shadowing the global row of
  its name (`visibleRows`); ids `ad_` plus 12, names `ADDON_NAME_RE` (20 at
  most, so `<addon>__<tool>` fits Claude's 64). The rules are pure:
  `addonProblem` (no secret in `command`, `args` or `url`, plain http only
  to this machine, `tokenEnv` only with oauth) and `exposedNames` in
  src/shared/addons.ts.
- **Where it lives.** The `addons` table and this host's
  `addon_tool_cache` (src/main/server/addonStore.ts). No column holds a
  secret: `env` and `headers` name the values, which live in the grant.
  One copy, on the box: `StoreSync` (src/main/server/remote/storeSync.ts,
  beside RulesSync) has the Mac follow the box, seed each shared scope
  once, forward every write and refuse one while the box is out of reach;
  a workspace the box has no copy of stays the Mac's. The wire is
  src/main/server/storeRpc.ts: `addons.list` and `addons.tools` (read),
  `addons.set` and `addons.remove` (admin), the `addons` and
  `addon-status` pushes.
- **The add-on host.** Every downstream MCP client runs in a utility
  process of its own, `out/main/addonHost.js` (src/main/addonHostProcess.ts,
  forked by src/main/addonHostSpawn.ts), never in main or the gateway's
  child. src/main/server/addons/: addonChild.ts (one `Downstream` per
  launch), downstream.ts (the SDK client over stdio or Streamable HTTP
  with the SSE fallback, restarts on 1, 2, 5, 15, 60 s, every grant value
  redacted), addonHost.ts (main's side: respawned, down after three exits
  a minute; `doctor.get` names it). The process guard sweeps an orphaned
  stdio server by its `TEMP_CODE_ADDON` mark.
- **What each harness sees.** Claude: each visible ready tool registered
  live on its `app` server as `mcp__app__<addon>__<tool>`, deferred behind
  tool search (every claude spawn sets `ENABLE_TOOL_SEARCH=true`), its
  schema verbatim (addons/exposure.ts). Codex and Muse: `addon_find` and
  `addon_call` over scripts/app-mcp-bridge.mjs, listed only with
  `TEMP_CODE_ADDONS`, which is fixed at spawn, so a scope gaining its first
  add-on or losing its last reboots their handles at the next turn
  (addons/scopeFlip.ts).
- **The app tools and their cards** (addons/tools.ts): `addon_list`,
  `addon_add`, `addon_remove` (deferred on Claude, always on the bridge),
  `addon_find`, `addon_call`. `addon_add` always asks, and only a person
  with an admin key may allow it (`assertMayAnswer`: "forbidden: approving
  an add-on needs a person with an admin key"; a deny always passes).
  `addon_remove` asks only over an add-on a person wrote last; `addon_call`
  follows the permission (auto runs, edits runs a read-only tool, safe
  asks), its card `Use <tool> from <addon>?`.
- **Grants.** One aliax-core profile of the `addon` service per add-on
  (aliax-core/src/adapters/addon.ts at the commit package.json pins,
  80345ae), `internal`, so no account page lists it. Static when its blob
  has no `oauth` section: typed values reach every host and leave by
  tombstone. An OAuth grant is signed in on the Mac (a host with a
  window), handed to the box by accountSync's two-phase handoff and
  refreshed there; the Mac keeps an access copy. `AddonGrants`
  (addons/addonGrants.ts) reads the vault fresh, refreshes on a downstream
  401, keeps a grant ahead of its end, writes on one host (`writerOf`),
  presents typed values once to the add-on's `initialize`
  (addons/grantProbe.ts) and sweeps a grant whose row is gone. The sign-in
  (addons/oauthFlow.ts, addons/oauthCallback.ts) is PKCE S256 with
  dynamic registration on a fixed loopback port saved before the browser
  opens; every line it says is in src/shared/addonGrantWords.ts. RPCs
  (src/shared/contract-addonGrants.ts): `addons.grant.list` (read),
  `setFields`, `clear`, `refresh` (admin), `signIn`, `cancel` (local); the
  `addon-grants` push.
- **The page.** Settings → Add-ons (src/renderer/src/surfaces/settings/addons/,
  docs/LAYOUT.md "Settings → Add-ons and Skills"); Sign in… is desktop only.
- **Seams.** `TEMP_CODE_ADDON_TRACE=1` (a line per connect, list and exit),
  `TEMP_CODE_ADDON_GRANTS=<file>` (grant values from a file, honoured only
  with TEMP_CODE_USER_DATA), `TEMP_CODE_OAUTH_BROWSER=follow` (a sign-in
  that follows the authorize redirect with no browser).
- **Proofs.** `bun run script:e2e-addons` (two paired headless instances
  and fake MCP servers, scripts/lib/fakeMcpServer.ts, then one real
  claude-haiku-5-5 thread on this user's HOME) and `bun run
  script:e2e-addon-grants` (the same pair and scripts/lib/fakeOAuthServer.ts).
  Both are publish rows with `--gate`, which skips the real-Claude leg;
  docs/release-gate.md "The store and computer proofs" has their times and
  the codex first-turn medians with and without add-ons.
  Their process scans use scripts/lib/procScan.ts: macOS allows 64 MiB
  of output and scan failures never log captured process environments.

## Skills: one store, materialized per host
docs/box.md "Skills: one store, materialized per host" is the long
account; the plans are .temp-code/plan--OsNna4IcfKO.md (the store core)
and .temp-code/plan-JBpcLz-eGMhp.md (the drivers).
- **What one is.** A folder with SKILL.md at its root and the files beside
  it (src/shared/contract-skills.ts), global or a workspace's, a workspace
  row shadowing the global one (`visibleSkills`). `skillProblem`
  (src/shared/skills.ts) refuses a SKILL.md whose frontmatter does not
  name the skill, unclean or secret paths, anything under `<skill>/scripts/bin/`,
  a native binary, past 512 files or 16 MiB, and the name `synced`. The
  `skills` and `skill_files` tables (src/main/server/skillStore.ts) hold a
  skill whole, written in one transaction; `skills.set` and `skills.remove`
  carry `expectUpdatedAt`. One copy, on the box, through `StoreSync` as
  for add-ons.
- **Where it is written** (src/main/server/skills/). views.ts: each
  provider (claude, codex, muse) has a `global` view, and a workspace has
  a `ws-<id>` view only when what its threads get differs. materialize.ts
  (`SkillMaterializer`) writes each view as a generation,
  `<userData>/harness/<provider>/<view>@<12 hex>/skills/<name>/`, built
  beside its place and renamed in, files 0444, an unchanged skill
  hard-linked from the last generation; `gc()` at boot and hourly removes
  a generation no view or scope pointer names. pointers.ts keeps one
  stable path per (provider, scope),
  `<userData>/harness/<provider>/scope/<global|ws-<id>>`, re-pointed by
  rename. skillText.ts localizes the other host's paths in text files
  through memory sync's path map. import.ts runs once, on the Mac: every
  skill under the home folders into the store (`skills-imported:v1`).
- **The app tools** (skills/tools.ts): `skill_list`, `skill_write`,
  `skill_remove`, deferred on Claude and listed by the bridge on every
  codex and Muse thread. A change to a skill a person or an import wrote
  last asks a card; a denial or Away writes nothing; a skill that moved
  since it was read is refused; the answer waits for the write-out.
- **What each CLI reads.** Claude: `CLAUDE_CONFIG_DIR` is an owned dir per
  scope, `<userData>/harness/claude-config/<scope>/` (skills/claudeRoots.ts),
  its `skills/` one link per store skill through the scope pointer by its
  bare name, `synced` the person's account-synced bucket, every other
  entry a link into the person's dir; a routed Anthropic row holds
  `CLAUDE_CODE_OAUTH_TOKEN=routed` for the gateway; a live CLI calls
  `reloadSkills()` at the first send after its pointer moved; the warm key
  splits by scope alone. It is not a plugin dir, since a plugin's skills
  are always named `<plugin>:<skill>`. Codex (skills/codexSkills.ts): each
  home SKILL.md disabled per process (`-c skills.config`), the scope's
  generation as its extra root (`skills/extraRoots/set`), and `needsReboot`
  when a home SKILL.md appeared since the spawn. Muse
  (src/main/server/museConfigDirs.ts): a config dir per (account, scope)
  whose `skills` links the pointer. Muse Code 1.4.14 also lists what it
  finds in other harnesses' home folders (`~/.agents/skills`,
  `$CODEX_HOME/skills`, tagged `origin-family`) and has no switch to stop
  it: a known gap, which the drivers' `--gate` reports on every run.
- **The home folders** (~/.claude/skills, ~/.codex/skills,
  ~/.agents/skills, ~/.config/muse/skills) are no live source after the
  import: never synced, never moved, renamed or deleted. What still reads
  them: the import itself; Codex's scan of the home SKILL.md paths at each
  spawn and turn, to disable them; Claude's `skills/synced` bucket, linked into the
  owned root; Codex's `.system`, which the slash menu still reads
  (commands.ts `configureCommandSkills`, `readHome: false`). Settings →
  Skills (src/renderer/src/surfaces/settings/skills/) says under its title
  that threads read skills from there.
- **The spike.** `bun run script:spike-config-dirs -- --host box|mac`
  (scripts/spike-config-dirs.ts) runs one experiment per id against
  loopback fakes; its answers are in .temp-code/findings/claude-config-dir.md.
  Rerun it after a CLI update.
- **Proofs.** `bun run script:e2e-skills-store` (two headless instances:
  the import, the seed, the views and their path text, a rewrite under a
  reader, the card, the slash menu, a restart) and `bun run
  script:e2e-skills-drivers`: its `--gate` runs the real CLIs of one
  headless instance against the spike's fakes (scripts/lib/spikeFakes.ts),
  and `--host box|mac` runs real turns by hand. Both `--gate` modes are
  publish rows.
- The skills drivers gate uses the user's `~/.bun/bin/bun` through
  `scripts/lib/proofBun.ts`, so an ancestor npm `.bin` cannot select another
  runtime. It waits for the gate build before starting that child.

## Computer use: the Mac's apps from any thread
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
  and what the service refuses.
- **The contract.** The zod in src/shared/computer/ (protocol.ts,
  observation.ts, tools.ts) is the one source; `bun run gen:swift-computer`
  writes the Swift under each target's Generated/, and
  `check:swift-computer` runs inside `bun run typecheck`. The parts:
  Capture (§6, §7: one window, never the desktop; screenshots, the preview
  stream, the pixel signal), Input (§14: the `ax`, `process` and `session`
  tiers, the paste under the clipboard lock), the AX reader (§15: pure
  `AXText`, tested on the box with `sh scripts/computer-text-test.sh`, and
  the Mac's walk), the service shell (§16: the router, the locks, the
  held-input ledger, the exit codes). `bun run computer:test` builds and
  tests the package on the Mac.
- **The host** (src/main/server/computer/, §17). On a Mac with a screen,
  one `ComputerService` (binary.ts; respawned with backoff, down five
  minutes after five crashes in two, shut down after ten idle minutes).
  `ComputerSessions` (sessions.ts) keeps one session per thread: its calls
  one at a time, the bound window, the element book, a live row from a
  turn's first call to its settle. The tier verdicts live in
  `computer.tiers.<bundleId>`, probed once per app. Stop on the Activity
  row (`computer.stop`) ends computer use for the turn.
- **The app tools.** The four `computer_*` tools on every Mac thread,
  subagents too: deferred on Claude (computer/mcp.ts), through the bridge
  on codex and Muse behind a per-thread token. `offersComputerTools` and
  `computerMechanicsFor` (apptools.ts) decide who gets them and
  COMPUTER_MECHANICS (computer/prompts.ts); a cursor thread gets neither.
  The words come in two shapes by the model's maker
  (src/shared/computer/descriptions.ts, §19).
- **Confirmations** (§19, src/shared/computer/policy.ts). In safe and
  edits every act that sends input asks one card naming the app, the
  window and each action; reads never ask. Full access asks only for an
  act the model flagged (`confirm: { kind, what }`) and before text goes
  into a password field. Away denies. Every call's app is pinned to a pid
  first (`TargetResolver`), and TempCode itself and the system's password
  and Touch ID prompts are refused (`refused_app`). Service errors read
  through `errorLine` (src/shared/computer/errorWords.ts).
- **The session tier** (§20, computer/schedule.ts,
  src/shared/computer/scheduleRules.ts) takes the person's pointer and
  keyboard only while they are away: no input for `computer.sessionIdleMs`
  (120 s), or the Away switch and 10 s of quiet; locked or asleep refuses.
  A held step says "Waiting for the Mac to be free" and asks one card with
  Run now and Skip (at once in safe and edits, after 3 minutes in full
  access). One session call at a time per host; the person's app and
  pointer go back after it. A paste waits out the person's copy
  (`RECENT_COPY_MS`). main feeds it `PersonIdle` (src/main/personIdle.ts).
- **What the person sees** (§8 "What the person sees"). A Computer row per
  live session in the right panel's Activity section
  (src/renderer/src/lib/computerSessions.ts, the tier in
  `COMPUTER_TIER_WORDS`), opening on the Mac's desktop onto the live
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
  `macBridge.maxComputer.<envId>` (2) live sessions. §18 and docs/box.md
  "Computer use from a box thread".
- **Seams.** `TEMP_CODE_COMPUTER=0` (off; `=1` serves a headless Mac
  instance), `TEMP_CODE_COMPUTER_BIN` (the binary),
  `TEMP_CODE_COMPUTER_TRACE=1` (every frame), `TEMP_CODE_COMPUTER_PIN`
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
  (docs/computer-protocol.md "The unattended proof modes"). The preview's
  scratch copy of TC Probe draws no highlight on Ping (scripts/lib/previewProbeApp.ts), so its second click
  changes no pixel and the no-frame check holds. The hand runs, each with what it needs:
  `script:e2e-tc-computer` whole (TextEdit and the paste: 5 idle minutes),
  `script:e2e-computer` (real Sonnet turns), `script:e2e-computer-bridge`
  over SSH (the real pair), `script:e2e-computer-ax` and
  `script:e2e-computer-input` (the person away), `script:e2e-computer-capture`
  (Screen Recording), `script:e2e-computer-schedule` (the session tier),
  `script:e2e-computer-preview` whole (it takes Escape for two seconds),
  `script:e2e-computer-images` and `script:e2e-computer-ui` (real model
  turns) and `script:compare-computer-words` (48 model runs, about 25 minutes).
  docs/release-gate.md "Hand runs" has each one's host, needs and last
  time.
- **The bench** (§21). `bun run script:e2e-computer-bench` runs seven real
  desktop tasks on Opus 5.5, GPT-6.1 Sol and Muse Wonder 1.0 side by side
  in the background tiers, each end state read through the AX tree, the
  files or `defaults`; `BENCH_RULE` (scripts/lib/computerBench.ts) judges
  it against `<git-dir>/temp-code-gate/computer-bench/baseline.json`.
  docs/release-gate.md "The computer bench".
- **Fixtures.** src/main/server/computer/fixtures/ (its README): wire
  frames, observation texts and app trees recorded from scratch content
  only (scripts/mac/record-computer-fixtures.sh), held to their schemas
  and the privacy guard by computerFixtures.test.ts.
## Background work and watching: a structured wait on the session row
- The claude driver keeps every live background task as an item
  (`BackgroundTaskSchema` in src/shared/events.ts: id, the model's label,
  `kind` shell | monitor | agent | workflow | cron | other from
  `kindOf(task_type | type)`, `startedAt`, the Stop hook's `command`, the
  starting call's `callId`; a session cron is `cron:<id>`) and emits
  `background-tasks { tasks, items }` whenever the items move (`tasks`, the
  labels alone, stays for old rows, the phone and the MCP facade). The
  registry folds it into `SessionMeta.background` (transient, like
  `activity`): `tasks`, `agents` (live subagent ids), `batch { out, total }`
  for a pinned master's local children, and `watchingSince` (set when a
  status moves the row into watching). A child's status change re-pushes its
  non-root parent and its master. The activity line is `watchLine`,
  "Waiting on <watchSubject>": `watchPhrase` names one task alone by its
  label and one subagent alone by its title, and counts anything more ("3
  subagents, a monitor"; the strip, `wait_for_agent` and the settle report
  read the same words; src/shared/watch.ts, with `STALE_WATCH_MS`
  30 min and `isStaleWatch`), "Waiting on the batch's steps" for a master
  with nothing out. A running turn a `wait_for_agent` holds (the meta's
  `awaiting`) says its agents by title in its activity and `statusDetail`,
  "Waiting on Review the payment flow" or "Waiting on 2 subagents"
  (`waitLine`, `statusWordsOf`; an id `env_…:<sid>` reads by its bare
  `<sid>`), and a parent below the root re-words when its child's title
  lands.
- A wait is a state of the turn, never a transcript row
  (surfaces/agentSteps.ts): while open, `isHiddenTool` hides it and the
  working line says `waitLine` (its `wait` phase, fed by TurnEnd when
  nothing after the wait speaks or runs: `openWaitOf`); once it returns, each agent
  it returned on (`waitOutcomes`: done, idle, watching, waiting, failed,
  error, stopped, paused) folds into the run as an `AgentStepRow`,
  "Finished <title>" (Failed, Needs you, Stopped, Paused by state), the
  same step a report draws; a steered, aborted, timed-out or refused wait
  leaves nothing. A batch spawn draws one `SpawnChildRow` per stamped
  child. Every agent row names its agent by `agentTitle`
  (lib/agentTitle.ts).
- `session.stopTask { sessionId, taskId }` (operate) stops one task through
  the SDK's `query.stopTask` (`DriverHandle.stopTask`); `session.taskLog
  { sessionId, taskId, from? }` (read) answers `TaskLog` from
  src/main/server/taskLog.ts: the task's output file (portSweep's
  `fileOfCall`, else `fileOfTask`), tailed by portLog.ts `readTail`, else
  the call's output in the transcript, else `none`. Neither is in the
  phone's subset. The desktop transcript folds a `background-task` settle
  into the run it woke as one step (`Block.task` in fold.ts, "Task finished
  <label>" through `TaskStepRow`), never a row of its own, beside the
  subagent reports, spawns and host notices that fold the same way
  (`isFoldedStep`, docs/TRANSCRIPT.md "Thinking, closing lines and
  notices"); the event also feeds the digest and the phone.
- A root idle or done whose `background.agents` is non-empty reads
  Watching "a subagent" / "N subagents" wherever `threadStatus` or the
  rail's `rowState` decides (`settledWithAgents`, lib/threadStripModel.ts),
  and the fleet header counts watching on its own ("1 watching, 1 done").
- The title bar's agents cue (chrome/AgentsCue.tsx, left of ⋯): while any
  subagent of the thread on screen (the one its pane shows,
  `useShownThreadId`: a master's open child) works, watches, waits or is queued (by
  `parentId`, any depth; a master's batch is its board's), a quiet 24px
  control (`ROW_CONTROL`): the loudest state's glyph, one 12px provider mark
  per distinct provider of the live agents (`HarnessIcon`, a Meta model's
  maker's mark; one drawing once, `markDrawing`; at most four, then "+N"), and "3 agents", or "1 needs you"
  in amber while one waits; its line "Agents: 1 needs you, 2 working on
  Claude Code and Codex"; working is the still dot while the thread's own
  turn runs; a new count morphs (`MorphText`); a click opens
  or closes the right panel on Agents, pressed whenever the open panel
  draws Agents, by name or as its default (RightPanel reports the section
  it draws, `useShownSection` in lib/rightPanel.ts; `useAgentsCue` in
  lib/threads/agents.ts, woken only for a change in that thread's tree).
  The Agents rows end with a model line: logo, model, effort and context
  window (`ModelLine`, surfaces/threads/ModelMark.tsx).
- Renderer: `lib/activity.ts` joins the meta's `background`, the thread's
  dev servers (its tree's ledger rows and the runs the pane started for it,
  `threadServers`) and its running Mac calls into
  `activityRows` (a master's batch as one row, then oldest first; never a
  row for subagents, which the Agents section lists; a background shell that opened a listed dev server is
  that server's row, matched by call id, else by command; `rowStale`, `hasActivity`, `stopActivity`, `stopAll` =
  `session.killBackground`). `surfaces/threads/ActivitySection.tsx` is the
  right panel's Activity section: 28px rows (glyph, label, the age, Stop;
  a failed Stop toasts), a shell row folding open onto its command and its
  `session.taskLog` output (a monitor writes no file
  the host can read, so it opens nothing; a failed read says so), a dev
  server row the dev servers pane. The slot above the composer (`WorkingStrip`, its rule
  `composerSlotOf` in lib/threadStripModel.ts) holds only the open turn's
  elapsed time and Stop while it works or waits, and the held rows (paused
  with Stop and Continue, stopped with Resume, queued with Start now); a
  watching thread leaves it empty and the transcript's closing line under
  the last settled turn says "Watching" with the stretch's age, amber past
  `STALE_WATCH_MS`, and opens Agents when it waits on subagents, else
  Activity (`watchSection` in lib/rightPanel.ts; `WatchingLine` in
  surfaces/transcript/TurnEnd.tsx, `onOpenActivity` through AgentTranscript).
  The thread on screen is left out of the paused banner (every thread has
  the slot, an orchestration parent's too, and no transcript draws the live
  turn under it) and out of the
  recovery banner for its own failure (its FailureCard has Continue; a
  failed descendant keeps the line). A watch is
  stale (`isStaleWatch`: the amber age, the banner) only past
  `STALE_WATCH_MS` on the thread's own tasks alone: live subagents and a
  master's batch have their own liveness, and Stop all
  (`session.killBackground`) ends only the thread's own background work;
  `chrome/ThreadBanners.tsx` `staleWatchers` adds one banner for the other
  roots of the project watching stale.

## Review before merge: an optional second model between the gate and the merge
- Off by default. Settings → Reviews holds the global set; a project's
  settings sheet (its Reviews section) overrides it whole, with "Use global
  setting" to go back. Keys: `review` and `review:project:<id>` in the
  settings table (`src/shared/review.ts` ReviewSettingsSchema: beforeMerge,
  provider + model (default codex gpt-6.1-sol at high; the picker shows only
  models the orchestration rules approve and this machine can run), blockOn
  `confirmed` | `any`, maxMinutes 15). RPCs `review.get` (override, global,
  effective + source), `review.set`, `review.override` (approve).
- The hook is the `merge_branch` app tool (`src/main/server/mergeReview.ts`,
  the git side in `mergeBranch.ts`), on every thread, claude in-process and
  codex over the bridge: it fast-forwards the project branch to the named
  branch in the project checkout (default: the branch the thread's directory
  is on; a thread working in its own worktree passes `branch`) and pushes
  when the repo has an origin. With the set on, it first starts a reviewer
  child (agentType reviewer, parentId = the thread, titled `Review: <branch>
  → <target>`, run in the worktree that has the branch) with the diff against
  the merge-base, the commits, the files and the thread's first message, and
  waits for ONE `report_findings` call (the ReportFindings shape: file, line,
  summary, failure_scenario, verdict) or the time limit. Why a tool and not
  an intercepted `git merge`: the harnesses own the model's shell, a git shim
  would miss `git -C`, aliases, scripts and hand-typed pushes, and a held
  merge has to be READ by the model as the next thing in its turn. The
  implementation preamble and the turn pass tell a reviewed project's
  threads to merge only through the tool. `TEMP_CODE_REVIEW_STUB_FILE` makes
  the reviewer report that file's findings (the proof).
- Outcomes land as `notice` rows (kind `review`, payload ReviewNotice) that
  the transcript renders as ReviewCard.tsx: pass → merged, "Reviewed by
  GPT-6.1 Sol: no blocking findings (2 minor)"; blocking findings → the
  merge is held, the card lists file:line, summary and failure scenario with
  a chip to the reviewer thread and "Merge anyway" (`review.override`, which
  merges the branch as it stands now and rows "Merged anyway"), and the tool
  answers "HELD … Address these before merging, then call merge_branch
  again"; timeout → the reviewer is interrupted and the merge proceeds with a
  row saying so; a reviewer that ends without reporting → "failed to run",
  merged. A head that passed is not reviewed twice (a failed push retries
  without a new reviewer). Runs persist as `review:run:<id>` so Merge anyway
  survives a restart. A reviewer's settle never wakes the implementation
  thread (orchestration.ts `suppressSettleReports`): the verdict already came
  back through the tool. Reviewers are ordinary children: in the subagent
  list, archived with the thread, in the Inbox only when their own run
  errored. Proof: `bun run script:e2e-merge-review` (headless instance, a
  scratch repo with a bare origin, two real haiku threads, the stub file
  for one blocking finding then none; build first).
  The gate before the fast-forward (typecheck alone for a batch child, the
  commit tier for a thread outside a batch, both on the host's `GateQueue`)
  is "Master threads" below: the review decides whether the branch may
  merge, the gate whether the tree is green, and a head that passed review
  is not reviewed again when its gate held it.

## The desktop transcript: a viewport window, markdown in a worker
- Renderer retention rules live in docs/RENDERER_RETENTION.md. An unfinished
  history head keeps every persisted row and only the newest partial input
  per tool call, in that call's first replay slot. The shared attachment
  cache is a 64 MiB LRU (two bytes per data URL character); failed reads
  retry. Host-job text keeps the last 512 Ki code units plus one truncation
  line, using the host's shared cap. Dev-run logs leave with their runs or
  host. Resource and Mac approval installers attach each existing link
  once through `onLink`'s replay. `perfMark` keeps at most 200 `tc:` marks,
  clearing the oldest name as a group; listeners still hear every mark.
- `src/renderer/src/surfaces/AgentTranscript.tsx` mounts only the rows that
  meet the viewport plus a screen of overscan each way. The thread is a flat
  list of rows (`transcriptRows.ts`: one per turn item, one closing row per
  turn, a `more` row for the remote profile's "Load earlier messages"), laid
  out by `lib/transcriptWindow.ts` (`RowLayout`: estimates until a
  ResizeObserver measures, offsets as prefix sums, the window range, the
  reader's anchor row, `anchorShift`). A measurement writes the container
  height and the offsets below it to the DOM and moves the scroll offset by
  the growth above the anchor row; the tail row growing while streaming
  touches its own box and the container height only. Scroll memory is the
  anchor row (`TranscriptScrollMemory.anchor`); the message list
  (surfaces/TranscriptOutline.tsx: the person's messages down the left
  side, a zero-height sticky child of the scroller placed by
  `outlinePlacement`) and search hits jump by block id through
  `scrollToRow`, which lands exactly once the row is measured (a keyboard
  jump with `instant`, no glide). Never put `content-visibility` or size containment on a row:
  the window measures natural heights.
- The streaming reveal (surfaces/smoothText.ts) holds a lead behind the live
  end (seeded 100 ms, 250 ms for another host's thread, grown by an
  underrun, decaying back), never runs slower than the stream, shows every
  character within 1.5 s of arriving, drains at the stream's end instead of
  snapping, and reveals a row born live (`RowBornContext`) from its first
  word (docs/TRANSCRIPT.md "The stream reveals a phrase at a time"). Inside
  an open fence a code line shows once its newline arrives (held
  `REVEAL.lineHoldMs`, then by words) and fades in as its own element
  (CodeBlock draws a `<span class="line">` per line, `splitColoured`; the
  row's reveal reaches it through `StreamRevealContext`, `lineTimes`); a
  list item, table row, heading, quote line or fence born mid-stream rises
  4px as it fades (`.stream-rise`); and a box that grows while it is read
  glides to its height (lib/heightGlide.ts `useHeightGlide`: the open tool
  table on the layout spring, a streaming code block's body on
  `--dur-base`), rows landing together staggered `--stagger-step` apart.
  `watchMotion` in the no-jerk runner and the soak's `--height-report`
  hold it.
- Settled markdown parses in `lib/markdown.worker.ts` (streamdown's own
  block split and plugin chain, shared through `lib/markdownPipeline.ts`);
  the answer fills the hast cache under each block's text and the row
  mounts the cached tree with no parse on the main thread
  (`lib/markdownParse.ts`, `useMarkdownReady`). Streaming rows keep the
  incremental main-thread path. With no `Worker` (tests, node), or one that
  fails, throws or never gives a first answer (8 s), every text is ready at
  once and the main thread parses as before; once the worker has answered,
  a request past 1.5 s parses that row alone on the main thread (the
  worker keeps serving the rest), a row that unmounts cancels its request,
  and the ready set is a 4,000-digest LRU tied to the hast cache. The renderer aliases
  `decode-named-character-reference` to its plain build (the DOM build has
  no document in a worker); keep that alias when touching the vite config.
- Opening a box thread is round trips (about 200 ms each from the Mac),
  not bytes: over a remote link a cold open is ONE request,
  `session.events { tail, subscribe: true }`, answered `subscribed: true`
  (an older host omits it and the client subscribes and folds the gap);
  the store keeps the last `KEEP_RECENT` (6) transcripts whose panes left
  loaded and subscribed, so a switch back sends nothing; the markdown
  worker parses one commit's texts newest first. docs/TRANSCRIPT.md
  "Opening a thread on another host" has the numbers. The local profile's
  `session.events` reads on the reader worker in 4 MiB pages
  (`registry.eventsAsync`), so the renderer's head walk ends on an empty
  page or at the tail's first row, never on a page shorter than it asked for.
- The scroll engine's frame loop rests once its glide, runway and follow
  spring have settled, running thread or not; new rows, the content
  growing, a resize and the reader's input start it again
  (docs/TRANSCRIPT.md "The follow loop rests when it has settled"). The
  editor's navigation past the end of a file waits at most 120 frames
  (surfaces/navigationRetry.ts).
- Measure with `bun run script:measure-transcript-seed` once, then
  `TEMP_CODE_PROFILE=1 electron-vite build` and
  `bun scripts/measure-transcript.ts --label <name>` (an isolated instance
  under /tmp/tc-transcript-measure on its own display; never the user's
  data). docs/TRANSCRIPT.md has the rules, the budget and the before/after
  table.

## The interactive lane: the thread on screen goes first
- `session.focus { sessionId | null }` (operate): each socket names the
  thread its window's focused pane shows (`FocusSignal` in
  lib/tcserver/commands.ts, sent from SessionPane's focused-pane effect,
  null while the window is blurred or its person is away: locked, asleep or
  no input for 2 minutes, src/main/attention.ts over `app:attention`; again
  after a reconnect). The host's
  `FocusSet` (src/main/server/focus.ts) keeps the union across sockets,
  widened to subagents and a focused master's batch; a closed socket drops
  its own. `RunningServer.isInteractive` and the scheduler's `focused` hook
  read it. Beside it the socket names `shown` (the same pane's thread while
  the document is visible, whatever the window's focus or attention), which
  makes that thread's rows leave the push coalescer at once
  (`FocusSet.pushesAtOnce`); nothing else reads it.
- Requests sort into lanes (src/main/server/lane.ts): interactive (names an
  interactive thread, or the renderer marked it `lane: 'ui'`: send,
  approve, answer, stop, pause, resume, start now, archive, the fleet
  switches), bulk (project.changes, project.compare, git.diffStats,
  git.diffIndex, an unfocused checkpoint.status, search.project,
  session.search, commands.list, github.*, resources.*, doctor.get,
  fs.watch, the deploy, publish and sync methods), normal (the rest). Two
  of them answer from a host cache, since the panels ask on every mount,
  focus and branch change: `github.prStatus` for 60 s per checkout and
  branch (concurrent asks share one gh child; the host's own PR and
  comment mutations forget the checkout, `invalidatePrStatus`),
  `project.compare` for 30 s per checkout, target and HEAD
  (`COMPARE_TTL_MS`), and `git.diffIndex` / `git.branches` for 3 s per
  checkout while the git dir's HEAD, index, reflog and refs have not moved
  (gitops.ts `gitDiffIndexCached`, `gitCacheTtl`; the host's own readers
  call the plain functions). No helper child forks from the main process:
  every git, gh, ps, ss and lsof runs from the exec broker's utility
  process (src/main/server/execBroker.ts, spawnBudget.ts; docs/box.md
  "The exec broker"), and the guard reads /proc on Linux (procScan.ts). attach() answers through
  `serve(req, sendFrame)`; the `LaneGate` runs bulk two at a time while the
  loop's mean lag is under 50 ms, joins a duplicate read (method and a
  digest of params, from any socket) to the one waiting or running, runs a
  write or fs.watch each in its turn (dropped if its socket closed first),
  and runs anything that waited 20 s, up to twice the bulk cap at once. The
  path fence runs before the gate.
- Pushes: a socket's own focused thread's rows go at once; other threads'
  rows wait 33 ms, or 100 ms locally and 250 ms remotely while the loop
  lags (wire.ts `eventsWindowMs`). A socket whose send queue passes the
  backpressure mark sheds the unfocused session and event pushes (the
  replayable ones; control and peer frames stay) and tells the client to
  `resync` once it drained to half; one past 64 MiB is closed (1013,
  `SocketBudget` in wire.ts). Stall lines end
  `lane=bulk:<running>/<held>`; the renderer reports `first-paint
  session=<id> host=<env> ms=<n>` past 500 ms (lib/firstPaint.ts).
- The host's own jobs pause on `yieldUntilIdle` (cold mover, turn index
  backfill, fold sweep, mirror backfill, archive and attachment sweeps) or
  run through `whenLoopIdle` (liveness sweep, headroom.json save, accounts
  rebuild); the scheduler pass waits for a quiet loop and comes at most
  every 250 ms while the loop lags.
  Server close stops that registry's thread mirror timers and awaits its writes before closing the reader and database (`mirror.ts`, `stopMirrors`).
  `SessionRegistry.disposeAll()` marks the registry closed first, clears pending titles and timers, and keeps late title, fold, driver and report callbacks from using the store.
- Proof: `bun run script:e2e-interactive-lane` (200 git.diffStats against a
  scratch repo beside a focused socket reading a 2,000-row thread; on the
  Mac: focused p95 3 ms, 15 git children where 200 runs would spawn 600).

## The renderer over time: React 19.3.1, the soak, a push re-renders only what it changed
- react and react-dom are 19.3.1: 19.2.8's development build wrote a
  `performance.measure` with a props diff for every component re-render
  with changed props and never cleared it, about 1.2 KB of native memory
  each, 51,000 a minute on the box: the 8 GB a dev window reached. 19.3.1
  clears each one at once (lib/reactDevMeasures.dom.test.tsx holds it).
- `bun scripts/measure-renderer-soak.ts` soaks a built tree's window
  (`--build prod|dev`, `--host synthetic|box`, `--view board|stream|split`,
  `--minutes`, `--every`, `--label`, `--tree`, `--gate`, `--scene
  board|chat|typing|switch|send|scenarios` (switch: the rail's two workspaces
  clicked in turn, each click timed to its column and strip and to its
  landing thread's rows, `--workspaces a,b`, `--clicks`, scripts/lib/soakSwitch.ts,
  a hand-run scene; docs/box.md "Switching workspaces"; send: messages sent
  from the master's composer into its 5,000-row history (`--history`,
  `--sends`, `--load-all` pages it all in, `--peer-delay <ms>` slows the
  synthetic host's answers), each timed to its row's first frame, to the
  composer emptying and to the host's answer, judged by `SEND_RULE`, a
  synthetic hand-run scene; docs/box.md "Sending into a long thread";
  scroll: the master's transcript, its board, the rail and the workspace
  column each turned by the wheel at 60 Hz for `--wheel` seconds and flung,
  every animation frame's interval kept, judged by `SCROLL_RULE`,
  `--surfaces`, `--host box` read-only, scripts/lib/soakScroll.ts;
  docs/box.md "Scrolling while threads work"; typing: the master's composer typed into
  beside its board in phases under the board's load, the master's churn and
  a 3,000-edit live-edit flood every 10 s, scripts/lib/soakTyping.ts, judged
  by `TYPING_RULE`; docs/box.md "Typing on a busy master"; scenarios: the no-jerk timeline of
  scripts/lib/soakScenarios.ts played once, with `--screencast <dir>`,
  `--reduced-motion`, `--scrolled-up`; never the gate; docs/TRANSCRIPT.md
  "No jerk in any scenario"), `--trace <s>` (scripts/lib/soakTrace.ts: main-thread frames
  by what they held, animation-frame and timer callbacks by function, busy
  time per renderer thread, each animation's compositing verdict),
  `--eval <js>` (an experiment run in the page); `--why` on a dev
  build tallies the props React's diff names as changed and who rendered
  them) on a fresh userData under /tmp/tc-soak, windowed (xvfb-run off
  macOS), and judges it (scripts/lib/soakJudge.ts). The synthetic host is
  scripts/soak-host.ts over scripts/lib/soakHost.ts (a real server in a
  child: bun with the electron stub on Linux, an esbuild bundle under node
  on macOS, whose bun has no node:sqlite; a pinned master,
  sixteen batch children, the fixed load of scripts/lib/soakLoad.ts; with
  `--scene chat` one plain chat thread with the focused child's load,
  CHAT_PROFILE, shown as a stream; with `--scene typing` TYPING_PROFILE,
  paused and resumed over the host's stdin;
  `bun run script:soak-host-check` proves the load reaches a socket, `--
  --scene typing` its live edits and the master's metas too); box
  mode pairs read-only and revokes at exit. The window opens through
  `window.__monocode.open(sessionId, { split })` (every build; lib/monocodeOpen.ts)
  and runs inactive and unthrottled (`TEMP_CODE_SOAK_WINDOW=1`, honoured
  only with TEMP_CODE_USER_DATA; src/main/soakWindow.ts). The gate rows
  `renderer-soak` (`--gate`: the board scene, split) and
  `renderer-soak-chat` (`--gate --scene chat`) each run a 50 s window
  inside 90 s (heap after GC ≤ +6 MB, RSS after GC ≤ +30 MB, no long task
  over 200 ms, ≤ 250 ms of long tasks a second, and CPU under the scene's
  bound, `GATE_CPU_PCT`: the scene's highest Mac figure plus a margin, board
  33% where it reads 29% on a quiet Mac and 20-22% on a busy one, chat 22%
  where it reads 15% busy; each fails the publish;
  `--cpu-report-only` reads CPU without failing for a hand run; docs/box.md
  "The soak's two scenes" has why the board cannot reach 12% while the
  phrase fade and the spinners stay as designed), and
  `renderer-soak-typing` (`--gate --scene typing`, about 65 s inside the
  same 90 s: keystroke to frame p95 ≤ 16 ms idle and ≤ 33 ms busy and fast,
  no long task over 100 ms while typing, every phase's text exact; CPU
  reported, not judged), and `renderer-soak-scroll` (`--gate --scene
  scroll`, about 40 s: 4 s of wheel and a fling on each of the four
  surfaces, every one moving and no long task while it does; the frame rate
  and the longest frame reported against `SCROLL_RULE` until a run on the
  Mac sizes them). Each soak in
  release-publish waits for `$STAGE/build.done`
  (TEMP_CODE_SOAK_BUILD_DONE), elsewhere it reads out/bundle-map.json's
  `head` stamp and builds when out/ is not HEAD's clean build. docs/box.md
  "The renderer over time" has the numbers; docs/RENDERER_RETENTION.md the
  bounds on the renderer's caches and logs.
- A push re-renders only what it changed, and these keep it so: an equal
  `session` push schedules no flush (store `mergeMeta` returns whether it
  changed anything); a thread row keeps its object while it reads the same
  (workspaceSessions `cachedRow`/`sameRow`), so do the rail's marks
  (`useWorkspaceMarks` computes outside React and shares mark by mark),
  the focused tree, the title bar's strip model and shelf
  (lib/keptValue.ts `useKept` with `sameSet`/`sameData`), a board row's
  meta while only the live context or an event's stamp changes
  (`sameShownMeta`), the board's agent summaries per changed child, and
  the approval toasts (`HiddenApprovalToasts` reads the store's
  pending-approval index, `usePendingApprovals`, ids, title, tool and label
  only, its builder installed by lib/approvalToast.ts so the store imports
  no transcript wording; chrome/toastSync.ts calls sonner only for added,
  changed or removed ids and dismisses an owner's toasts when it unmounts).
  A keystroke forces no layout and renders the field alone (the field sizes
  itself, lib/composerHeight.ts: only a paste, a restore, a quote or a
  replaced range eases its height, the inline height cleared after). A
  live-edit push costs one pass however many items it carries (store
  `applyLiveEdits`: one copy per session, one notify). A step's log line
  renders the board's foot alone: the batch state lives in a holder
  (useMasterModel.ts `BatchHolder`) the foot follows whole, the view reads a
  kept projection (`useBatchView`), each row is a memoized `BoardRow` and
  the master's chat is built only for new render functions; AgentTranscript
  is memoized. A scroll re-renders what scrolls: a virtualizer re-renders
  the component that holds it whenever its range or `isScrolling` moves, so
  it lives in a list component of its own (MasterView.tsx `BoardList`), and
  a scroller's children take no pointer while it scrolls
  (lib/scrollActivity.ts `QUIET_ATTR`, `SCROLL_QUIET_MS`; index.css), so rows
  sliding under a still pointer turn no hover. The rail card's clock reaches the time alone (`LineElapsed`,
  `CardAgo` on the shared tickers; `CardNowContext` fixes them for a
  fixture), and its master block, batch lines and agents lines are
  memoized. The composer keeps its session by `sameComposerChrome`
  (lib/session.ts `COMPOSER_FIELDS`, a proxy test fails on a read outside
  it) and reads its meta through `useSessionMetaValue`, one primitive at a
  time, so a busy master's activity renders no composer. A parked
  transcript (its tab behind `content-visibility: hidden`) reads and writes
  nothing on a resize or a push and catches up when it shows; its
  `--transcript-viewport` is written only when it moves (a custom property
  restyles every row under it). Every `RowsContextMenu` mounts its body on
  the first right-click (`lazyMount`, lib/lazyMenuGuard.test.ts). A component that only needs the metas when a
  menu opens or a click lands reads `sessionStore.metas()` then, never
  `useSessionMetas()`: a hook subscribed to the metas renders its component
  on every push, whatever it returns. Keep the hot parents compilable by
  the React Compiler: no ref read or write during render (latest-callback
  refs are written in a layout effect), no prop mutation, no cast in a
  computed key, and a ref callback taken out of its hook's object before it
  reaches a `ref` prop (`useDragResize` gives `attachPane`). In the
  transcript a delta re-renders the row it changed and the closing row:
  `RowView` compares its row by what it draws (`sameRow` in
  transcriptRows.ts), since the live turn's rows are new objects at every
  flatten; a settled turn keeps its row objects and their height estimates
  while its blocks array, its index and the row above it stay
  (`settledRows`, `estimateRowHeight`), so a send builds and measures the
  last turn's rows alone, however long the thread; and only
  the live turn's closing row is handed the session (`rowTurnState`; a
  notice reads it from context). Chrome that reads a thread's status, host
  or model never subscribes to its streamed text: the composer and the
  working strip get the session `useThreadChat` keeps while only streamed
  text changed (`sameSessionChrome` in lib/session.ts, `ThreadComposer`
  memoized, its callbacks stable), and a hook outside the pane reads it
  through `useSessionChrome` (the store), never `useSession`.
- Nothing that moves asks for a frame it does not paint: every requested
  frame runs the page's style, prepaint and layerize on the main thread,
  144 a second on a 144 Hz screen. The spinner turns the HTML box around
  its arc as a Web Animation (components/ui/spinner.tsx, `SPINNER_TURN`):
  on macOS a turn on the svg, CSS or Web Animation, ran a main-thread frame
  at every display frame, and a board's 35 spinners took 37% of a core. The
  streaming reveal (surfaces/smoothText.ts) steps whole words every 100 ms
  (`REVEAL.stepMs`, `revealCut` holding a bare block marker and a table's
  header row until they have content) and waits on a timer between steps;
  each step fades in as one span, a CSS opacity animation the compositor
  runs (`.stream-step`, lib/streamReveal.ts, a rehype plugin per streaming
  row, named per row because streamdown caches processors by plugin name),
  and the settle waits for the last fade (docs/TRANSCRIPT.md "The stream
  reveals a phrase at a time"). The working line's words shimmer
  (`WorkingText`: a masked band and its `::before` copy of the words moved
  by transform alone, every 3 s) beside its three-dot mark (`WorkingMark`),
  both Web Animations on the document timeline that the compositor runs,
  unmounted or still in a hidden pane or document. A streaming code block colours on a 150 ms throttle.

## The shape that scales: many threads exist, a bounded number run
docs/box.md "The shape that scales" has the before numbers, each step's
proof and the sizing rules; the pieces, by name:
- `doctor.profile` (admin): an in-process CPU profile of the main process
  into `<userData>/logs/profiles/`; Help → "Profile the Host for 10 Seconds" on
  the Mac, `tc-local doctor.profile` on the box; read it with
  scripts/profile-summary.ts, the stall log with scripts/stalls-summary.ts.
  `currentLag()` and `untilLoopIdle()` in stalls.ts are what the lane and
  the host's own jobs read.
- `session.focus` and the lanes: "The interactive lane" above.
- Checkpoints are the host's (src/main/server/checkpointTurns.ts): every
  send refreshes the baseline (`CheckpointStore.ensure`: one `git diff`
  listing per send, none per path; a path that became dirty between turns
  is the person's, snapshotted, never claimed by the settle's sync, never
  undone, and shown only once a write tool edits it, when Undo restores
  their bytes), a
  settled live edit costs a set lookup (a baseline path's is a no-op), a write tool's complete call (Edit,
  MultiEdit, Write, NotebookEdit) touches the path its input names the same
  way (`writtenPath`; the Edit tool writes through a temporary name and
  renames it onto the target, so the checkpoint never depends on what the
  watcher saw), the mid-turn flush writes only paths on disk and the settle
  forgets a path neither HEAD nor the disk has (made and removed inside the
  turn, or the tool's temporary file whose edit settled after the turn),
  a turn's settle writes the manifest and syncs once and pushes
  `checkpoint-changed`; status, undo and keep take a sessionId only. The strip above the composer
  (chrome/SessionReview.tsx) is their only control, and its Undo confirms.
- A thread's pane tells `loading`, `slow` and `failed` from empty (the
  store's `load` phase, request deadlines and retries in
  lib/connection/transport.ts and link.ts); empty is the host's word
  (`load.empty`: loaded with no persisted row), never a page that folded to
  nothing, and a fetch in flight is joined only by the owner it was made
  for (docs/TRANSCRIPT.md "A fetch belongs to its owner"). A tab restored
  at boot is the store's thread, never a layout stub's: `loadSession`
  answers the store's session when the active pane's first load fails
  (the host's socket not open yet) and the pane retries, and
  `sessionStore.mutate` gives a stub (born of `newSession`, no `status`)
  for a thread the host has named the meta's fields, so a restored master
  keeps `isMaster` and opens on its board (store.test.ts "a layout stub
  for a thread the host has listed", sessionStore.test.ts "loadSession
  when the host is not connected yet"). `ensureMeta` asks the owning host
  first (the entry's, a mirror row's, or a named host), then only
  connected hosts, once each with retry off; past a 300 ms window a tab
  opens a provisional entry the meta fills whole or that reads `gone`, and
  a pane whose thread is gone shows "No longer on <host>" with Close tab
  and Open archived (`SessionGone`); the new-chat screen is a project's one
  remembered draft (lib/projectDrafts.ts, keyed like the strip order, never
  a chip, opened by every New thread path through App's `openProjectDraft`;
  its draft row's "Name this thread" field (chrome/DraftTitleField.tsx, 80
  characters, kept on the record as `title`) is the thread's title from the
  first send, `session.create { title }`: a title that is no placeholder
  (src/shared/placeholderTitles.ts) is never sliced from the message nor
  replaced by the generated one, and an empty field leaves both as before;
  the phone's New thread sheet has the same row;
  coming back to a project, a workspace or the home takes one rule,
  `landingOf` in lib/projectLanding.ts: the newest root that runs or needs
  you (a batch thread's master on its board), else the newest unread (the
  rail's rule), else the newest unarchived root at rest, else the draft
  only once nothing unarchived is left; never an archived thread, and no
  remembered thread or open tab outranks it),
  and the host archives empty placeholder threads a day old at boot
  (`archiveEmptyThreads`); the board under Search, Inbox, Notes,
  Accounts or Settings is parked (`.board-parked`), never display:none.
  A provisional entry resolves on its host's word, never as a draft
  (`resolveProvisional`: the archived sets, owner first; `gone` only once
  the owner listed and answered; `settleDrafts` skips it), and a saved tab
  whose thread existed (`persisted` on its layout stub, or a titled stub
  saved before the stamp, `isPersistedStub`) that no host answered for at
  launch restores as one (`restoreProvisional` in lib/sessionStore.ts)
  carrying its title and place. The host refuses `session.events` for an
  id it shows no row for (`unknown session: <id>`, wire.ts
  `sessionEvents`), which the store reads as `gone` with the meta out of
  the lists. The new-chat screen (`EmptySession`) is a draft's alone; a
  thread its host holds with no rows shows the composer under one muted
  line (`NoRowsLine`: the failure summary, else "No messages yet"). An
  `adopt` loads like any open unless this window created the thread empty
  (`{ created: true }`: a draft's first send, an appshot chat). Delete
  keeps the window on its project (lib/threadDelete.ts `planThreadDelete`,
  decided from the layout before the delete, since `session-removed`
  lands ahead of the answer): the neighbour chip takes the thread on
  screen's place (`deleteNeighbour`, Archive's rule without the outside
  chip), else another tab of the project, else the project's empty
  screen; a split loses only the pane.
- `batch.board { masterId }` (read): the master board's one answer;
  "Master threads" above.
- The gateway's byte path runs in a utility process ("Provider traffic"
  above); the route scope carries the model, so no body is parsed.
- Stats off the loop: `aliax:stats:get` ran the Stats bundle (a dozen
  synchronous `node:sqlite` aggregates over 30 to 120 days, queries.ts) on
  the main loop, 3.2 to 3.5 s every other open once its 60 s cache missed,
  and the first open ran the index (indexer.ts: `statSync` per file, a
  per-line parse, prepared inserts) beside it. Both run in the stats worker
  now (`src/main/aliax/stats/statsWorker.ts`, a fourth main entry beside
  `gateway` in electron.vite.config.ts, a worker thread `statsService.ts`
  starts over `<userData>/stats.db`): `statsEngine.ts` is the index and the
  bundle over one connection (the bundle cached in the worker until it
  writes anything: an index pass, a usage sample, an app event),
  `statsHost.ts` is main's side (one bundle ask in flight shared by every
  caller, the progress mirrored, the samples and app events forwarded, one
  restart, then `unavailable`: the last bundle it gave, else an empty one,
  with the reason on `StatsBundle.unavailable`, which the Stats page says as
  one red line under its title; Reindex starts a worker left down again); the pages' three handlers
  and aliax.ts's usage sample and app event hooks go through the host, and
  main never opens stats.db. Proof `bun run script:e2e-stats-loop` (the
  box's real logs indexed twice, on the loop and through the worker, the
  loop's worst lag under each).
- `admission.get` / `admission.set`: the running cap; "Master threads"
  above.
- A project switch: `bun run script:measure-project-switch`
  (scripts/measure-project-switch.ts, on the Mac: a TEMP_CODE_PROFILE=1
  build under a fresh userData, paired read-only to the box and revoked at
  exit, the named threads with the right panel on Changes or closed, a
  scratch workspace with N untracked files) prints click → paint, long
  tasks, React commit time, the Changes rows mounted and requests per
  click; docs/box.md "Measuring a project switch" has the table.

## The iOS contract package is generated
- `ios/TempCodeContract` holds the Swift `Codable` types of the remote wire,
  generated from zod by `scripts/gen-swift-contract.ts` (`bun run gen:swift`).
  `src/shared/wireSchemas.ts` is the zod for every server → client shape,
  pinned to its interface by type-level checks that the typecheck runs; the
  generator's `SUBSET` array is the one list of what the phone speaks.
- Never edit `Sources/TempCodeContract/Generated/`. Change the contract,
  run `bun run gen:swift`, commit the output: `bun run check:swift-contract`
  (inside `bun run typecheck`) fails the gate when it is stale, and
  `bun run ios:test` (in the gate too) builds and tests the package.
  Fixtures under `Tests/Fixtures` come from a real server through
  `bun run script:capture-swift-fixtures`; re-record them when a captured
  shape changes (on the box, where the esbuild → node path fails:
  `bun --preload ./scripts/lib/electron-stub.ts scripts/capture-swift-fixtures.ts`).
  The capture reads a scratch deploy directory, never the machine's own log.
  The package README has the subset policy and what L2
  (the socket actor) builds on it. The subset covers the master, notes,
  project-plan, review, plans, resources, devices, deploy, Mac bridge and
  accounts methods and their pushes (`notes`, `batch`, `resources`,
  `boot-resume`, `accounts`, `host.devices`, `host-log`, `macBridge.held`);
  the README's table is the list, with the capability each needs. The
  generator refuses a `local` method (`jsonSchemas` throws), names
  `BuildFacts` and `NoticeKind` once, and `scripts/gen-swift-contract.test.ts`
  pins its rules; `DecoderRulesTests.swift` proves the decoder on
  hand-written JSON, so it passes before the fixtures are re-recorded.

## The iOS client: ios/TempCodeClient and ios/TempCode
- docs/IOS-DESIGN.md fixes the phone's design: information architecture
  (Home in two levels shaped like the desktop's sidebar, a project as its shell in the detail; Inbox; Search), the thread
  screen per type (board, plan, fleet, sources as the hero with the chat as
  a second segment), tokens, exact motion values and the performance rules.
  iOS threads build to it and do not re-decide what it states.
- The phone's numbers are written once: the transcript's type and lengths
  are the client package's `TranscriptScale` and `TranscriptLengths`
  (Design/TranscriptScale.swift; the desktop's ladder on iOS text styles,
  prose 15/22, lines 13/20, details 12/16), drawn through Tokens.swift's
  `.transcriptType(_:)`, `TranscriptType` and `TranscriptMetrics`; the
  Live Activity target links `TempCodeClient` too, since it compiles the
  shared Tokens.swift. The desktop in-out curve is asymmetric; its Swift
  test checks its Bézier midpoint rather than assuming symmetry. The
  motion numbers are `MotionValues` (Design/MotionValues.swift, the
  desktop's durations, curves, springs, holds and loops exactly), which
  Design/Motion.swift turns into animations. Two vitest guards run on the
  box: scripts/ios-motion-parity.test.ts fails when a `MotionValues` line
  differs from index.css, lib/ease.ts or the holds, and
  scripts/ios-literal-guard.test.ts counts every literal duration, curve,
  font size or row height under ios/TempCode/Sources/{Thread,Shell,Design}
  outside Tokens.swift and Motion.swift against a per-file allow-list that
  only shrinks (`IOS_LITERAL_GUARD_PRINT=1` prints the tally).
- `ios/TempCodeClient` (Swift 6 package on the contract package) is the
  phone's connection runtime: `TempCodeSocket` mirrors the desktop supervisor
  (ticket, hello checked against the paired id and contract, jittered backoff
  to 5 min reset after 30 s up, probes on foreground/online/retry, a 10 s
  background grace), `Subscriptions` resumes with `afterSeq` and honours
  `reset`, `SessionCache` is the sqlite3 mirror a cold launch paints from,
  `EnvironmentClient` is what SwiftUI observes; it reconciles its session
  list with `session.changes` from the cursor the cache kept and lists
  whole on `reset`, with no cursor or on an older host (the return flow:
  docs/IOS-DESIGN.md "Background"). A thread's transcript always opens and
  returns at its bottom: no scroll memory, a snap with no motion when the app
  goes to the background, and a cold launch's restored thread at the bottom
  too (`TranscriptLanding` in the client package, `LaunchRestore` in
  Shell/Navigation.swift); only a route that names a row (a search hit, a
  notification) lands on it. Its README has the state
  table and the L3/L4 extension points. `ios/TempCode` is the read-only
  SwiftUI app, generated by `xcodegen` from `project.yml`. Home is the
  desktop's sidebar in two pushed levels (docs/IOS-DESIGN.md "Information
  architecture"): Home lists the workspaces (linked copies as one row) with
  the rail's one status mark (paused, needs you, working with the running
  thread's title, unread) and a Chats row; `Route.workspace(key:)`
  (Shell/WorkspaceScreen.swift) is the middle sidebar: each project as the
  desktop's project card (Shell/ProjectCardView.swift on the package's
  `ProjectCards.card`, Shell/ProjectCard.swift, a port of sidebarRows.ts
  `cardLines`/`masterBlock`/`cardCounts` and projectCardModel.ts: the name,
  the branch line and the mode, then needs you and failed roots as lines
  (never counted), master blocks with `lead`, working and watching, paused,
  unread (never the thread on screen, `EnvironmentClient.visibleThread`, nor
  a housed one), a page of 32 then "N more", and "N dormant", "N archived"
  or "No threads"; a pin earns no line; on the group fill, `Surface.group`
  and `CardMetrics` in Tokens.swift; a needs-you or failed detail drawn as
  plain words, `InlineMarkdown.plain`; a line opens its thread in its shell,
  elsewhere the shell on its landing, a long press or the ellipsis the
  project's menu), then the stray chats 16 pt under the cards.
  `Route.project(key:thread:seq:)` (Shell/ProjectShell.swift) is a project's
  place in the DETAIL column, the desktop's project home: the strip, then
  the thread its chip selects (`ThreadScreen`) or the project's draft (an
  empty body and Shell/DraftComposer.swift: the A10 box as `ComposerBox`,
  the A11 row with the draft's own mode, and the draft row with the type,
  "Name this thread" (80 characters, `ProjectDraft.title`, sent as
  `session.create { title }`), Master for a chat (admin) and the host of a
  linked project with New copy through `project.ensureLinked`; the client's
  `ProjectDraftStore`, one draft per link key or `loose:<workspace>`, 64
  keys for 30 days in UserDefaults `project.drafts.v1` written after 500 ms
  of quiet (`flush` when the draft leaves the screen or the app the
  foreground), photos in memory; the first send waits for the host's
  catalog (`DraftSend.canSend`; a host switch reloads it, `CatalogLoad`) and
  is `session.create { firstMessage }`, or create, upload, send and
  `session.archive` on a failed send, `sendDraft`, carrying the model and
  effort the picker shows (the draft's saved pick only seeds it); the
  catalog load keys on the host and its link (`CatalogLoad.Trigger`), so a
  draft opened while its host was down asks again when it comes up, its row
  reading "Waiting for <host>" meanwhile, and an ask the host answers with
  an error is asked once more after 2 s, then reads "Couldn't load models"
  with Retry, on the draft and the thread composer alike (`CatalogLoad.failed`;
  the seam `TEMP_CODE_FAIL_ANSWERS=method:count` on an isolated instance,
  src/main/server/answerSeams.ts); while it runs the button
  spins and the strip draws its chip (`DraftSending`, live until the meta
  lands); the box empties at the click (`ProjectDraftStore.take`: what was
  sent rides the chip, what is typed meanwhile is the next draft) and only a
  failed create gives the sent text, name and photos back (`restore`); it
  opens the thread in the shell; every New thread focuses the draft,
  `NewThreadPresenter.compose`); `key` is the strip scope's
  key (a project's `ProjectPairs.key`, `loose:…` for a workspace's loose
  chats), `thread` the chip id `<env>:<sid>`. `ShellPaths.place` puts every
  root of a project or of a workspace's loose chats in its shell, a
  subagent pushed over its root's, a chat outside every workspace bare;
  `ShellPaths.land` (a card's tap, `ShellNavigator.openProject`) picks
  `ProjectLanding`'s active thread, else the last one on screen there
  (`ShellLandingStore`, `shell.landing.v1`, per scope key), else the draft,
  and moves nothing while that shell is open; `ShellPaths.identity` keeps
  the shell one screen across its threads. The rules are the package's `HomeSections` (`home`, `workspace`,
  `project`, `RailStatus`, `isActive`; ThreadGroups.swift
  `masters`/`batchHome`), pure over `HomeHostInput` values (ProjectCardTests
  holds the card); the app's `HomeRows` adapts the clients,
  Shell/ShellRows.swift holds the shared rows and `NewThreadPresenter` (New
  thread focuses the project's draft; the new-thread sheet, kept for a
  prefilled brief, presents from the root), and `HomeSlots`
  (Shell/HomeSlots.swift) is where sibling features plug in (host notes,
  host and project menus, project settings, the plan chip and the menu's
  Project Plan row, the host's trailing mark). On the iPhone Duo (plan 1) Home and Search are each one
  `NavigationSplitView` on a `ShellNavigator` (Shell/ShellSplit.swift,
  ShellNavigator.swift: the sidebar's routes, the detail's root and stack,
  `open(route)` placing a route by `ShellPaths.column(of:)` and a thread in
  its shell by `ShellPaths.place`; a notification tap opens Home's shell, a
  search hit the same shell in Search's detail; a thread opened bare before
  its host listed it moves into its shell when the list lands, or when a
  later push names it or the host's workspaces or projects push lands (a
  walk cut short settles nothing; the shell reads the client's stamps,
  `completeLists`, `catalogStamp` and `watchPlacing`, never its sessions;
  `ShellPaths.relisted`, `awaitsListing`), the pose is the
  client package's `ShellPose` published as `\.shellPose` (read it, never
  `horizontalSizeClass`, for a shell decision), the thread strip
  (Shell/ThreadStrip.swift over the package's `ThreadStrip` and
  `StripChip.look`, `StripMetrics` in Tokens.swift) sits at the project
  shell's top in every pose (a 40 pt live row, the status mark in the chip's
  one glyph slot, a selected chip keeping its slot until another is
  selected, New Thread after it, leading the row in words when no chip is
  live; regular width adds the 32 pt shelf,
  compact width the Recent menu with Archived Threads at its foot), and the place is remembered under
  `navigation.memory.v3` (`NavigationSnapshot`; a v2 snapshot gives back its
  tab alone, `NavigationSnapshot.restore`; the Inbox's path has its own
  key); docs/IOS-DESIGN.md "Information architecture" and "iPhone Duo".
- The thread screens (L4) live in `ios/TempCode/Sources/Thread/`; the entry
  the shell routes to is `ThreadScreen(client:sessionId:targetSeq:)`, one
  screen for every type and for a subagent's detail. Its frame (the header
  with the status subtitle and the inline rename, the segmented control
  whose pill is bound to the pager, the agents button and the menu, the
  gone line) is `Sources/Thread/Frame/`, drawing the client package's
  `Rendering/ThreadFrame.swift` (`ThreadKind`, `ThreadSegment`,
  `ThreadPhase`, `SegmentRules`, `ThreadHeaderLine`, `ThreadMenuItem`: pure,
  tested in ThreadFrameTests). In a project's shell (`shellTitle:` from
  `ProjectShell`) the bar's title is the project's name and the subtitle
  goes (`ThreadHeaderLine.subtitle(inShell:)`), the account chip becomes the
  menu's "Account…" (the same AccountMenu sheet), and the trailing group is
  the plan chip, the agents button, Notes and the menu; a subagent's screen
  and a bare chat keep the thread's own header. The screen's pose on the iPhone Duo (the pager or two
  panes by its own size class and width, the columns from the fold's
  division band, the 768 pt measure, the transcript's reflow) is
  `Rendering/ThreadPose.swift` (`ThreadPose`, `TwoPaneColumns`: the chat
  keeps 360, the hero yields first, a board fits its widest task within
  320–672 and half; `ReadingMeasure`: the transcript at 768, a document at
  640, `cap(for:)` by segment, the composer on the column's edges, and a
  slot that takes room on its own solid band, `ComposerSlot.backing`;
  `TranscriptReflow`; tested in ThreadPoseTests and ComposerSlotTests; the
  sidebar's 260 pt is `SidebarColumn` in Shell/ShellPose.swift, tested in
  ShellPoseTests), and the
  27.1 reads (`Duo.divisionBand`, `\.tcVerticalBar`, `BarRegionProbe`) are
  `Design/Duo.swift` behind a runtime `#available` (docs/IOS-DESIGN.md "The thread
  screen on the iPhone Duo"). The models they read
  are the client package's `Rendering/`: `ThreadFold` (the desktop's fold
  with round, todo and pass stamps and the `BoardState` of todos.ts; a
  `notice` row keeps its whole payload on `SystemLine.notice`, an error
  row the host's verdict on `SystemLine.failure`, a user row its
  `preamble`), the
  `Board`, `ResearchBoard`, `Fleet`, `PlanDoc` and `Inbox` selectors (the
  Inbox's sort, status words, seen marks and the patch split by file), the
  `MarkdownCache` that parses rows off the main actor (ahead of their
  mount for the transcript's window, `prefetch`; a row whose parse has not
  landed keeps its height undrawn, never plain text first) and a streaming
  row's changed block only, on it (`streamingDocument`, the last block's
  open inline spans closed first by `MarkdownClose`, the desktop's remend),
  `TranscriptRows`
  (entries → the list's rows, the desktop's transcriptRows.ts: an item,
  a group of everything between two paragraphs (`ActivityGroup`: a lone
  step is its own row under the same key; `GroupFold` opens the working
  group at two steps, shows its newest five, folds at least 0.6 s after
  the work moves on and only with the reader at the bottom, and a
  person's hand decides from then on, kept by group key in `GroupHands`
  outside the row), a turn's end row, its working line then its closing
  line, one per turn (a message landing mid-turn, `joins`, is a bubble
  inside it); stable ids, never two rows on one key; settled turns reuse
  their rows from `RowKeyMemory`; `RowGap.above` the desktop's ROW_GAP),
  `ToolPhrase` (the
  desktop's toolPhrase.ts), `GroupPhrase` (groupPhrase.ts, over
  `GroupStep` tool and host steps: heard from, the batch, tasks finished,
  gate, review, pass, hand-off, batch merge, away), `ActionRow` (the
  desktop's actionModel.ts: verb, object, counts, what a row opens) and
  `Rendering/AgentSteps.swift` (`AgentTitle` = agentTitle.ts, `WaitSteps` =
  agentSteps.ts, `FoldedStep` = isFoldedStep, stepRows and spawnedNames,
  `AgentsCue` = agentsCue), all tested; the fold stamps each `agent-spawned`
  child on its `spawn_agent` call (`ToolItem.spawned`, a row of its own only
  with no call of the turn to stand on), marks the batch's own report
  (`SystemLine.batch`), stops a compaction its turn left open
  (`CompactionItem.stoppedTs`) and draws no row for `background-tasks`; `threads[id].fold`
  stays current incrementally. The transcript's two seams for sibling
  threads: `StreamingAssistantRow` (`Thread/StreamingRow.swift`, the
  streaming reveal) and `MediaImage.hostOf(_:)` (the host of an `fs.media`
  URL). The implementation board is
  `Thread/ImplementationBoardView.swift` with `BoardStyles.swift` and
  `BoardOutcomes.swift` (gate and review rows from `RoundData.outcomes`,
  the words from `BoardSections.swift`'s `GateLine` and `ReviewLine`);
  docs/IOS-DESIGN.md "Implementation: the board is the hero" is its spec.
  An agent's `html_render` page is its own transcript row
  (`Thread/HtmlRenderView.swift`: `HtmlRenderRow`, a touchless WKWebView
  sized by the client package's `Rendering/HtmlRender.swift`
  `frameHeight`, themed from the phone's colours; a tap pushes
  `HtmlRenderScreen` with Share and links in Safari), fetched from the
  host's `/asset/page/…` with the key (`HtmlPages`); the test server seeds
  one in "Why is the build slow?" and `TC_PROOF_SET=page` shoots it.
  The diff screen's model and parsers are the client package's
  `Rendering/DiffDocument.swift` (`DiffDocument.from(edits:)`,
  `from(patch:file:)`, `DiffLayout`) with their suite, and `DiffRoute`,
  `LinesDiffRoute` and `PatchDiffRoute` are the three ways into
  `DiffScreen`. The plan or report file is read with
  `file.read` (in the subset since L4), polled 1.5 s running / 8 s idle
  while the screen shows; the plan page parses it with the client package's
  `PlanDocument` (nested and task lists, tables, frontmatter, sections) and
  paints from `PlanPages`' disk cache before the first read answers. A
  project-plan thread renders through `ProjectPlanView` (the client
  package's `ProjectPlan` parser, milestone rows that tick over
  `projectPlan.tick`, the options card after `status: complete`, the Home
  chip in `ProjectPlanChip.swift` through the `projectTrailing` Home slot). The
  fleet surfaces are `Thread/FleetStyles.swift` (the agent row and its
  pieces, `FleetSections`, `FleetGather` over every paired host,
  `AgentDetailRoute`), `SubagentListScreen(client:rootSessionId:)` and
  `AgentDetailScreen(client:agentId:parentCwd:hostName:)`
  (docs/IOS-DESIGN.md "Orchestration"). DEBUG launch hooks (`TC_TEST_SEGMENT`,
  `TC_TEST_OPEN=chip|group|diff|page|agent|agents|rename|agent-detail|report|source|item|item-diff|account`,
  `TC_TEST_SCROLL=1`, the Search tab's `TC_TEST_SEARCH=<query>` and
  `TC_TEST_SEARCH_SCOPE=files`, and L5's
  `TC_TEST_ACTION=send:<text>|steer:<text>|stop|approve|deny|answer:<label>|start-build|
  rename:<title>|pin|archive|new-chat` and `TC_TEST_SHEET=start|new`) exist
  for the proof only; an action runs once, on the screen the launch route
  opened, through the same calls the buttons make. The test server's
  `TC_TEST_FLEET=large` seeds a twelve-agent fleet in all four groups.
- Streaming (27, rewritten by the desktop-pass A4): `Rendering/SmoothText.swift`
  is the desktop's jitter buffer in Swift as of 0b82ddad (`Pacer`, the rate
  window, the 250 ms seeded lead, the catch-up, `revealCut`'s whole-word
  steps every 100 ms with the desktop's later holds: an open fence's code
  line until its newline, then `revealLineHold` 0.6 s, and a table row of
  bare pipes; `SmoothTextReveal` on a timer `RevealClock`, no
  display link; UTF-16 positions; born-live rows through the client
  package's `BornRows`, claimed by TranscriptView on appearance, a reply
  that lands in one step kept on the streaming render until its fade by
  `StreamRowRule`), and the
  thread screen names its thread with
  `session.focus { sessionId, shown }` (`FocusSignal`, in the phone's
  subset); the fold gives a partial-born tool item a
  provisional id and the final row's seq, folds `live-edits` into the
  running edit tool by path (`ToolItem.live`, `ThreadFold.liveEdits`), and
  `EnvironmentClient.append` applies a batch in place;
  `Thread/StreamingRow.swift` holds the streaming assistant row; the phrase fade (A5) is the client package's
  `Rendering/StreamReveal.swift` (`StreamRevealLedger`: a ledger per block
  by its first 32 characters without their marks, the settled prefix and
  at most four steps younger than `revealFade` as runs, a block whose
  marks alone were rewritten keeping what it showed (`shownEnd`), a
  reparsed block fading whole, none before arming or under reduced motion;
  `RevealDrain`, the turns still revealing, which the closing line waits
  on, each row reporting under its turn's opener, a steer's reply too,
  `TranscriptRows.turnKeys`) drawn by
  `Thread/StreamFade.swift` (`StreamFadeRenderer`, a `TextRenderer` under a
  `TimelineView` that runs only while a run is young, over a `Text`
  interpolated from the runs; prose blocks only, never code or tables); a
  row stays on the streaming render until its drain and last fade are
  done, then swaps to the settled parse, which equals
  `streamingDocument(settled: true)` (MarkdownSettleTests); the scenario
  runner's reveal, fade and drain checks live in
  `Rendering/TranscriptScenarioReveal.swift`, its hold, morph and
  closing-line checks in `Rendering/TranscriptScenarioLine.swift`;
  `FollowRule.atBottom`
  decides the reader's place (only their own scroll or a deliberate scroll
  to a row leaves the bottom; growth under them pins), nothing pins while
  their finger is down or the list decelerates (`FollowRule.write(readerMoving:)`),
  pins coalesce to one per main-queue turn (`PinQueue`), a tap that
  resizes its row in place (a group's line, a step's body, a gate log, Show
  more) glides on the layout spring through `TranscriptFollow.resize`
  (`FollowRule.Event.handResize`: a reader at the bottom followed on the same
  spring, one up left still; UIKit runs it, `ListGlide`, since a `List`
  animates no cell from a SwiftUI transaction; no pin while `HandGlide` runs;
  proof `TC_PROOF_SET=glide`, scripts/lib/group_glide_check.py), the closing line
  believes the drain for `TurnLineTracker.drainBound` past the turn's end
  and no longer, and TranscriptView's DEBUG `TranscriptTrace`
  notes every scroll write and every offset drop that stays two frames
  (`write`, `jumpUp` in layout-events.json), which the transcript set
  fails on; the test server's `POST /scenario` gives each play its own ids
  (`uniqueScenarioIds`); `Thread/ActionGroup.swift` a group and its
  steps, one tree for a lone row and a table (`ActionLine.swift` the step
  grid; a thought is no row: only a group opened by hand shows one, as
  "Thought"; while the turn is open a streaming thought is no step and a
  call the working line tells is a step with no row, `TranscriptRows.rows`;
  a running step is the still dot, and a step whose turn is over draws
  settled; `Thread/AgentSteps.swift` draws the host's steps in a run, a
  wait's agents and a batch spawn's children as `AgentStepLine` and
  `SpawnChildLine` with a still `StepStateMark`, every transcript notice
  on the one `NoticeLine`, and the compaction as one `CompactionLine`;
  the toolbar's `AgentsButton` draws the `AgentsCue`); a
  turn's end row is one row from Send to the
  close, `TurnLineRow` (`Thread/WorkingLine.swift`, over the client
  package's `TurnLineInput` and `TurnLineModel` in `Rendering/TurnLine.swift`
  and `LinePhase`): the working line (`WorkingMark`, the words in
  `WorkingText`'s shimmer, each phase held 300 ms and changed through
  `Design/MorphText.swift`), folded while a card waits or the thread is
  paused, Stopped after a Stop, and "Worked for …" once `RevealDrain`
  says the turn's rows are done revealing, then the Watching line under
  the last turn while the thread watches; a turn's end ends every text
  still streaming (`ThreadFold.closeUserTurns`); the header's subtitle
  says no phase. The test server's
  `POST /stream` plays a bursty turn with a growing Edit and live edits.
- Settings (thread 5): `ios/TempCode/Sources/Shell/{SettingsView,HostsView,
  AddEnvironmentSheet,SettingsStyles}.swift` are the SwiftUI alone; every
  word they say (`ConnectionWord`, `HostFix`, `HostBuildLine`,
  `HostPushWord`, the `Capability` titles) and `forgetHost` (which sends
  `remote.push.unregister` on the host before removing the key) live in the
  client package's `Shell/HostPresentation.swift` with their tests; the
  `settings` proof set shoots them with `TC_TEST_OPEN=host` (pushed through
  the stack's path) and `TC_TEST_SHEET=pair|pair-error`.
- iPhone Duo (plan 4, the toolchain and the proof): every iOS script picks
  its Xcode through scripts/ios-xcode.sh (`bun run ios:xcode`: DEVELOPER_DIR
  passes through, else TC_XCODE, else the highest-versioned
  /Applications/Xcode*.app with a tie to the non-beta, refused below
  TC_XCODE_MIN, 27.1 for the app and 0 for the packages; never `sort -V` on
  file names, which chose the 27.0 beta over the 27.1 release). `bun run
  ios:duo:check` (scripts/ios-duo-check.sh; `-- --create` makes the
  simulator, `-- --device` wants the phone) names what a Duo pass needs;
  scripts/ios-duo-pose.sh `<udid> <pose>|lit|state` poses the "TempCode Duo"
  simulator over `hinge` (brew artemnovichkov/tap/hinge) and reads the lit
  panel from `devicectl device info displays`. The poses are `folded|fp`,
  `folded-landscape|fl`, `unfolded|ul`, `unfolded-portrait|up`, `half-open|ho`
  (`DuoPose` in the client package is the table). `TC_DUO_POSE=<pose>` is an
  axis on every proof set (the Duo by default, the lit panel captured, shots
  in `shots/<pose>/`, each shot's layout report in `layout/<pose>/` checked
  against the pose's row by `pose_check`; `fold <pose>` with the app running;
  `duo_shot` is `shot` under the axis); `TC_PROOF_SET=duo` (paired with the
  acting key) is every pose's seed shots, the thread matrix of
  docs/IOS-DESIGN.md "The thread screen on the iPhone Duo" in
  `duo_shots_shell|thread|sheets` (one seeded thread per type in unfolded,
  unfolded-portrait and half-open, the sidebar shown and hidden
  (`TC_TEST_SIDEBAR`), light and dark, the keyboard up, accessibility-large;
  each shot's `pose-<sessionId>.json` copied beside its report as
  `<name>.pose.json`) and the fold cycle (`duo_fold_cycle`: a streaming
  implementation thread with a draft and an undecided approval, run at the
  bottom and 700 pt up, four shots and a .mov each). `pose_check` is
  scripts/lib/duo_pose_check.py: the pose's row, the dock's rule, and per
  thread shot the sidebar (its state as asked; beside the thread 260-320 pt,
  iOS 27.1 holding it at 320, half open up to the fold; the column from its
  edge, half open past the fold's band, to the window less its safe area), the mode and columns `ThreadPose`
  gives that column (a board beside the sidebar is the pager, by the
  person's choice: no UIKit workaround), the measure (768, or the column
  less 32), the composer on the column's edges and the dock's band
  (scripts/lib/duo_band.py: the dock its parts' height, the band and the bar
  no taller); scripts/lib/
  duo_fold_check.py holds the fold run to the route, the draft
  (`notes.draftChars`), one hSize, window and sidebar change per step,
  `revealedUnits` never decreasing, the reader's end or `topRow` kept, no
  row made twice and the dock band at every stop; `duo_unfold_idle` unfolds
  each type at rest live; scripts/ios-duo-checks.test.ts tests both. The app writes
  `Documents/layout-report.json` and `layout-events.json` (500 events, merged by the fold run's scripts/lib/duo_fold_sampler.py) from
  `LayoutProbe` (ios/TempCode/Sources/Shell/LayoutProbe.swift, DEBUG, on
  RootView's root; `LayoutProbe.note(key, value)` from any view, inside `#if DEBUG` (scripts/ios-debug-guard.test.ts refuses a DEBUG-only type outside one; every proof set compiles Release first); the shell notes `sidebar`, `sidebar.width` and `split.width`, the thread screen `columns`, `measure` and `body.frame`, the dock `composer.frame`, `slot.frame`, `dock.backing` and `draftChars`;
  `LayoutProbe.route` from RootView and ThreadScreen). project.yml allows
  portrait and both landscapes (scripts/ios-project.test.ts pins it); 27.1
  symbols live in the app target under a runtime `#available` only. `bun run
  ios:device:duo` is the Ad Hoc build on the Duo (TC_DEVICE_MODEL=iPhone19,4;
  scripts/lib/pick-device.py picks connected over paired, never a simulator).
  docs/IOS-DESIGN.md "iPhone Duo" has the pose table and the on-device list.
- iPhone Duo (plan 3): every sheet is shaped by the client package's
  `SheetRules.shape(kind, in: window)` (`Shell/DuoLayout.swift`: form,
  editor, picker, field, confirm, document) through `tcSheet(kind)`
  (`Design/SheetShape.swift`, which also publishes `\.windowClasses` from
  RootView's outermost modifier); `InboxColumns` splits the Inbox tab's one
  typed path (`InboxRoute`, `Shell/InboxScreen.swift`: a split at regular
  width, the stack otherwise); `ToastMeasure` caps the fleet toast at 440 pt;
  `highVisibility()` and `horizontalOnly()` (`Design/BarItems.swift`) are the
  bar items' 27.x rules. Hooks for the `duo` set:
  `TC_TEST_SHEET=rename|notes|project-settings|preamble|milestone` (rename on
  the first thread row on screen, so launch with `TC_TEST_ROUTE=archived`).
  docs/IOS-DESIGN.md "iPhone Duo".
- Relayed hosts (thread 29, the phone side of the box's relay): a host the
  box relays is a client of its own in `ClientRegistry` on the box's
  `/ws?host=<id>` lane with the box's key (`PairedEnvironment.via`,
  `isRelayed`, `keyOwner`, `socketURL`); `Client/RelayedHosts.swift` is the
  store (`RelayedHosts`, `relayed.json` beside `environments.json`, fed by
  the carrier's hello `hosts`, the `presence` push and a lane's hello
  `presence`), `RelayState` (the one word, read from link/screen/power in
  the wire's order), `RelayWords` (every sentence: the row line, the
  subline, the strip line for locked, the held and reconnecting lines) and
  `RelayRefusal` (`unavailable: …` / `linkDown: …` parsed to one line); the
  registry syncs the union of stored and relayed environments and seeds
  each relayed client's `presence` before its socket starts; the socket's
  `setHostReachable` holds a lane the box says is down (no attempt, no
  Retry) and tries at once when it is back; `relayBlock` folds into
  `operateBlock`/`approveBlock` (asleep and unreachable block, locked keeps
  Send). Views: `Shell/Hosts/PresenceLine.swift` (`PresenceLine`,
  `HostSubline`, `RelayStripLine`) and `RelayedHostRow.swift` (the row under
  its carrier in Settings → Hosts, the detail with no key, Pair Again or
  Forget); hooks: HostsView (the relayed rows, the relayed detail, the
  Forget copy), `HomeSlots.hostSubline` + HomeView's host header + RootView,
  WorkingStrip's idle arm, StatusLine's words and Retry rule,
  `PushRegistrar.sync`'s guard. Tests: RelayWordsTests, RelayedHostsTests,
  the socket's `setHostReachable` cases, and `LiveRelayTests` in
  LiveServerTests.swift (enabled by `TC_TEST_RELAY_HOSTS`, which
  scripts/ios-client-test.ts passes from thread 28's `relayHosts` seed).
  docs/IOS-DESIGN.md "Hosts through the box".
- Host activity (thread 21): the host detail's Activity slot is
  `ios/TempCode/Sources/Shell/Hosts/` (`HostActivitySections`: Build with
  the `+N` drift mark, Deploy Master and the log sheet; the Mac bridge's
  calls on a box's detail with Stop; Devices per Mac; Sync), every loop in
  one `ActivityPollers`; the drift mark also fills Home's `hostTrailing`
  slot. The stores are the client package's `Client/HostExtras.swift`
  (`HostExtras` on `EnvironmentClient.extras`, and `MasterReleaseWatcher`,
  which reads master's release.json from GitHub itself) and the words
  `Client/HostExtrasText.swift`, ported from the desktop's, with their
  suites. The wire it reads: `host.devices*`, `host.simulator.*`,
  `host.device.openXcode`, `host.deployStatus`/`deploy`/`log` (admin),
  `harness.status`/`sync` and `memory.status`/`sync` (admin), and
  `macBridge.activity`/`stop`, with the `host.devices` and `host-log`
  pushes in the subset. The test server seeds a saved host "box", two Mac
  bridge calls for it (`MacBridge.seed`, behind `TEMP_CODE_E2E_SEED`), a
  finished deploy (`TEMP_CODE_DEPLOY_DIR`) and an admin key
  (`adminPairing`), beside thread 26's fake devices;
  `TC_PROOF_SET=host-extras` shoots it (`TC_TEST_SHEET=deploy-log` opens
  the log).
- Steering (L5): `ios/TempCode/Sources/Thread/Composer.swift` (the
  desktop's composer box on every segment, drawn as one Liquid Glass shape
  at radius 12 in one `TCGlassContainer` floating over the transcript on
  the transcript's column edges: `+` at the left (28 pt, 44 pt hit; Photos;
  it and the button grow with the type up to 44 pt, `ComposerHeight.control`), the
  field in the prose type, the one button at the right, a 28 pt circle on
  prominent glass; 46 pt empty, 22 pt more a line up to six lines (160 pt),
  then it scrolls; a keystroke snaps the height, a paste of more than one
  line eases it over `base`. The button is the desktop's `SendButton` on the
  client package's `ComposerRules` and `ComposerIntent`: Send; steer (the
  corner glyph) mid-turn with text or a photo, `queue.add { steer: true }`
  as the desktop's composer (`steer` in Actions: the host's `steered`
  answer, its user row's `steerId` and the `steer` rows put Sent, then
  Received, under the bubble; a photo's queued answer goes in through
  `queue.steer`); Pause (`session.pause`) mid-turn with
  the box empty; a paused thread's text queues; a long press mid-turn with
  text shows the queue glyph until release and queues for the next turn
  (`queue.add`); a watching master's button is Send; the glyphs trade on the
  icon swap; `ComposerHeight` holds the box's numbers. Glass goes through
  `Design/Glass.swift` alone; `ComposerRow.swift`, the row under the
  box (24 pt, 4 pt under it, always there: the model and its effort as one
  menu, catalog then Effort, the pick riding the next send; the context
  meter, a 14 pt ring and the percent from `SessionMeta.context`, amber from
  85 %, a spinner while compacting; the permission mode over
  `session.permission`, read-only without approve; giving way under 400,
  368, 320 and 144 pt, never wrapping; the client package's `ComposerRow`
  and `PermissionWords`, `setPermission` in Actions); the radius ladder and `ComposerMetrics`
  through `Design/Tokens.swift`, and no view joins facts with " · ":
  docs/IOS-DESIGN.md "The composer, the slot…", "Liquid Glass" and "Text
  hierarchy")
  with `ComposerStyles.swift` (the catalog choice, the menus, the chip, the
  card button) and `ComposerAttachments.swift` (photos from the system
  picker, four per turn, uploaded through `attachment.begin/chunk/commit`
  as they are picked, a chip with a bar each); `WorkingStrip.swift` (the
  slot above the box, the desktop's `composerSlotOf` as the client
  package's `ComposerSlot`, which was `WorkingPhase`: while a turn works or
  waits the turn's elapsed from the click (`ThreadState.sentAt`, stamped by
  a send into a thread with no turn open and never stepped back by the
  host's `busySince`; `sending` holds the slot and the button busy from the
  click until the host's status moves, never ended by the echo alone, and
  the click is ignored once its turn closed, `ThreadState.observe`,
  `sendEcho`, `sentTurn`) and Stop, "Stopping…" while it is out; Paused with
  Stop and Continue and a master's batch line, Stopped with Resume, Queued
  with its reason and Start now, worded by `StripWords`; nothing for
  watching, failed, idle or done, and no flavour words; 28 pt kept at
  regular width (its ideal height, never what the bottom bar offers: an
  empty reserved slot once took the column after an unfold), at compact width it rises in on the layout spring and
  leaves inert on a `fast` fade); `CardActions.swift` (Allow,
  Deny and Answer under the live cards in `TranscriptRows.swift`: the
  decision shows on the tap as Allowed or Denied and goes once, a refusal
  puts the buttons back with its line, the client's `CardDecision`,
  `ThreadState.deciding` and `refusals`; the question card in the desktop's
  proportions, option rows of 28 pt; `FailureCard.swift` on the desktop's
  recipe, radius 8, 12 in, at most three actions, Retry last); the person's
  turn is the desktop's bubble (`UserTurnRow`: trailing, the chrome fill at
  radius 12, 12 × 8, at most 85 % of the column, `UserTurnLayout`; a sent
  bubble rises 16 pt over `Motion.rise` once, other born rows fade over
  `fast`, `BornMotion` in TranscriptView.swift; the steer word morphs,
  `MorphText`, the working line's morph, its time in `TimeFormat.clock`, the
  desktop's `clockTime`, and the runner's `.steer` check holds it forward);
  `Shell/ThreadSheets.swift` (Start a build from a plan, the New thread
  sheet for a prefilled brief, both over the host's `catalog.get`;
  Rename); `Design/ThreadRowActions.swift` (swipe to pin and archive,
  context menu with rename). All of it sits on the client package's
  `Client/Actions.swift` (the gate on the key and the socket, pending
  turns, optimistic decisions, `ThreadDraft`, `TurnModel`, `start` as
  `session.start`, `pause`, `queue` as `queue.add`), `Client/Attachments.swift` (`upload`) and
  `Client/Steering.swift`; the README there has the rules. A read key
  hides nothing: the field and the cards carry the reason instead. `Client/PlanFlow.swift`
  is the plan page's state (`PlanFlowState`) and `implementPlan` over
  `plan.implement`; `Client/ProjectSettings.swift` the preamble, review and
  plan drafts the project settings sheet (`Shell/ProjectSettingsSheet.swift`)
  saves over `project.setPreamble`, `review.set` and `plans.set`, admin
  only, with the reason on a lesser key. DEBUG
  hooks: `TC_TEST_ACTION=start-now|resume|pause|queue:<text>` beside the L4 ones.
  A master opens on its Board (`ios/TempCode/Sources/Thread/Master/**`:
  MasterView with its bar, MasterRows, BatchFoot and StepConsole, the
  Rules, add, adopt and archive sheets, MasterPinButton for an admin key)
  over the client package's `Rendering/Batch.swift` (`MasterBoard`,
  `BatchSteps`, `RulesEdit`, `BoardActions`), `Client/ThreadBatch.swift` (the fleet switches' rule)
  and `Client/Batches.swift` (each master's `BatchState`, the `batch` push
  landed at most twice a second, `batch.get` every 5 s while the board
  shows); the SUBSET carries the batch types, the push and `batch.get`,
  `batch.setRules`, `batch.stopStep`, `batch.adopt`, `batch.archive`,
  `session.setMaster` and `session.batch` (docs/IOS-DESIGN.md "Master: the
  batch is the hero"). DEBUG hooks `TC_TEST_OPEN=rules|add-thread|adopt|
  archive-done` and `TC_TEST_ACTION=stop-step|set-master`; the test server
  seeds the batch under `ios-master` with a streaming shell step.
  The host's own rows
  (`Thread/NoticeRows.swift`: review and gate cards, batch, account-gone and
  plan-handoff lines; `FailureCard.swift`; `PreambleRow.swift`) draw from the
  typed payloads the fold keeps on `SystemLine.notice`/`.failure` and
  `UserTurn.preamble`; the client package ports the desktop's
  `failureActions` as `FailureActions` (`Rendering/Notices.swift`, with
  `GateText` and `ReviewText`; the phone's reach is Route automatically,
  Continue on another model through the composer's model menu, and Retry,
  label-sized and wrapping as the desktop's flex-wrap, `Design/FlowLayout.swift`
  over `FlowRows`, the first solid) and speaks `session.continue` (with the
  picked model for Continue on another model),
  `session.reroute` and `review.override` (`Client/NoticeActions.swift`).
  The fleet switches, the Resources sheet and the archive prompt (thread
  iOS 20) sit on the client package's `Client/ThreadBatch.swift`,
  `StatusWords.swift` and `Resources.swift` (`ResourceLedger` on the
  `resources` push, loaded whole at every open) through
  `Shell/FleetSwitches.swift` and `Thread/ResourcesSheet.swift`.
- Accounts on the phone (iOS 24): a routed thread's header ends with
  the account chip (`ios/TempCode/Sources/Thread/AccountChip.swift`; in a
  project's shell, which has no subtitle, the menu's "Account…") and
  its menu sheet (`AccountMenu.swift`): `accounts.list` once on open, then
  the `accounts` push into `EnvironmentClient.accounts` (`HostAccounts`);
  This thread reads the route and offers `session.reroute` (operate),
  Project and Workspace pin over `project.setAccounts` /
  `workspace.setAccounts` (admin; a lesser key sees "This key can't change
  pins"); the pure rules (`AccountScope`, `HeadroomLook`, `AccountMenuModel`)
  are the client package's `Client/Accounts.swift`. The provider is
  `RoutedProvider(provider:model:catalog:)`: a catalog row with `vendor:
  meta` under either harness spends the host's Meta keys (`providers.meta`,
  absent on an older host and read as none; pins carry `meta`; a key's row,
  `AccountProfile.kind == .key`, draws no bar while it has room and says
  "pay as you go"); the failure card's `FailureActions` takes the same
  provider (`key_invalid` and a keyless Meta thread are Retry alone). A failed thread's row and Home's cue read the
  host's `failure.summary` (`Shell/FailureCue.swift`). The test server
  seeds two Claude accounts, one Meta key and a Meta thread (`ios-meta`,
  Muse Wonder on the claude harness) and answers `POST /accounts/headroom`.
- Push (L6): the phone registers its APNs token with every paired host
  (`remote.push.register`/`unregister`/`status`/`activity`, capability read:
  the key's own row); the host keeps one row per key (`remote_push`,
  `src/main/server/remote/push.ts`) and forwards it to the hub as an `apns`
  subscription, which the hub delivers with token auth (infra/hub/src/apns.ts;
  the .p8, key id and team id are Worker secrets, never files). A notice
  carries `environmentId` and `seq`, so a tap opens the thread on the card
  through the same `Route.thread` a search hit takes; delivery while that
  thread is on screen shows nothing. The Live Activity (`ios/TempCode/Activity`,
  the TempCodeActivity extension; `Sources/Push/ActivityCoordinator.swift`)
  starts when the person sends a turn or watches a running thread, hands its
  push token to the host, and the host's `ActivityFeed` pushes the strip's
  phase on every transition and ends it (the final state stays two minutes)
  when the thread goes idle, waiting, errored or stopped. A queued thread is
  not live: the feed skips it whole and the phone never starts an activity
  for it (a turn sent into one starts the activity when the host boots it).
  One activity per host: a second thread followed on that host joins it
  (the phone registers the same token for each thread it covers), the host
  sees one token on several threads and pushes a group state
  (`activityGroupState`: `threads` rows needs-you first, settled rows leave
  after a minute, six rows and 3.5 KB at most, `more` for the rest; the top
  level names the lead thread for older builds), the card lists the threads
  and the island counts them (docs/IOS-DESIGN.md "Several threads"; fixture
  `activity-group.json`). The group ends when nothing it covers works or is
  paused, and only then do its token rows go.
  Settings has one row: the Notifications switch with its state beside it.
  What the phone shows: the Live Activity's content state is the desktop's
  running row (`HubActivityState` in src/main/server/hub.ts: `phase`
  working | paused | waiting | finished | failed | stopped, `since`, `ts`,
  `seq`, `title`, `task`, `done`, `total`, `unit` tasks | threads (absent
  means tasks), `reason`; `activityState` in remote/push.ts builds it from
  the meta and the hub's `ActivityState` is the same shape; the phone's is
  `ThreadActivityContent` in ios/TempCode/Activity/Shared/ThreadActivityText.swift,
  pure Swift the client package's tests compile through a symlink) and the
  clock ticks on the device from `since`. A watching master's state counts
  its batch: `done`/`total` are the children done of total with `unit:
  'threads'` and `task` the engine's running step, else "Waiting on N
  threads" (index.ts's `batch` hook; `batches().onChange` pokes the feed).
  `ActivityFeed` pushes every change of phase, tally, title, unit or reason
  at once (priority 10) and coalesces task-line-only changes to one
  priority-5 push per 20 s per thread (`ACTIVITY_COALESCE_MS`); a waiting
  end holds 2.5 s for the notifier's needs-you line (`ActivityFeed.needsYou`,
  wired from `notifier.onNotice`). The lock screen card
  (ios/TempCode/Activity/Shared/ThreadActivityViews.swift, shared with the
  app's DEBUG gallery): tinted type glyph, title, live timer; under it the
  status mark with the task alone while working (the spinner already says
  working), the word plus the task or reason while paused or waiting, the
  word alone once finished, failed or stopped (Done, Failed, Stopped), in a
  row that never changes height; a tally bar with `3/7` for either unit. The
  Dynamic Island: the glyph compact leading (the final state's mark once
  settled), the tally or the clock compact trailing (bounded, it shrinks
  past an hour instead of clipping), the status dot minimal (a still square
  for stopped), the card's rows expanded; every presentation deep-links to
  the thread. No `.animation` modifier in the widget: WidgetKit drives the
  updates. Notifications: the notifier's `Notice` carries `kind` (approval,
  question, plan, waiting, finished, failed, stuck, batch, stopped),
  `subtitle` (the project's name, else the workspace's), an approval's
  `requestId` and `hostName`. One voice (the header of remote/notifier.ts):
  the title is the thread's title (an untitled thread takes its project's
  name and no subtitle), the body one line, a status word or a verb first, a
  colon before its detail, commas after, no dashes, dots or raw tool names:
  an approval is the action as a question (`approvalLine`: "Run bun test?",
  "Read types.ts?", "Use linear?"; the subagent that asked is not named),
  "Tabs or spaces?" (the first question), "Plan ready to approve", "Needs
  you", "Done in 12m" or "Done in 12m, 2 tasks left", "Ready to build",
  "Batch done: 3 landed, gate passed in 4m 12s", "Batch stopped: gate
  failed at vitest", "Failed: <the host's failure summary, else the first
  line>", "Stopped unexpectedly", "No output for 12m"; the hub's host
  notices are titled by the host's name, "Not heard from in 3m" and "Back
  online". A queued thread decides nothing, and the host stays quiet when
  the person needs nothing: a thread whose `masterId` names a live master
  sends no Done (the master's batch notice covers it, and the master's
  idle after it is not a second Done), a plan whose build started sends
  nothing, and a root a desktop window names to its person right now
  (`FocusSet.isNamed`, unwidened) is stamped `onScreen`, which the hub and
  local APNs skip (on this host, and on the box for a relayed notice) while
  key webhooks and the Live Activity reason still take it. The alert
  (remote/apnsPayload.ts, identical in infra/hub/src/delivery.ts) has the
  subtitle, `thread-id` and `summary-arg` per thread, `relevance-score`
  (needs_you 1, failed 0.8, stuck 0.6, finished 0.4), sound only for
  needs_you and failed, time-sensitive only for needs_you, `category`
  `tc.approval` (Approve, which asks for the unlock, and Deny; `PushDelegate`
  decides through `session.approve` after bringing the socket up, and a
  refusal answers one local notice saying why) or `tc.thread`,
  `mutable-content: 1` and `tc.host` (the host's name): the
  TempCodeNotificationService extension (ios/TempCode/NotificationService)
  appends it to the subtitle only when the phone pairs with two or more
  hosts, read from the App Group `group.dev.landon.tempcode` directory the
  app publishes (`HostDirectory.swift`; both entitlements carry the group).
  Parity is proved by shared fixtures: infra/hub/test/fixtures/apns/*.json,
  one `{ input, payload }` per notification kind and activity phase, read by
  both remote/apnsPayload.test.ts and the hub's test; each `payload` is what
  `xcrun simctl push` takes. In the foreground a notice for a thread whose
  Live Activity is live shows in the list only, unless it needs you; in the
  background an alert and the activity's end for one settle both show: the
  alert is the record, the activity leaves after two minutes. DEBUG hooks
  for the proof: `TC_TEST_ACTIVITY=<phase>[,notasks][,threads]` starts a
  host-shaped activity with no host (`threads`: a master's batch tally);
  `TC_TEST_ACTIVITY_GALLERY=1|<phase>` opens the gallery of every state's
  card and island over the app, `TC_TEST_ACTIVITY_THREADS=1` as a master
  (the simulator has no lock screen or island a script can drive on a Mac
  without a device window). Device build:
  `bun run ios:device` (scripts/ios-device.sh) builds with the Xcode
  scripts/ios-xcode.sh picks through DEVELOPER_DIR, automatic signing and
  `-allowProvisioningUpdates` with the team id from `TEMP_CODE_APPLE_TEAM`
  or the gitignored `ios/TempCode/Local.xcconfig` (`DEVELOPMENT_TEAM = …`),
  and installs on the connected or paired iPhone with `xcrun devicectl`;
  the simulator build stays ad hoc. DEBUG hook: `TC_TEST_ROUTE=notification`
  with `TC_TEST_NOTIFICATION="title part|seq"` feeds the delegate a
  hub-shaped payload; the proof's `push` set (in `all`) checks the landing.
  Delivery in practice: Cloudflare's fetch speaks HTTP/1.1 to origins and
  Apple refuses it, so the box sends itself (`src/main/server/remote/apns.ts`,
  node http2, the same payloads as the hub's) when `TEMP_CODE_APNS_KEY_PATH`,
  `_KEY_ID` and `_TEAM_ID` name the key (on the box: `/etc/temp-code/apns/`,
  root:agents 640, env in `/etc/temp-code.secrets.env`); with the key the
  host relays every registration locally, takes its devices back from the hub
  at boot and posts notices and Live Activity states over http2. The owner's
  APNs keys are Production-only, so the phone runs the Ad Hoc build
  (`TC_DEVICE_METHOD=ad-hoc bun run ios:device`: archive, export with
  automatic signing, install; `aps-environment` production, no DEBUG hooks,
  the pairing from an earlier Debug install carries over in the keychain).
- Two hosts on the phone: `ProjectPairs` folds one checkout on both hosts
  into one Home row by its `linkId` alone (every host's threads by recency;
  the `HostGlyph` on each thread and agent row with two or more hosts; the
  settings sheet saves on `ProjectLinks.settingsHome`), `HostChip` names a
  thread's host in the header's subtitle with the five-tone `HostDot` (no
  move: `session.move` is Mac-local), a `session-moved` push leaves a
  `MovedThread` record the open screen shows as "Moved to <host>",
  `CrossHost` places a `<env>:<sid>` child or an `agent-spawned` row's host,
  `PathHost` picks the host of a path or an `fs.media` URL's `&host=` and
  words a missing file "No such file on <host>."; the test server's
  `TC_IOS_SECOND_HOST=1` child is the same project on a second host with the
  cross-host child, exported as `TC_TEST_SECOND_*`. docs/IOS-DESIGN.md
  "Two hosts".
- A2/A4 verification on the Mac: pending-turn fixtures use `addPending`
  so each send takes its own key; the reveal test clock runs an already-due
  wake before its 10 ms samples, so a 100 ms step does not read as 90 ms.
  The DEBUG transcript report's `topRow` is `TranscriptRowID.key`, not the
  persisted seq. `docs/IOS-PHONE-A2-A4-VERIFY.md` records the checks and proof.
- Tests: `bun run ios:test` (contract) and `bun run ios:test:client` (the
  package, pure suites plus a live suite against scripts/ios-client-test-server.ts,
  a real server with a read key that lives only in the test process
  environment); both run in the release gate. The test server seeds one
  thread per type with realistic rows and a 2,000-row chat. Simulator proof:
  `bun scripts/ios-sim-proof-local.ts` (every set compiles the Release configuration first and stops on a break, then every segment of every type, a chip
  opened, the diff, the agent detail, light and dark, then the scroll run
  whose frame report lands in /tmp/tc-ios-proof/scroll-report.json;
  `TC_PROOF_SET=transcript` plays the no-jerk timeline through the test
  server's `POST /scenario` in four recorded runs (light, dark, reduce
  motion, scrolled up) and fails when a row on screen made its state twice,
  LayoutProbe's `rowInits` by row key over `RowInitLedger`, or the
  scrolled-up offset moved; `TC_PROOF_SET=stream` writes
  `stream-report.json` from FrameRecorder's `stream` driver while `POST
  /stream` plays pinned at the bottom; `TC_PROOF_SET=glide` (with
  `TC_DUO_POSE=folded`; folded and unfolded, `TC_GLIDE_POSES`) taps a tool
  group of the seeded "Where does the gateway pick an account?" open and
  shut three times at the bottom and 700 pt up, recorded, and
  scripts/lib/group_glide_check.py judges what was drawn (each cell's
  presentation frame, `TC_TEST_GROUP_GLIDE`): heights and rows in steps,
  one way, the rows above still for a reader up and the rows under still
  at the bottom, the group never over the row under it (the tap's glide is
  `ListGlide`, docs/IOS-DESIGN.md "Groups"); `TC_TEST_NO_HARNESS=1` keeps the
  test server's seeded threads from booting CLIs; the 2026-11-05 baseline
  and why the transcript stays a `List` are in docs/IOS-DESIGN.md
  "Performance"), or
  `TC_PROOF_SET=box TC_TEST_THREADS="a|b" scripts/ios-sim-proof.sh` with
  `TC_TEST_PAIR_LINK` from `tc-local remote.pairings.create` on the box; it
  drives the simulator with `simctl` because XCUITest cannot run while the
  Command Line Tools are the selected developer directory. The `features` set
  shoots the screens the 2026-10-22 batch added (the master's board and
  rules, the project plan, notices, failures, the account menu, resources,
  queued and stopped roots, the gate row, Home's fleet confirm). The `actions` set
  (in `all`) re-pairs with the test server's acting key and performs every
  steering action, then reads back what landed from the control panel;
  `bun scripts/ios-sim-proof-box-actions.ts` is the live pass against the
  box: two pairings minted over `tc-local`, two claude-haiku-5-5 threads in
  /srv/agents/work/l5-phone-scratch, one real turn sent and answered, one
  approval decided on the card, then everything archived and revoked. Never
  put a pairing link or a key in a file or a log; the scripts scrub their
  output.

## The menu bar: one table
src/shared/menuTree.ts is the menu as data, read by main (src/main/menu.ts),
the in-app bar and the tests: TempCode, File, Edit, View (Show/Hide
Message List, ⌘⇧M, folds the transcript's message list in every thread of
the window, lib/messageListFold.ts; Force Reload,
keyless, reloads the focused window past its cache from main), Go
(navigation), Threads (Switch Model, Mark All Read, the fleet switches),
Window and Help (What's New opens the running build's notes, Show Logs opens
`<userData>/logs`, the host profile, Developer Tools). Ids
are command ids of lib/appCommands.ts; `MAIN_MENU_IDS` act in main. Each
window sends what it shows over `menu:state` (lib/nativeMenuState.ts:
Show/Hide on the four toggles, ⌘W's Close Tab or Close Pane while the
focused tab is split, idle rows greyed) and main rebuilds the menu
from the focused window's state when it changes. A `pageKey` row (New
Terminal, ⌃`) shows its key but leaves it to the page. The in-app bar
(chrome/MenuBar.tsx, `inAppMenus`) mounts only in web mode off macOS: a
desktop window off macOS has the native bar. It is a `menubar` named "Menu
bar": a lone Alt focuses its first title, Left, Right, Home and End move
between the titles (one tab stop; while a menu is open Left and Right open
its neighbour), and Escape with no menu open, or Alt again, closes it and
puts the focus back where it was, as a pick does before its command runs. Go to Symbol is ⌘⇧O and
Open Project ⌘O, in the menu and the renderer's resolver alike; New
Terminal is ⌃` (⌘` is macOS's window cycle).
Every Node warning the main process raises lands in its log with the site
that raised it (src/main/warningLog.ts `installWarningLog`, the first thing
index.ts does after its boot mark): Node prints a warning's name and message
alone, so the `MaxListenersExceededWarning` V1 saw at boot named neither its
emitter nor its listener. It was appshots.ts: the preload sends
`appshot-ready` at every registration of a capture listener (each pane,
each remount), and each announcement added a `destroyed` listener to the
window; `appshotReady` watches a window for its end once.

## The fleet switches: one click for every thread of a scope
Pause all, Resume all, Stop all and Archive done sit beside Mark all read in
a project's menu (rail row and project header; on a project linked across
hosts they act on every copy, one `session.batch` per host), a host's
submenu in the rail's Hosts row (`HostsRow` in chrome/HostRows.tsx, with two
or more hosts), and the Threads menu for everything; a project card in the
workspace column offers Pause all, Resume all and Stop all over the project
and its linked copies (the `projects` scope, `ids` of every copy), its
archiving staying Archive dormant. Roots only, subagents follow their parent; a row with nothing to
act on is disabled. The rules per row and the toast line are
`src/renderer/src/lib/threadBatch.ts`, the confirm copy with its live count
`lib/threadBatchCopy.ts` (out of the first paint; both unit-tested); the
confirm is red for Stop, and for Archive done only while its removal box is
ticked;
the menus' rows are `threadBatchMenu.ts`; the dialog and toast are
`chrome/ThreadBatchDialog.tsx` and `chrome/ThreadBatchToasts.tsx` (a sonner
toast per batch, through `chrome/toastSync.ts`). Pause,
Stop and Archive confirm; Resume and Mark all read do not. The server side
is `session.batch {action, ids, cleanup?}` (operate), answered by
`SessionRegistry.batch` through `src/main/server/sessionBatch.ts`: ids
mapped to roots once, the existing per-session calls four at a time, every
id answered. `registry.resourceCleanup` (null today) is where the
thread-resources build hangs its clean-up; `setResourceCleanup` in the
renderer turns the Archive done checkbox on. Proof:
`bun run script:e2e-thread-batch`. docs/box.md "The fleet switches". The
phone has the same rows in its host and project menus
(ios/TempCode/Sources/Shell/FleetSwitches.swift over the client package's
ThreadBatch.swift, the rules and copy ported with tests mirroring
threadBatch.test.ts), one `session.batch` per host.

## Plans: `plan_complete` and the auto-start
- A plan is finished when the planner calls the `plan_complete` app tool
  (planning threads only; refused while the plan file is empty) and the
  thread then settles. The planning preamble makes it the last tool call.
  The flow (src/main/server/planFlow.ts, settings in src/shared/plans.ts)
  runs on that settle, never mid-turn: with `plans.autoImplement` on
  (default; Settings → Thread defaults → Plans, overridable per project from the
  project's settings sheet) the host starts the implementation thread
  itself — same host, cwd, model, effort and context window as the plan
  thread unless `plans.implementModel` / `implementReasoning` /
  `implementContext` fix one — with planPath set, the plan thread seeded,
  the title from the plan's `#` heading; `implementationId` on the plan and
  `planThreadId` on the build link them, a `plan-handoff` row lands on the
  plan, and `plans.archiveAfterStart` (default on) archives the plan thread.
  The build, like every thread started with a first message (app_start_thread,
  spawn_agent, a cross-host `thread.start`/`thread.spawn`, `session.create`
  with `firstMessage`, which the renderer's `startThread` sends unless this
  Mac bridges that host), starts through `SessionRegistry.startWith`: the
  message is the thread's first row, flushed with the meta, or the thread
  is removed (`session-removed`) and the error is the caller's; the link,
  the handoff row and the archive wait for that row, and a failed
  auto-start lands a `plan-build` notice on the plan ("The build did not
  start: …"). A first message into a paused tree is stored as its row
  before it waits. Proof `bun run script:e2e-titled-threads`.
  The thread that started the plan (`startedBy`, set by app_start_thread,
  else `parentId`) is woken with a `<subagent-report>` through
  `deliverAgentReport`; a person-started plan whose build waits for them is
  the notifier's "Ready to build" (nothing once the build started: it says
  Done itself) and the "Plan ready" mark on its tab, its rail row (the
  rail reads `usePlanReady` once, `PlanReadyContext`) and the plan view's
  header (with the task count). Plan ready is `planCompletedAt` on a settled
  planning thread alone: nothing reads the plan file for it. With auto-start off
  the plan view's single Start build button (it opens the Start dialog,
  surfaces/threads/StartBuildDialog.tsx), the phone's Start a build sheet (its
  confirm is `plan.implement` since thread 25) and `plan.implement` over the
  wire start the build through the same function.
  Sending into a completed plan whose build has not started reopens it.
  Unit tests: planFlow.test.ts, plans.test.ts; proof
  `bun run script:e2e-plan-auto-implement` (three haiku planners on an
  in-process registry; `scripts/lib/electron-stub.ts` is the Bun preload
  that stands in for the claude driver's `nativeImage` import, so such a
  proof runs without an Electron runtime, on the box too).

## Plans: one build per plan, and the project plan
- A plan's Start (desktop plan pane, phone Start sheet) starts ONE thread:
  an implementation thread, or an orchestration thread as the secondary
  action. The 1/2/3 worker count and the per-worker brief are gone.
- The `project-plan` thread type (docs/PROJECT-PLAN.md) writes
  `<cwd>/.temp-code/plans/project.md` with fixed sections (Goals, Current
  state, Milestones with scope/dependencies/done-when, Risks, Open
  questions; parser in src/shared/projectPlan.ts), calls the same
  `plan_complete` app tool as an ordinary plan (the section above): for a
  project plan the tool writes `status: complete` into the file's
  frontmatter (`ProjectPlans.complete`) instead of stamping `planCompletedAt`,
  so the plan flow's settle rule (`isPlanSettle`, planning threads only)
  never fires and a project plan NEVER starts a build on its own, whatever
  `plans.autoImplement` says. A complete plan ends with three buttons: Plan
  milestone N (a planning thread linked to the first undone milestone, then
  the ordinary single Start), Orchestrate milestone N, Revise… (a dialog
  whose text goes in as a new turn); the view header's "Project's plan"
  toggle keeps it as the project's plan (the header chip then reads "Plan"
  and `3/7`). A landed
  `project.mergeInto` ticks the milestone of every linked build
  (`ProjectPlans.landed`, src/main/server/projectPlan.ts); the checkbox in
  the plan view ticks by hand. State over `projectPlan.*` RPCs
  (src/shared/contract-projectplan.ts). Proof:
  `bun run script:e2e-project-plan` (a real haiku project plan, then a haiku
  milestone plan).

## Master threads: a project's batch of root threads
docs/master-threads.md is the long account (why, the wire, the proofs);
this is the short one.
- **The master is a role, pinned on the thread.** Any root thread is
  pinned as a master on its own row (`sessions.is_master`,
  `SessionMeta.isMaster`; "Make master thread" / "Remove as master" on the
  thread's context menu, rail row and tab; RPC `session.setMaster
  { sessionId, master }`, admin, a subagent refused, answered as the
  thread's meta push; the row is disabled on an unsent draft with "Send a
  message first" as its tooltip, since the host pins only a thread it knows).
  A new chat is born pinned instead: an unsent chat draft's composer
  offers "Master thread" in its draft row (chrome/MasterCheck.tsx, the
  box from the select chunk, kept on the draft's record as `master`), and
  its first send passes `session.create { master: true }` (admin through
  `requiredCapability`, a subagent refused), which sets the flag before
  the eager boot, so the first spawn is a master's; the phone's New thread
  sheet has no such pick yet. Several threads of one project may be, each with
  its own batch keyed by its id. `projects.master_thread_id` is read once
  into the flag when the column is added and ignored since (the column
  stays; `ProjectMeta.masterThreadId` left the wire). Its tab reads one
  muted "Master" after the title; nothing else marks it.
  `isMasterSession(session)` (orchestration.ts) reads the flag off the live
  row when the registry knows the id (the harness boots eagerly at create,
  so a thread pinned after that still gets the batch tools and supervises
  its batch; its prompt and tool set were built at that spawn, so
  `setMaster` drops the handle of a booted thread with no turn running,
  pinned or unpinned (a watching master unpinned idles first), whose next
  send spawns a harness that knows what it is, and whispers
  `masterPinNotice` into one mid-turn or still booting, the next spawn
  carrying the change), `registry.isMaster(id)` in the registry,
  `isMasterThread` (lib/masterThread.ts) in the renderer. The master's
  prompt carries `MASTER_MECHANICS` through `mechanicsFor`, and the claude
  driver denies it Edit, MultiEdit, Write and NotebookEdit: it steers, the
  batch edits.
- **Subagents have titles.** `spawn_agent` (and each batch entry, and the
  codex bridge's `app.spawnAgent`) takes `title`, 3 to 6 plain words the
  transcript, the rail and the Agents list name the agent by; the
  orchestrator's prompt asks for it, `cleanAgentTitle` keeps it one line of
  at most 60 characters, and a batch entry never inherits a top-level one.
  An agent spawned without one starts on its task's first line and the host
  writes its title from the task at once (`SessionRegistry.titleFromTask`,
  the root threads' one-shot `generateTitle`; a rename before it lands
  wins, no answer keeps the first line); a spawn on another host sends
  `autoTitle` on `thread.spawn` and that host writes it.
- **The children are root threads, not subagents.** Each carries the
  master's id (`sessions.master_id`, `SessionMeta.masterId`,
  `session.create { masterId }`) and, when it waits for a sibling, that
  sibling's id (`after_id`, `after`); any type, model, effort, context
  window or host. **The batch follows the starter** (`batchMembershipOf`,
  orchestration.ts): a thread a master starts carries the master's id; a
  thread a batch root starts (a plan calling `app_start_thread` for its own
  build) inherits that root's `masterId`; `startedBy` stays the caller
  either way. It runs in `app_start_thread`, the cross-host `thread.start`
  (`masterId` rides in the args; the Mac stamps it and the box caller as
  `startedBy`) and `SessionRegistry.create` when `startedBy` names a thread
  and no `masterId` was given; the board's add sheet passes `masterId`
  itself. A plan child's auto-started build (planFlow.ts) inherits the
  plan's `masterId`, `after` and `startedBy` the same way; `planThreadId`
  links the two. `batch.adopt { masterId, sessionIds }` (operate) and the
  master's `adopt_thread { threadId }` tool (codex `app.adoptThread`) bring
  an existing unarchived root of this host in (`masterId`, and `startedBy`
  when it had none); a master, a subagent or a thread of another batch is
  refused with its reason. `batch.archive { masterId, which: 'done' |
  'all', removeResources? }` (operate) archives the children through the
  fleet's `session.batch` (done = done, or idle after a turn; all = every
  one, the queued ones archived first so stopping a sibling never starts
  them, then the live ones stopped) and leaves the master.
  `supervisedBy(caller, session)` is the one check every supervision tool
  runs: the caller's subagents, and for a master every root thread on this
  host carrying its id, and every far one of its batch whoever started it
  (crossHostAgents `childOf` reads the batch index); a refusal says why and
  what to do (`refusedAgent`: the `<host>:<id>` of a far thread, a batch
  thread's subagent is that thread's, another batch, adopt_thread).
  `list_agents` marks rows `subagent` or `thread`. Stop, archive, delete
  (docs/master-threads.md "Stopping, archiving and deleting a batch
  thread"): a person may do all three to any batch thread; a master stops
  (`interrupt_agent`: a batch thread with its own subagents,
  `registry.stopSubtree`; a queued thread leaves the queue unstarted,
  archived, which is what a Stop does to any queued row now, the master's,
  a far host's `thread.interrupt` or a tree stop) and archives
  (`archive_threads { which | threadIds }`, codex `app.archiveThreads`,
  `Batches.archiveTool`) and never deletes (irreversible: the person's;
  MASTER_MECHANICS says so). A tree stop's subagents report to no one
  (`quietSettles`), and a stopped turn's settle leaves parked reports for
  the next turn. `session.interrupt { subtree: true }` is a menu's Stop:
  the thread and what it started, never its parent (a subagent line, the
  Agents section's Stop). The renderer says every failed thread action
  with the host's reason (lib/threadActionFailure.ts), never swallows a
  Delete or Archive, and the board drops a deleted child at once
  (`useBoardLayout` remembers a listed child the store stopped holding,
  `boardLayout`'s `removed`; the host re-pushes the batch on a removal it
  listed). Proof: sessions-batch-actions.test.ts,
  MasterView.dom's board actions and `bun run
  script:e2e-batch-child-actions` (real haiku threads). A thread
  settling (idle, error, waiting; never a pause) reports to everyone in
  `settleTargets`, once each: its parent or else its master
  (`settleTarget`), and the thread that started it (`startedBy`) when that
  is someone else, so a plan's build started by the plan reports to the
  master and to the plan; `notifyParentOfSettle` writes the
  `<subagent-report>`, a waiting one with its question for `answer_agent`;
  a `wait_for_agent` in flight takes the settle instead; a plan child's
  plan-complete report is its one report; two threads naming each other as
  master wake neither. A thread a master (or a batch root) starts on
  another host is a batch member there and counted here: the asking side
  indexes it under the master (`crossHost.batch.<masterId>`),
  `Batches.members` joins it with the local roots keyed
  `<envId>:<sessionId>`, `batch.get` lists every child with its host
  (`children`), its state comes from the settle pushes and one
  `thread.list` per host when the local children are done (a far child is
  done when its host says `done` or `idle`), a host out of reach blocks the
  end as `unreachable` naming the host, Pause and Resume cascade to it
  (`thread.pause/resume`), `batch.archive` archives it there
  (`thread.archive`, listed in `succeeded`), `batch.adopt` takes a
  `<envId>:<sessionId>` root (`thread.adopt`), and it lands through its own
  host's `merge_branch`, which asks the owner first (`crossHost.landing`:
  held with `{ branch, host }` under all-at-once after a push to origin,
  else merged and pushed there and reported); the owner's land step fetches
  origin and fast-forwards the project checkout before the gate and release,
  and merges a held far branch from origin. docs/box.md "A master's batch
  across hosts".
- **A thread is the person's choice; the model policy is for subagents.**
  The orchestration rules (src/shared/rules.ts `modelApproved`,
  `approvedDefault`, `fitReasoning`; Settings → Orchestration's Everyone /
  Orchestrators only / Off, Fable orchestrators-only by default, and a
  model the saved rules do not list is Off: a copy saved before that rule
  is written out once with every catalog model it lacked as Everyone,
  `explicitModels`) govern `spawn_agent` alone. The page lists every
  provider's models from the host's live catalog (`catalog.get`, asked at
  each mount: the static rows, the probed ones such as Muse Code's, the Meta
  rows under claude and codex), an empty provider as one muted line, and a
  model the rules name that the catalog lacks as a muted "not on this host"
  row that keeps its policy (`staleModels` in lib/tcserver/rules.ts). A
  probed row the copy never decided reads its `defaultApproval`
  (`withProbedDefaults`, applied in `rules.get` and `rulesFor`, never
  written back, so the page and `spawn_agent` agree on each host); the page
  saves Off as `approved: false` so a decision is never taken for absence. The rules and the thread
  defaults have one copy, on the box: `remote/rulesSync.ts` on the Mac
  seeds each shared scope (global, and every workspace by `linkId`) from the
  Mac once, then follows the box on link-up, its `workspaces` push and
  every 5 minutes (a read sent before a forwarded write never lands over
  it), and sends `rules.set`/`defaults.set` there (refused while it is
  offline; the box stores a rule for a model it cannot run). `rules.get` and
  `defaults.get` answer `home { name, online }` when the copy is another
  host's: the Orchestration and Thread defaults pages print "Saved on box",
  or "box is offline" with every control off, and a refused write rolls
  back with a toast. Each host also knows what the others run
  (`peerCatalogs.ts`: `catalog.exchange`, admin, on every rules sync; kept
  under `catalog:peer:<envId>`), since one copy of the rules cannot make the
  box run Muse Code: the spawnable table lists another reachable host's
  approved rows this one lacks under that host (`- muse on <Mac>
  (environmentId: "mac"):`), `spawn_agent` and `app_start_thread` that name
  a host check the model against that host's rows (`hostCatalogView`), one
  that names none is refused with the environmentId that reaches it
  (`hostServing`), and `withProbedDefaults` reads every host's probed rows.
  Proof: `bun run script:e2e-rules-sync` (`TEMP_CODE_PROBED_CATALOG=<file>`
  answers an isolated instance's probes; docs/box.md "Orchestration rules
  and thread defaults: one copy, on the box"). `app_start_thread`, the
  cross-host `thread.start` and `session.create` check the catalog only (the
  named host's for a start there): the model exists for some provider, the
  effort is on its ladder (else refused, never clamped), `context1m` where
  offered. `spawn_agent`'s refusal of an orchestrators-only model and the
  approved table point a thread at `app_start_thread` for the same model as
  a thread.
- **The queue: `after` and the running cap.**
  `ThreadScheduler` (src/main/server/scheduler.ts) creates a thread
  `queued` (SessionStatusSchema: not live, never counted, never resumed by
  the liveness sweep) for two reasons. Its `after` sibling has not finished
  (met when the sibling is `done`, or `idle` after a turn, or archived or
  deleted; one that errored, stopped or paused keeps the waiter queued);
  only a root whose create opted in waits on `after` (`session.create
  { queue: true }`, or any thread with a `masterId`), on its first message.
  Or the host is at its running cap (src/main/server/admission.ts): the
  `admission.maxRunning` setting when pinned, else floor((budget − reserve)
  / perProcess), budget the smaller of the cgroup's memory.high/max and the
  machine's memory, reserve the larger of 25% and 8 GiB on Linux (50% and
  16 GiB on macOS), perProcess the median harness RSS read every 60 s (450
  MB until five readings); admission also pauses while available memory is
  under 10% of the budget (MemAvailable on Linux, `kern.memorystatus_level`
  on macOS: os.freemem() there counts only never-used pages). Slots are
  counted by handle: every harness up or booting counts (`handles` ∪
  `starting`), whatever its row says, and a running or watching row with
  no harness (a zombie the liveness sweep has not reached, a master Stop
  idled) holds none. That is, every live
  harness counts, roots and subagents, in starting, running, waiting or
  watching (unarchived), plus every row still holding a handle; warm
  processes and queued rows never do. The count and the queue come from the
  session index (sessionIndex.ts `live` and `queued`, roots and subagents)
  and the live handles: a pass reads no sessions table. The cap applies to every start: create's eager
  boot, a first message, a send on a thread whose handle is gone, a
  `spawn_agent` child (created `queued`; `wait_for_agent` waits through
  queued and starting; spawn, `list_agents` and `check_agent` say "queued ·
  120 of 120 running"). `admit` decides in `SessionRegistry.send` (the user
  row and its preamble stamp land as a held-back boot stores them, the
  message waits at the front of the thread's queue marked `stored` on the
  wire, so the composer's queue skips it and the transcript's row is its
  one appearance); `startQueued` (the
  scheduler; `session.start { sessionId }`, operate, the strip's Start now,
  past `after` and past the cap) sends it through the same path; a focused
  send is admitted over the cap, up to two (`scheduler.focused`, wired
  to the host's FocusSet). `tick` runs oldest-first (createdAt, then
  the order the scheduler queued them in) on every meta change and removal and after boot once the BootResumer is done
  (`holdUntil`); a pass reserves the slots of the starts it picks before
  launching them, and while rows wait on the cap it puts down the
  longest-idle harnesses (`reclaimIdle`, 3 s grace, never one with a pass,
  queued messages or reports due), which is how a settle frees a slot. The
  BootResumer resumes up to the cap and leaves the rest `queued` with their
  nudge stored (`queueResume`; their ledger rows stay). A queued row's
  `statusDetail` reads "Waiting for <sibling>" ("(errored)" /
  "(stopped)" / "(paused)" appended), "120 of 120 running" or "Waiting
  for memory" (scheduler.ts `QueuedLine`), and its `activity` the legacy
  "Queued  waiting for memory" for old readers, pushed only when it
  changes; `list_agents` says "queued: 120 of 120 running". RPCs
  `admission.get` (read: cap, pinned, default, running, queued, memory) and
  `admission.set { cap | null }` (admin); a Running threads row in each
  connected host's section of Settings → Hosts shows it
  (surfaces/settings/hosts/Admission.tsx). The
  fleet's Stop and Archive done take a queued root as "remove from the
  queue" and archive it.
- **The batch's rules are a steps list the master writes, and the engine
  runs it** (src/main/server/batch.ts, src/shared/contract-batch.ts
  `BatchRulesSchema`): `land` as-they-finish (merge_branch fast-forwards
  each child's branch as it lands) or all-at-once (merge_branch answers
  "HELD: the batch lands all at once; the master will merge <branch> when
  every thread is done", records the branch, and the engine merges the
  held branches in landing order at the end); `steps: BatchStepSpec[]`
  (`{ id, name, kind, run?, cwd?, when? }`, at most 32) in the order they
  run; `then` notify (a `batch` notice row on the master and a wake) or
  archive-children (the same, and every done child archived); and one
  `summary` line in the master's words. The kinds: `land` (always first;
  a list without one gets it); `gate` (the commit tier once on the project
  checkout at the project branch's head); `release` (`bun
  scripts/release.ts --notes-file <tmp> --push`, the notes the master's
  title then each landed subject's first line, cut at whole subjects to
  16 KiB with "… and N more" (`boundNotes`, `RELEASE_NOTES_MAX` in batch.ts),
  written to a file under the tmp dir that gateRun.ts removes when the run
  ends: the tag, and master with it pushed to origin; with nothing new since the last
  tag the step is skipped as "nothing to release since release-N" and a
  publish or deploy after it takes that version); `publish` (the Mac's publish job
  for that commit over the peer link, "Releases" above; a person's
  decision); `deploy` (the box's deploy trigger of docs/box.md "Deploy from
  the app": `v1.0.N` when a publish passed, `master` otherwise; skipped as
  "needs a release" when no release step comes before it); `shell`
  (`run` through the login shell in `cwd`, default the project checkout,
  on the GateQueue in its own process group, stdout and stderr streamed
  into the step's `log`, exit 0 passes; `when: 'each-landing'` runs it
  again after every landing, serialized, and leaves it out of the end).
  `stepsProblem` refuses a repeated or bad id, two steps of one built-in
  kind, a shell step without `run` and `run` on anything else. Default:
  land, gate, release. The master writes the list with the `batch_rules`
  app tool (master only; codex over the bridge as `app.batchRules`;
  MASTER_MECHANICS says to write the steps that fit the project, for a
  Minecraft plugin build, deploy to the dev server, smoke test, for this
  app gate, release, publish, deploy, and to state them to the person), a
  person over `batch.setRules { masterId, rules }` (operate, a partial);
  a new list keeps the telemetry of every step whose id and kind stay.
  The engine runs when the last child is done (every unarchived root
  carrying the masterId is `done`, or `idle` with a turn completed,
  `Store.hasCompletedTurn`, and no subagent still working: an idle root
  over live subagents is watching, not done, and Archive done leaves it); an errored or stopped child blocks the end,
  and so does one idle on a turn that ended in a failure (its row's
  `failure`, a usage cap; `blocked.why` `failed`; a paused child `paused`, one idle on a turn it never completed `no-turn`, or `interrupted` ("was stopped") when a person's Stop ended that turn, `Store.lastTurnStopped`), `blocked` names it and
  the master is told once as a `<batch-report>`. A red gate or release
  step's `detail` is the step the gate names as failing and its first
  error line, or that line alone when nothing finer than the row's own
  step failed, so the row's name is never said twice
  (`gateFailureDetail`, src/shared/gate.ts; the runner keeps the first
  error line past its tail), no duration, and the gate notice carries the
  same words as `GateNotice.detail`; a failed step whose log only repeats
  its detail opens no console (`hasConsole`, master/steps.ts). `describeTool` (sessions.ts) words
  every tool the strip can meet, the CLI's task tools, the app's and the
  orchestrator's included; an unknown name is humanized, never printed raw.
  Steps run in order on the host's `GateQueue`, a gate or release outcome a
  `gate` notice row on the master; a red step stops the rest and tells the
  master; the steps after land run whenever the batch ends, on the project
  checkout at the project branch's head, however the branches got there (a
  child that fast-forwarded the branch itself never called merge_branch;
  "nothing landed" is the land step's detail, never a reason to skip the
  rest; only deploy without a release step before it is skipped, as "needs
  a release"); the land step counts only threads with a branch to land
  (`canLand`: implementation and orchestration, a chat or research thread
  once it landed or holds one, a planner never); a planning child whose
  plan is complete holds the batch open until its build exists. The end
  runs once per cycle: at all-done when it never ran, or when since it last
  started a landing came in (landed, held, or reported by a far host), a
  child joined that was not in the batch then, or the rules were set
  (`batch_rules`/`batch.setRules`, even unchanged: the hand re-run); a
  child resuming and settling idle again, a child leaving or a failed step
  never starts it (`armed`, `ranChildren` on the row), so a failed publish
  never cuts a fresh release on the next idle. `batch_gate` stays the master's way to run
  the gate and release steps early, with children still out left out of
  the land step (refused when the list names no gate). The deploy restarts
  the box's own process: the row is persisted before the trigger fires and
  `Batches.resumeAfterBoot` (after the BootResumer) closes the step from
  the trigger's exit file, runs the steps after it and `then`; any step still
  running at a restart but a deploy it can follow (gate, release, land
  and shell alike) is failed as such, the master told. `batch.stopStep
  { masterId, stepId }` (operate) kills a running shell step's process
  group or stops the Mac's publish job. Seam: `TEMP_CODE_GATE_STUB=<json>`
  (rules `{ step, branch?, ok, log? }`) decides a gate or release step
  without spawning.
- **Step telemetry on the wire.** `BatchState` (`batch.get`, `batch.board`,
  and the pushes, coalesced to four a second while a log streams) carries
  `rules`, `steps`. Sockets watching that master (boardWatch.ts) get
  `batch-delta`, each step's log as `{ from, lines }` since the last push;
  a socket that never asked `batch.board` (the phone's `BatchPush`) gets
  the whole state as `batch`. `steps` is the list
  in order, each `{ id, name, kind }` with `status` pending | running |
  passed | failed | skipped, `detail`, `startedAt`, `endedAt`, `progress
  { done, total, label? }` (land: branches merged of total; gate: the
  tier's steps done with the running one as label; publish and deploy:
  their stage) and `log` (the newest 200 console lines; a shell step's
  opens with `$ <run>` and ends with its outcome), plus `landed`,
  `pending`, `held` (all-at-once), `blocked` and `finishedAt`. The board's
  foot draws a live console per running step from exactly these.
- **The master stays live until the batch is done.** A master whose batch
  is open (`Batches.open`: children exist and not all are done, or the
  engine is at work) takes `watching` in place of `idle` when its turn
  ends: the harness stays up, the queue and the completed-turn pass drain
  on that watching as on idle, the boot ledger keeps it so a restart brings
  it back (into a turn, then watching again), and the batch closing idles
  it (`registry.masterIdle` when nothing is coming). A dead harness under a
  watching row is settled the moment the driver's stream ends
  (`harnessGone` → `settleGoneHarness`), the liveness sweep being the
  fallback past the grace: a master kept watching by its batch reads
  `stopped` with its clock at zero (Resume boots a fresh harness with the
  restart nudge and a clock that starts then; the parked reports follow at
  its settle), a thread watching its own background work settles idle, a
  report to a dead watching master boots a fresh harness (`drainReports`); Stop and
  Kill background tasks on a watching master idle it for real (a one-shot
  `stopWatching`), unpinning idles it, and `liveIds` counts handles and
  boots only. `decorate` gives a watching master its batch's reason ahead
  of the watch line ("Blocked: A errored", "Blocked: A ended its turn
  without completing": `blockedWords` in src/shared/batchWords.ts, which the
  board's foot and the phone say too) and every meta carries
  `lastEventAt`. A batch that has not moved for `STALE_WATCH_MS` (30 min:
  the children's last rows, a far child's last settle, the steps, the
  master itself) while its master watches unblocked is told once as a
  `<batch-report>` naming every thread with its state and age
  (`Batches.checkStalls`, every minute, the stamp on the row), and again
  only after the batch moves and goes quiet again; a blocked batch is not
  a stall.
- **A message to a live thread goes straight in.** To a watching master it
  starts a turn at once (the idle path). To any thread mid-turn and not
  paused, `queueAdd` whispers it into the live turn as a `<user-steer>`
  with its user row kept (`steerLive`; attachments still queue; the
  composer's Enter steers by default, `MID_TURN_DEFAULT`; `queue.add`
  answers `queued` with its item or `steered` with its id); a whisper into
  a dead handle boots a fresh harness that gets the text once; a provider
  that cannot take mid-turn input, or any other failure to hand it over,
  front-queues it. Every person's steer (the composer's, a queued item's
  Send now, attachments and all, the phone's; never `send_to_agent`)
  carries a `steerId` on its user row, and `steer { steerId, state, how?,
  reason? }` rows say where it stands (src/shared/events.ts; the last row
  wins): `sent` once the harness has it, `received` when the model read it
  (claude: the CLI lists the id, sent as the SDK message's uuid, in
  `user_message_uuids` on the frame after the fold, drivers/claude.ts
  `readSteers`; codex: `turn/steer { expectedTurnId, clientUserMessageId }`,
  falling back to `turn/start` with the id when the turn ended, and the
  `userMessage` item carrying it as `clientId`), `in-turn` or `next-turn`,
  `queued` while it waits for the next turn, `failed` with the reason when
  it never reached a model. A driver without `confirmsSteers`, or a steer
  still at sent when its turn settled, is received at the next turn's
  first output (`steerFallback`). The text goes in as `wrapSteer` (the
  `<user-steer>` block and one line asking for a one-line answer first;
  `STEER_MECHANICS` says the same beside the notes mechanics in every
  prompt). Under the bubble the transcript says one 12px word, Sent,
  Received, Queued for the next turn or Not delivered, its time and how in
  a tooltip (transcript/UserMessage.tsx `SteerLine`, lib/steerWords.ts);
  the phone the same (`SteerStamp`, TranscriptRows.swift; its time is the locale's clock, `TimeFormat.clock`). The CLI reads a
  steer only at its next model request, after the call it is running or
  the compaction it is in (the box, 2026-11-06: one waited through a 600 s
  Bash call, one through a 3 min gate; nothing was open at the provider),
  so a send into an open turn announces nothing (`announcesSend`,
  drivers/claude.ts: no `running`, no `waiting-provider`, no first-output
  watchdog), a `running` repeated on a running row keeps the turn's
  activity, and while a confirming driver's steer is unread the row reads
  the turn's own word with the message behind it, "Running the gate, then
  your message" (`thenYourMessage` in shared/statusWords.ts, `steerUnread`
  in sessions.ts; a Bash call is named by its first command past a `cd`,
  an `export` or a `NAME=value`, `commandLead`), never a provider wait of
  its own. Proof: `bun run
  script:e2e-steer-ack` (docs/box.md "A steer says it was received"). And a send releases the
  thread's pending `wait_for_agent` as the steer does
  (`resolveSteerWaiters`): a master's wait in flight returns
  `{ status: 'steered', message }` in every mode, never swallowing the
  person. A settle, idle or watching, takes what waits as one turn
  (`drainSettled`): the held notices, the parked reports, the person's text
  last; a report never wakes the thread alone while text waits.
  MASTER_MECHANICS prefers ending the turn and being woken to blocking
  waits.
- **Pause cascades.** `session.pause` on a master pauses every root of its
  batch on this host (four at a time through sessionBatch.ts
  `batchChildIds`), `session.resume` resumes them, Stop stays per thread;
  the paused banner folds those children under the master as "and N batch
  threads with it", and the master's own strip says the same when it is
  on screen. A board view (master, plan, implementation, research) whose
  chat is folded draws the thread's paused row under its header
  (SplitShell `held`, `heldRowOf`), never while the chat shows.
- **The gate out of the children** (src/main/server/{gateQueue,gateRun}.ts,
  src/shared/gate.ts, docs/review-before-merge.md): `merge_branch` gates
  the branch after the optional review and before the fast-forward: a
  batch child runs `bun run typecheck` alone in its worktree (a break is
  named to its thread); a thread outside any batch runs `bun
  scripts/gate.ts --tier commit --since <merge-base>` there. A red run
  answers "HELD: typecheck failed on <branch> · 3 errors", the last 20
  lines, "call merge_branch again", and lands a `notice` row of kind `gate`
  (`GateNotice`, surfaces/GateCard.tsx). The gate's hub, ios, ios-client and
  computer-swift steps are `mac: true`: a host off macOS (the box's merge gate, the box's
  release step) skips them with a note, and the Mac's publish gate runs
  them before anything ships. The house preamble (`HOUSE_PREAMBLE`) tells a
  thread to run typecheck and the tests it wrote or touched, never the full
  suite or the build, and to land with `merge_branch`.
- **The view** (docs/LAYOUT.md "Master"): `MasterView` (surfaces/threads,
  routed when the session's `isMaster` flag is on, whatever its type;
  `isMasterThread(session)` and `useMasterIds()` in lib/masterThread.ts,
  the tab's and the rail row's "Make master thread" / "Remove as master" over
  `session.setMaster`) on the SplitShell recipe, the board left of the
  master's chat while the batch has a row or a step runs (`boardShown`);
  with nothing in its batch the master is its transcript alone and its
  thread menu holds New batch thread… and Add existing thread…
  (`BatchAddDialog`, the same dialogs as the board's + menu); a board
  that arrives live opens the chat and fades in, one that empties leaves
  at once. The board, its rows, the foot, the dialogs and the add
  sheet are surfaces/threads/master/**. The rows are the children on
  every host the renderer knows (the session store holds each connected
  or mirrored host's rows; `batch.get`'s `children` list, when the host
  sends one, overrides a row's host and status, `mergeBatchChildren`); a
  row on another host than the master's carries that host's glyph after
  its title, its name on hover (`rowHost`), and sits under the
  offline tint while that host's link is not open. A child the store has
  no row for draws from a whole stand-in meta (`standInMeta`: the list's
  provider, model and effort, the rest at rest; no model, no model mark).
  Each row sits in its own `RowBoundary` (master/RowBoundary.tsx, the
  ChunkBoundary pattern): a row that throws paints "Couldn't load" and
  Retry at its height, its siblings, the board, the rail and the
  transcript stay, and stalls.log's `[renderer] caught` line ends
  `thread=<master> row=<child>` (`tagRendererError`). The board sits in
  one more boundary (`MasterView`'s, `failed` on ChunkBoundary): a board
  that throws outside a row leaves the master as its transcript alone
  under "Couldn't load the board" and Retry (`BoardFailed`), tagged
  `thread=<master> view=master`. A plan that started several builds lends
  its row to the first and each later build is its own row (`foldRows`):
  rows never share a key, which kept `useBoardLayout`'s snapshot from
  settling (React #185 on "Update 35 more"). A row is 48px, two
  lines on `Item` with every left edge of the board 12px in
  (master/MasterRow.tsx, the rule `rowStatus` in master/rowBody.ts):
  the type glyph (its word in a tooltip), the title, the host glyph and the
  model mark (provider mark, model and effort, "Opus 5.5 High"; the whole
  model, effort and context in its tooltip; the title gives way first);
  then `StatusMark`'s glyph hanging under the type's (working's spinner the
  row's one moving mark; none for done or idle) and in the title's column
  the word where the section does not say it, then what the state is
  about (the task in hand, the question or "Approve Bash" in amber, the
  failure in red; "Landed 12:08 PM" (lib/duration.ts `clockTime`, the app's one clock time: 12-hour with AM/PM where the locale writes it) or a settled research thread's summary;
  the child the batch's `blocked` names says why, "Ended its turn without
  completing"; a watching or paused child under Working, a failed one
  under Needs you, says its own word) and the task tally `3/7` at the end; the sections read Needs you, Working, Queued,
  Done with no counts. An implementation or orchestration row with tasks
  is 64px until it is done (a finished one is 48px, its tally back at the
  end of line two, none once every task is ticked): a third line holds the task bar (`Progress`, foreground while
  working, muted otherwise), the tally said there alone and a chevron
  right after it; every bar on the board is one width, 35% of the board
  pane (`@container` on MasterView's `data-board-pane`, the bar
  `w-[max(160px,35cqw)]`, no cap: a column too narrow shrinks the bar),
  the whole line folding the task list open under it (`TaskRows` compact;
  open by default while the thread is live, folded with the line on
  `.collapsible-auto` `FOLD_HOLD_MS` after it reaches Done, once, at that
  transition, `useFoldHold` in lib/foldHold.ts; the person's choice wins
  both ways, remembered per row for the window's life in
  master/taskFold.ts; `taskBar` and `taskProgress` in master/rowBody.ts).
  On hover the model mark gives way to Message, the state's one verb
  (Pause, Resume, Start now) and ⋯, the row's menu, where Stop, Archive
  and a queued thread's Remove from queue live. A row whose thread has
  live subagents lists them under its two lines, one line each: the status
  glyph drawn still (working as a dot), the title, the state's word in its tone and what it
  is about, muted, in the board row's own words (`rowStatus`), and the
  host's glyph, no role glyph; the
  whole tree by the parentId chain, archived ones out, a far child's from
  its host's rows, the person's first (waiting, failed, working, then
  paused or queued), at most three, then one quiet "2 more, 3 done";
  agents that all settled show nothing. A line opens the agent in the
  board's place like a row (`underRow` keeps it open)
  (`master/agentSummary.ts`: the session store keeps a parent index and
  reports changed ids with their old and new ancestor chains once per
  flush; only affected rows rebuild their summaries, and a row
  re-renders only when its own lines changed. Summaries and digests prune
  children that leave the board; the phone's
  `MasterBoard.rowAgentLines` the same, each line a link to the agent's
  thread screen, the tail "2 more, 3 done"). A row's click puts the
  child's full view in the whole pane with one Back control
  (`master/ChildPane.tsx`, given the row's host; Escape and ⌘↩ outside
  the composer go back; the board keeps its scroll; the header is Back and
  the title, drawn at once from the board's row, the body the transcript's
  skeleton until the rows load; a board-type child's view draws one header,
  its own, with Back leading it, surfaces/threads/viewBack.tsx), over the same
  transcript, strip and composer a tab has (`surfaces/threadChat.tsx`:
  `ThreadComposer` and `useThreadChat`, shared with SessionPane; App's
  handlers through `SessionActionsContext`). A right-click on a row or a
  subagent line, or its ⋯, is that thread's one menu (lib/threadMenu.ts
  with `{ open, newPass }`: Open, New pass…, Start now for a queued
  thread, then the rows every surface shows, Remove from queue in a
  queued thread's Archive place; chrome/useThreadMenu.tsx answers the
  picks); New pass… is a Modal (`master/NewPassDialog.tsx`) with the
  thread's title, its status and activity or last words on one line
  (`passLine`) and that composer, closing on send; the draft stays per
  thread. The title bar's ⋯ menu is the batch's
  fleet switches over every host (Pause all and Resume all through each
  row's host's `session.batch`; Archive done… and Archive all… with the
  live count (done by the host's own rule, `BatchState.done`, the far
  children as `<env>:<id>`; an older host's answer falls back to done or
  idle less the blocked child) and the resources checkbox: `batch.archive` on the master's
  host, then each other host's `session.batch` for the rows its answer
  left, `remoteArchivePlan` in `master/boardActions.ts`), + (Add thread) a menu
  with New thread… (the add sheet: every type, Chat first; Host over the master's host and every
  linked one, `linkedHosts`; `session.create` on that host with
  `masterId` and `startedBy` = the master) and Add existing thread…
  (the project's roots in no batch on this host and its paired copies,
  `pairedProjectIds`; one `batch.adopt` on the master's host, a remote
  thread as `<envId>:<id>`, refusals read back in the sheet). The board's
  header is SplitShell's: the master's title (14px semibold), the batch's
  done tally (`doneTally`, "3/7", the rail card's count), then ⋯, + and
  the conversation toggle as equal 28px icon buttons; the master's
  summary stays in the rules dialog. The foot is rows: "When done" with Edit, one row per step
  (`StatusMark` through `stepState`, the name, `stepDetail`, the time,
  Stop on the running one), the running step's console opening under its
  own row (`Collapsible`; a shell step's command shows once, as the
  console's first line), and "Then notify you" or "Then archive the
  threads"; the rows paint from the store at once and only the foot is a
  still `Skeleton` until `batch.board` answers. The foot and the
  rules dialog read the steps as the master's
  list: `master/steps.ts` joins `rules.steps` with `state.steps` by id (a
  step the rules name that the host has not seen is pending at the end),
  Stop is `batch.stopStep { stepId }`, and the dialog
  (`master/rulesEdit.ts`) reorders, renames, adds a built-in kind or a
  shell command with a cwd and removes steps, land pinned first with no
  move or remove of its own (`normalizeSteps`, `pinned`); no step name is written in
  the renderer. A menu or popover sits on the popover layer
  (`--layer-popover`), above every dialog. `lib/threadBatch.ts`
  exports `hasRunningTurn` so the rows and Pause all use the fleet
  switches' rule. The phone draws a queued root with the label "Queued"
  (StatusDot.swift), never under Home's Running (`HomeModel.isLive`); the
  strip offers Start now (`session.start`) and a stopped root Resume; the
  fleet switches sit in the host's and the project's menus
  (ios/TempCode/Sources/Shell/FleetSwitches.swift over the client package's
  ThreadBatch.swift); a master opens on its Board segment ("The iOS
  client" below).
- **The rail houses the batch under the master's row** the way subagents
  sit under a root (`batchHome`, `railMasters` in lib/workspaceSessions.ts):
  each unarchived root carrying the master's id is a `batch` row (apart
  from the master's own subagents in `children`; a list row shows the batch
  first, then the subagents, folded behind "N threads"), each with its own
  subagents under it; a plan whose build has started takes no row
  (`startedPlan`), an archived thread never does, and a batch whose master
  is archived or unpinned shows as plain roots, in the strip as on the
  rail (`batchHome`, lib/threadStripModel.ts). In the workspace column a
  project's card draws a master's batch as one block under the master's
  line, which ends in the batch's done tally (`3/7`; `cardLines` in
  lib/sidebarRows.ts, `MasterLines` in chrome/WorkspaceSessions.tsx; a
  working batch line draws a dot and the master's line spins while its
  block works (`MasterBlock.lead`), one moving mark per block); the
  workspace popover (a rail row's word)
  keeps a master as one block (`masterBlock` in lib/sidebarRows.ts,
  `MasterRows` in chrome/WorkspaceThreadsPopover.tsx): the master's row
  with the tally, its own working subagents under its title in the fleet's
  words, then each batch thread that works, waits, failed, paused or
  stopped one step in, loudest first, its working subagents under it, and
  the queued ones as one "N queued" line; settled ones are the tally.
  Nothing inside a master is unread (`housedIds`: the batch and every
  subagent of the master or of its batch): no weight and no count in the
  project card, the rail row, the popover or Mark all read; the master
  keeps its own. They still light their project's and workspace's Needs
  you and Working (`groupMark` over `cardThreads`).
- **Proofs and tests.** `bun run script:e2e-master-batch`
  (scripts/e2e-master-batch.ts: the whole flow in one process, a haiku
  master pinned with `session.setMaster` beside a second master of the same
  project, writing its steps with `batch_rules` (a shell step last) and
  starting four children of three types with one `after`, a thread a child
  starts inheriting the batch, `batch.adopt` and its refusal, settles,
  `answer_agent`, a land held then merged, a Fable THREAD started from a
  plain chat and a Fable SUBAGENT refused it, the engine ending the batch
  by its steps and idling the master, `batch_gate`, `batch.archive done`),
  `bun run script:e2e-queue` and `bun run script:e2e-batch-gate`; none in
  the gate (they boot harnesses). Unit tests: rules, orchestration (master
  section, the refusal wording, the steer, `settleTargets`,
  `batchMembershipOf`), apptools (no policy for threads, the inherited
  batch), remote/crossHostThreads (the batch over `thread.start`),
  db-master (the flag, the one-time copy of the project pin), scheduler,
  threadBatch, gateQueue, gateRun, mergeReview, batch (the steps list and
  its refusals, the legacy row, shell steps passing, failing, stopped and
  each-landing, adopt, archive, the blocked case, the telemetry, the push
  throttle, the deploy's restart), sessions-master (the watching master,
  the steer, the cascade, the batch following the starter, `setMaster`,
  archive), sessionBatch, planFlow, projectPreamble, contract-batch, the
  peer publish on both sides (remote/macPublish, remote/peerPublish,
  contract-publish); the renderer's useMasterModel, MasterView.dom,
  GateCard.dom, TabIndicator.dom, ThreadBanners, ThreadHeader,
  WorkspaceSessions.dom.
## The prod worktree is retired
~/IdeaProjects/temp-code-prod was the old local updater's build checkout.
The updater no longer reads it or the source repo at all; it can stay
detached as a scratch checkout or be removed. Never build into or swap
/Applications/TempCode.app yourself.
