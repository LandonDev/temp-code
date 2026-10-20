#!/usr/bin/env bash
# Caller holds /run/lock/box-backup.lock. VACUUM reads a consistent database
# while the live host keeps writing. Publish the generation only when all pass.
set -euo pipefail
umask 077
[[ $EUID == 0 && $# == 2 ]] || exit 2
data=$1 target=$2
parent=$(dirname "$target")
install -d -m 700 -o agents -g agents "$parent"
staging=$(mktemp -d "$parent/.tmp-snapshot-XXXXXX")
chown agents:agents "$staging"
trap 'rm -rf -- "$staging"' EXIT
runuser -u agents -- python3 - "$data" "$staging" <<'PY'
import json, pathlib, sqlite3, sys, uuid
files = sorted(pathlib.Path(sys.argv[1]).glob('*.db'))
if not files:
    raise RuntimeError('no SQLite databases to snapshot')
manifest = {'version': 1, 'generation': uuid.uuid4().hex, 'databases': {}}
for source in files:
    dest = pathlib.Path(sys.argv[2]) / source.name
    with sqlite3.connect(source.as_uri() + '?mode=ro', uri=True, timeout=60) as db:
        db.execute('VACUUM INTO ?', (str(dest),))
    with sqlite3.connect(dest) as db:
        if db.execute('PRAGMA quick_check').fetchall() != [('ok',)]:
            raise RuntimeError(f'{source.name}: quick_check failed')
        counts = {'sqlite_master': db.execute('SELECT count(*) FROM sqlite_master').fetchone()[0]}
        for (name,) in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"):
            quoted = '"' + name.replace('"', '""') + '"'
            counts[name] = db.execute(f'SELECT count(*) FROM {quoted}').fetchone()[0]
        manifest['databases'][source.name] = counts
    print(f'snapshot {source.name} {dest.stat().st_size} bytes')
(pathlib.Path(sys.argv[2]) / 'manifest.json').write_text(json.dumps(manifest, sort_keys=True) + '\n')
print('snapshot generation=' + manifest['generation'])
PY
# No consumer can see a partial snapshot. The daily target is replaced while
# its lock is held; dated pre-update targets do not already exist.
if [[ -e $target ]]; then rm -rf -- "$target"; fi
mv "$staging" "$target"
