#!/usr/bin/env bash
set -euo pipefail
umask 077
source /etc/restic/box.env
export RESTIC_REPOSITORY RESTIC_PASSWORD_FILE AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_DEFAULT_REGION
for name in RESTIC_REPOSITORY RESTIC_PASSWORD_FILE AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY; do
  value=${!name:-}
  [[ -n $value && $value != *REPLACE* ]] || { echo "ERROR: configure $name in /etc/restic/box.env" >&2; exit 1; }
done
[[ -s $RESTIC_PASSWORD_FILE ]] || { echo 'ERROR: restic password file missing' >&2; exit 1; }
# No automatic init, forget, or prune. Test restore before setting retention.
exec restic backup --host tempcode-box --tag baseline \
  --exclude-file=/etc/restic/excludes /srv/agents /srv/prod /etc
