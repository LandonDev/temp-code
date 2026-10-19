#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/lib.sh"
put /etc/box-heartbeat.env.example 600 <<'EOF'
# Copy to /etc/box-heartbeat.env (root:root, 600) when the hub ships.
BOX_HEARTBEAT_URL=https://hub.landonhale.com/v1/hosts/box/heartbeat
BOX_HEARTBEAT_TOKEN=REPLACE_HUB_BEARER_TOKEN
EOF
put /usr/local/bin/box-heartbeat 750 < "$BOX_DIR/heartbeat.sh"
put /etc/systemd/system/box-heartbeat.service <<'EOF'
[Unit]
Description=POST the box heartbeat to its configured hub
ConditionPathExists=/etc/box-heartbeat.env
[Service]
Type=oneshot
ExecStart=/usr/local/bin/box-heartbeat
User=root
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
UMask=0077
TimeoutStartSec=60
EOF
reload=$FILE_CHANGED
put /etc/systemd/system/box-heartbeat.timer <<'EOF'
[Unit]
Description=Box heartbeat (enable when the hub is ready)
[Timer]
OnBootSec=2m
OnUnitActiveSec=1m
RandomizedDelaySec=10s
[Install]
WantedBy=timers.target
EOF
((FILE_CHANGED == 0)) || reload=1
if ((reload)); then systemctl daemon-reload; changed 'heartbeat units loaded'; fi
if [[ ! -f $STATE/heartbeat-scaffold.done ]]; then
  systemctl disable --now box-heartbeat.timer
  touch "$STATE/heartbeat-scaffold.done"
  changed 'heartbeat timer installed disabled'
else skip 'heartbeat timer state left as configured by owner'; fi
