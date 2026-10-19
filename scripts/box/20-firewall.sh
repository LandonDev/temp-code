#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/lib.sh"
packages ufw fail2ban
# Refuse to erase someone else's rules on a later run.
if ufw show added | grep '^ufw ' | grep -vE '^ufw allow 22/tcp$' >/dev/null; then die 'Unexpected UFW rules; inspect before changing policy'; fi
if ! ufw status verbose | grep -q 'Default: deny (incoming), allow (outgoing), deny (routed)'; then
  ufw default deny incoming; ufw default allow outgoing; ufw default deny routed
  changed 'UFW defaults'
else skip 'UFW defaults'; fi
if ! ufw show added | grep -qx 'ufw allow 22/tcp'; then ufw allow 22/tcp; changed 'UFW SSH rule'; else skip 'UFW SSH rule'; fi
if ! ufw status | grep -q '^Status: active'; then ufw --force enable; changed 'UFW enabled'; else skip 'UFW enabled'; fi
service_on ufw.service
put /etc/fail2ban/jail.d/box-sshd.local <<'EOF'
[sshd]
enabled = true
backend = systemd
port = 22
maxretry = 5
findtime = 10m
bantime = 1h
EOF
reload=$FILE_CHANGED
service_on fail2ban.service
if ((reload)); then fail2ban-client reload; changed 'fail2ban reload'; fi
