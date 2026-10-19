#!/usr/bin/env bash
# Restore only the SQLite snapshots. Never restore over live data.
set -euo pipefail
umask 077
source /etc/restic/box.env
export RESTIC_REPOSITORY RESTIC_PASSWORD_FILE AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_DEFAULT_REGION
exec 9>/run/lock/box-backup.lock
flock -w 21600 9
scratch=$(mktemp -d /srv/agents/backups/.restore-drill-XXXXXX)
trap 'rm -rf -- "$scratch"' EXIT
# Select once: backup retention and a concurrently-created snapshot cannot
# change what "latest" means halfway through this drill.
id=$(restic snapshots --host tempcode-box --tag daily --latest 1 --json | jq -er '.[0].id')
restic restore "$id" --target "$scratch" --include '/srv/agents/backups/sqlite/*.db' --quiet
python3 - "$scratch/srv/agents/backups/sqlite" /srv/agents/backups/sqlite <<'PY'
import pathlib, sqlite3, sys
restored, on_disk = map(pathlib.Path, sys.argv[1:])
files = sorted(restored.glob('*.db'))
if not files or {p.name for p in files} != {p.name for p in on_disk.glob('*.db')}:
    raise RuntimeError('missing restored or on-disk SQLite snapshots')
def check(path):
    with sqlite3.connect(path.as_uri() + '?mode=ro', uri=True) as db:
        if db.execute('PRAGMA quick_check').fetchall() != [('ok',)]:
            raise RuntimeError(f'{path.name}: quick_check failed')
        # Count schema rows and every user table named by sqlite_master.
        counts = {'sqlite_master': db.execute('SELECT count(*) FROM sqlite_master').fetchone()[0]}
        for (name,) in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"):
            quoted = '"' + name.replace('"', '""') + '"'
            counts[name] = db.execute(f'SELECT count(*) FROM {quoted}').fetchone()[0]
        return counts
for file in files:
    counts = check(file)
    if counts != check(on_disk / file.name):
        raise RuntimeError(f'{file.name}: restored row counts differ from snapshot on disk')
    print(f'PASS: {file.name} quick_check=ok sqlite_master={counts["sqlite_master"]} table-counts={len(counts)-1} match disk')
PY
echo "RESTORE DRILL PASS: snapshot=$id"
