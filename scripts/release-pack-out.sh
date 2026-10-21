#!/usr/bin/env bash
# Pack the built tree for the box: `out/` (main, preload, renderer, boot.js:
# platform-independent JavaScript), package.json with the commit under
# `tempcodeBuild.sha` (what src/main/buildInfo.ts reads), release.json,
# bun.lock, scripts/box (the runtime's launcher, probe and tc-local), the
# history importer, docs/box.md and a build-manifest.json, into
# `<dist>/temp-code-out-1.0.N.tar.gz` with a sha256sum line beside it.
#
# release-publish.sh runs this after the Mac build and uploads both files as
# assets of the GitHub release v1.0.N; box-update lays the tarball into a
# fresh build directory instead of cloning and building (docs/box.md
# "Updating"). Only node_modules has native parts, so the box installs
# those itself and only when bun.lock changed.
#
# Standalone (the dry run; needs an `out/` from electron-vite build):
#   scripts/release-pack-out.sh [--dist <dir>] [--sha <commit>]
# TEMP_CODE_BUILD_SHA also names the commit when the tree is not a checkout.
set -euo pipefail
cd "$(dirname "$0")/.."

DIST=dist
SHA=${TEMP_CODE_BUILD_SHA:-}
while [ $# -gt 0 ]; do
  case $1 in
    --dist) DIST=$2; shift 2 ;;
    --sha) SHA=$2; shift 2 ;;
    *) echo "usage: $0 [--dist <dir>] [--sha <commit>]" >&2; exit 2 ;;
  esac
done

VERSION=$(sed -n 's/^  "version": "\(1\.0\.[0-9]*\)",$/\1/p' package.json)
[ -n "$VERSION" ] || { echo "package.json version is not 1.0.N" >&2; exit 1; }
N=$(sed -n 's/^  "n": \([0-9]*\),$/\1/p' release.json)
[ "$N" = "${VERSION#1.0.}" ] || { echo "release.json n and package.json version disagree" >&2; exit 1; }
CONTRACT=$(sed -n 's/^export const CONTRACT_VERSION = \([0-9]*\)$/\1/p' src/shared/capabilities.ts)
[ -n "$CONTRACT" ] || { echo "no CONTRACT_VERSION in src/shared/capabilities.ts" >&2; exit 1; }
if [ -z "$SHA" ]; then
  SHA=$(git rev-parse HEAD 2>/dev/null) || { echo "not a checkout: pass --sha or TEMP_CODE_BUILD_SHA" >&2; exit 1; }
fi
case $SHA in *[!0-9a-f]*) SHA= ;; esac
[ ${#SHA} -eq 40 ] || { echo "the commit must be 40 hex characters (--sha or TEMP_CODE_BUILD_SHA)" >&2; exit 1; }
for f in out/main/boot.js out/main/index.js out/preload/index.js out/renderer/index.html bun.lock \
         scripts/box/temp-code-run.sh scripts/box/tc-local.mjs scripts/box/box-probe.mjs \
         src/main/server/historyImport.ts; do
  [ -f "$f" ] || { echo "missing $f: run electron-vite build first" >&2; exit 1; }
done

# sha256 of a file as one hex string, on macOS (shasum) and Linux (sha256sum).
digest() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1
}

ASSET="temp-code-out-$VERSION.tar.gz"
mkdir -p "$DIST"
DIST=$(cd "$DIST" && pwd)
STAGE=$(mktemp -d "${TMPDIR:-/tmp}/tc-pack-out.XXXXXX")
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/scripts" "$STAGE/src/main/server" "$STAGE/docs"
cp -R out "$STAGE/out"
cp release.json bun.lock "$STAGE/"
cp -R scripts/box "$STAGE/scripts/box"
cp src/main/server/historyImport.ts "$STAGE/src/main/server/"
cp docs/box.md "$STAGE/docs/"
find "$STAGE" -name .DS_Store -delete
find "$STAGE" -type d -name __pycache__ -prune -exec rm -rf {} +
# The commit rides in package.json the way electron-builder's extraMetadata
# puts it in the Mac bundle; everything else in the file stays as committed.
node -e '
  const fs = require("fs")
  const [src, dst, sha] = process.argv.slice(1)
  const pkg = JSON.parse(fs.readFileSync(src, "utf8"))
  pkg.tempcodeBuild = { ...(pkg.tempcodeBuild ?? {}), sha }
  fs.writeFileSync(dst, JSON.stringify(pkg, null, 2) + "\n")
' package.json "$STAGE/package.json" "$SHA"
LOCK_SHA=$(digest bun.lock)
BUN_VERSION=$(bun --version 2>/dev/null || echo unknown)
node -e '
  const fs = require("fs")
  const [dst, version, n, sha, contract, lockSha, asset, bun] = process.argv.slice(1)
  const manifest = {
    version, release: Number(n), sha, contract: Number(contract),
    asset, builtAt: new Date().toISOString(),
    builtOn: `${process.platform} ${process.arch}`, node: process.version, bun,
    lockfile: { sha256: lockSha },
    files: ["out", "package.json", "release.json", "bun.lock", "scripts/box", "src/main/server/historyImport.ts", "docs/box.md"]
  }
  fs.writeFileSync(dst, JSON.stringify(manifest, null, 2) + "\n")
' "$STAGE/build-manifest.json" "$VERSION" "$N" "$SHA" "$CONTRACT" "$LOCK_SHA" "$ASSET" "$BUN_VERSION"

# COPYFILE_DISABLE keeps macOS from adding ._ resource forks; the owner is
# whoever extracts (box-update extracts as agents).
rm -f "$DIST/$ASSET" "$DIST/$ASSET.sha256"
(cd "$STAGE" && COPYFILE_DISABLE=1 tar --no-xattrs -czf "$DIST/$ASSET" .)
printf '%s  %s\n' "$(digest "$DIST/$ASSET")" "$ASSET" > "$DIST/$ASSET.sha256"
SIZE=$(wc -c < "$DIST/$ASSET" | tr -d ' ')
echo "packed $DIST/$ASSET ($SIZE bytes, $(cut -d' ' -f1 "$DIST/$ASSET.sha256")) for $VERSION at ${SHA:0:12}, contract $CONTRACT, bun.lock ${LOCK_SHA:0:12}"
