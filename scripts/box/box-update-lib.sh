#!/usr/bin/env bash
# The install half of box-update (docs/box.md "Updating"), sourced by
# /usr/local/sbin/box-update and by scripts/box/test-build-once.py. Nothing
# here needs root or the live service: every function takes its paths as
# arguments and runs as the calling user (box-update calls them as agents).
#
# What a deploy lays into a fresh build directory:
#   - for a v1.0.N ref, the release's temp-code-out-1.0.N.tar.gz (the out/
#     the Mac built, package.json, release.json, bun.lock, scripts/box, a
#     build-manifest.json), fetched with its sha256 and verified;
#   - for master, a clone built with electron-vite as before;
#   - node_modules: a hardlinked copy of the current build's when bun.lock is
#     byte-identical (modules_plan), else a fresh `bun install` with Electron's
#     binary and the native modules rebuilt for Linux (build_script).
# BOX_UPDATE_FRESH_MODULES=1 forces the install; BOX_UPDATE_ASSET_BASE points
# a proof at a local feed in place of GitHub's release downloads.

BOX_UPDATE_REPO=${BOX_UPDATE_REPO:-LandonDev/temp-code}
BOX_UPDATE_ASSET_BASE=${BOX_UPDATE_ASSET_BASE:-https://github.com/$BOX_UPDATE_REPO/releases/download}

# lockfile_digest <build> → sha256 of its bun.lock, or nothing without one.
lockfile_digest() {
  [[ -f $1/bun.lock ]] || return 0
  sha256sum "$1/bun.lock" | cut -d' ' -f1
}

# modules_plan <candidate> [<current build>] → "reuse <digest>" when the
# current build's node_modules fit the candidate, else "install <reason>".
# The lockfile pins every package and Electron's version, and the native
# modules were rebuilt against that Electron, so the same lockfile means the
# same tree; the Electron binary is checked because a tree without it
# (an interrupted install) is not one to copy.
modules_plan() {
  local candidate=$1 current=${2:-} want have
  if [[ ${BOX_UPDATE_FRESH_MODULES:-0} == 1 ]]; then echo 'install BOX_UPDATE_FRESH_MODULES=1'; return 0; fi
  [[ -n $current ]] || { echo 'install no current build'; return 0; }
  want=$(lockfile_digest "$candidate")
  [[ -n $want ]] || { echo 'install the candidate has no bun.lock'; return 0; }
  have=$(lockfile_digest "$current")
  [[ $want == "$have" ]] || { echo "install bun.lock changed (${have:0:12} -> ${want:0:12})"; return 0; }
  [[ -x $current/node_modules/electron/dist/electron ]] || { echo 'install the current build has no Electron binary'; return 0; }
  echo "reuse $want"
}

# link_modules <from build> <to build>: node_modules as a hardlinked copy
# (seconds for the 800-package tree, on the same filesystem; nothing writes
# into node_modules at runtime, and pruning the old build only drops its
# links). A filesystem that refuses hardlinks gets a plain copy.
link_modules() {
  local from=$1/node_modules to=$2/node_modules
  [[ -d $from ]] || { echo "ERROR: $from is missing" >&2; return 1; }
  [[ ! -e $to ]] || { echo "ERROR: $to already exists" >&2; return 1; }
  if ! cp -al "$from" "$to" 2>/dev/null; then
    rm -rf -- "$to"
    cp -a "$from" "$to"
  fi
}

# build_script <source|asset> <reuse|install> → the bash the build unit
# runs, or nothing when the candidate is complete as laid out.
build_script() {
  local source=$1 modules=$2 steps=()
  if [[ $modules == install ]]; then
    steps+=('bun install --frozen-lockfile'
      '[[ -x node_modules/electron/dist/electron ]] || node node_modules/electron/install.js'
      'node_modules/.bin/electron-builder install-app-deps')
  fi
  if [[ $source == source ]]; then steps+=('node_modules/.bin/electron-vite build'); fi
  ((${#steps[@]})) || return 0
  printf 'set -euo pipefail\n'
  printf '%s\n' "${steps[@]}"
}

# fetch_asset <version> <dir> → downloads temp-code-out-<version>.tar.gz and
# its .sha256 into <dir>, checks the digest, prints the tarball's path.
# Exit 3 when the release has no such asset (one published before the box
# packing existed), 1 for any other failure.
fetch_asset() {
  local version=$1 dir=$2 asset="temp-code-out-$1.tar.gz" base="$BOX_UPDATE_ASSET_BASE/v$1" code
  mkdir -p "$dir"
  code=$(curl -sSL --retry 3 --retry-delay 2 --max-time 120 -o "$dir/$asset.sha256" -w '%{http_code}' "$base/$asset.sha256") || code=000
  if [[ $code == 404 ]]; then rm -f "$dir/$asset.sha256"; return 3; fi
  [[ $code == 200 ]] || { echo "ERROR: $base/$asset.sha256 answered $code" >&2; return 1; }
  grep -qE "^[0-9a-f]{64}  $asset\$" "$dir/$asset.sha256" || { echo "ERROR: $asset.sha256 is not a sha256sum line for $asset" >&2; return 1; }
  curl -fsSL --retry 3 --retry-delay 2 --max-time 1800 -o "$dir/$asset" "$base/$asset" || { echo "ERROR: download of $base/$asset failed" >&2; return 1; }
  (cd "$dir" && sha256sum --quiet -c "$asset.sha256" >/dev/null) || { echo "ERROR: $asset does not match its published sha256" >&2; return 1; }
  echo "$dir/$asset"
}

# unpack_asset <tarball> <build dir> <version>: extracts and checks what the
# box runs (the three bundles, package.json with the commit, release.json,
# bun.lock, the manifest), prints the commit sha.
unpack_asset() {
  local tar=$1 dest=$2 version=$3 f
  [[ -d $dest ]] || { echo "ERROR: $dest is not a directory" >&2; return 1; }
  tar -xzf "$tar" -C "$dest" --no-same-owner || { echo "ERROR: $tar does not extract" >&2; return 1; }
  for f in out/main/boot.js out/main/index.js out/preload/index.js out/renderer/index.html \
           package.json release.json bun.lock build-manifest.json; do
    [[ -f $dest/$f ]] || { echo "ERROR: the asset lacks $f" >&2; return 1; }
  done
  node -e '
    const fs = require("fs")
    const [dir, version] = process.argv.slice(1)
    const read = (f) => JSON.parse(fs.readFileSync(dir + "/" + f, "utf8"))
    const m = read("build-manifest.json"), p = read("package.json")
    const fail = (why) => { console.error("ERROR: " + why); process.exit(1) }
    if (p.version !== version) fail(`the asset is ${p.version}, wanted ${version}`)
    if (m.version !== p.version) fail(`manifest ${m.version} disagrees with package.json ${p.version}`)
    if (!/^[0-9a-f]{40}$/.test(String(m.sha ?? ""))) fail("the manifest names no commit")
    if (p.tempcodeBuild?.sha !== m.sha) fail("package.json tempcodeBuild.sha disagrees with the manifest")
    if (!Number.isInteger(m.contract)) fail("the manifest names no contract version")
    console.log(m.sha)
  ' "$dest" "$version"
}

# write_manifest <build> key=value... merges into <build>/build-manifest.json
# (creating it): dotted keys nest (deploy.source=asset), a value prefixed
# `json:` is parsed, and `release` is read from release.json when unset.
write_manifest() {
  local build=$1; shift
  node -e '
    const fs = require("fs")
    const [dir, ...pairs] = process.argv.slice(1)
    const path = dir + "/build-manifest.json"
    let m = {}
    try { m = JSON.parse(fs.readFileSync(path, "utf8")) } catch {}
    for (const pair of pairs) {
      const i = pair.indexOf("=")
      const keys = pair.slice(0, i).split("."), raw = pair.slice(i + 1)
      const value = raw.startsWith("json:") ? JSON.parse(raw.slice(5)) : raw
      let at = m
      for (const k of keys.slice(0, -1)) at = (at[k] && typeof at[k] === "object") ? at[k] : (at[k] = {})
      at[keys[keys.length - 1]] = value
    }
    if (m.release === undefined) {
      try { m.release = JSON.parse(fs.readFileSync(dir + "/release.json", "utf8")).n } catch {}
    }
    fs.writeFileSync(path + ".tmp", JSON.stringify(m, null, 2) + "\n")
    fs.renameSync(path + ".tmp", path)
  ' "$build" "$@"
}

# expected_of <build> → "<version> <contract>": package.json's version and
# the contract from the manifest (an asset build), else from
# src/shared/capabilities.ts (a source checkout).
expected_of() {
  node -e '
    const fs = require("fs")
    const dir = process.argv[1]
    const version = JSON.parse(fs.readFileSync(dir + "/package.json", "utf8")).version
    let contract
    try { contract = JSON.parse(fs.readFileSync(dir + "/build-manifest.json", "utf8")).contract } catch {}
    if (!Number.isInteger(contract)) {
      const m = fs.readFileSync(dir + "/src/shared/capabilities.ts", "utf8").match(/export const CONTRACT_VERSION = (\d+)/)
      if (!m) throw Error("no contract version")
      contract = Number(m[1])
    }
    console.log(version + " " + contract)
  ' "$1"
}
