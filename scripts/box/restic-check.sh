#!/usr/bin/env bash
set -euo pipefail
umask 077
source /etc/restic/box.env
export RESTIC_REPOSITORY RESTIC_PASSWORD_FILE AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_DEFAULT_REGION
exec 9>/run/lock/box-backup.lock
flock -w 21600 9
restic check --read-data-subset=5%
echo 'MONTHLY CHECK PASS: 5% of repository data read'
