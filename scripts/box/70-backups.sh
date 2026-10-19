#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/lib.sh"
packages restic sqlite3
if [[ ! -d /etc/restic ]] || [[ $(stat -c %a /etc/restic) != 700 ]]; then install -d -m 700 /etc/restic; changed '/etc/restic'; else skip '/etc/restic'; fi
put /etc/restic/box.env.example 600 <<'EOF'
# Copy to /etc/restic/box.env (root:root, 600) and replace all placeholders.
RESTIC_REPOSITORY=s3:https://REPLACE_ACCOUNT_ID.r2.cloudflarestorage.com/REPLACE_BUCKET/tempcode-box
AWS_ACCESS_KEY_ID=REPLACE_R2_ACCESS_KEY_ID
AWS_SECRET_ACCESS_KEY=REPLACE_R2_SECRET_ACCESS_KEY
AWS_DEFAULT_REGION=auto
RESTIC_PASSWORD_FILE=/etc/restic/password
EOF
put /etc/restic/excludes 600 <<'EOF'
/etc/restic/password
/etc/restic/box.env
/srv/prod/docker
**/node_modules
**/.cache
**/.bun/install/cache
**/Cache
**/Code Cache
**/GPUCache
/srv/agents/temp-code
/srv/agents/temp-code-data/*.db
/srv/agents/temp-code-data/*.db-wal
/srv/agents/temp-code-data/*.db-shm
/srv/agents/temp-code-data/blob_storage
/srv/agents/temp-code-data/Crashpad
/srv/agents/home/.npm-global
/srv/agents/home/.npm
/srv/agents/home/.bun
/srv/agents/home/.cache
EOF
put /usr/local/sbin/box-backup 750 < "$BOX_DIR/restic-backup.sh"
put /usr/local/sbin/box-backup-failed 750 < "$BOX_DIR/backup-failed.sh"
put /etc/systemd/system/box-backup-failed.service <<'EOF'
[Unit]
Description=Report a failed box backup to the hub
ConditionPathExists=/etc/box-heartbeat.env
[Service]
Type=oneshot
ExecStart=/usr/local/sbin/box-backup-failed
UMask=0077
TimeoutStartSec=60
EOF
put /etc/systemd/system/box-backup.service <<'EOF'
[Unit]
Description=Back up box data to the configured R2 restic repository
ConditionPathExists=/etc/restic/box.env
ConditionPathExists=/etc/restic/password
OnFailure=box-backup-failed.service
[Service]
Type=oneshot
ExecStart=/usr/local/sbin/box-backup
Environment=RESTIC_CACHE_DIR=/var/cache/restic
CacheDirectory=restic
Slice=prod.slice
Nice=10
IOSchedulingClass=best-effort
IOSchedulingPriority=7
UMask=0077
TimeoutStartSec=6h
EOF
reload=$FILE_CHANGED
put /etc/systemd/system/box-backup.timer <<'EOF'
[Unit]
Description=Daily box backup (enable after credentials and a restore test)
[Timer]
OnCalendar=*-*-* 04:15:00
RandomizedDelaySec=20m
Persistent=true
[Install]
WantedBy=timers.target
EOF
((FILE_CHANGED == 0)) || reload=1
if ((reload)); then systemctl daemon-reload; changed 'backup units loaded'; fi
# Preserve a timer that its owner later enables; first installation leaves it off.
if [[ ! -f $STATE/backup-scaffold.done ]]; then
  systemctl disable --now box-backup.timer
  touch "$STATE/backup-scaffold.done"
  changed 'backup timer installed disabled'
else skip 'backup timer state left as configured by owner'; fi
