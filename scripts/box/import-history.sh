#!/usr/bin/env bash
# The cutover import on the box, as root (docs/history-move.md): the
# launcher's pre-update snapshot of the live databases under the backup
# lock, temp-code.service stopped, the importer run as agents (dry run,
# then for real), the service started again and probed. Nothing here
# touches the box's identity rows; the importer never reads them.
#
#   box-import-history <from-dir> [--dry-run] [--into <rehearsal-dir>]
#
# <from-dir> holds the Mac's VACUUM INTO copies (temp-code.db,
# temp-code-cold.db) plus checkpoints/ and html-renders/, owned by agents.
# With --dry-run the service still stops (the importer refuses a live
# writer). With --into <rehearsal-dir> it only checks that offline copy
# and never stops, starts or snapshots the live service.
set -euo pipefail
umask 077
[[ $EUID == 0 && $# -ge 1 ]] || { echo 'usage: box-import-history <from-dir> [--dry-run] [--into <rehearsal-dir>]' >&2; exit 2; }
# Lock order is maintenance, then backup. Hold both through service probes
# and EXIT recovery; a deploy must never restart a writer mid-import.
exec 8>/run/lock/temp-code-update.lock
flock -n 8 || { echo 'ERROR: a box update or history import holds the maintenance lock; try again after it finishes' >&2; exit 1; }
from=$1; shift
dry=0
data=/srv/agents/temp-code-data
rehearsal=0
while (($#)); do
  case $1 in
    --dry-run) dry=1; shift ;;
    --into) [[ $# -ge 2 ]] || exit 2; data=$2; rehearsal=1; shift 2 ;;
    *) echo "ERROR: unexpected argument $1" >&2; exit 2 ;;
  esac
done
if ((rehearsal)); then
  ((dry)) || { echo 'ERROR: --into is only allowed with --dry-run' >&2; exit 2; }
  [[ $(realpath -e "$data") != /srv/agents/temp-code-data ]] || { echo 'ERROR: --into must be a rehearsal copy' >&2; exit 2; }
fi
build=${BOX_HISTORY_BUILD:-$(readlink -f /srv/agents/temp-code-builds/current)}
home=$(getent passwd agents | cut -d: -f6)
path=$home/.local/bin:$home/.npm-global/bin:$home/.bun/bin:/usr/local/bin:/usr/bin:/bin
importer=$build/src/main/server/historyImport.ts
map=${BOX_HISTORY_MAP:-$build/scripts/box/history-map.json}
[[ -f $importer && -f $map ]] || { echo "ERROR: $build lacks the importer or the mapping; deploy a ref that has them" >&2; exit 1; }
[[ -f $from/temp-code.db && -f $from/temp-code-cold.db ]] || { echo "ERROR: $from lacks the database copies" >&2; exit 1; }
as_agents() { runuser -u agents -- env HOME="$home" PATH="$path" "$@"; }

identity_counts() {
  as_agents python3 - "$data/temp-code.db" <<'PY_COUNTS'
import json, pathlib, sqlite3, sys
with sqlite3.connect(pathlib.Path(sys.argv[1]).as_uri() + '?mode=ro', uri=True) as db:
    tables = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    print(json.dumps({t: db.execute(f'SELECT count(*) FROM {t}').fetchone()[0] if t in tables else 0
                      for t in ('remote_keys', 'remote_pairings', 'remote_sessions')}, sort_keys=True))
PY_COUNTS
}
check_identity() {
  local after
  after=$(identity_counts)
  echo "identity after: $after"
  [[ $before == "$after" ]] || { echo 'ERROR: host identity counts changed during import' >&2; return 1; }
}

# Also exclude the daily backup and restore drill until the import exits.
exec 9>/run/lock/box-backup.lock
flock -w 21600 9
if ((rehearsal)); then
  before=$(identity_counts)
  echo "identity before: $before"
  echo 'REHEARSAL: dry run on a copy; no service or live snapshot changes'
  as_agents node "$importer" --from "$from" --into "$data" --map "$map" --label mac --dry-run
  check_identity
  exit 0
fi
snap=/srv/agents/backups/pre-update/$(date -u +%Y%m%dT%H%M%S)-import
/usr/local/sbin/box-sqlite-snapshot "$data" "$snap"
echo "SNAPSHOT: $snap"

was_active=0; systemctl is-active --quiet temp-code.service && was_active=1
restart() { (( was_active )) && systemctl start temp-code.service || true; }
trap restart EXIT
systemctl stop temp-code.service
# The host removes server.json on a clean exit; a stale one would be read as a live writer.
sleep 2
before=$(identity_counts)
echo "identity before: $before"

echo "DRY RUN:"
as_agents node "$importer" --from "$from" --into "$data" --map "$map" --label mac --dry-run
if ((!dry)); then
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
fi
check_identity

trap - EXIT
if ((was_active)); then
  systemctl start temp-code.service
  deadline=$((SECONDS + 120))
  until curl -fsS --max-time 2 http://127.0.0.1:7677/healthz >/dev/null 2>&1 && [[ -s $data/server.json ]]; do
    (( SECONDS < deadline )) || { echo 'ERROR: the host did not come back on 7677; see journalctl -u temp-code' >&2; exit 1; }
    sleep 1
  done
  as_agents env TEMP_CODE_USER_DATA="$data" TC_LOCAL_TIMEOUT_MS=30000 tc-local --hello | head -4
  echo "sessions listed: $(as_agents env TEMP_CODE_USER_DATA="$data" TC_LOCAL_TIMEOUT_MS=60000 tc-local session.list '{"archived":false}' | python3 -c 'import json,sys; d=json.load(sys.stdin); r=d.get("result", d); print(len(r if isinstance(r, list) else r.get("sessions", [])))')"
fi
echo "IMPORT PASS: $snap is the pre-import snapshot"
