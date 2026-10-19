#!/usr/bin/env bash
source "$(dirname "$0")/prod-lib.sh"
count=$(docker exec coolify php artisan tinker --execute='echo App\Models\User::where("id", 0)->count();' 2>/dev/null | tail -1)
[[ $count == 1 ]] || die 'First admin must exist before routing the dashboard'
if [[ ! -f $STATE/prod-ingress-ready ]]; then
  touch "$STATE/prod-ingress-ready"
  changed 'production ingress enabled'
fi
bash "$BOX_DIR/60-tunnel.sh"
