#!/usr/bin/env bash
# Root coordinates links and systemd; every build/app command runs as agents.
set -Eeuo pipefail
umask 077
cd /
[[ $EUID == 0 ]] || { echo 'Run sudo box-update <ref>' >&2; exit 2; }
[[ $# == 1 && $1 != -* && $1 =~ ^[A-Za-z0-9][A-Za-z0-9._/-]*$ ]] || { echo 'Usage: box-update <branch|tag|sha>' >&2; exit 2; }
ref=$1
builds=/srv/agents/temp-code-builds
data=/srv/agents/temp-code-data
state=/var/lib/box-baseline
home=/srv/agents/home
path="$home/.local/bin:$home/.npm-global/bin:$home/.bun/bin:/usr/local/bin:/usr/bin:/bin"
repo=https://github.com/LandonDev/temp-code
pending=$state/temp-code-update.pending
trial= scratch= candidate= old= old_previous= flipped=0
mkdir -p "$state"
exec 8>/run/lock/temp-code-update.lock
flock -n 8 || { echo 'ERROR: another update is running' >&2; exit 1; }
as_agents() { runuser -u agents -- env HOME="$home" PATH="$path" "$@"; }
link_to() {
  rm -f "$builds/.$1.next"
  ln -s "$2" "$builds/.$1.next"
  mv -Tf "$builds/.$1.next" "$builds/$1"
}
expected() {
  as_agents node -e 'const fs=require("fs"),p=process.argv[1]; const v=JSON.parse(fs.readFileSync(p+"/package.json")).version; const c=fs.readFileSync(p+"/src/shared/capabilities.ts","utf8").match(/export const CONTRACT_VERSION = (\d+)/); if(!c)throw Error("no contract version"); console.log(v+" "+c[1])' "$1"
}
probe() {
  local build=$1 user_data=$2 port=$3 version contract
  read -r version contract < <(expected "$build")
  as_agents env TEMP_CODE_USER_DATA="$user_data" TC_LOCAL_TIMEOUT_MS=10000 \
    node /usr/local/lib/temp-code/box-probe.mjs "$port" "$version" "$contract"
}
wait_ready() {
  local build=$1 user_data=$2 port=$3 deadline=$((SECONDS + 90))
  while ((SECONDS < deadline)); do
    if curl -fsS --max-time 2 "http://127.0.0.1:$port/healthz" >/dev/null 2>&1 && [[ -s $user_data/server.json ]]; then
      probe "$build" "$user_data" "$port" && return 0
    fi
    sleep 1
  done
  echo "ERROR: health/socket check failed on $port" >&2
  return 1
}
rollback() {
  echo "ROLLBACK: restoring $(basename "$old")"
  link_to current "$old"
  if [[ -n $old_previous ]]; then link_to previous "$old_previous"; else rm -f "$builds/previous"; fi
  systemctl restart temp-code.service
  wait_ready "$old" "$data" 7677 || { echo 'ERROR: rollback verification failed; pending record retained' >&2; return 1; }
  rm -f "$pending"
  flipped=0
  echo "ROLLBACK PASS: $(expected "$old") current=$(readlink "$builds/current")"
}
finish() {
  local status=$?
  trap - EXIT INT TERM HUP
  set +e
  if [[ -n $trial ]]; then systemctl stop "$trial.service"; fi
  if [[ -n $scratch ]]; then rm -rf -- "$scratch"; fi
  if ((flipped)); then
    echo "ERROR: update of $ref failed after flip (exit $status)" >&2
    rollback || status=1
    status=1
  elif ((status != 0)); then
    echo "ERROR: update of $ref rejected before switch (exit $status); current unchanged" >&2
  fi
  if ((status != 0)) && [[ -n $candidate && $(readlink -f "$builds/current") != "$candidate" ]]; then
    as_agents find "$candidate" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
    rmdir "$candidate"
  fi
  exit "$status"
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP
# A hard power loss cannot run a trap. Recover the recorded switch before
# accepting another ref. The record is root-owned, outside the build trees.
if [[ -f $pending ]]; then
  mapfile -t recovery < "$pending"
  old=${recovery[0]}; old_previous=${recovery[1]:-}; flipped=1
  rollback
fi
[[ -L $builds/current ]] || { echo 'ERROR: install stage 85 first' >&2; exit 1; }
old=$(readlink -f "$builds/current")
old_previous=
if [[ -L $builds/previous ]]; then old_previous=$(readlink -f "$builds/previous"); fi
# Keep all clone, package lifecycle, compilation and metadata reads unprivileged.
candidate=$(mktemp -d "$builds/build-$(date -u +%Y%m%dT%H%M%S)-XXXXXX")
chown agents:agents "$candidate"
chmod 750 "$candidate"
as_agents git clone --quiet --no-checkout "$repo" "$candidate"
# A Mac may have green master commits not yet published to GitHub. A root-
# supplied bundle transfers that exact ref without pushing a branch or keys.
source=origin
if [[ -n ${BOX_UPDATE_BUNDLE:-} ]]; then
  [[ -f $BOX_UPDATE_BUNDLE && $(stat -c %U "$BOX_UPDATE_BUNDLE") == root ]] || { echo 'ERROR: source bundle must be root-owned' >&2; exit 1; }
  source=$BOX_UPDATE_BUNDLE
fi
as_agents git -C "$candidate" fetch --quiet "$source" "$ref"
sha=$(as_agents git -C "$candidate" rev-parse --verify 'FETCH_HEAD^{commit}')
as_agents git -C "$candidate" -c advice.detachedHead=false checkout --quiet --detach "$sha"
release="$builds/$sha-$(basename "$candidate" | cut -d- -f2-)"
mv "$candidate" "$release"; candidate=$release
# A failed build never touches current or the live unit.
echo "BUILD: $ref $sha"
systemd-run --quiet --wait --pipe --collect --unit="temp-code-build-$$" \
  --property=User=agents --property=Group=agents --property=Slice=agents.slice \
  --property="WorkingDirectory=$candidate" --setenv="HOME=$home" --setenv="PATH=$path" \
  /bin/bash -c 'set -euo pipefail
    bun install --frozen-lockfile
    [[ -x node_modules/electron/dist/electron ]] || node node_modules/electron/install.js
    node_modules/.bin/electron-builder install-app-deps
    node_modules/.bin/electron-vite build'
# Scratch HOME prevents a trial from seeing CLI accounts or the live shim.
scratch=$(mktemp -d /srv/agents/.temp-code-trial-XXXXXX)
chown agents:agents "$scratch"
as_agents mkdir -p "$scratch/home" "$scratch/data" "$scratch/tmp"
port=$(as_agents node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')
trial=temp-code-trial-$$
echo "TRIAL: $(basename "$candidate") remote-port=$port scratch=$scratch"
systemd-run --quiet --collect --unit="$trial" \
  --property=User=agents --property=Group=agents --property=Slice=agents.slice \
  --property="WorkingDirectory=$candidate" --property=RuntimeMaxSec=180 \
  --property=KillMode=control-group --property=TimeoutStopSec=30 \
  --setenv="HOME=$scratch/home" --setenv="PATH=$path" --setenv="TMPDIR=$scratch/tmp" \
  --setenv="TEMP_CODE_USER_DATA=$scratch/data" --setenv=TEMP_CODE_HEADLESS=1 \
  --setenv=TEMP_CODE_CLAIM_SHIM=0 --setenv=AGENT_CLI_CREDENTIAL_STORE=file \
  --setenv="TEMP_CODE_REMOTE_PORT=$port" --setenv=NODE_ENV=production --setenv=SHELL=/bin/bash \
  /usr/local/lib/temp-code/run "$candidate"
wait_ready "$candidate" "$scratch/data" "$port"
echo "TRIAL PASS: $(expected "$candidate") port=$port sha=$sha"
systemctl stop "$trial.service"; trial=
rm -rf -- "$scratch"; scratch=
read -r new_version _ < <(expected "$candidate")
read -r old_version _ < <(expected "$old")
if dpkg --compare-versions "$new_version" lt "$old_version"; then
  echo "ERROR: refusing older $new_version over $old_version; publish master or supply its green bundle" >&2
  exit 1
fi
# The backup lock also prevents the daily snapshot/upload and restore drill
# from racing this snapshot. Only complete, checked generations survive.
(
  flock -w 21600 9
  snapshots=/srv/agents/backups/pre-update
  install -d -m 700 -o agents -g agents "$snapshots"
  snap="$snapshots/$(date -u +%Y%m%dT%H%M%S)-$$"
  /usr/local/sbin/box-sqlite-snapshot "$data" "$snap"
  echo "SNAPSHOT PASS: $snap"
  while IFS= read -r stale; do rm -rf -- "$snapshots/$stale"; done < <(find "$snapshots" -mindepth 1 -maxdepth 1 -type d ! -name '.tmp-*' -printf '%f\n' | sort -r | tail -n +4)
) 9>/run/lock/box-backup.lock
printf '%s\n%s\n' "$old" "$old_previous" > "$pending.tmp"
mv "$pending.tmp" "$pending"
flipped=1
link_to previous "$old"
link_to current "$candidate"
echo "COMMIT: current=$(basename "$candidate") previous=$(basename "$old")"
systemctl restart temp-code.service
wait_ready "$candidate" "$data" 7677
# Root-only one-shot fault file for proving rollback after a healthy restart.
if [[ -f /run/temp-code-update-force-post-flip-failure ]]; then
  rm /run/temp-code-update-force-post-flip-failure
  echo 'ERROR: forced post-flip health-check failure' >&2
  exit 1
fi
as_agents touch "$candidate/.box-committed"
rm "$pending"; flipped=0
echo "COMMIT PASS: $(expected "$candidate") sha=$sha"
# Keep the two newest successful builds plus current and previous. Failed
# candidates never count toward retention and cannot evict a known good build.
kept=0
while IFS= read -r dir; do
  if [[ -f $dir/.box-committed ]]; then kept=$((kept + 1)); fi
  if { [[ ! -f $dir/.box-committed ]] || ((kept > 2)); } &&
     [[ $dir != $(readlink -f "$builds/current") && $dir != $(readlink -f "$builds/previous") ]]; then
    if as_agents find "$dir" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} + && rmdir "$dir"; then
      echo "PRUNE: $(basename "$dir")"
    else echo "WARN: could not prune $(basename "$dir")" >&2; fi
  fi
done < <(find "$builds" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' | sort -rn | cut -d' ' -f2-)
# Retire the original in-place checkout only after two successful builds
# replace it, and only when no release link or local edit still needs it.
legacy=/srv/agents/temp-code
if ((kept >= 2)) && [[ -d $legacy/.git && $legacy != $(readlink -f "$builds/current") && $legacy != $(readlink -f "$builds/previous") ]]; then
  if [[ -z $(as_agents git -C "$legacy" status --porcelain) ]]; then
    if as_agents find "$legacy" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} + && rmdir "$legacy"; then
      echo 'PRUNE: original in-place checkout'
    else echo 'WARN: original checkout cleanup failed' >&2; fi
  else echo 'WARN: original checkout has local edits; retained' >&2; fi
fi
