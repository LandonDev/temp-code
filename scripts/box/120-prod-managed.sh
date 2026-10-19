#!/usr/bin/env bash
source "$(dirname "$0")/prod-lib.sh"
secret_env "$SECRETS/postgres.env" POSTGRES_PASSWORD
secret_env "$SECRETS/redis.env" REDIS_PASSWORD
cat "$SECRETS/postgres.env" "$SECRETS/redis.env" | put "$SECRETS/managed.env" 600
install -d -m 750 "$PROD/stacks/managed"
put "$PROD/stacks/managed/compose.yml" 644 < "$BOX_DIR/managed.compose.yml"
compose_up prod-managed "$PROD/stacks/managed/compose.yml" "$SECRETS/managed.env"
put /usr/local/sbin/prod-postgres-backup 750 < "$BOX_DIR/prod-postgres-backup.sh"
put /etc/systemd/system/prod-postgres-backup.service <<'UNIT'
[Unit]
Description=Production PostgreSQL logical backups
Requires=docker.service
After=docker.service
[Service]
Type=oneshot
Slice=prod.slice
UMask=0077
ExecStart=/usr/local/sbin/prod-postgres-backup
UNIT
reload=$FILE_CHANGED
put /etc/systemd/system/prod-postgres-backup.timer <<'UNIT'
[Unit]
Description=Nightly production PostgreSQL dumps (7 days)
[Timer]
OnCalendar=*-*-* 03:15:00 America/New_York
Persistent=true
RandomizedDelaySec=600
[Install]
WantedBy=timers.target
UNIT
if ((FILE_CHANGED || reload)); then systemctl daemon-reload; fi
service_on prod-postgres-backup.timer
