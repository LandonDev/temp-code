#!/usr/bin/env bash
set -euo pipefail
# Docker's DNAT skips UFW INPUT rules. Reject new external forwarded flows.
# Established replies and container-originated outbound traffic still work.
mapfile -t interfaces < <({ ip -4 route show default; ip -6 route show default; } | awk '{for(i=1;i<=NF;i++) if($i=="dev") print $(i+1)}' | sort -u)
((${#interfaces[@]})) || { echo 'ERROR: no default-route interface found' >&2; exit 1; }
for binary in iptables ip6tables; do
  if ! "$binary" -w -nL DOCKER-USER >/dev/null 2>&1; then
    # IPv6 forwarding is off until Docker has an IPv6 network.
    if [[ $binary == ip6tables ]] && ! "$binary" -w -S FORWARD | grep -q DOCKER; then continue; fi
    echo "ERROR: $binary DOCKER-USER chain missing" >&2; exit 1
  fi
  for iface in "${interfaces[@]}"; do
    if ! "$binary" -w -C DOCKER-USER -i "$iface" -m conntrack --ctstate NEW -j DROP 2>/dev/null; then
      "$binary" -w -I DOCKER-USER 1 -i "$iface" -m conntrack --ctstate NEW -j DROP
      echo "CHANGED: $binary Docker inbound fence on $iface"
    else echo "SKIP: $binary Docker inbound fence on $iface"; fi
  done
done
