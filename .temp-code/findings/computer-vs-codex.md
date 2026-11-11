# Computer use vs Codex: the measuring rounds

This file records each round of the field suite (docs/computer-protocol.md §21.7: `bun run script:e2e-computer-bench -- --set field`, hand run on the Mac), which runs the 2026-11-10 field test's tasks three ways — our computer tools from Mac threads (`--host mac`), our tools from box threads over the Mac bridge (`--host box`), and Codex's own `cua_repl` (`--reference codex`) — on `claude-opus-5-5`, `claude-sonnet-5-5` and `gpt-6.1-sol`, one run at a time, Away on, every end state read from the disk or the app's own state. The bar is `fieldBar` (scripts/lib/fieldBar.ts, `--judge-field mac.json box.json codex.json`), three clauses exactly: **(a)** per model, the Mac run passes every task Codex passed AND passes at least one task Codex failed; **(b)** per task Codex passed, the model's Mac median wall seconds and median computer calls are at or under Codex's; **(c)** per model, the box run's total wall seconds over the tasks both hosts ran is within 15% of the Mac run's (`BOX_TOTAL_RATIO` 1.15). A (model, task) hole in a given report is a named `missing` miss, so "field bar met" is impossible with one.

## Round 0 — the baseline: the 2026-11-10 field test

Source: `.temp-code/findings/computer-field-test-2026-11-10.md` (the hand script `suite.py`, the person's Mac, one run at a time; outcomes verified on disk by `suite.py verify`). Its six tasks map onto the field ids: T1 → `field-calc`, T2 → `field-chrome-bg-tab`, T3 → `field-web-form`, T4 → `field-textedit-add-line`, T5 → `field-textedit-save-as`, T6 → `field-finder-rename` + `field-finder-trash` + `field-finder-new-folder` (one T6 tally of 3). The old test had NO counterpart for `field-app-launch`, `field-chrome-below-fold`, `field-chrome-tab-switch`, `field-textedit-close-discard`, `field-textedit-close-keep` and `field-menu-shortcut` — those start at round 1. Round 0 ran under the old Away rules (every approval denied: T3 and T6 denials in three runs) and before every fix below, so it is the baseline, not a bar-judged round.

| run | tool | model | host | T1 calc | T2 bg-tab | T3 form | T4 add-line | T5 save-as | T6 finder (of 3) | pass | agent s | calls |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| r1 | TempCode | Opus 5.5 | box | pass | fail | fail | pass | fail | 0 | 2/6 | 195 | 39 |
| r1b | TempCode | Opus 5.5 | box | pass | fail | fail | pass | fail | 0 | 2/6 | 430 | 36 |
| r2 | TempCode | Sonnet 5.5 | box | pass | pass | pass | pass | fail | 0 | 4/6 | 252 | 69 |
| r4 | TempCode | GPT-6.1 Sol | box | pass | fail | fail | pass | fail | 0 | 2/6 | 383 | 32 |
| r3 | TempCode | GPT-6.1 Sol | Mac | pass | pass | denied (Away) | pass | fail | 0 | 3/6 | 153 | 32 |
| r3b | TempCode | GPT-6.1 Sol | Mac | pass | pass | pass | pass | fail | 0 | 4/6 | 564 | 39 |
| r6 | TempCode | Opus 5.5 | Mac | pass | pass | pass | pass | fail | 2 | 4/6 | 255 | 52 |
| r7 | TempCode | Sonnet 5.5 | Mac | pass | pass | pass | pass | fail | 0 | 4/6 | 221 | 47 |
| r5 | **Codex cua_repl** | GPT-6.1 Sol | Mac | pass (24 s) | fail | pass (26 s) | pass (17 s) | pass (31 s) | 3 (36 s) | **5/6** | **165** | **32** |

The reference row to beat: Codex 5 of 6 in 165 s over 32 calls; its one failure the background tab (T2), which our Mac runs read in 13–31 s. Our fast lanes in round 0: T1 8–19 s, T3 9–14 s (Sonnet/Opus Mac). Our losses: the save panel (T5, 0 of 8), Finder commits (T6 on disk, 2 of 24 legs), background Chrome from the box.

## Round 1 — the baseline of the field suite (Sonnet on the Mac only)

Ran 2026-11-10 21:51–22:16 on the Mac, a scratch clone at master `d24b29c7b` (`~/tc-bench-r1`, built with `TEMP_CODE_REQUIRE_NATIVE=1`), `TEMP_CODE_COMPUTER_TRACE=1`; the runner kept its own idle gate and ran the bench with `TC_BENCH_UNGATED=1`. The master stopped the round at ~23:30: the person was using the Mac, and another agent's TC Probe proof (`e2e-tc-computer --gate`) held the proof order. One invocation completed — ours, on the Mac, `claude-sonnet-5-5` — and it ran twice (`bun run` relaunched the lane after the judge's exit 1): pass 1 **7/14**, pass 2 **8/14**. Reports and the trace: `.temp-code/cu-vs-codex/mac/r1/` (`mac-claude-sonnet-5-5.{json,md,log}` is pass 2, `-pass1.{json,md}` pass 1, `summary.md`). Codex has no run this round, so nothing here is judged by the bar.

