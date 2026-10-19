#!/usr/bin/env bash
set -euo pipefail
umask 077
source /etc/box-heartbeat.env
[[ ${BOX_HEARTBEAT_URL:-} == https://* && $BOX_HEARTBEAT_URL != *REPLACE* ]] || { echo 'ERROR: set BOX_HEARTBEAT_URL' >&2; exit 1; }
[[ -n ${BOX_HEARTBEAT_TOKEN:-} && $BOX_HEARTBEAT_TOKEN != *REPLACE* ]] || { echo 'ERROR: set BOX_HEARTBEAT_TOKEN' >&2; exit 1; }
# Hub heartbeat body (infra/hub README): environmentId, name, version, startedAt (ms).
env_id=${BOX_ENVIRONMENT_ID:-$(hostname)}
if [[ -r ${BOX_ENVIRONMENT_FILE:-/srv/agents/temp-code-data/environment.json} ]]; then
  env_id=$(jq -r '.environmentId // .id // empty' "${BOX_ENVIRONMENT_FILE:-/srv/agents/temp-code-data/environment.json}" 2>/dev/null || true)
  [[ -n $env_id ]] || env_id=${BOX_ENVIRONMENT_ID:-$(hostname)}
fi
boot_ms=$(( $(date -d "$(uptime -s)" +%s) * 1000 ))
payload=$(jq -nc --arg env "$env_id" --arg name "$(hostname)" --arg ver "${BOX_HEARTBEAT_VERSION:-box-scaffold}" --argjson started "$boot_ms" \
  '{environmentId:$env,name:$name,version:$ver,startedAt:$started}')
# Send the token through stdin config rather than placing it in curl's argv.
[[ $BOX_HEARTBEAT_TOKEN =~ ^[A-Za-z0-9._~-]+$ ]] || { echo 'ERROR: token must be a bearer token' >&2; exit 1; }
printf 'header = "Authorization: Bearer %s"\n' "$BOX_HEARTBEAT_TOKEN" |
  curl --config - --fail --silent --show-error --output /dev/null \
    --connect-timeout 5 --max-time 15 --retry 2 --proto '=https' \
    --header 'Content-Type: application/json' --data "$payload" "$BOX_HEARTBEAT_URL"
