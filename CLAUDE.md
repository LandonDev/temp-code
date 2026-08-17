# temp-code — instructions for AI sessions

## The user lives in the installed app — never touch it
Prod is /Applications/TempCode.app with its data in
`~/Library/Application Support/temp-code/`. Do not launch anything
against that userData (that means never `bun run dev` without
TEMP_CODE_USER_DATA), do not send messages into the user's threads, and
do not kill or restart the installed app. The user gets your work through the
release flow below, on their own click.

## Testing: spawn an isolated dev instance
```bash
env -u ELECTRON_RUN_AS_NODE \
  TEMP_CODE_USER_DATA="$HOME/Library/Application Support/temp-code-dev" \
  TEMP_CODE_DEBUG_PORT=9224 bun run dev
```
- Own database, own window; CDP on 9224 for driving and screenshots
  (`window.__app` exposes the store in dev builds).
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
- Kill your dev instance when the pass is done.

## Releases cut themselves — just commit finished work
A post-commit hook on master (.githooks/, wired via core.hooksPath) runs
`bun scripts/release.ts` after every commit: it gates on a clean tree +
typecheck + build, bumps release.json, commits and tags `release-N`,
using your commit subject as the release notes. The installed app checks
automatically (and by button) and offers the update; the user applies it
when they choose.

- Commit complete, verified slices — every green commit on master ships.
- If the hook skipped (tree was dirty at commit time, or the gate was
  red), the next green commit releases everything since; you can also run
  `bun scripts/release.ts "notes"` yourself.
- Worker log: /tmp/temp-code-auto-release.log.
- Never build into or swap /Applications/TempCode.app yourself, and never
  commit with a broken typecheck "to fix later" — that blocks the train.