| task | pass 2 | s | calls | held s | tiers | pass 1 (s, calls) | cause of the loss |
|---|---|---|---|---|---|---|---|
| field-calc | pass | 14.1 | 3 | 0 | ax 22 | pass (17.0, 4) | |
| field-app-launch | pass | 9.9 | 3 | 0 | ax 11 | pass (9.8, 3) | |
| field-chrome-bg-tab | pass | 31.2 | 5 | 0 | process 1, ax 1 | pass (38.2, 8) | |
| field-chrome-below-fold | pass | 20.8 | 6 | 0 | process 2, session 1 | pass (19.3, 5) | |
| field-chrome-tab-switch | pass | 19.4 | 2 | 0 | – | pass (19.8, 2) | |
| field-web-form | pass | 47.2 | 18 | 0 | process 6, ax 4, session 1, front 1 | pass (34.1, 13) | |
| field-textedit-add-line | pass | 14.0 | 3 | 0 | process 1, ax 1 | fail, off-route Bash (21.1, 4) | pass 1: the model |
| field-textedit-save-as | fail | 62.1 | 20 | 0 | ax 4, session 1, front 1 | fail, timed out (480.0, 123) | front tier: the stale menu item |
| field-textedit-close-discard | fail | 21.6 | 7 | 0 | ax 3, process 1 | fail, off-route Bash (16.0, 3) | suite: no close sheet |
| field-textedit-close-keep | pass | 28.1 | 10 | 0 | ax 2, process 1 | pass (27.1, 10) | passed on autosave: suite, no close sheet |
| field-menu-shortcut | fail | 27.5 | 8 | 0 | front 2, ax 1 | fail (46.9, 15) | front tier: the stale menu item |
| field-finder-rename | fail | 12.9 | 5 | 0 | ax 2 | fail (12.6, 5) | a rename on screen only, not on disk |
| field-finder-trash | fail | 20.3 | 7 | 0 | ax 1, front 1 | fail (16.5, 6) | suite: the Trash EPERM |
| field-finder-new-folder | fail | 66.3 | 19 | 4.0 | ax 4, process 4, front 1 | fail (73.1, 21) | front tier: the stale menu item |

**Each loss by cause** (the diagnosis of every call is `/tmp/cu-r1-diagnosis.md` on the box, written from the per-call records and the protocol trace):

- **Suite bugs, fixed by `614dbd142`** (field tasks to version 3, §21.7):
  - *The Trash EPERM.* TCC bars the bench from listing `~/.Trash`, so `field-finder-trash`'s check crashed before it judged (`EPERM … scandir '/Users/landon/.Trash'`) and every Finder teardown failed to sweep its scratch file. The task itself very likely passed: the forced front-tier ⌘⌫ ran (call 7). The suite now reads and sweeps the Trash through Finder over AppleScript, names every scratch Finder file by the run's nonce, deletes only this run's items one by one (never `empty trash`), and `--clean-trash <nonce|all-bench>` removes what a failed teardown left.
  - *The dead close-sheet flag.* `-NSCloseAlwaysConfirmsChanges YES` as a launch argument has no effect on macOS 27.2 TextEdit: the close ran with no sheet, so `close-discard` had nothing to answer (the model went to Bash: off-route), and `close-keep` passed only because autosave kept the line. The suite now writes the pref with `defaults` for the run and restores it exactly, proves the sheet on a sacrificial saved file in its own TextEdit (no sheet skips the task with the reason, neither pass nor fail), and gives `close-keep` close-discard's edited-before-close guard.
