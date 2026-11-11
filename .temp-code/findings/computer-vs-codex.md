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

## Round 1 — after the 2026-11-10 fixes

**Not run: the Mac was locked (2026-11-10 evening, the person away).**

The fix threads landed on master that evening in `f8d0f2021..5fb737b01` (2026-11-10, 17:28 onward; `git log f8d0f2021^..5fb737b01` lists them): window actions (§22: title-bar buttons always in the tree, close/minimize as clicks, the closing observation), background fallbacks (§24: a shortcut runs its menu item, AX routes for clicks, the caret, scroll, text and paste, save panels), launch and open without taking the screen with the front guard (§23, `computer_apps` `open`), held calls answering Codex and Muse (`computer_result`, §17.8), the box thread's held status on its own row, Away allows approvals (only `pay`/`subscribe` denied), Settings → Computer use, the phone's held-step card, the person guard (§14.9), and the notes-loop ceiling (`NOTES_STREAK_LIMIT`). Still building when this was written: Chromium tabs, pages and web controls (thread zU0oY6255zEp), the box bridge at Mac speed (8NX-u7Lyhj8V), steps that need the app active (7jru36EbqlG4), and fewer calls / shorter waits (planning, yGNHcO9z3paD) — a round run before those lands measures the first batch alone.

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

- Round 1: not run (above).
- Round 2: —
- Round 3: —
- Round 4: —
- Round 5: —
