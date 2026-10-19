#!/usr/bin/env bash
# OnFailure hook of box-backup.service: tell the hub, with the host's own
# heartbeat token, so a broken backup is never silent.
set -euo pipefail
umask 077
source /etc/box-heartbeat.env
[[ ${BOX_HEARTBEAT_URL:-} == https://*/v1/hosts/*/heartbeat ]] || { echo 'ERROR: BOX_HEARTBEAT_URL unset' >&2; exit 1; }
[[ ${BOX_HEARTBEAT_TOKEN:-} =~ ^[A-Za-z0-9._~-]+$ ]] || { echo 'ERROR: BOX_HEARTBEAT_TOKEN unset' >&2; exit 1; }
host_id=${BOX_HEARTBEAT_URL#*/v1/hosts/}; host_id=${host_id%/heartbeat}
url=${BOX_HEARTBEAT_URL%/v1/hosts/*}/v1/notify
reason=$(journalctl -u box-backup.service -n 8 --no-pager -o cat 2>/dev/null | tail -c 600 | tr -d '\0' || true)
payload=$(jq -nc --arg host "$host_id" --arg body "${reason:-see journalctl -u box-backup}" --argjson ts "$(date +%s%3N)" \
  '{event:"failed",hostId:$host,title:"Box backup failed",body:$body,ts:$ts}')
printf 'header = "Authorization: Bearer %s"\n' "$BOX_HEARTBEAT_TOKEN" |
  curl --config - --fail --silent --show-error --output /dev/null \
    --connect-timeout 5 --max-time 15 --retry 2 --proto '=https' \
    --header 'Content-Type: application/json' --data "$payload" "$url"