- **Owned by fix threads still open on master: the front tier, steps that need the app active** — `save-as`, `menu-shortcut`, `finder-new-folder`, and the menu path of `finder-trash`. The front hold now arms and the app activates, but the menu item still reads disabled when the hold ends: `enabledInHold` (native/tc-computer `InputEngine.swift` ~297) polls `AXEnabled` for only `Front.settleMs` = 250 ms, and TextEdit's and Finder's File-menu items do not re-validate in that window unless the menu opens (AppKit validates lazily). Every hold timed out at 251–262 ms and failed `action_unsupported` ("File › Save As… is disabled now; try another way"); `save_as` goes the same way through `PanelPlan.open()`. It is a race, not a true disable: in `finder-trash` a retry of ⌘⌫ forced to the front tier ran after identical attempts failed. Owners: **Z1fF9Kpxy3hR** for the service, **ypMfSDYrNA9E** for the bridge proof.
- **`finder-rename`**, same family (7jru36EbqlG4, §26): ax `set_value` on Finder's name cell changed the screen, not the disk; `confirm` ran with no effect, and the tool answered ok, so the model reported done. The step should say "on screen only, not committed" until the commit lands.
- **The model**: pass 1's `add-line` went to Bash (off-route) and passed in pass 2.

**Where our tools win:** all five Chrome tasks passed for Sonnet on the Mac in both passes, `field-chrome-bg-tab` among them — the field test's background-tab read, which Codex failed (round 0, T2), now passes in 31–38 s.

**Cost on the tasks that passed**, against Codex's round-0 times: `field-web-form` is the outlier (18 calls, 47 s, against Codex's 6 calls and 26 s); `field-chrome-tab-switch` spends 19 s on 2 calls, mostly the settle wait. Both are the fewer-calls work (§27): its build, `0de7a9bc0`, landed after round 1, so round 2 is the first to measure it.

**Not run, six invocations:** Opus and GPT-6.1 Sol on the Mac, all three models from the box, and the Codex reference. The master stopped the round because the person was using the Mac. Opus had started (22:23) but sat held by `proofOrder` behind the other agent's `e2e-tc-computer --gate` wrapper, itself waiting on idle; `field-calc` and `field-app-launch` were skipped at the 30-minute cap ("another computer proof is running") and the process was gone at the stop, with no report. The box clone (`/srv/agents/work/tc-bench-r1`, `d24b29c7b`) was ready and never used.

## What is left to run: round 2

- **Commit:** current `origin/master` once the two fix threads (Z1fF9Kpxy3hR, ypMfSDYrNA9E) land. It carries `614dbd142` (the suite fixes) and `0de7a9bc0` (fewer calls, §27).
- **Clones**, both at that commit and built: `~/tc-bench-r2` on the Mac (`TEMP_CODE_REQUIRE_NATIVE=1 bunx electron-vite build`) and `/srv/agents/work/tc-bench-r2` on the box, each with a `.bench-ready` marker once the build passed.
- **Order**, one invocation at a time, round label `r2`: ours on the Mac with Sonnet, Opus, GPT-6.1 Sol; then from the box with Sonnet, Opus, GPT-6.1 Sol; then the Codex reference.
- **Idle gate** before each invocation: the screen unlocked and HID idle ≥ 300 s, polled once a minute, for at most 3 hours (then the invocation is "not run"); one computer proof at a time, through `proofOrder`.
- **Each invocation:** `--clean-trash all-bench` before and after; `TEMP_CODE_COMPUTER_TRACE=1`; copy its report, `.md` and log off to `.temp-code/cu-vs-codex/<host>/r2/` at once (`/tmp` is purged on reboot).
- **Then judge** with `--judge-field mac.json box.json codex.json` and fill the round-2 block below.
- `bun run` proof rows now start through `scripts/proof-bun.ts` (master `191083b43`), so `bun run script:e2e-computer-bench -- …` is fine again.

