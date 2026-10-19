#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/lib.sh"
repos_changed=0
if [[ ! -s /usr/share/keyrings/cloudflare-main.gpg ]]; then
  curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | put /usr/share/keyrings/cloudflare-main.gpg
  repos_changed=1
fi
put /etc/apt/sources.list.d/cloudflared.list <<'EOF'
deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main
EOF
((FILE_CHANGED == 0)) || repos_changed=1
if ((repos_changed)) || ! apt-cache show cloudflared >/dev/null 2>&1; then apt-get update; fi
packages cloudflared
id=$(cat "$STATE/tunnel-id")
[[ $id =~ ^[a-f0-9-]{36}$ && -s /etc/cloudflared/$id.json ]] || die 'Run the Mac tunnel helper first'
[[ $(jq -r .TunnelID "/etc/cloudflared/$id.json") == "$id" ]] || die 'Tunnel credential ID mismatch'
{
  printf 'tunnel: %s\ncredentials-file: /etc/cloudflared/%s.json\nmetrics: 127.0.0.1:20241\n' "$id" "$id"
  cat "$BOX_DIR/ingress.yml"
} | put /etc/cloudflared/config.yml 600
# put runs in the pipe subshell; compare service's running config by hash below.
cloudflared --config /etc/cloudflared/config.yml tunnel ingress validate
digest=$(sha256sum /etc/cloudflared/config.yml | cut -d' ' -f1)
if [[ ! -f /etc/systemd/system/cloudflared.service ]]; then
  cloudflared --config /etc/cloudflared/config.yml service install
  changed 'cloudflared service installed'
fi
service_on cloudflared.service
if [[ $(cat "$STATE/tunnel-config.sha256" 2>/dev/null || true) != "$digest" ]]; then
  systemctl restart cloudflared
  printf '%s\n' "$digest" > "$STATE/tunnel-config.sha256"
  changed 'cloudflared config applied'
else skip 'cloudflared config applied'; fi
