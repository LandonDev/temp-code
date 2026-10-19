#!/usr/bin/env bash
set -euo pipefail
umask 077
source /etc/box-heartbeat.env
[[ ${BOX_HEARTBEAT_URL:-} == https://* && $BOX_HEARTBEAT_URL != *REPLACE* ]] || { echo 'ERROR: set BOX_HEARTBEAT_URL' >&2; exit 1; }
[[ -n ${BOX_HEARTBEAT_TOKEN:-} && $BOX_HEARTBEAT_TOKEN != *REPLACE* ]] || { echo 'ERROR: set BOX_HEARTBEAT_TOKEN' >&2; exit 1; }
payload=$(jq -nc --arg host "$(hostname)" --arg time "$(date -u +%FT%TZ)" '{host:$host,time:$time}')
# Send the token through stdin config rather than placing it in curl's argv.
[[ $BOX_HEARTBEAT_TOKEN =~ ^[A-Za-z0-9._~-]+$ ]] || { echo 'ERROR: token must be a bearer token' >&2; exit 1; }
printf 'header = "Authorization: Bearer %s"\n' "$BOX_HEARTBEAT_TOKEN" |
  curl --config - --fail --silent --show-error --output /dev/null \
    --connect-timeout 5 --max-time 15 --retry 2 --proto '=https' \
    --header 'Content-Type: application/json' --data "$payload" "$BOX_HEARTBEAT_URL"
