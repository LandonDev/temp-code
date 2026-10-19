#!/usr/bin/env bash
# The cutover import on the box, as root (docs/history-move.md): the
# launcher's pre-update snapshot of the live databases under the backup
# lock, temp-code.service stopped, the importer run as agents (dry run,
# then for real), the service started again and probed. Nothing here
# touches the box's identity rows; the importer never reads them.
#
#   box-import-history <from-dir> [--dry-run]
#
# <from-dir> holds the Mac's VACUUM INTO copies (temp-code.db,
# temp-code-cold.db) plus checkpoints/ and html-renders/, owned by agents.
# With --dry-run the service still stops (the importer refuses a live
# writer) but nothing is written; it restarts on exit either way.
set -euo pipefail
[[ $EUID == 0 && $# -ge 1 ]] || { echo 'usage: box-import-history <from-dir> [--dry-run]' >&2; exit 2; }
from=$1; shift
dry=0; [[ ${1:-} == --dry-run ]] && dry=1
data=/srv/agents/temp-code-data
build=$(readlink -f /srv/agents/temp-code-builds/current)
home=$(getent passwd agents | cut -d: -f6)
path=$home/.local/bin:$home/.npm-global/bin:$home/.bun/bin:/usr/local/bin:/usr/bin:/bin
importer=$build/src/main/server/historyImport.ts
map=${BOX_HISTORY_MAP:-$build/scripts/box/history-map.json}
[[ -f $importer && -f $map ]] || { echo "ERROR: $build lacks the importer or the mapping; deploy a ref that has them" >&2; exit 1; }
[[ -f $from/temp-code.db && -f $from/temp-code-cold.db ]] || { echo "ERROR: $from lacks the database copies" >&2; exit 1; }
as_agents() { runuser -u agents -- env HOME="$home" PATH="$path" "$@"; }

# One lock with the daily backup, the restore drill and the launcher's snapshot.
exec 9>/run/lock/box-backup.lock
flock 9
snap=/srv/agents/backups/pre-update/$(date -u +%Y%m%dT%H%M%S)-import
/usr/local/sbin/box-sqlite-snapshot "$data" "$snap"
echo "SNAPSHOT: $snap"

was_active=0; systemctl is-active --quiet temp-code.service && was_active=1
restart() { (( was_active )) && systemctl start temp-code.service || true; }
trap restart EXIT
systemctl stop temp-code.service
# The host removes server.json on a clean exit; a stale one would be read as a live writer.
sleep 2

echo "DRY RUN:"
as_agents node "$importer" --from "$from" --into "$data" --map "$map" --label mac --dry-run
if (( dry )); then exit 0; fi
echo "IMPORT:"
as_agents node "$importer" --from "$from" --into "$data" --map "$map" --label mac
as_agents python3 - "$data" <<'PY'
import pathlib, sqlite3, sys
for name in ('temp-code.db', 'temp-code-cold.db'):
    with sqlite3.connect(pathlib.Path(sys.argv[1]) / name) as db:
        ok = db.execute('PRAGMA quick_check').fetchall() == [('ok',)]
        print(f'quick_check {name}: {"ok" if ok else "FAILED"}')
        if not ok: sys.exit(1)
PY

trap - EXIT
systemctl start temp-code.service
deadline=$((SECONDS + 120))
until curl -fsS --max-time 2 http://127.0.0.1:7677/healthz >/dev/null 2>&1 && [[ -s $data/server.json ]]; do
  (( SECONDS < deadline )) || { echo 'ERROR: the host did not come back on 7677; see journalctl -u temp-code' >&2; exit 1; }
  sleep 1
done
as_agents env TEMP_CODE_USER_DATA="$data" TC_LOCAL_TIMEOUT_MS=30000 tc-local --hello | head -4
echo "sessions listed: $(as_agents env TEMP_CODE_USER_DATA="$data" TC_LOCAL_TIMEOUT_MS=60000 tc-local session.list '{"archived":false}' | python3 -c 'import json,sys; d=json.load(sys.stdin); r=d.get("result", d); print(len(r if isinstance(r, list) else r.get("sessions", [])))')"
echo "IMPORT PASS: $snap is the pre-import snapshot"
