#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/lib.sh"
for service in docker cloudflared fail2ban ufw unattended-upgrades; do
  systemctl is-active --quiet "$service" || die "$service inactive"
  systemctl is-enabled --quiet "$service" || die "$service not enabled"
  echo "PASS: $service enabled and active"
done
ufw status verbose
[[ $(ufw show added | grep '^ufw ' | wc -l) == 1 ]] || die 'Unexpected UFW rule count'
ufw show added | grep -qx 'ufw allow 22/tcp' || die 'SSH UFW rule missing'
[[ $(/usr/sbin/sshd -T | awk '$1=="passwordauthentication" {print $2}') == no ]] || die 'SSH passwords allowed'
[[ $(/usr/sbin/sshd -T | awk '$1=="kbdinteractiveauthentication" {print $2}') == no ]] || die 'SSH keyboard auth allowed'
root_policy=$(/usr/sbin/sshd -T | awk '$1=="permitrootlogin" {print $2}')
[[ $root_policy == prohibit-password || $root_policy == without-password ]] || die 'Root SSH policy incorrect'
[[ $(hostname) == tempcode-box ]] || die 'Hostname mismatch'
[[ $(timedatectl show -p Timezone --value) == America/New_York ]] || die 'Timezone mismatch'
[[ $(systemctl show agents.slice -p MemoryHigh --value) == 85899345920 ]] || die 'MemoryHigh mismatch'
[[ $(systemctl show agents.slice -p MemoryMax --value) == 94489280512 ]] || die 'MemoryMax mismatch'
[[ $(systemctl show agents.slice -p TasksMax --value) == 6000 ]] || die 'TasksMax mismatch'
[[ $(systemctl show prod.slice -p MemoryMin --value) == 25769803776 ]] || die 'MemoryMin mismatch'
for spec in agents:100 prod:400; do
  user=${spec%:*}; weight=${spec#*:}
  [[ $(systemctl show "$user.slice" -p CPUWeight --value) == "$weight" ]] || die 'CPU weight mismatch'
  [[ $(systemctl show "$user.slice" -p IOWeight --value) == "$weight" ]] || die 'IO weight mismatch'
  [[ $(loginctl show-user "$user" -p Linger --value) == yes ]] || die "$user linger off"
  [[ $(systemctl show "user@$(id -u "$user").service" -p ControlGroup --value) == /$user.slice/* ]] || die "$user manager outside slice"
  [[ $(su - "$user" -c 'printf "%s:%s" "$(ulimit -Sn)" "$(ulimit -Hn)"') == 1048576:1048576 ]] || die "$user login nofile mismatch"
  echo "PASS: $user slice, linger, and login limits"
done
for file in /etc/sysctl.d/60-box-swap.conf /etc/sysctl.d/60-box-fleet.conf; do
  while IFS='=' read -r key value; do [[ $(sysctl -n "$key") == "$value" ]] || die "$key mismatch"; done < "$file"
done
[[ $(stat -c '%s:%a' /swapfile) == 8589934592:600 ]] || die 'Swapfile mismatch'
swapon --show=NAME --noheadings | grep -qx /swapfile || die 'Swapfile inactive'
findmnt --verify --tab-file /etc/fstab
if id -nG agents | tr ' ' '\n' | grep -qx docker; then die 'agents in docker group'; fi
runuser -u agents -- test ! -r /var/run/docker.sock || die 'agents can read Docker socket'
runuser -u agents -- test ! -w /var/run/docker.sock || die 'agents can write Docker socket'
su - prod -c 'docker info --format "Docker {{.ServerVersion}}, live-restore={{.LiveRestoreEnabled}}"'
[[ $(docker info --format '{{.LiveRestoreEnabled}}') == true ]] || die 'live restore off'
[[ $(systemctl show docker -p Slice --value) == prod.slice ]] || die 'Docker outside prod slice'
[[ $(jq -r '."cgroup-parent"' /etc/docker/daemon.json) == prod.slice ]] || die 'Docker container parent mismatch'
ip4=$(ip -4 route show default | awk '{for(i=1;i<=NF;i++) if($i=="dev") {print $(i+1); exit}}')
iptables -w -C DOCKER-USER -i "$ip4" -m conntrack --ctstate NEW -j DROP || die 'Docker IPv4 fence missing'
if ip6tables -w -nL DOCKER-USER >/dev/null 2>&1; then
  ip6tables -w -C DOCKER-USER -i "$ip4" -m conntrack --ctstate NEW -j DROP || die 'Docker IPv6 fence missing'
fi
[[ $(node -p 'process.versions.node.split(".")[0]') == 22 ]] || die 'Node 22 missing'
/root/.bun/bin/bun --version
su - agents -c 'bun --version'
fail2ban-client status sshd
curl -fsS http://127.0.0.1:20241/ready | jq -e '.status==200 and .readyConnections>0' >/dev/null
[[ ! -f /etc/cloudflared/cert.pem ]] || die 'Origin certificate should stay on Mac'
for timer in box-backup box-heartbeat; do
  [[ $(systemctl show "$timer.timer" -p LoadState --value) == loaded ]] || die "$timer timer not loaded"
  printf 'SCAFFOLD: %s.timer enabled=%s active=%s\n' "$timer" "$(systemctl is-enabled "$timer.timer" || true)" "$(systemctl is-active "$timer.timer" || true)"
done
systemd-analyze verify /etc/systemd/system/agents.slice /etc/systemd/system/prod.slice \
  /etc/systemd/system/box-backup.service /etc/systemd/system/box-backup.timer \
  /etc/systemd/system/box-heartbeat.service /etc/systemd/system/box-heartbeat.timer
[[ -z $(dpkg --audit) ]] || die 'dpkg audit failed'
echo 'PASS: host baseline verified (Electron proof runs in stage 55)'
