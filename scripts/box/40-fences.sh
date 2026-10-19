#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/lib.sh"
for user in agents prod; do
  if ! id "$user" >/dev/null 2>&1; then useradd --system --user-group --create-home --home-dir "/srv/$user/home" --shell /bin/bash "$user"; changed "user $user"; else skip "user $user"; fi
  [[ $(getent passwd "$user" | cut -d: -f6-7) == "/srv/$user/home:/bin/bash" ]] || die "Unexpected $user home/shell"
  if [[ $(stat -c '%a:%U:%G' "/srv/$user") != "750:$user:$user" ]]; then chown "$user:$user" "/srv/$user"; chmod 750 "/srv/$user"; changed "/srv/$user ownership and mode"; else skip "/srv/$user ownership and mode"; fi
  if [[ $(stat -c %a "/srv/$user/home") != 750 ]]; then chmod 750 "/srv/$user/home"; changed "$user home mode"; fi
  if [[ ! -f /var/lib/systemd/linger/$user ]]; then loginctl enable-linger "$user"; changed "linger $user"; else skip "linger $user"; fi
  # Place lingering user managers and all their child units in the right slice.
  put "/etc/systemd/system/user@$(id -u "$user").service.d/box.conf" <<EOF
[Service]
Slice=$user.slice
LimitNOFILE=1048576
EOF
  manager_changed=${manager_changed:-0}
  ((FILE_CHANGED == 0)) || manager_changed=1
done
if getent group docker >/dev/null && id -nG agents | tr ' ' '\n' | grep -qx docker; then gpasswd -d agents docker; changed 'removed agents from docker'; fi
put /etc/systemd/system/agents.slice <<'EOF'
[Unit]
Description=Agent workloads
[Slice]
MemoryHigh=80G
MemoryMax=88G
TasksMax=6000
CPUWeight=100
IOWeight=100
EOF
reload=$FILE_CHANGED
put /etc/systemd/system/prod.slice <<'EOF'
[Unit]
Description=Production workloads
[Slice]
MemoryMin=24G
CPUWeight=400
IOWeight=400
EOF
((FILE_CHANGED == 0)) || reload=1
if ((reload || manager_changed)); then systemctl daemon-reload; changed 'systemd fence reload'; fi
for unit in agents.slice prod.slice; do
  if ! systemctl is-active --quiet "$unit"; then systemctl start "$unit"; changed "started $unit"; else skip "$unit active"; fi
done
for user in agents prod; do
  unit=user@$(id -u "$user").service
  if [[ $(systemctl show "$unit" -p Slice --value) != "$user.slice" ]]; then die "$unit slice override failed"; fi
  if [[ $(systemctl show "$unit" -p ControlGroup --value) != /$user.slice/* ]]; then
    systemctl restart "$unit"
    changed "moved $unit into $user.slice"
  else skip "$unit in $user.slice"; fi
done
put /etc/sysctl.d/60-box-fleet.conf <<'EOF'
fs.inotify.max_user_watches=1048576
fs.inotify.max_user_instances=8192
fs.file-max=4194304
vm.max_map_count=1048576
net.core.somaxconn=4096
EOF
while IFS='=' read -r key value; do
  if [[ $(sysctl -n "$key") != "$value" ]]; then sysctl -w "$key=$value"; changed "$key"; else skip "$key"; fi
done < /etc/sysctl.d/60-box-fleet.conf
put /etc/security/limits.d/60-box-fleet.conf <<'EOF'
agents soft nofile 1048576
agents hard nofile 1048576
prod soft nofile 1048576
prod hard nofile 1048576
EOF
