#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/lib.sh"
lsblk -f; df -h; pvs; vgs; lvs
# Only unused LVM extents are eligible. Never shrink root or repartition remotely.
if [[ ! -f $STATE/storage-layout ]]; then
  if [[ -f $STATE/storage-vg ]]; then
    vg=$(cat "$STATE/storage-vg")
    vgs "$vg" >/dev/null || die 'Recorded storage VG is missing'
  else
    vg=$(vgs --noheadings --units b --nosuffix -o vg_name,vg_free | awk '$2>=1800000000000 {print $1; exit}')
    if [[ -n $vg ]]; then printf '%s\n' "$vg" > "$STATE/storage-vg"; fi
  fi
  if [[ -n $vg ]]; then
    for spec in agents:1210G prod:466G; do
      name=${spec%:*}; size=${spec#*:}; dev=/dev/$vg/$name
      if ! lvs "$dev" >/dev/null 2>&1; then
        lvcreate -L "$size" -n "$name" --addtag tempcode-box-baseline "$vg"
        changed "LV $name"
      elif ! lvs --noheadings -o lv_tags "$dev" | tr ', ' '\n' | grep -qx tempcode-box-baseline; then
        die "Refusing to use an LV not created by this baseline: $dev"
      fi
      fs=$(blkid -s TYPE -o value "$dev" || true)
      if [[ -z $fs ]]; then mkfs.ext4 "$dev"; changed "ext4 $dev"; elif [[ $fs != ext4 ]]; then die "Unexpected filesystem on $dev"; fi
      mkdir -p "/srv/$name"
      [[ -z $(ls -A "/srv/$name") ]] || mountpoint -q "/srv/$name" || die "Refusing to hide files in /srv/$name"
      uuid=$(blkid -s UUID -o value "$dev")
      fstab_line "UUID=$uuid /srv/$name ext4 defaults 0 2"
      if ! mountpoint -q "/srv/$name"; then mount "/srv/$name"; changed "mounted /srv/$name"; fi
    done
    printf 'lvm:%s\n' "$vg" > "$STATE/storage-layout"
  else
    mkdir -p /srv/agents /srv/prod
    printf 'directories: no VG has enough unused extents; no live root resize\n' > "$STATE/storage-layout"
    changed '/srv/agents and /srv/prod directory fallback'
  fi
else
  skip "storage layout: $(cat "$STATE/storage-layout")"
  if grep -q '^lvm:' "$STATE/storage-layout"; then
    for name in agents prod; do mountpoint -q "/srv/$name" || { mount "/srv/$name"; changed "mounted /srv/$name"; }; done
  else mkdir -p /srv/agents /srv/prod; fi
fi
if [[ ! -f /swapfile ]]; then
  fallocate -l 8G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  changed '8 GiB swapfile'
fi
[[ $(stat -c %s /swapfile) == 8589934592 ]] || die 'Existing swapfile has unexpected size'
[[ $(stat -c %a /swapfile) == 600 ]] || { chmod 600 /swapfile; changed 'swapfile mode'; }
[[ $(blkid -p -s TYPE -o value /swapfile) == swap ]] || die 'Existing swapfile has no swap signature'
fstab_line '/swapfile none swap sw 0 0'
if ! swapon --show=NAME --noheadings | grep -qx /swapfile; then swapon /swapfile; changed 'swapfile enabled'; else skip 'swapfile active'; fi
put /etc/sysctl.d/60-box-swap.conf <<'EOF'
vm.swappiness=10
EOF
if [[ $(sysctl -n vm.swappiness) != 10 ]]; then sysctl -w vm.swappiness=10; changed 'swappiness'; else skip 'swappiness'; fi
