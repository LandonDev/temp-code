#!/usr/bin/env bash
# temp-code.service's ExecStart: Electron from this checkout under its own
# virtual X server. The unit's EnvironmentFile carries the rest (headless,
# userData, the fixed remote port); see docs/box.md "temp-code service".
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")/../.."
# dbus-run-session: a private session bus for Chromium's own use. On the
# user's bus it would register with systemd and leave the unit's cgroup.
exec env -u ELECTRON_RUN_AS_NODE /usr/bin/xvfb-run -a -s '-screen 0 1600x1200x24 -nolisten tcp' \
  /usr/bin/dbus-run-session -- node_modules/electron/dist/electron .