## How to run a round (on the Mac)

The bench runs a SCRATCH build and never the installed app; never run it from `~/IdeaProjects/temp-code`.

1. **Scratch clone and build:**
   ```sh
   git clone ~/IdeaProjects/temp-code ~/tc-bench-r1 && cd ~/tc-bench-r1
   git checkout <the round's master commit>
   bun install --frozen-lockfile
   TEMP_CODE_REQUIRE_NATIVE=1 bunx electron-vite build   # builds tc-computer too
   ```
2. **For `--host box`:** a built clone of the SAME commit on the box (the box's agents user holds the claude and codex CLI logins the half uses direct):
   ```sh
   ssh box 'git clone /srv/agents/work/temp-code /srv/agents/work/tc-bench-r1 && cd /srv/agents/work/tc-bench-r1 && git checkout <commit> && cp -al /srv/agents/work/temp-code/node_modules node_modules && bun install && bunx electron-vite build'
   ```
3. **Keep the Mac awake** (`caffeinate -dis &`), screen unlocked, the person away; TC_BENCH_UNGATED=1 is their leave. Quit Calculator and System Settings first.
4. **The three runs**, from `~/tc-bench-r1`, one after the other (each is serial inside too):
   ```sh
   TC_BENCH_UNGATED=1 bun run script:e2e-computer-bench -- --set field --round r1
   TC_BENCH_UNGATED=1 TC_BOX_SSH="ssh box" TC_BOX_CLONE=/srv/agents/work/tc-bench-r1 \
     bun run script:e2e-computer-bench -- --set field --host box --round r1
   TC_BENCH_UNGATED=1 bun run script:e2e-computer-bench -- --set field --reference codex --round r1
   ```
   The reference needs the person's `cua_repl` plugin in codex and waits for 2 idle minutes per run unless ungated.
5. **Reports** land at `/tmp/tc-computer-bench/<stamp>/report.json` (one stamp per run; /tmp is purged on reboot). Copy them off at once:
   ```sh
   mkdir -p ~/tc-bench-rounds/r1 && cp /tmp/tc-computer-bench/*/report.json ~/tc-bench-rounds/r1/   # rename mac/box/codex.json by run
   ```
6. **Judge** (any host; the reports classify themselves):
   ```sh
   bun run script:e2e-computer-bench -- --judge-field ~/tc-bench-rounds/r1/mac.json ~/tc-bench-rounds/r1/box.json ~/tc-bench-rounds/r1/codex.json
   ```
   Paste the table into this file under the round, with each miss.

Round 2 replaces `r1` with `r2` in every path and label above, and runs each command under the idle gate and the steps of "What is left to run".

**Seeing the fixes in the installed app** is separate from measuring them: the bench's scratch build has them at its commit, but `/Applications/TempCode.app` gets them only when a release containing them is published (`bun run release:publish`) and the person clicks "Restart to update". No round touches the installed app or its data.

## Rounds 1–5

Fill one block per round from `--judge-field`'s table; s = median wall seconds, held s = the session-hold share inside it (our hosts only). Codex columns are the one gpt-6.1-sol reference run.

| task | opus mac pass/s/calls/held | opus box pass/s/calls/held | sonnet mac | sonnet box | gpt mac | gpt box | codex pass/s/calls |
|---|---|---|---|---|---|---|---|
| field-calc | | | | | | | |
| field-app-launch | | | | | | | |
| field-chrome-bg-tab | | | | | | | |
| field-chrome-below-fold | | | | | | | |
| field-chrome-tab-switch | | | | | | | |
| field-web-form | | | | | | | |
| field-textedit-add-line | | | | | | | |
| field-textedit-save-as | | | | | | | |
| field-textedit-close-discard | | | | | | | |
| field-textedit-close-keep | | | | | | | |
| field-menu-shortcut | | | | | | | |
| field-finder-rename | | | | | | | |
| field-finder-trash | | | | | | | |
| field-finder-new-folder | | | | | | | |
| **bar** | (a) | (b) | (c) | misses: | | | |

- Round 1: Sonnet on the Mac only, above; no Codex run, so no bar.
- Round 2: —
- Round 3: —
- Round 4: —
- Round 5: —
