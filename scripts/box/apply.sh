#!/usr/bin/env bash
set -euo pipefail
HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
from=0 through=90
while (($#)); do
  case $1 in
    --from) from=$2; shift 2 ;;
    --through) through=$2; shift 2 ;;
    *) echo 'Usage: apply.sh [--from NUMBER] [--through NUMBER]' >&2; exit 2 ;;
  esac
done
[[ $from =~ ^[0-9]+$ && $through =~ ^[0-9]+$ ]] || exit 2
# A fresh key-only connection is mandatory before SSH policy can change.
SSH=(ssh -o BatchMode=yes -o PasswordAuthentication=no -o KbdInteractiveAuthentication=no -o ConnectTimeout=15 box)
"${SSH[@]}" 'test "$(. /etc/os-release; echo "$ID:$VERSION_ID")" = ubuntu:24.04'
"${SSH[@]}" 'install -d -m 700 /opt/box-baseline'
rsync -az --chmod=D700,F600 -e 'ssh -o BatchMode=yes' "$HERE/" box:/opt/box-baseline/
rsync -az --chmod=F600 -e 'ssh -o BatchMode=yes' "$HOME/.ssh/id_ed25519.pub" box:/opt/box-baseline/root-key.pub
for file in "$HERE"/[0-9][0-9]-*.sh; do
  name=$(basename "$file"); n=${name%%-*}; n=$((10#$n))
  ((n >= from && n <= through)) || continue
  if ((n == 60)); then bash "$HERE/tunnel.sh"; fi
  printf '\n== %s ==\n' "$name"
  "${SSH[@]}" "BOX_KEY_VERIFIED=1 bash /opt/box-baseline/$name"
done
