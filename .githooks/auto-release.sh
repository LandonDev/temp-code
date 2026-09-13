#!/bin/bash
# The auto-release worker: while commits keep landing, keep trying. A
# dirty tree, a red typecheck or a red test just means no release this round — the
# next green commit retries. Never touches the installed app.
ROOT="$1"
cd "$ROOT" || exit 1
# node must be found, else bunx vitest runs under Bun and node:sqlite is missing.
export PATH="$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
while [ -f .git/auto-release.pending ]; do
  rm -f .git/auto-release.pending
  if [ -n "$(git status --porcelain | grep -v '^??')" ]; then
    echo "$(date '+%H:%M:%S') skipped: tree dirty"
    break
  fi
  subject="$(git log -1 --format=%s)"
  echo "$(date '+%H:%M:%S') releasing: $subject"
  bun scripts/release.ts "$subject" || break
done
rmdir .git/auto-release.lock 2>/dev/null
