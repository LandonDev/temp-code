#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/lib.sh"
# Keep this explicit even when stage 10 has already set the same policy.
put /etc/apt/apt.conf.d/99-box-security <<'EOF_POLICY'
#clear Unattended-Upgrade::Allowed-Origins;
Unattended-Upgrade::Allowed-Origins {
    "${distro_id}:${distro_codename}-security";
};
Unattended-Upgrade::Automatic-Reboot "false";
Unattended-Upgrade::Automatic-Reboot-WithUsers "false";
EOF_POLICY
put /usr/local/sbin/box-sqlite-snapshot 750 < "$BOX_DIR/sqlite-snapshot.sh"
put /usr/local/sbin/box-backup 750 < "$BOX_DIR/restic-backup.sh"
put /usr/local/sbin/box-backup-failed 750 < "$BOX_DIR/backup-failed.sh"
put /usr/local/sbin/box-restore-drill 750 < "$BOX_DIR/restore-drill.sh"
put /usr/local/sbin/box-restic-check 750 < "$BOX_DIR/restic-check.sh"
# Exclude rebuildable release trees without changing any prod backup rules.
if ! grep -qxF /srv/agents/temp-code-builds /etc/restic/excludes; then
  printf '%s\n' /srv/agents/temp-code-builds '/srv/agents/.temp-code-trial-*' >> /etc/restic/excludes
  changed 'excluded release builds and trial scratch data'
fi
for spec in restore-drill:restore-drill restic-check:restic-check; do
  name=${spec%:*}; script=${spec#*:}
  put "/etc/systemd/system/box-$name.service" <<EOF_UNIT
[Unit]
Description=Box $name
ConditionPathExists=/etc/restic/box.env
ConditionPathExists=/etc/restic/password
OnFailure=box-$name-failed.service
After=box-backup.service
[Service]
Type=oneshot
ExecStart=/usr/local/sbin/box-$script
Environment=RESTIC_CACHE_DIR=/var/cache/restic
CacheDirectory=restic
Slice=agents.slice
Nice=10
IOSchedulingClass=best-effort
IOSchedulingPriority=7
UMask=0077
TimeoutStartSec=8h
EOF_UNIT
  put "/etc/systemd/system/box-$name-failed.service" <<EOF_UNIT
[Unit]
Description=Report a failed box $name to the hub
ConditionPathExists=/etc/box-heartbeat.env
[Service]
Type=oneshot
ExecStart=/usr/local/sbin/box-backup-failed $name
UMask=0077
TimeoutStartSec=60
EOF_UNIT
done
put /etc/systemd/system/box-restore-drill.timer <<'EOF_TIMER'
[Unit]
Description=Weekly SQLite restore drill after the Sunday backup
[Timer]
OnCalendar=Sun *-*-* 06:00:00
Persistent=true
[Install]
WantedBy=timers.target
EOF_TIMER
put /etc/systemd/system/box-restic-check.timer <<'EOF_TIMER'
[Unit]
Description=Monthly restic data check (5 percent)
[Timer]
OnCalendar=*-*-01 08:00:00
Persistent=true
[Install]
WantedBy=timers.target
EOF_TIMER
systemctl daemon-reload
for timer in box-restore-drill box-restic-check; do
  systemctl enable --now "$timer.timer"
done
