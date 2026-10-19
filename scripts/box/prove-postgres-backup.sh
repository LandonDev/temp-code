#!/usr/bin/env bash
# Run on the box. Restore into RAM in a disposable, network-isolated container.
set -euo pipefail
unset HISTFILE
umask 077
id=''
cleanup() { if [[ -n $id ]]; then docker rm -f "$id" >/dev/null; fi; }
trap cleanup EXIT
systemctl start prod-postgres-backup.service
backup=$(find /srv/prod/backups/postgres -name 'managed-*.sql.gz' | sort | tail -1)
[[ -n $backup ]]
id=$(docker run -d --rm --name prod-postgres-restore-proof --network none --cgroup-parent prod.slice --tmpfs /var/lib/postgresql/data:rw,size=1g -e POSTGRES_HOST_AUTH_METHOD=trust -e POSTGRES_USER=restore_admin postgres:16@sha256:ca0bd484cb98bf4b24eb1010e73fb3fcbd6714d240fbc1a10eea5b7dbecb641d)
for ((i=0;i<60;i++)); do
  if docker exec "$id" pg_isready -U restore_admin -d postgres >/dev/null 2>&1; then break; fi
  sleep 1
done
gzip -dc "$backup" | docker exec -i "$id" psql -q -v ON_ERROR_STOP=1 -U restore_admin -d postgres >/dev/null
[[ $(docker exec "$id" psql -U restore_admin -d convex_template -tAc 'SELECT count(*) FROM information_schema.tables WHERE table_schema='"'"'public'"'"'') -gt 0 ]]
printf 'PASS: nightly pg_dumpall restored with Convex tables into isolated temporary PostgreSQL\n'
