#!/usr/bin/env bash
set -euo pipefail
HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
from=0 through=190
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
if ! "${SSH[@]}" 'command -v rsync >/dev/null'; then
  # A minimal image has no rsync: harden SSH and upgrade before bootstrapping it.
  COPYFILE_DISABLE=1 tar -C "$HERE" -cf - lib.sh 10-access.sh | "${SSH[@]}" 'tar -xf - -C /opt/box-baseline'
  "${SSH[@]}" 'cat > /opt/box-baseline/root-key.pub' < "$HOME/.ssh/id_ed25519.pub"
  "${SSH[@]}" 'BOX_KEY_VERIFIED=1 bash /opt/box-baseline/10-access.sh && DEBIAN_FRONTEND=noninteractive apt-get install -y rsync'
fi
rsync -rltz -e 'ssh -o BatchMode=yes' "$HERE/" box:/opt/box-baseline/
rsync -rltz -e 'ssh -o BatchMode=yes' "$HOME/.ssh/id_ed25519.pub" box:/opt/box-baseline/root-key.pub
"${SSH[@]}" 'find /opt/box-baseline ! -user root -exec chown root:root {} +'
while IFS= read -r name; do
  n=${name%%-*}; n=$((10#$n))
  ((n >= from && n <= through)) || continue
  if ((n == 60)); then bash "$HERE/tunnel.sh" < /dev/null; fi
  if ((n == 150)); then bash "$HERE/prod-tunnel.sh" < /dev/null; fi
  printf '\n== %s ==\n' "$name"
  "${SSH[@]}" "unset HISTFILE; BOX_KEY_VERIFIED=1 bash /opt/box-baseline/$name" < /dev/null
done < <(cd "$HERE" && printf '%s\n' [0-9]*-*.sh | sort -n)
