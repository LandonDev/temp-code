#!/usr/bin/env bash
# Shared only by production stages; never source live secrets with tracing on.
set -euo pipefail
unset HISTFILE
umask 077
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
PROD=/srv/prod
SECRETS=$PROD/secrets
install -d -m 700 "$SECRETS"
install -d -m 750 "$PROD/stacks" "$PROD/data" "$PROD/backups"
secret_env() {
  local file=$1 key=$2
  if [[ ! -s $file ]]; then
    printf '%s=%s\n' "$key" "$(openssl rand -hex 32)" | put "$file" 600
  fi
  [[ $(stat -c '%a:%U:%G' "$file") == 600:root:root ]] || die "Unsafe secret permissions: $file"
}
compose_up() {
  local project=$1 file=$2 env=$3 before after
  before=$(docker compose -p "$project" --env-file "$env" -f "$file" ps -aq | sort)
  docker compose -p "$project" --env-file "$env" -f "$file" up -d --wait --wait-timeout 180
  after=$(docker compose -p "$project" --env-file "$env" -f "$file" ps -aq | sort)
  if [[ $before != "$after" ]]; then changed "$project containers"; else skip "$project containers unchanged"; fi
}
