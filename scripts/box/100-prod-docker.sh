#!/usr/bin/env bash
source "$(dirname "$0")/prod-lib.sh"
# Save guards once, before changing the host. No credentials or agent files.
if [[ ! -f $STATE/prod-before.json ]]; then
  python3 - "$STATE/prod-before.json" <<'PY'
import json, subprocess, sys
run=lambda *a: subprocess.check_output(a,text=True).strip()
s=dict(line.split('=',1) for line in run('systemctl','show','temp-code.service','-p','MainPID','-p','NRestarts','-p','ActiveEnterTimestampMonotonic').splitlines())
s['ufw']=run('ufw','status')
s['listeners']=sorted(line.split()[3] for line in run('ss','-H','-ltn').splitlines() if not line.split()[3].startswith(('127.','[::1]:')))
with open(sys.argv[1],'w') as f: json.dump(s,f)
PY
  changed 'saved production host guards'
fi
# Docker's documented key is cgroup-parent, NOT default-cgroup-parent.
# Merge rather than erase the baseline's live-restore, logs, fence, or data root.
tmp=$(mktemp)
jq '. + {"cgroup-parent":"prod.slice","live-restore":true} | if has("default-address-pools") then . else . + {"default-address-pools":[{"base":"10.240.0.0/16","size":24}]} end' /etc/docker/daemon.json > "$tmp"
dockerd --validate --config-file="$tmp"
put /etc/docker/daemon.json 644 < "$tmp"
rm -f "$tmp"
if ((FILE_CHANGED)); then systemctl restart docker; changed 'Docker restarted with live restore'; fi
[[ $(systemctl show prod.slice -p MemoryAccounting --value) == yes ]] || die 'Production memory accounting is off'
[[ $(docker info --format '{{.CgroupDriver}} {{.LiveRestoreEnabled}}') == 'systemd true' ]] || die 'Docker cgroup driver or live restore differs'
/usr/local/sbin/box-docker-fence
# Loopback-only proof, including the kernel's cgroup path, not just Docker metadata.
id=$(docker run -d --rm --name prod-cgroup-proof --network none alpine:3.22 sleep 60)
trap 'docker rm -f "$id" >/dev/null 2>&1 || true' EXIT
pid=$(docker inspect -f '{{.State.Pid}}' "$id")
grep '/prod.slice/' "/proc/$pid/cgroup"
systemd-cgls --no-pager /prod.slice
