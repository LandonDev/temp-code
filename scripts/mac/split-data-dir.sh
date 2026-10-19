#!/bin/bash
# The Mac side of the history move (docs/history-move.md), run with
# TempCode.app quit. Two phases, each safe to repeat:
#
#   split-data-dir.sh copy     VACUUM INTO copies of the databases into the
#                              staging dir and rsync the delta (copies,
#                              checkpoints/, html-renders/, .temp-code dirs)
#                              to the box's staging dir.
#   split-data-dir.sh split    rename the data dir to temp-code.moved-<date>
#                              and build a fresh temp-code dir: the Mac's own
#                              identity and settings, no history, the box as a
#                              saved environment (TC_BOX_KEY, TC_BOX_ENV_ID).
#
# Nothing is deleted. The key for the box comes from the environment only
# (mint it on the box: tc-local remote.keys.create) and lands in the new
# database the way pairing stores it. Secrets never touch a file here.
set -euo pipefail
export PATH=/opt/homebrew/bin:/usr/bin:/bin
phase=${1:-}
support="$HOME/Library/Application Support"
data=${TEMP_CODE_DATA:-"$support/temp-code"}
staging=${TEMP_CODE_MOVE_STAGING:-"$support/temp-code-history-move/inventory"}
box=${TEMP_CODE_BOX_HOST:-box}
remote=${TEMP_CODE_BOX_STAGING:-/srv/agents/history-move/mac}
today=$(date +%Y-%m-%d)

die() { echo "ERROR: $*" >&2; exit 1; }
quit_check() {
  pgrep -fq '/Applications/TempCode.app/Contents/MacOS/TempCode' && die 'TempCode.app is running; quit it first'
  pgrep -fq 'electron-vite|out/main/boot.js' && echo 'warning: a dev instance is running; make sure it is not on the prod data dir' >&2
  if [[ -L $data/SingletonLock ]]; then
    lock=$(readlink "$data/SingletonLock"); pid=${lock##*-}
    kill -0 "$pid" 2>/dev/null && die "pid $pid still holds $data"
  fi
}

copy() {
  quit_check
  mkdir -p "$staging"
  for name in temp-code.db temp-code-cold.db; do
    rm -f "$staging/$name"
    sqlite3 -readonly "$data/$name" "VACUUM INTO '$staging/$name'"
    [[ $(sqlite3 "$staging/$name" 'PRAGMA quick_check') == ok ]] || die "$name copy failed its check"
    echo "copy $name $(du -h "$staging/$name" | cut -f1)"
  done
  R=(rsync -rltz --stats --rsync-path='sudo rsync')
  "${R[@]}" "$staging/temp-code.db" "$staging/temp-code-cold.db" "$box:$remote/" | grep -E 'transferred|Total transferred'
  "${R[@]}" "$data/html-renders/" "$box:$remote/html-renders/" | grep -E 'transferred file size'
  "${R[@]}" "$data/checkpoints/" "$box:$remote/checkpoints/" | grep -E 'transferred file size'
  while IFS= read -r root; do
    n=$(basename "$root")
    [[ -d $root/.temp-code ]] || continue
    ssh "$box" "sudo install -d -m 750 -o agents -g agents $remote/temp-code-dirs/$n"
    "${R[@]}" "$root/.temp-code/" "$box:$remote/temp-code-dirs/$n/.temp-code/" | grep -E 'transferred file size' | sed "s#^#$n: #"
  done < <(python3 -c 'import json,sys; print("\n".join(json.load(open(sys.argv[1]))["roots"]))' "$(dirname "$0")/../box/history-map.json")
  for wt in "$HOME"/.temp-code/worktrees/*/; do
    [[ -d $wt/.temp-code ]] || continue
    n=$(basename "$wt")
    ssh "$box" "sudo install -d -m 750 -o agents -g agents $remote/temp-code-dirs/worktrees/$n"
    "${R[@]}" "$wt/.temp-code/" "$box:$remote/temp-code-dirs/worktrees/$n/.temp-code/" >/dev/null
  done
  ssh "$box" "sudo chown -R agents:agents $remote && sudo chmod -R u+rwX,g+rX,o-rwx $remote"
  echo "COPY DONE: $remote on $box holds the $today copies"
}

split() {
  quit_check
  [[ -n ${TC_BOX_KEY:-} && -n ${TC_BOX_ENV_ID:-} ]] || die 'TC_BOX_KEY and TC_BOX_ENV_ID are required (mint the key on the box)'
  [[ $TC_BOX_ENV_ID =~ ^env_[A-Za-z0-9_-]{22}$ ]] || die 'TC_BOX_ENV_ID is not an environment id'
  origin=${TC_BOX_ORIGIN:-https://tempcode.landonhale.com}
  moved="$support/temp-code.moved-$today"
  [[ -e $moved ]] && die "$moved already exists"
  mv "$data" "$moved"
  mkdir -p "$data"
  for f in environment.json window-state.json update-times.json .updaterId localstorage-migrated; do
    [[ -f $moved/$f ]] && cp -p "$moved/$f" "$data/$f"
  done
  [[ -d "$moved/Local Storage" ]] && cp -Rp "$moved/Local Storage" "$data/"
  [[ -d $moved/tls ]] && cp -Rp "$moved/tls" "$data/"
  # Aliax usage stats stay Mac-side: an APFS clone costs no space.
  [[ -f $moved/stats.db ]] && cp -c "$moved/stats.db" "$data/stats.db"
  # The new database: the app adds every table on launch; settings first,
  # with the Mac's own rows and the box as a saved environment.
  sqlite3 "$data/temp-code.db" <<SQL
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
ATTACH DATABASE '$moved/temp-code.db' AS old;
INSERT OR IGNORE INTO settings (key, value)
  SELECT key, value FROM old.settings
  WHERE key IN ('github.inbox.auth', 'github.inbox.viewer', 'github.inbox.fetchedAt', 'codex.speedTiers',
                'appshots', 'appshots-prompted', 'thread-defaults', 'orchestration-rules')
     OR key LIKE 'remote.%';
DETACH DATABASE old;
SQL
  python3 - "$data/temp-code.db" "$TC_BOX_ENV_ID" "$origin" <<'PY'
import json, os, sqlite3, sys, time
db, env_id, origin = sys.argv[1:4]
route = origin.replace('https://', 'wss://').replace('http://', 'ws://').rstrip('/') + '/ws'
row = {"name": os.environ.get("TC_BOX_NAME", "Box"), "routes": [{"url": route, "kind": "tunnel"}],
       "addedAt": int(time.time() * 1000), "caps": ["read", "operate", "approve"],
       "keyName": os.environ.get("TC_BOX_KEY_NAME", "Mac"), "key": os.environ["TC_BOX_KEY"]}
with sqlite3.connect(db) as c:
    c.execute("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", (f"remote.environments.{env_id}", json.dumps(row)))
print("box saved as environment", env_id)
PY
  echo "SPLIT DONE: history at $moved, fresh dir at $data ($(sqlite3 "$data/temp-code.db" 'SELECT count(*) FROM settings') settings rows)"
}

case $phase in
  copy) copy ;;
  split) split ;;
  *) echo 'usage: split-data-dir.sh copy|split' >&2; exit 2 ;;
esac
