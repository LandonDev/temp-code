#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/lib.sh"
packages git gh jq ripgrep build-essential python3 restic rsync htop ncdu unzip dbus-x11 apparmor-utils
electron_packages=(xvfb xauth libgtk-3-0t64 libnss3 libasound2t64 libxss1 libgbm1 libdrm2 libxkbcommon0 libatk-bridge2.0-0t64 libcups2t64 libxcomposite1 libxdamage1 libxrandr2 libpango-1.0-0 libcairo2 libatspi2.0-0t64 libx11-xcb1 fonts-liberation fonts-noto-color-emoji)
for p in "${electron_packages[@]}"; do
  candidate=$(apt-cache policy "$p" | awk '/Candidate:/ {print $2}')
  [[ -n $candidate && $candidate != '(none)' ]] || die "No Ubuntu 24.04 candidate for $p"
  printf 'PACKAGE: %s candidate %s\n' "$p" "$candidate"
done
packages "${electron_packages[@]}"
repos_changed=0
if [[ ! -s /etc/apt/keyrings/docker.asc ]]; then
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg | put /etc/apt/keyrings/docker.asc
  repos_changed=1
fi
put /etc/apt/sources.list.d/docker.sources <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: noble
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF
((FILE_CHANGED == 0)) || repos_changed=1
if [[ ! -s /usr/share/keyrings/nodesource.gpg ]]; then
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor | put /usr/share/keyrings/nodesource.gpg
  repos_changed=1
fi
put /etc/apt/sources.list.d/nodesource.sources <<EOF
Types: deb
URIs: https://deb.nodesource.com/node_22.x
Suites: nodistro
Components: main
Architectures: $(dpkg --print-architecture)
Signed-By: /usr/share/keyrings/nodesource.gpg
EOF
((FILE_CHANGED == 0)) || repos_changed=1
if ((repos_changed)) || ! apt-cache show docker-ce >/dev/null 2>&1; then apt-get update; fi
# A later repo check must not overwrite unrelated daemon settings silently.
put /etc/docker/daemon.json <<'EOF'
{
  "live-restore": true,
  "log-driver": "json-file",
  "log-opts": { "max-size": "10m", "max-file": "3" },
  "data-root": "/srv/prod/docker",
  "exec-opts": ["native.cgroupdriver=systemd"],
  "cgroup-parent": "prod.slice",
  "userland-proxy": false
}
EOF
docker_changed=$FILE_CHANGED
put /usr/local/sbin/box-docker-fence 755 < "$BOX_DIR/docker-fence.sh"
((FILE_CHANGED == 0)) || docker_changed=1
put /etc/systemd/system/docker.service.d/box.conf <<'EOF'
[Service]
Slice=prod.slice
ExecStartPost=/usr/local/sbin/box-docker-fence
EOF
((FILE_CHANGED == 0)) || docker_changed=1
packages docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin nodejs
[[ $(node -p 'process.versions.node.split(".")[0]') == 22 ]] || die 'Node 22 required'
if ((docker_changed)); then
  dockerd --validate --config-file=/etc/docker/daemon.json
  systemctl daemon-reload
  systemctl restart docker
  changed 'Docker configuration reload'
fi
service_on docker.service
# Reconcile rules after firewall reloads too; this helper reports only real changes.
/usr/local/sbin/box-docker-fence
if ! id -nG prod | tr ' ' '\n' | grep -qx docker; then
  usermod -aG docker prod
  systemctl restart "user@$(id -u prod).service"
  changed 'prod docker membership and refreshed user manager'
else skip 'prod docker membership'; fi
if id -nG agents | tr ' ' '\n' | grep -qx docker; then die 'agents must not be in docker group'; fi
[[ $(stat -c '%a:%U:%G' /var/run/docker.sock) == 660:root:docker ]] || die 'Unexpected docker socket permissions'
for user in root agents; do
  home=$(getent passwd "$user" | cut -d: -f6)
  if [[ ! -x $home/.bun/bin/bun ]]; then
    curl -fsSL https://bun.com/install -o "$STATE/bun-install.sh"
    chmod 644 "$STATE/bun-install.sh"
    runuser -u "$user" -- env HOME="$home" BUN_INSTALL="$home/.bun" bash "$STATE/bun-install.sh"
    changed "Bun for $user"
  else skip "Bun for $user ($("$home/.bun/bin/bun" --version))"; fi
done
put /etc/profile.d/box-bun.sh <<'EOF'
if [ -x "$HOME/.bun/bin/bun" ]; then
  export BUN_INSTALL="$HOME/.bun"
  export PATH="$BUN_INSTALL/bin:$PATH"
fi
EOF
docker --version; node --version; /root/.bun/bin/bun --version
