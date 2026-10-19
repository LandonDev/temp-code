#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/lib.sh"
[[ ${BOX_KEY_VERIFIED:-} == 1 ]] || die 'Use apply.sh, which checks a fresh key login first'
key=$(cat "$BOX_DIR/root-key.pub")
install -d -m 700 /root/.ssh
touch /root/.ssh/authorized_keys
chmod 600 /root/.ssh/authorized_keys
if ! grep -qxF "$key" /root/.ssh/authorized_keys; then printf '%s\n' "$key" >> /root/.ssh/authorized_keys; changed 'root public key'; else skip 'root public key'; fi
put /etc/ssh/sshd_config.d/00-box-baseline.conf <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
PubkeyAuthentication yes
EOF
ssh_changed=$FILE_CHANGED
/usr/sbin/sshd -t
[[ $(/usr/sbin/sshd -T | awk '$1=="passwordauthentication" {print $2}') == no ]] || die 'PasswordAuthentication overridden'
[[ $(/usr/sbin/sshd -T | awk '$1=="permitrootlogin" {print $2}') == prohibit-password || $(/usr/sbin/sshd -T | awk '$1=="permitrootlogin" {print $2}') == without-password ]] || die 'PermitRootLogin overridden'
if ((ssh_changed)); then systemctl reload ssh; changed 'sshd reload'; fi
if [[ $(hostname) != tempcode-box ]]; then hostnamectl set-hostname tempcode-box; changed 'hostname tempcode-box'; else skip 'hostname'; fi
if [[ $(timedatectl show -p Timezone --value) != America/New_York ]]; then timedatectl set-timezone America/New_York; changed 'timezone America/New_York'; else skip 'timezone'; fi
if [[ ! -f $STATE/full-upgrade.done ]]; then
  apt-get update
  apt-get -y -o Dpkg::Options::=--force-confold full-upgrade
  touch "$STATE/full-upgrade.done"
  changed 'initial full upgrade complete'
else skip 'initial full upgrade (security updates run daily)'; fi
packages unattended-upgrades ca-certificates curl gnupg lvm2
put /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF
put /etc/apt/apt.conf.d/99-box-security <<'EOF'
#clear Unattended-Upgrade::Allowed-Origins;
Unattended-Upgrade::Allowed-Origins {
    "${distro_id}:${distro_codename}-security";
};
Unattended-Upgrade::Automatic-Reboot "false";
Unattended-Upgrade::Automatic-Reboot-WithUsers "false";
EOF
service_on unattended-upgrades.service
service_on apt-daily.timer
service_on apt-daily-upgrade.timer
[[ ! -f /var/run/reboot-required ]] || echo 'NOTICE: an explicit maintenance reboot is needed; automatic reboot stays off'
