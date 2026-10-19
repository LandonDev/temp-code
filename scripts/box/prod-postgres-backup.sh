#!/usr/bin/env bash
set -euo pipefail
unset HISTFILE
umask 077
install -d -m 700 /srv/prod/backups/postgres
exec 9>/run/lock/prod-postgres-backup.lock
flock -n 9 || exit 0
# Never rotate old backups until BOTH dumps succeed. Temp files are not backups.
files=()
cleanup() { rm -f "${files[@]}"; }
trap cleanup EXIT
stamp=$(date -u +%Y%m%dT%H%M%SZ)
for container in prod-postgres coolify-db; do
  tmp=$(mktemp /srv/prod/backups/postgres/.dump.XXXXXX)
  files+=("$tmp")
  docker exec "$container" sh -c 'exec pg_dumpall -U "$POSTGRES_USER"' | gzip > "$tmp"
  gzip -t "$tmp"
  [[ $(gzip -dc "$tmp" | tail -3) == *'PostgreSQL database cluster dump complete'* ]] || { echo "Incomplete dump: $container" >&2; exit 1; }
done
mv "${files[0]}" "/srv/prod/backups/postgres/managed-$stamp.sql.gz"
mv "${files[1]}" "/srv/prod/backups/postgres/coolify-$stamp.sql.gz"
files=()
find /srv/prod/backups/postgres -type f -name '*.sql.gz' -mmin +10080 -delete
printf 'PASS: managed and Coolify PostgreSQL dumps complete\n'
