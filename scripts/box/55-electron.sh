#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/lib.sh"
proof=/srv/agents/home/.local/share/box-electron-proof
if [[ ! -d $proof ]]; then install -d -o agents -g agents -m 750 "$proof"; changed 'Electron proof directory'; fi
if [[ ! -x $proof/node_modules/.bin/electron ]]; then
  runuser -u agents -- env HOME=/srv/agents/home bash -c 'cd "$1"; npm i --save-exact electron@latest' bash "$proof"
  changed 'Electron latest installed in scratch directory (lockfile retained)'
else skip "Electron installed: $(node -p "require('$proof/node_modules/electron/package.json').version")"; fi
put "$proof/proof.cjs" 644 agents agents < "$BOX_DIR/electron-proof.cjs"
# Ubuntu restricts user namespaces. Grant this one executable access; keep the
# renderer sandbox and the host's global AppArmor restriction enabled.
put /etc/apparmor.d/box-electron-proof <<EOF
abi <abi/4.0>,
include <tunables/global>
profile box-electron-proof $proof/node_modules/electron/dist/electron flags=(unconfined) {
  userns,
  include if exists <local/box-electron-proof>
}
EOF
if ((FILE_CHANGED)) || ! grep -q '^box-electron-proof ' /sys/kernel/security/apparmor/profiles; then
  apparmor_parser -r /etc/apparmor.d/box-electron-proof
  changed 'Electron proof AppArmor profile loaded'
else skip 'Electron proof AppArmor profile loaded'; fi
# Use the same slice, uid and login limits that thread C will use.
systemd-run --quiet --wait --pipe --collect --uid=agents --gid=agents \
  --slice=agents.slice --property=LimitNOFILE=1048576 \
  --property=WorkingDirectory="$proof" --setenv=HOME=/srv/agents/home \
  /bin/bash -c 'set -euo pipefail; xvfb-run -a npx --no-install electron --version; xvfb-run -a dbus-run-session -- npx --no-install electron proof.cjs'
echo 'PASS: Electron version and offscreen screenshot proof as agents'
