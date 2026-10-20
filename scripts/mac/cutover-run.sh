#!/usr/bin/env bash
# The history cutover as one detached job (docs/history-move.md "Cutover").
# The person driving it talks to the app that holds the data, so the job
# runs on its own: it waits for TempCode.app to quit, takes fresh backups on
# both hosts, copies the history to the box, imports it there, splits the
# Mac's data dir down to its identity, and posts a macOS notification that
# says whether to reopen the app or read the log.
#
#   nohup scripts/mac/cutover-run.sh > /dev/null 2>&1 &
#
# Log: ~/Library/Logs/tempcode-cutover.log. Needs TC_BOX_ENV_ID (the box's
# environment id); TC_BOX_KEY only when the Mac has never paired the box.
# Nothing here prints a key. Waits up to TC_WAIT_MINUTES (default 180) for
# the app to quit, then gives up with nothing changed.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
support="$HOME/Library/Application Support"
data=${TEMP_CODE_DATA:-"$support/temp-code"}
box=${TEMP_CODE_BOX_HOST:-box}
remote=${TEMP_CODE_BOX_STAGING:-/srv/agents/history-move/mac}
log="$HOME/Library/Logs/tempcode-cutover.log"
wait_minutes=${TC_WAIT_MINUTES:-180}
: "${TC_BOX_ENV_ID:?TC_BOX_ENV_ID is required}"
export PATH="$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
exec >>"$log" 2>&1
say() { printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }
notify() { osascript -e "display notification \"$2\" with title \"TempCode cutover\" subtitle \"$1\" sound name \"Glass\"" >/dev/null 2>&1 || true; }
fail() { say "FAILED: $*"; notify "Failed" "Nothing more was changed. Read ~/Library/Logs/tempcode-cutover.log"; exit 1; }
trap 'rc=$?; [[ $rc == 0 ]] || { say "FAILED at line $LINENO (exit $rc)"; notify "Failed" "Read ~/Library/Logs/tempcode-cutover.log before reopening TempCode"; }' EXIT

app_running() {
  pgrep -fq '/Applications/TempCode.app/Contents/MacOS/TempCode' && return 0
  if [[ -L $data/SingletonLock ]]; then
    lock=$(readlink "$data/SingletonLock"); pid=${lock##*-}
    kill -0 "$pid" 2>/dev/null && return 0
  fi
  lsof -- "$data/temp-code.db" "$data/temp-code-cold.db" >/dev/null 2>&1 && return 0
  return 1
}

say "cutover job started; waiting for TempCode.app to quit (up to $wait_minutes min)"
deadline=$(( $(date +%s) + wait_minutes * 60 ))
while app_running; do
  (( $(date +%s) < deadline )) || fail "TempCode.app did not quit within $wait_minutes minutes"
  sleep 5
done
say "app is closed; settling 15 s"
sleep 15
app_running && fail "the data dir was reopened"

say "fresh backup on the box"
ssh -o BatchMode=yes "$box" 'systemctl start box-backup.service && journalctl -u box-backup.service -n 3 --no-pager -o cat' || fail "box backup did not run"
say "fresh backup on the Mac"
TEMP_CODE_DATA="$data" "$here/backup.sh" >/dev/null || fail "Mac backup did not run"

say "copy: VACUUM INTO copies and rsync to $box:$remote"
TEMP_CODE_DATA="$data" "$here/split-data-dir.sh" copy || fail "copy stage"

say "import on the box (snapshots, stops the service, dry run, import, restart, probe)"
ssh -o BatchMode=yes "$box" "bash /srv/agents/temp-code-builds/current/scripts/box/import-history.sh $remote" || fail "import on the box"

say "split: the Mac keeps its identity, history moves aside"
TEMP_CODE_DATA="$data" "$here/split-data-dir.sh" split || fail "split stage"

say "probe"
code=$(curl -s -m 15 -o /dev/null -w '%{http_code}' https://tempcode.landonhale.com/api/hello || true)
[[ $code == 200 ]] || fail "the box did not answer hello ($code)"
ssh -o BatchMode=yes "$box" 'systemctl is-active temp-code.service; echo "threads on the box: $(tc-local session.list | jq length)"' || true
say "DONE: reopen TempCode.app; history shows under the box environment"
notify "Done" "Reopen TempCode. Your threads now live on the box."
