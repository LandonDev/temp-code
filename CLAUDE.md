# temp-code — instructions for AI sessions

## One line: prod runs master's releases
- `/Applications/TempCode.app` runs the newest `release-N` tag on `master`
  (its data lives in `~/Library/Application Support/temp-code/`). Every
  green commit on master is offered to the installed app on its next
  check, so commit only finished, verified slices.
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

## The user dogfoods master on the prod data
`bun run dev:prod` runs master against the prod userData (CDP on 9220).
It is the user's command, not ours. The single-instance lock keeps it and
the installed app from running at once: quit one before opening the
other. Master only adds to the database (new tables, defaulted columns),
so the two apps can take turns on it. Unread marks and layout live in
localStorage, which differs by origin, so they do not carry across.

## Releases cut themselves — just commit finished work
A post-commit hook on master (.githooks/, wired via core.hooksPath) runs
`bun scripts/release.ts` after every commit: it gates on a clean tree +
typecheck + tests + build, bumps release.json, commits and tags
`release-N`, using your commit subject as the release notes.

- Commit complete, verified slices — every green commit on master ships
  to `stable` once it is moved.
- If the hook skipped (tree was dirty at commit time, or the gate was
  red), the next green commit releases everything since; you can also run
  `bun scripts/release.ts "notes"` yourself.
- Worker log: /tmp/temp-code-auto-release.log.
- Never build into or swap /Applications/TempCode.app yourself, and never
  commit with a broken typecheck "to fix later" — that blocks the train.

## The prod worktree
~/IdeaProjects/temp-code-prod is the updater's build checkout: it detaches
onto the target tag, installs and builds there, then swaps or syncs the
bundle. Leave it detached; never keep a branch checked out in it, and never
build into or swap /Applications/TempCode.app yourself.
