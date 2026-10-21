#!/usr/bin/env bash
# The build-once path on a scratch build under /tmp, as agents, nothing root
# and nothing live (docs/box.md "Updating" → "Build once"):
#   scripts/box/prove-build-once.sh <temp-code-out-1.0.N.tar.gz> [<current build>]
# Lays the tarball out the way box-update does (unpack_asset, modules_plan
# against the current build, link_modules, write_manifest, expected_of), then
# starts it headless under Xvfb with a private HOME, userData, TMPDIR and a
# free loopback port, and waits for /healthz, server.json and the hello's
# contract. The current build defaults to the live one; its node_modules
# must fit (same bun.lock), since reuse is the point. PROVE_ELECTRON_ARGS
# adds flags to the launch (`--no-sandbox` where the scratch path is outside
# the AppArmor userns grant; the real builds under temp-code-builds need none).
set -euo pipefail
here=$(dirname "$(readlink -f "$0")")
source "$here/box-update-lib.sh"
[[ $# -ge 1 && -f $1 ]] || { echo "usage: $0 <temp-code-out-1.0.N.tar.gz> [<current build>]" >&2; exit 2; }
tar=$(readlink -f "$1")
current=$(readlink -f "${2:-/srv/agents/temp-code-builds/current}")
version=$(tar -xzOf "$tar" ./package.json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).version))')
scratch=$(mktemp -d /tmp/tc-build-once-proof.XXXXXX)
build=$scratch/build
mkdir -p "$build" "$scratch/home" "$scratch/data" "$scratch/tmp"
pid=
finish() {
  local status=$?
  if [[ -n $pid ]]; then kill -- -"$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true; fi
  if ((status != 0)); then echo "--- app log"; tail -40 "$scratch/app.log" 2>/dev/null || true; fi
  rm -rf -- "$scratch"
  ((status == 0)) && echo "PASS: build-once scratch install of $version" || echo "FAIL: exit $status"
}
trap finish EXIT
now() { date +%s%N; }
ms() { echo $((($2 - $1) / 1000000)); }

t0=$(now)
sha=$(unpack_asset "$tar" "$build" "$version")
t1=$(now)
echo "UNPACK: $version $sha in $(ms "$t0" "$t1") ms ($(du -sh --apparent-size "$build" | cut -f1))"
read -r modules reason < <(modules_plan "$build" "$current")
[[ $modules == reuse ]] || { echo "ERROR: $current's node_modules do not fit: $reason" >&2; exit 1; }
link_modules "$current" "$build"
t2=$(now)
links=$(stat -c %h "$build/node_modules/electron/dist/electron")
echo "MODULES: hardlinked from $current in $(ms "$t1" "$t2") ms (electron binary link count $links)"
((links >= 2)) || { echo 'ERROR: the Electron binary is not a hardlink' >&2; exit 1; }
write_manifest "$build" "version=$version" "sha=$sha" "deploy.ref=v$version" "deploy.source=asset" \
  "deploy.nodeModules=reused" "deploy.modulesFrom=$(basename "$current")" "deploy.lockfileSha256=$reason" \
  "deploy.at=$(date -u +%FT%TZ)"
read -r got_version contract < <(expected_of "$build")
[[ $got_version == "$version" ]] || { echo "ERROR: probe reads $got_version, wanted $version" >&2; exit 1; }
echo "MANIFEST: $(node -e 'const m=require(process.argv[1]);console.log(JSON.stringify({release:m.release,contract:m.contract,deploy:m.deploy}))' "$build/build-manifest.json")"

port=$(node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')
cd "$build"
# shellcheck disable=SC2086
setsid env -u ELECTRON_RUN_AS_NODE HOME="$scratch/home" TMPDIR="$scratch/tmp" TEMP_CODE_USER_DATA="$scratch/data" \
  TEMP_CODE_HEADLESS=1 TEMP_CODE_CLAIM_SHIM=0 AGENT_CLI_CREDENTIAL_STORE=file TEMP_CODE_REMOTE_PORT="$port" \
  NODE_ENV=production SHELL=/bin/bash \
  xvfb-run -a -s '-screen 0 1600x1200x24 -nolisten tcp' dbus-run-session -- \
  node_modules/electron/dist/electron ${PROVE_ELECTRON_ARGS:-} . > "$scratch/app.log" 2>&1 &
pid=$!
t3=$(now)
deadline=$((SECONDS + 90))
while ((SECONDS < deadline)); do
  if curl -fsS --max-time 2 "http://127.0.0.1:$port/healthz" >/dev/null 2>&1 && [[ -s $scratch/data/server.json ]]; then break; fi
  kill -0 "$pid" 2>/dev/null || { echo 'ERROR: the app exited' >&2; exit 1; }
  sleep 1
done
hello=$(curl -fsS --max-time 5 "http://127.0.0.1:$port/api/hello")
t4=$(now)
echo "READY: /healthz and server.json in $(ms "$t3" "$t4") ms; hello $hello"
node -e 'const h=JSON.parse(process.argv[1]);if(h.contract!==Number(process.argv[2]))throw Error("hello contract "+h.contract+", manifest "+process.argv[2])' "$hello" "$contract"
if [[ -x /usr/local/bin/tc-local ]]; then
  TEMP_CODE_USER_DATA="$scratch/data" TC_LOCAL_TIMEOUT_MS=10000 node "$build/scripts/box/box-probe.mjs" "$port" "$version" "$contract"
  echo "PROBE: box-probe.mjs passed on $port"
fi
echo "TOTAL: tarball to answering app in $(ms "$t0" "$t4") ms"
