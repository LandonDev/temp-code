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
umask 077
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
  if [[ $data -ef "$support/temp-code" || $data -ef "$support/TempCode" ]]; then
    pgrep -fq '/Applications/TempCode.app/Contents/MacOS/TempCode' && die 'TempCode.app is running; quit it first'
  fi
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
  moved="$data.moved-$today"
  [[ -e $moved ]] && die "$moved already exists"
  fresh=$(mktemp -d "$data.split-XXXXXX")
  trap 'rm -rf -- "$fresh"' EXIT
  for f in environment.json window-state.json update-times.json .updaterId localstorage-migrated; do
    [[ -f $data/$f ]] && cp -p "$data/$f" "$fresh/$f"
  done
  [[ -d "$data/Local Storage" ]] && cp -Rp "$data/Local Storage" "$fresh/"
  [[ -d $data/tls ]] && cp -Rp "$data/tls" "$fresh/"
  # Aliax usage stats stay Mac-side: an APFS clone costs no space.
  [[ -f $data/stats.db ]] && cp -c "$data/stats.db" "$fresh/stats.db"
  # Copy exact table definitions and rows, including revoked/expired rows.
  # Keep salts, hashes and browser cookies paired with this host's identity.
  python3 - "$data/temp-code.db" "$fresh/temp-code.db" <<'PY_IDENTITY'
import sqlite3, sys
source, target = sys.argv[1:]
with sqlite3.connect('file:' + source + '?mode=ro', uri=True) as old, sqlite3.connect(target) as new:
    old.execute('BEGIN')
    new.execute('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    new.executemany('INSERT INTO settings VALUES (?, ?)', old.execute(
        """SELECT key, value FROM settings WHERE key IN
        ('github.inbox.auth', 'github.inbox.viewer', 'github.inbox.fetchedAt', 'codex.speedTiers',
         'thread-defaults', 'orchestration-rules') OR key LIKE 'appshots%' OR key LIKE 'remote.%'"""))
    for table in ('remote_keys', 'remote_pairings', 'remote_sessions'):
        schema = old.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name=?", (table,)).fetchone()
        if schema is None:
            if table == 'remote_keys': print('remote_keys before=0 after=0 (no table)')
            continue
        new.execute(schema[0])
        rows = old.execute(f'SELECT * FROM {table} ORDER BY id').fetchall()
        if rows:
            new.executemany(f'INSERT INTO {table} VALUES (' + ','.join('?' for _ in rows[0]) + ')', rows)
        for (sql,) in old.execute("SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name=? AND sql IS NOT NULL", (table,)):
            new.execute(sql)
        copied = new.execute(f'SELECT * FROM {table} ORDER BY id').fetchall()
        if rows != copied: raise RuntimeError(f'{table}: identity rows differ')
        print(f'{table} before={len(rows)} after={len(copied)}')
    if new.execute('PRAGMA quick_check').fetchall() != [('ok',)]:
        raise RuntimeError('fresh identity database failed quick_check')
PY_IDENTITY
  python3 - "$fresh/temp-code.db" "$TC_BOX_ENV_ID" "$origin" <<'PY'
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
  mv "$data" "$moved"
  if ! mv "$fresh" "$data"; then
    mv "$moved" "$data"
    die 'could not install the fresh data dir; restored the original'
  fi
  trap - EXIT
  echo "SPLIT DONE: history at $moved, fresh dir at $data ($(sqlite3 "$data/temp-code.db" 'SELECT count(*) FROM settings') settings rows)"
}

case $phase in
  copy) copy ;;
  split) split ;;
  *) echo 'usage: split-data-dir.sh copy|split' >&2; exit 2 ;;
esac
