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
restic restore "$id" --target "$scratch" --include '/srv/agents/backups/sqlite/*.db' --include '/srv/agents/backups/sqlite/manifest.json' --quiet
python3 - "$scratch/srv/agents/backups/sqlite" <<'PY'
import json, pathlib, sqlite3, sys
restored = pathlib.Path(sys.argv[1])
if not (restored / 'manifest.json').is_file():
    raise RuntimeError('uploaded snapshot has no generation manifest; run a new box backup first')
manifest = json.loads((restored / 'manifest.json').read_text())
if manifest.get('version') != 1 or not manifest.get('generation'):
    raise RuntimeError('invalid snapshot generation manifest')
files = sorted(restored.glob('*.db'))
if not files or {p.name for p in files} != set(manifest['databases']):
    raise RuntimeError('restored SQLite files differ from the uploaded generation manifest')
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
    if counts != manifest['databases'][file.name]:
        raise RuntimeError(f'{file.name}: restored row counts differ from uploaded generation manifest')
    print(f'PASS: {file.name} quick_check=ok sqlite_master={counts["sqlite_master"]} table-counts={len(counts)-1} match generation={manifest["generation"]}')
PY
echo "RESTORE DRILL PASS: snapshot=$id"
