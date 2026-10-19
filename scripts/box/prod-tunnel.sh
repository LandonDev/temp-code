#!/usr/bin/env bash
# Mac only. Origin certificate stays here; remote never gets zone credentials.
set -euo pipefail
unset HISTFILE
HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# Fail before creating DNS if first admin has not been confirmed.
ssh -o BatchMode=yes box 'unset HISTFILE; test -f /var/lib/box-baseline/coolify-installed; test "$(docker exec coolify php artisan tinker --execute='"'"'echo App\Models\User::where("id", 0)->count();'"'"' 2>/dev/null | tail -1)" = 1'
for host in coolify.landonhale.com convex-template.landonhale.com convex-template-dash.landonhale.com; do
  cloudflared --config "$HERE/cloudflared-local.yml" tunnel route dns tempcode-box "$host"
done
