#!/bin/bash
# Nightly Mac backup of the temp-code data dir to the R2 restic repo.
# Live SQLite files are never copied as files: each database is snapshotted
# with VACUUM INTO (one read transaction, so the app keeps writing) and the
# snapshot is what restic uploads. Secrets come from the login Keychain:
#   tempcode-restic       account landon          -> restic password
#   tempcode-r2-backups   account <access key id> -> R2 secret key
set -euo pipefail
export PATH=/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin
data=${TEMP_CODE_DATA:-"$HOME/Library/Application Support/temp-code"}
staging=${TEMP_CODE_BACKUP_STAGING:-"$HOME/Library/Application Support/temp-code-backup-staging"}
export RESTIC_REPOSITORY=${TEMP_CODE_BACKUP_REPO:-s3:https://6d0588686eec76c3b1ceccc6205ee083.r2.cloudflarestorage.com/tempcode-backups/mac}
export AWS_DEFAULT_REGION=auto
export RESTIC_PASSWORD; RESTIC_PASSWORD=$(security find-generic-password -s tempcode-restic -a landon -w)
export AWS_ACCESS_KEY_ID; AWS_ACCESS_KEY_ID=$(security find-generic-password -s tempcode-r2-backups | sed -n 's/.*"acct"<blob>="\(.*\)"/\1/p')
export AWS_SECRET_ACCESS_KEY; AWS_SECRET_ACCESS_KEY=$(security find-generic-password -s tempcode-r2-backups -a "$AWS_ACCESS_KEY_ID" -w)
[[ -n $RESTIC_PASSWORD && -n $AWS_ACCESS_KEY_ID && -n $AWS_SECRET_ACCESS_KEY ]] || { echo 'ERROR: Keychain items missing' >&2; exit 1; }
[[ -d $data ]] || { echo "ERROR: no data dir at $data" >&2; exit 1; }

mkdir -p "$staging"
if ! mkdir "$staging/.lock" 2>/dev/null; then echo 'another backup is running' >&2; exit 1; fi
cleanup() { rm -rf "$staging/.lock" "$staging/sqlite"; }
trap cleanup EXIT
echo "[$(date '+%F %T')] backup start"

rm -rf "$staging/sqlite"; mkdir -p "$staging/sqlite"
for db in "$data"/*.db; do
  [[ -f $db ]] || continue
  name=$(basename "$db"); tmp="$staging/sqlite/.tmp-$name"
  sqlite3 "$db" "VACUUM INTO '$tmp'"
  [[ $(sqlite3 "$tmp" 'PRAGMA quick_check') == ok ]] || { echo "ERROR: snapshot of $name failed its check" >&2; exit 1; }
  mv "$tmp" "$staging/sqlite/$name"
  echo "snapshot $name $(du -h "$staging/sqlite/$name" | cut -f1)"
done

# A data dir the history move left behind (temp-code.moved-<date>, see
# docs/history-move.md) has no writer, so its database files go up as they
# are; it stays covered until the user removes it.
moved=()
for dir in "$(dirname "$data")"/temp-code.moved-*; do [[ -d $dir ]] && moved+=("$dir"); done
excludes=()
for dir in "$data" "${moved[@]}"; do
  excludes+=(--exclude "$dir/Cache" --exclude "$dir/Code Cache" --exclude "$dir/GPUCache"
    --exclude "$dir/DawnCache" --exclude "$dir/DawnWebGPUCache" --exclude "$dir/DawnGraphiteCache"
    --exclude "$dir/blob_storage" --exclude "$dir/Crashpad" --exclude "$dir/Service Worker")
done
restic backup --host mac --tag daily --quiet \
  --exclude "$data/*.db" --exclude "$data/*.db-wal" --exclude "$data/*.db-shm" --exclude "$data/*.db-journal" \
  "${excludes[@]}" \
  "$data" "${moved[@]}" "$staging/sqlite"
restic forget --host mac --keep-daily 7 --keep-weekly 4 --keep-monthly 6 --prune --quiet
restic check --quiet
echo "[$(date '+%F %T')] backup done: $(restic snapshots --host mac --latest 1 --compact 2>/dev/null | tail -1)"
