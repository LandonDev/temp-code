#!/bin/bash
# Installs the nightly backup job for this Mac user: copies backup.sh to
# ~/.local/bin/tempcode-backup and loads the launchd agent (03:30 daily;
# launchd runs a missed slot at the next wake). Re-run after editing backup.sh.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
label=dev.landon.tempcode.backup
plist="$HOME/Library/LaunchAgents/$label.plist"
mkdir -p "$HOME/.local/bin" "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
install -m 755 "$here/backup.sh" "$HOME/.local/bin/tempcode-backup"
sed "s#HOME_DIR#$HOME#g" "$here/$label.plist" > "$plist"
launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$plist"
launchctl print "gui/$(id -u)/$label" | grep -E 'state|program' | head -3
echo "installed $label; run now with: launchctl kickstart gui/$(id -u)/$label"
