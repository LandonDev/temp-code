#!/usr/bin/env bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a
export APT_LISTCHANGES_FRONTEND=none
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
BOX_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
STATE=/var/lib/box-baseline
[[ $EUID == 0 ]] || { echo 'ERROR: run on the box as root' >&2; exit 1; }
source /etc/os-release
[[ $ID == ubuntu && $VERSION_ID == 24.04 ]] || { echo 'ERROR: Ubuntu 24.04 required' >&2; exit 1; }
mkdir -p "$STATE"
changed() { printf 'CHANGED: %s\n' "$*"; }
skip() { printf 'SKIP: %s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
# Atomic files; callers can use FILE_CHANGED to reload only when needed.
put() {
  local path=$1 mode=${2:-644} owner=${3:-root} group=${4:-root} tmp staged
  FILE_CHANGED=0
  mkdir -p "$(dirname "$path")"
  tmp=$(mktemp)
  cat > "$tmp"
  if [[ ! -f $path ]] || ! cmp -s "$tmp" "$path" ||
     [[ $(stat -c '%a:%U:%G' "$path") != "$mode:$owner:$group" ]]; then
    staged=$(mktemp "${path}.tmp.XXXXXX")
    install -o "$owner" -g "$group" -m "$mode" "$tmp" "$staged"
    mv -f "$staged" "$path"
    FILE_CHANGED=1
    changed "$path"
  else skip "$path"; fi
  rm -f "$tmp"
}
packages() {
  local p missing=()
  for p in "$@"; do
    if [[ $(dpkg-query -W -f='${Status}' "$p" 2>/dev/null || true) != 'install ok installed' ]]; then missing+=("$p"); fi
  done
  if ((${#missing[@]})); then
    apt-get -o DPkg::Lock::Timeout=300 install -y "${missing[@]}"
    changed "packages: ${missing[*]}"
  else skip "packages: $*"; fi
}
service_on() {
  local unit=$1
  if ! systemctl is-enabled --quiet "$unit"; then systemctl enable "$unit"; changed "enabled $unit"; fi
  if ! systemctl is-active --quiet "$unit"; then systemctl start "$unit"; changed "started $unit"; else skip "$unit active"; fi
}
fstab_line() {
  if ! grep -qxF "$1" /etc/fstab; then printf '%s\n' "$1" >> /etc/fstab; changed "fstab: $1"; else skip "fstab: $1"; fi
}
