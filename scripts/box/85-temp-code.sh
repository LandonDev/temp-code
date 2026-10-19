#!/usr/bin/env bash
# temp-code as an always-on agent host (docs/box.md "temp-code service"):
# the CLIs the drivers spawn, the checkout and its build, an AppArmor
# userns grant for its Electron, /etc/temp-code.env, and temp-code.service
# in agents.slice. Re-runnable. TEMP_CODE_REF picks the ref to deploy
# (default master); TEMP_CODE_REF=local builds the tree as it sits.
set -euo pipefail
source "$(dirname "$0")/lib.sh"
AGENTS_HOME=/srv/agents/home
CHECKOUT=/srv/agents/temp-code
DATA=/srv/agents/temp-code-data
REPO=${TEMP_CODE_REPO:-https://github.com/LandonDev/temp-code}
REF=${TEMP_CODE_REF:-master}
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
restart=0 reload=0

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

# -- the checkout: a deploy copy pinned to $REF, reset hard on every change.
if [[ $REF == local ]]; then
  [[ -f $CHECKOUT/package.json ]] || die "$CHECKOUT has no tree to build"
  tree="local-$(date +%s)"
else
  if [[ ! -d $CHECKOUT/.git ]]; then
    [[ ! -e $CHECKOUT ]] || die "$CHECKOUT exists without .git: move it aside, or use TEMP_CODE_REF=local"
    as_agents git clone -q "$REPO" "$CHECKOUT"
    changed "cloned $REPO"
  fi
  as_agents git -C "$CHECKOUT" fetch -q origin
  target=$(as_agents git -C "$CHECKOUT" rev-parse --verify -q "origin/$REF" ||
           as_agents git -C "$CHECKOUT" rev-parse --verify -q "$REF^{commit}") || die "unknown ref $REF"
  if [[ $(as_agents git -C "$CHECKOUT" rev-parse HEAD) != "$target" ]] || [[ -n $(as_agents git -C "$CHECKOUT" status --porcelain) ]]; then
    as_agents git -C "$CHECKOUT" -c advice.detachedHead=false checkout -q --detach "$target"
    as_agents git -C "$CHECKOUT" reset -q --hard "$target"
    changed "checkout at ${target:0:12}"
  else skip "checkout at ${target:0:12}"; fi
  tree=$target
fi

# -- the build: deps, Electron's binary, node-pty against it, main + preload + renderer.
built=$(cat "$STATE/temp-code-built" 2>/dev/null || true)
if [[ $tree != "$built" ]] || [[ ! -x $CHECKOUT/node_modules/electron/dist/electron ]] || [[ ! -f $CHECKOUT/out/renderer/index.html ]]; then
  as_agents bash -c 'set -euo pipefail; cd "$1"
    bun install --frozen-lockfile
    # bun runs no dependency lifecycle scripts: Electron fetches its binary
    # here, and node-pty is rebuilt against that Electron.
    [[ -x node_modules/electron/dist/electron ]] || node node_modules/electron/install.js
    [[ -f node_modules/node-pty/build/Release/pty.node ]] || node_modules/.bin/electron-builder install-app-deps
    node_modules/.bin/electron-vite build' bash "$CHECKOUT"
  echo "$tree" > "$STATE/temp-code-built"
  restart=1
  changed "built $tree"
else skip "built $tree"; fi

# -- Ubuntu restricts user namespaces; this one executable may create them,
#    the way stage 55 grants the Electron proof. The renderer sandbox stays on.
put /etc/apparmor.d/temp-code <<EOF
abi <abi/4.0>,
include <tunables/global>
profile temp-code $CHECKOUT/node_modules/electron/dist/electron flags=(unconfined) {
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
((FILE_CHANGED == 0)) || restart=1
put /etc/systemd/system/temp-code.service <<EOF
[Unit]
Description=temp-code agent host (headless Electron under Xvfb)
Documentation=file://$CHECKOUT/docs/box.md
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=0

[Service]
User=agents
Group=agents
Slice=agents.slice
WorkingDirectory=$CHECKOUT
EnvironmentFile=/etc/temp-code.env
EnvironmentFile=-/etc/temp-code.secrets.env
Environment=HOME=$AGENTS_HOME
# No user session bus here on purpose: given one, Chromium registers itself
# with the user's systemd and moves out of this unit's cgroup (into
# app-org.chromium.Chromium-<pid>.scope), beyond systemctl's reach. The run
# script gives it a private bus instead.
ExecStart=$CHECKOUT/scripts/box/temp-code-run.sh
Restart=always
RestartSec=5
TimeoutStopSec=30
LimitNOFILE=1048576

[Install]
WantedBy=multi-user.target
EOF
((FILE_CHANGED == 0)) || { reload=1; restart=1; }
put /usr/local/bin/tc-local 755 <<EOF
#!/usr/bin/env bash
# The headless host's local socket, the implicit admin: tc-local <method> [json]
exec /usr/bin/node $CHECKOUT/scripts/box/tc-local.mjs "\$@"
EOF
if ((reload)); then systemctl daemon-reload; changed 'temp-code unit loaded'; fi
if ! systemctl is-enabled --quiet temp-code; then systemctl enable --quiet temp-code; changed 'temp-code enabled'; fi
if ((restart)) && systemctl is-active --quiet temp-code; then systemctl restart temp-code; changed 'temp-code restarted'
elif ! systemctl is-active --quiet temp-code; then systemctl start temp-code; changed 'temp-code started'
else skip 'temp-code active'; fi
for _ in $(seq 1 90); do
  curl -fsS --max-time 2 http://127.0.0.1:7677/healthz >/dev/null 2>&1 && break
  sleep 1
done
curl -fsS --max-time 2 http://127.0.0.1:7677/healthz | grep -qx ok ||
  { journalctl -u temp-code -n 60 --no-pager; die 'temp-code listener did not answer on 127.0.0.1:7677'; }
{
  echo "node $(node --version)"
  echo "bun $(as_agents bun --version)"
  echo "electron $(node -p "require('$CHECKOUT/node_modules/electron/package.json').version")"
  echo "claude $(as_agents claude --version 2>/dev/null | head -1)"
  echo "codex $(as_agents codex --version 2>/dev/null)"
  echo "cursor-agent $(as_agents cursor-agent --version 2>/dev/null | head -1 || echo unavailable)"
  echo "gh $(gh --version | head -1)"
  echo "temp-code $tree"
} | tee "$STATE/temp-code-versions.txt"
curl -fsS --max-time 5 http://127.0.0.1:7677/api/hello; echo
echo 'PASS: temp-code.service up on 127.0.0.1:7677'
