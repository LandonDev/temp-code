#!/usr/bin/env bash
# Daily box backup to the R2 restic repo (box-backup.service, prod.slice).
# temp-code's SQLite files are never copied live: each is snapshotted with
# VACUUM INTO as the agents user (one read transaction; the app keeps writing)
# into /srv/agents/backups/sqlite, and the live files are excluded. Postgres
# dumps come from prod-postgres-backup.timer into /srv/prod/backups/postgres.
set -euo pipefail
umask 077
source /etc/restic/box.env
export RESTIC_REPOSITORY RESTIC_PASSWORD_FILE AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_DEFAULT_REGION
for name in RESTIC_REPOSITORY RESTIC_PASSWORD_FILE AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY; do
  value=${!name:-}
  [[ -n $value && $value != *REPLACE* ]] || { echo "ERROR: configure $name in /etc/restic/box.env" >&2; exit 1; }
done
[[ -s $RESTIC_PASSWORD_FILE ]] || { echo 'ERROR: restic password file missing' >&2; exit 1; }
exec 9>/run/lock/box-backup.lock
flock -n 9 || { echo 'another backup is running' >&2; exit 1; }

data=${BOX_TEMP_CODE_DATA:-/srv/agents/temp-code-data}
snap=/srv/agents/backups/sqlite
/usr/local/sbin/box-sqlite-snapshot "$data" "$snap"

restic backup --host tempcode-box --tag daily --quiet \
  --exclude-file=/etc/restic/excludes /srv/agents /srv/prod /etc
restic forget --host tempcode-box --keep-daily 7 --keep-weekly 4 --keep-monthly 6 --prune --quiet
restic check --quiet
echo "backup done: $(restic snapshots --host tempcode-box --latest 1 --compact 2>/dev/null | tail -1)"
