#!/usr/bin/env bash
source "$(dirname "$0")/prod-lib.sh"
python3 - "$STATE/prod-before.json" <<'PY'
import json, subprocess, sys
run=lambda *a: subprocess.check_output(a,text=True).strip()
before=json.load(open(sys.argv[1]))
for key in ('MainPID','NRestarts','ActiveEnterTimestampMonotonic'):
    assert run('systemctl','show','temp-code.service','-p',key,'--value')==str(before[key]), f'temp-code {key} changed'
assert run('systemctl','is-active','temp-code.service')=='active'
assert run('ufw','status')==before['ufw'], 'UFW changed'
listeners=sorted(line.split()[3] for line in run('ss','-H','-ltn').splitlines() if not line.split()[3].startswith(('127.','[::1]:')))
assert listeners==before['listeners'], f'Non-loopback listeners changed: {listeners}'
ids=run('docker','ps','-q').splitlines()
assert ids, 'No running containers'
for c in json.loads(run('docker','inspect',*ids)):
    assert c['HostConfig']['CgroupParent'] in ('','prod.slice'), c['Name']+' wrong cgroup parent'
    assert '/prod.slice/' in open(f"/proc/{c['State']['Pid']}/cgroup").read(), c['Name']+' wrong kernel cgroup'
    for bindings in (c['NetworkSettings']['Ports'] or {}).values():
        for b in bindings or []:
            assert b['HostIp']=='127.0.0.1', c['Name']+' has non-loopback published port'
    assert c['State'].get('Health',{}).get('Status','healthy')=='healthy', c['Name']+' unhealthy'
from pathlib import Path
for secret in Path('/srv/prod/secrets').iterdir():
    info=secret.stat()
    assert secret.is_file() and info.st_uid==0 and info.st_gid==0 and (info.st_mode & 0o777)==0o600, f'Unsafe secret file: {secret.name}'
print(f'PASS: {len(ids)} containers in prod.slice, loopback ports only; UFW and temp-code PID/restarts unchanged')
PY
[[ $(systemctl show prod.slice -p MemoryAccounting --value) == yes ]]
[[ $(stat -c '%a:%U:%G' /var/run/docker.sock) == 660:root:docker ]]
! id -nG agents | tr ' ' '\n' | grep -qx docker
curl -fsS http://127.0.0.1:8000/api/health >/dev/null
curl -fsS http://127.0.0.1/ping
curl -fsS http://127.0.0.1:3210/version
curl -fsS http://127.0.0.1:6791/ >/dev/null
docker exec prod-postgres sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" psql -h 127.0.0.1 -U prod_admin -d postgres -tAc "SELECT 1"' | grep -qx 1
docker exec prod-redis sh -c 'REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli ping' | grep -qx PONG
docker exec prod-redis redis-cli ping 2>&1 | grep -q NOAUTH
systemctl is-active prod-postgres-backup.timer
systemd-cgls --no-pager /prod.slice
ss -ltnp
ufw status
