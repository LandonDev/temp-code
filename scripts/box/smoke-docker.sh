#!/usr/bin/env bash
set -euo pipefail
# Mac-only functional test; never changes UFW. The temporary published port
# must work over loopback and remain unreachable from the Mac.
SSH=(ssh -o BatchMode=yes -o ConnectTimeout=10 box)
id=''
cleanup() {
  if [[ -n $id ]]; then "${SSH[@]}" "docker rm -f '$id' >/dev/null"; fi
}
trap cleanup EXIT
id=$("${SSH[@]}" 'docker run -d --rm --name box-baseline-port-proof -p 0.0.0.0:18080:80 nginx:alpine')
[[ $id =~ ^[a-f0-9]{64}$ ]] || { echo 'ERROR: no test container ID' >&2; exit 1; }
"${SSH[@]}" "curl -fsS --retry 5 --retry-connrefused --retry-delay 1 http://127.0.0.1:18080/ >/dev/null; test \"\$(docker inspect -f '{{.HostConfig.CgroupParent}}' '$id')\" = prod.slice; pid=\$(docker inspect -f '{{.State.Pid}}' '$id'); grep -q '/prod.slice/' /proc/\$pid/cgroup"
echo 'PASS: Docker loopback port works and container runs in prod.slice'
if curl --noproxy '*' -sS --connect-timeout 5 --max-time 6 http://104.194.11.2:18080/ >/dev/null 2>&1; then
  echo 'ERROR: Docker published port reachable from outside' >&2; exit 1
fi
echo 'PASS: Docker published port blocked from the Mac'
"${SSH[@]}" 'iptables -nvL DOCKER-USER'
