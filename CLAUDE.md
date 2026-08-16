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
- `env -u ELECTRON_RUN_AS_NODE` is required — the variable leaks into
  agent shells and breaks Electron.
- Renderer must be on port 5173; a different port means a stale dev
  server from another session is holding it. Kill it (`pkill -f
  electron-vite`) and relaunch — electron-vite never restarts the main
  process on its own, so main-process changes always need a relaunch.
- Kill your dev instance when the pass is done.

## End every pass with a release
When the slice is committed and verified:
```bash
bun scripts/release.ts "one-line release notes"
```
It gates on a clean tree + typecheck + build, bumps release.json, commits
and tags `release-N`. The installed app checks automatically (and by
button) and offers the update with your notes; the user applies it when
they choose. Never build into or swap /Applications/TempCode.app yourself,
and never run the release with a broken typecheck "to fix later".
