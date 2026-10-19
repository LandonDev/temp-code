#!/usr/bin/env bash
set -euo pipefail
# Mac only. No change to ~/.cloudflared/config.yml or any other tunnel.
command -v cloudflared >/dev/null
[[ -s $HOME/.cloudflared/cert.pem ]] || { echo 'ERROR: Mac origin cert missing' >&2; exit 1; }
config=$(mktemp)
trap 'rm -f "$config"' EXIT
printf '{}\n' > "$config"
CF=(cloudflared --config "$config" tunnel --origincert "$HOME/.cloudflared/cert.pem")
lookup() {
  "${CF[@]}" list --output json | python3 -c 'import json,sys; a=[t["id"] for t in json.load(sys.stdin) if t["name"]=="tempcode-box"]; assert len(a)<=1; print(a[0] if a else "")'
}
id=$(lookup)
if [[ -z $id ]]; then
  "${CF[@]}" create tempcode-box
  id=$(lookup)
  echo 'CHANGED: created tempcode-box tunnel'
else echo "SKIP: tempcode-box tunnel $id exists"; fi
[[ $id =~ ^[a-f0-9-]{36}$ ]] || { echo 'ERROR: invalid tunnel ID' >&2; exit 1; }
credential=$HOME/.cloudflared/$id.json
[[ -s $credential ]] || { echo 'ERROR: tunnel exists but its Mac credentials are missing; refusing to recreate it' >&2; exit 1; }
route=$("${CF[@]}" route dns tempcode-box tempcode.landonhale.com 2>&1)
printf '%s\n' "$route"
if [[ $route == *'Added CNAME'* ]]; then echo 'CHANGED: tunnel DNS route'; else echo 'SKIP: tunnel DNS route'; fi
ssh -o BatchMode=yes box 'test -d /etc/cloudflared || install -d -m 700 /etc/cloudflared'
# This is the only private Cloudflare file sent to the server.
copied=$(rsync -rltzic -e 'ssh -o BatchMode=yes' "$credential" "box:/etc/cloudflared/$id.json")
if [[ -n $copied ]]; then echo 'CHANGED: tunnel credentials copied'; else echo 'SKIP: tunnel credentials'; fi
ssh -o BatchMode=yes box "test \"\$(cat /var/lib/box-baseline/tunnel-id 2>/dev/null)\" = '$id' || { printf '%s\\n' '$id' > /var/lib/box-baseline/tunnel-id; echo 'CHANGED: tunnel ID'; }"
ssh -o BatchMode=yes box "test \"\$(stat -c '%a:%U:%G' /etc/cloudflared/$id.json)\" = '600:root:root' || { chmod 600 /etc/cloudflared/$id.json; chown root:root /etc/cloudflared/$id.json; echo 'CHANGED: credential permissions'; }"
