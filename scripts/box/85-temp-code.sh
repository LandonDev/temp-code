#!/usr/bin/env bash
# temp-code as an always-on agent host (docs/box.md "temp-code service"):
# the CLIs the drivers spawn, the checkout and its build, an AppArmor
# userns grant for its Electron, /etc/temp-code.env, and temp-code.service
# in agents.slice. Re-runnable; installs only, box-update deploys a ref.
set -euo pipefail
source "$(dirname "$0")/lib.sh"
AGENTS_HOME=/srv/agents/home
CHECKOUT=/srv/agents/temp-code
DATA=/srv/agents/temp-code-data
MIN_CODEX=0.162.1
AGENTS_PATH="$AGENTS_HOME/.local/bin:$AGENTS_HOME/.npm-global/bin:$AGENTS_HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin"
as_agents() { runuser -u agents -- env HOME="$AGENTS_HOME" PATH="$AGENTS_PATH" "$@"; }
version_ge() { [[ $(printf '%s\n%s\n' "$2" "$1" | sort -V | head -1) == "$2" ]]; }
dir_as() {
  local dir=$1 mode=$2
  if [[ ! -d $dir ]] || [[ $(stat -c '%a:%U:%G' "$dir") != "$mode:agents:agents" ]]; then
    install -d -o agents -g agents -m "$mode" "$dir"; changed "$dir"
  else skip "$dir"; fi
}
reload=0

dir_as "$AGENTS_HOME/.local" 750
dir_as "$AGENTS_HOME/.local/bin" 750
dir_as "$AGENTS_HOME/.npm-global" 750
dir_as "$DATA" 700

# -- the CLIs the drivers spawn, installed as agents. Nothing signs in here:
#    the logins are a separate, interactive step (docs/box.md).
packages gh
if ! as_agents test -x "$AGENTS_HOME/.local/bin/claude"; then
  curl -fsSL https://claude.ai/install.sh -o "$STATE/claude-install.sh"
  chmod 644 "$STATE/claude-install.sh"
  as_agents bash "$STATE/claude-install.sh"
  changed "claude $(as_agents claude --version 2>/dev/null | head -1)"
else skip "claude $(as_agents claude --version 2>/dev/null | head -1)"; fi
codex_version() { as_agents codex --version 2>/dev/null | awk '{print $NF}'; }
if ! as_agents test -x "$AGENTS_HOME/.npm-global/bin/codex" || ! version_ge "$(codex_version)" "$MIN_CODEX"; then
  as_agents env npm_config_prefix="$AGENTS_HOME/.npm-global" npm install -g --no-fund --no-audit @openai/codex@latest
  changed "codex $(codex_version)"
else skip "codex $(codex_version)"; fi
version_ge "$(codex_version)" "$MIN_CODEX" || die "codex $(codex_version) is older than $MIN_CODEX"
if ! as_agents test -x "$AGENTS_HOME/.local/bin/cursor-agent"; then
  if curl -fsS https://cursor.com/install -o "$STATE/cursor-install.sh" && chmod 644 "$STATE/cursor-install.sh" &&
     as_agents bash "$STATE/cursor-install.sh"; then
    changed "cursor-agent $(as_agents cursor-agent --version 2>/dev/null | head -1)"
  else echo 'WARN: cursor-agent did not install; the cursor driver stays unavailable'; fi
else skip "cursor-agent $(as_agents cursor-agent --version 2>/dev/null | head -1)"; fi

# Builds are agents-owned; the directory containing current/previous is root-owned
# so an app process cannot change the next service target.
install -d -o root -g agents -m 755 /srv/agents/temp-code-builds
if [[ ! -L /srv/agents/temp-code-builds/current && -d $CHECKOUT/.git ]]; then
  ln -s "$CHECKOUT" /srv/agents/temp-code-builds/current
  changed 'adopted existing checkout without restarting it'
