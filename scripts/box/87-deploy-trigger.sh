#!/usr/bin/env bash
# Deploy from the app (docs/box.md "Updating" → "Deploy from the app"): the
# root-owned trigger behind the "Deploy master to the box" button. The app
# runs as agents and box-update must run as root, so the app writes a ref
# into /run/temp-code/deploy/request and temp-code-deploy.path starts the
# oneshot temp-code-deploy.service, which runs deploy-runner (box-update with
# its output in /run/temp-code/deploy/log and the status in .../exit).
# Re-runnable; installs only, nothing restarts.
set -euo pipefail
source "$(dirname "$0")/lib.sh"
reload=0

# /run is tmpfs: tmpfiles recreates the directory at boot. Sticky and
# group-writable, so agents can drop and withdraw its own request and read
# the root-owned log and exit files, and nothing else of root's can go.
put /etc/tmpfiles.d/temp-code-deploy.conf <<'EOF2'
# Managed by scripts/box/87-deploy-trigger.sh: the deploy request directory.
d /run/temp-code 0755 root root -
d /run/temp-code/deploy 1770 root agents -
EOF2
systemd-tmpfiles --create /etc/tmpfiles.d/temp-code-deploy.conf
if [[ $(stat -c '%a:%U:%G' /run/temp-code/deploy) == '1770:root:agents' ]]; then skip '/run/temp-code/deploy'
else die '/run/temp-code/deploy is not 1770 root:agents'; fi

install -d -m 755 /usr/local/lib/temp-code
put /usr/local/lib/temp-code/deploy-runner 755 < "$BOX_DIR/deploy-runner.sh"
put /etc/systemd/system/temp-code-deploy.service <<'EOF2'
[Unit]
Description=temp-code deploy requested from the app (box-update as root)
Documentation=file:///srv/agents/temp-code-builds/current/docs/box.md

[Service]
Type=oneshot
ExecStart=/usr/local/lib/temp-code/deploy-runner
EOF2
((FILE_CHANGED == 0)) || reload=1
put /etc/systemd/system/temp-code-deploy.path <<'EOF2'
[Unit]
Description=temp-code deploy request from the app

[Path]
PathExists=/run/temp-code/deploy/request
Unit=temp-code-deploy.service

[Install]
WantedBy=multi-user.target
EOF2
((FILE_CHANGED == 0)) || reload=1
if ((reload)); then systemctl daemon-reload; changed 'temp-code-deploy units loaded'; fi
service_on temp-code-deploy.path
echo 'PASS: deploy trigger installed; the app may now deploy master to this box'
