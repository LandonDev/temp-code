#!/usr/bin/env bash
source "$(dirname "$0")/prod-lib.sh"
# Official installer reviewed 2026-10-19. Fail closed if upstream changes.
INSTALL_SHA=add4e64e82b5fcb751415a681c26db2bff939d4f034d024c632ba0b7dc03c090
if [[ ! -e /data/coolify ]]; then
  install -d -m 755 /data
  install -d -m 700 "$PROD/coolify"
  ln -s "$PROD/coolify" /data/coolify
  changed '/data/coolify points to /srv/prod/coolify'
fi
[[ $(readlink -f /data/coolify) == "$PROD/coolify" ]] || die 'Existing Coolify directory needs manual review'
install -d -m 700 /data/coolify/source
put /data/coolify/source/docker-compose.custom.yml 700 9999 root < "$BOX_DIR/coolify.custom.yml"
if [[ ! -f $STATE/coolify-installed ]]; then
  # Reuse the approved account and password after any interrupted installation.
  if [[ ! -s $SECRETS/coolify-admin.env ]]; then
    {
      printf 'ROOT_USERNAME=Landon\nROOT_USER_EMAIL=landonhaleyoutube@gmail.com\n'
      printf 'ROOT_USER_PASSWORD=Aa1!%s\n' "$(openssl rand -hex 32)"
    } | put "$SECRETS/coolify-admin.env" 600
  fi
  curl -fsSL https://cdn.coollabs.io/coolify/install.sh -o "$STATE/coolify-install.sh"
  echo "$INSTALL_SHA  $STATE/coolify-install.sh" | sha256sum -c -
  # Installer would replace daemon.json without an existing address pool.
  jq -e '.["default-address-pools"] and .["cgroup-parent"] == "prod.slice" and .["live-restore"]' /etc/docker/daemon.json >/dev/null
  set -a; source "$SECRETS/coolify-admin.env"; set +a
  # Installer logs remain private on the host, including its generated .env.
  USER=root AUTOUPDATE=false bash "$STATE/coolify-install.sh" > "$STATE/coolify-install.log" 2>&1 || die "Coolify installer failed; inspect $STATE/coolify-install.log locally"
  unset ROOT_USERNAME ROOT_USER_EMAIL ROOT_USER_PASSWORD
  touch "$STATE/coolify-installed"
  changed 'Coolify official installer completed'
fi
# The installer owns source/ as UID 9999 mode 700. Preserve that on reapply.
# No upgrades/pulls on reapply: retain the installed Coolify version.
cd /data/coolify/source
before=$(docker inspect -f '{{.Id}}' coolify 2>/dev/null || true)
docker compose --env-file .env -f docker-compose.yml -f docker-compose.prod.yml -f docker-compose.custom.yml up -d --wait --wait-timeout 180
[[ $before == "$(docker inspect -f '{{.Id}}' coolify)" ]] || changed 'Coolify reconciled'
curl -fsS http://127.0.0.1:8000/api/health >/dev/null
# First-user takeover must be closed before any tunnel DNS is created.
count=$(docker exec coolify php artisan tinker --execute='echo App\Models\User::where("id", 0)->count();' 2>/dev/null | tail -1)
[[ $count == 1 ]] || die 'First admin was not created; do not publish Coolify DNS'
printf 'PASS: Coolify healthy and first admin exists\n'