fi
install -d -m 755 /usr/local/lib/temp-code
put /usr/local/sbin/box-update 755 < "$BOX_DIR/box-update.sh"
put /usr/local/sbin/box-sqlite-snapshot 750 < "$BOX_DIR/sqlite-snapshot.sh"
put /usr/local/lib/temp-code/box-update-lib.sh 644 < "$BOX_DIR/box-update-lib.sh"
put /usr/local/lib/temp-code/box-probe.mjs 644 < "$BOX_DIR/box-probe.mjs"
put /usr/local/lib/temp-code/tc-local.mjs 644 < "$BOX_DIR/tc-local.mjs"
put /usr/local/lib/temp-code/run 755 <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
cd "${1:-/srv/agents/temp-code-builds/current}"
exec env -u ELECTRON_RUN_AS_NODE /usr/bin/xvfb-run -a -s '-screen 0 1600x1200x24 -nolisten tcp' \
  /usr/bin/dbus-run-session -- node_modules/electron/dist/electron .
EOF
# landon already has host sudo access; keep an explicit launcher rule too.
put /etc/sudoers.d/91-box-update 440 <<'EOF'
landon ALL=(root) NOPASSWD: /usr/local/sbin/box-update
EOF
visudo -cf /etc/sudoers.d/91-box-update

# -- Ubuntu restricts user namespaces; this one executable may create them,
#    the way stage 55 grants the Electron proof. The renderer sandbox stays on.
put /etc/apparmor.d/temp-code <<EOF
abi <abi/4.0>,
include <tunables/global>
profile temp-code "/srv/agents/{temp-code,temp-code-builds/*}/node_modules/electron/dist/electron" flags=(unconfined) {
  userns,
  include if exists <local/temp-code>
}
EOF
if ((FILE_CHANGED)) || ! grep -q '^temp-code ' /sys/kernel/security/apparmor/profiles; then
  apparmor_parser -r /etc/apparmor.d/temp-code
  changed 'temp-code AppArmor profile loaded'
else skip 'temp-code AppArmor profile loaded'; fi

# -- the service: root-only env (nothing secret in the managed file), the
#    unit in agents.slice, and tc-local for an operator on the box.
put /etc/temp-code.env 600 <<'EOF'
# temp-code.service environment, managed by scripts/box/85-temp-code.sh: a
# reapply rewrites this file. Nothing secret belongs here; secrets go in
# /etc/temp-code.secrets.env (root:root, 600), read by the unit when present.
TEMP_CODE_USER_DATA=/srv/agents/temp-code-data
TEMP_CODE_HEADLESS=1
TEMP_CODE_CLAIM_SHIM=1
AGENT_CLI_CREDENTIAL_STORE=file
TEMP_CODE_REMOTE_PORT=7677
NODE_ENV=production
SHELL=/bin/bash
EOF
put /etc/systemd/system/temp-code.service <<EOF
[Unit]
Description=temp-code agent host (headless Electron under Xvfb)
Documentation=file:///srv/agents/temp-code-builds/current/docs/box.md
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=0

[Service]
User=agents
Group=agents
Slice=agents.slice
WorkingDirectory=/srv/agents/temp-code-builds/current
EnvironmentFile=/etc/temp-code.env
EnvironmentFile=-/etc/temp-code.secrets.env
Environment=HOME=$AGENTS_HOME
# No user session bus here on purpose: given one, Chromium registers itself
# with the user's systemd and moves out of this unit's cgroup (into
# app-org.chromium.Chromium-<pid>.scope), beyond systemctl's reach. The run
# script gives it a private bus instead.
ExecStart=/usr/local/lib/temp-code/run
Restart=always
RestartSec=5
# On stop the whole cgroup gets SIGTERM at once. The main process records
# every thread mid-turn in one synchronous SQLite write before it exits
# (src/main/index.ts, sessions.ts recordForResume) and the next boot resumes
# them; the harnesses write their transcripts as they go, so nothing needs
# a long flush. 30 s is ample.
TimeoutStopSec=30
LimitNOFILE=1048576

[Install]
WantedBy=multi-user.target
EOF
((FILE_CHANGED == 0)) || reload=1
put /usr/local/bin/tc-local 755 <<EOF
#!/usr/bin/env bash
# The headless host's local socket, the implicit admin: tc-local <method> [json]
exec /usr/bin/node /usr/local/lib/temp-code/tc-local.mjs "\$@"
EOF
if ((reload)); then systemctl daemon-reload; changed 'temp-code unit loaded'; fi
if ! systemctl is-enabled --quiet temp-code; then systemctl enable --quiet temp-code; changed 'temp-code enabled'; fi
# Stage installation never restarts the host. box-update owns every switch,
# including first start and rollback; env/unit edits take effect at commit.
echo 'PASS: launcher installed; deploy with sudo box-update master'
