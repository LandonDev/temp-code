#!/bin/sh
# Publish the release at HEAD: build a signed arm64 zip plus the box's
# temp-code-out-1.0.N.tar.gz (the same out/, no native parts), push them to
# the public repo's GitHub releases, and tag the source `v1.0.N`. The
# installed app (electron-updater, GitHub provider) downloads it the moment
# this script exits green when the app itself ran it (the Publish button, a
# batch's publish step: hostJobs.ts → update.ts), else on its next check:
# at launch, every 5 minutes, when a window comes forward after 15 idle
# minutes, or when the box says `release-available` over the peer link.
#
# What to publish is already decided by the local train: every green commit
# on master runs scripts/release.ts, which bumps release.json to N and
# package.json to 1.0.N and tags release-N. This script publishes whatever
# 1.0.N HEAD carries — it bumps nothing, and refuses a version the feed
# already serves.
#
# The fast path, about five minutes on the Mac: signed but NOT notarized
# (Squirrel validates an update against the installed app's designated
# requirement, so the Developer ID signature is what makes updates install;
# Gatekeeper reads a notarization ticket only on a quarantined bundle, a
# browser download, and this app is its owner's alone), a zip and no dmg,
# the publish tier of the gate running BESIDE the build, and the box's
# tarball packed from out/ and uploaded while the app is still being signed.
#   --notarize  or TEMP_CODE_NOTARIZE=1  notarize, for a release someone
#               else will download; needs the notary Keychain profile
#   --dmg       or TEMP_CODE_DMG=1       build and upload the dmg too, for
#               a fresh install (the README's download link)
#   --pack-only [dist-dir]               the box packing step alone, from
#               the out/ already built: nothing signed or uploaded
#   --dry-run                            every local phase (gate, build, sign,
#               pack, the zip's validation) with its timing, on any
#               commit; nothing pushed, no release, no upload, no feed
#   GATE_SKIP=1                          skip the gate, to retry an upload
#
# One line per phase with its duration, a fixed prefix the app's publish
# job reads (src/shared/releasePhases.ts):
#   phase › gate          the phase started
#   phase ✓ gate 71s      it passed, in that long
#   phase ✗ build 12s     it failed
#   phase – gate skipped  it was skipped
#   phase ✓ total 4m12s 1.0.283   the whole run, and the version published
#
# One-time setup this script checks for:
#   1. A "Developer ID Application" certificate in the Keychain
#      (developer.apple.com -> Certificates -> + -> Developer ID Application).
#   2. `gh auth login` with repo scope.
#   3. With --notarize: notary credentials stored as Keychain profile "aliax".
set -e
cd "$(dirname "$0")/.."
export PATH="$HOME/.bun/bin:/opt/homebrew/bin:$PATH"

NOTARIZE=${TEMP_CODE_NOTARIZE:-0}
DMG=${TEMP_CODE_DMG:-0}
DRY=0
while [ $# -gt 0 ]; do
  case $1 in
    --pack-only) exec scripts/release-pack-out.sh --dist "${2:-dist}" ;;
    --notarize) NOTARIZE=1 ;;
    --dmg) DMG=1 ;;
    --dry-run) DRY=1 ;;
    *) echo "usage: $0 [--notarize] [--dmg] [--dry-run] | --pack-only [dist-dir]" >&2; exit 2 ;;
  esac
  shift
done

REPO="LandonDev/temp-code"
PROFILE="${APPLE_KEYCHAIN_PROFILE:-aliax}"

# ── the phase lines ─────────────────────────────────────────────────────
now() { date +%s; }
fmt() { if [ "$1" -ge 60 ]; then echo "$(($1 / 60))m$(($1 % 60))s"; else echo "$1s"; fi; }
T0=$(now)
PH=
PH0=0
begin() { PH=$1; PH0=$(now); echo "phase › $1"; }
end() { echo "phase ✓ $PH $(fmt $(( $(now) - PH0 )))"; PH=; }
# A background phase prints its own two lines; its output goes to a log.
bg_phase() { # bg_phase <name> <log> <cmd...>
  bp_name=$1; bp_log=$2; shift 2
  bp0=$(now)
  echo "phase › $bp_name"
  if "$@" >"$bp_log" 2>&1; then
    echo "phase ✓ $bp_name $(fmt $(( $(now) - bp0 )))"
  else
    echo "phase ✗ $bp_name $(fmt $(( $(now) - bp0 )))"
    return 1
  fi
}

STAGE=$(mktemp -d "${TMPDIR:-/tmp}/tc-publish.XXXXXX")
DRAFTED=0
GATE_PID=
PACK_PID=
on_exit() {
  status=$1
  if [ "$status" -ne 0 ]; then
    [ -z "$PH" ] || echo "phase ✗ $PH $(fmt $(( $(now) - PH0 )))"
    for pid in $GATE_PID $PACK_PID; do pkill -P "$pid" 2>/dev/null || true; kill "$pid" 2>/dev/null || true; done
    # Drop the draft so a fixed build can run again; nothing reached the feed.
    if [ "$DRAFTED" = 1 ]; then
      gh api "repos/$REPO/releases" \
        --jq ".[] | select(.draft and .tag_name==\"v$VERSION\") | .id" 2>/dev/null |
        while read -r id; do gh api -X DELETE "repos/$REPO/releases/$id" >/dev/null; done
    fi
  fi
  rm -rf "$STAGE"
}
trap 'on_exit $?' EXIT

# ── the checks ──────────────────────────────────────────────────────────
IDENTITY=$(security find-identity -v -p codesigning | grep -o '"Developer ID Application: [^"]*"' | head -1 | tr -d '"')
[ -n "$IDENTITY" ] || {
  echo "no Developer ID Application certificate in the Keychain." >&2
  echo "developer.apple.com/account/resources/certificates/add -> Developer ID Application" >&2
  exit 1
}
# Read the team from the certificate itself. The Developer ID cert can belong to
# a different team than the Apple Development one, and a wrong --team-id makes
# notarization fail with an unhelpful error.
TEAM=$(printf '%s' "$IDENTITY" | sed -n 's/.*(\([A-Z0-9]*\))$/\1/p')
if [ "$NOTARIZE" = 1 ]; then
  xcrun notarytool history --keychain-profile "$PROFILE" >/dev/null 2>&1 || {
    echo "no notary credentials stored as profile '$PROFILE'. Create an app-specific password at" >&2
    echo "account.apple.com -> App-Specific Passwords, then run:" >&2
    echo "  xcrun notarytool store-credentials $PROFILE --apple-id <your-apple-id> --team-id $TEAM --password <app-specific-password>" >&2
    exit 1
  }
  export APPLE_KEYCHAIN_PROFILE="$PROFILE"
fi
VERSION=$(sed -n 's/^  "version": "\(1\.0\.[0-9]*\)",$/\1/p' package.json)
[ -n "$VERSION" ] || { echo "package.json version is not 1.0.N" >&2; exit 1; }
N=${VERSION#1.0.}
[ "$(sed -n 's/^  "n": \([0-9]*\),$/\1/p' release.json)" = "$N" ] || {
  echo "release.json n and package.json version disagree — let the train bump them" >&2; exit 1
}
SHA=$(git rev-parse HEAD)
if [ "$DRY" = 1 ]; then
  echo "dry run of $VERSION ($(git rev-parse --short HEAD)) signed as $IDENTITY: nothing pushed, no release, no upload"
else
  GH_TOKEN=$(gh auth token) || { echo "gh is not signed in" >&2; exit 1; }
  export GH_TOKEN

  # Release what is committed, so the tag and the artifact always match. A
  # detached worktree at master's tip counts (the train publishes from one
  # while the main checkout carries other threads' uncommitted work).
  [ -z "$(git status --porcelain)" ] || { echo "working tree is dirty — commit first" >&2; exit 1; }
  git merge-base --is-ancestor HEAD master || { echo "HEAD is not on master" >&2; exit 1; }
  if gh release view "v$VERSION" --repo "$REPO" >/dev/null 2>&1; then
    echo "v$VERSION is already published — commit something and let the train bump first" >&2
    exit 1
  fi
  echo "publishing $VERSION ($(git rev-parse --short HEAD)) signed as $IDENTITY, $([ "$NOTARIZE" = 1 ] && echo notarized || echo 'not notarized'), $([ "$DMG" = 1 ] && echo 'zip and dmg' || echo 'zip only')"

  # Push the source first: GitHub creates the v1.0.N tag at master's remote tip
  # the moment the release leaves draft, so master must already be there or the
  # tag lands on the previous commit and the final tag push is rejected.
  git tag -f "v$VERSION"
  git push -q origin master && git push -q -f origin "v$VERSION"

  # The draft release now, so the tarball can go up while the app is signed.
  # Title and notes from the commits since the last published release; the
  # auto-release commits are noise to a reader, so they stay out.
  PREV_TAG=$(git tag --list 'v1.0.*' --sort=-v:refname | sed -n 2p)
  NOTES=$(git log --no-merges --pretty='- %s' ${PREV_TAG:+$PREV_TAG..}HEAD | grep -v '^- release: ' | cut -c1-400 || true)
  [ -n "$NOTES" ] || NOTES="- TempCode $VERSION"
  gh release create "v$VERSION" --repo "$REPO" --draft --title "TempCode $VERSION" --notes "$NOTES" >/dev/null
  DRAFTED=1
fi

# ── gate, beside the build ──────────────────────────────────────────────
# The publish tier of the gate (scripts/gate.ts): the remote fence proof, the
# hub tests and the iOS packages. The commit tier already ran in the train;
# this is what it leaves to publish. It shares nothing with the build, so it
# runs beside it; its verdict is read before anything reaches the feed.
if [ -n "$GATE_SKIP" ]; then
  echo "phase – gate skipped"
else
  bg_phase gate "$STAGE/gate.log" bun run gate --tier publish &
  GATE_PID=$!
fi

# ── build ───────────────────────────────────────────────────────────────
# electron-vite into out/, then the bundle-size check. The train's gate
# typechecked this very commit, so the typecheck is not run again here.
begin build
bunx electron-vite build >"$STAGE/build.log" 2>&1 || { tail -40 "$STAGE/build.log" >&2; exit 1; }
bun scripts/check-bundle-size.ts >>"$STAGE/build.log" 2>&1 || { tail -40 "$STAGE/build.log" >&2; exit 1; }
end

# The same out/ for the box: temp-code-out-1.0.N.tar.gz and its sha256,
# which box-update v1.0.N downloads instead of cloning and building
# (scripts/release-pack-out.sh; docs/box.md "Updating"). Packed and uploaded
# to the draft while the app is signed; a red gate deletes the draft.
rm -rf dist
mkdir -p dist
pack_and_upload() {
  bg_phase pack "$STAGE/pack.log" scripts/release-pack-out.sh --dist dist --sha "$SHA" || return 1
  [ "$DRY" = 0 ] || return 0
  gh release upload "v$VERSION" --repo "$REPO" --clobber \
    "dist/temp-code-out-$VERSION.tar.gz" "dist/temp-code-out-$VERSION.tar.gz.sha256" >"$STAGE/pack-upload.log" 2>&1 ||
    { echo "the tarball upload failed:" >&2; tail -5 "$STAGE/pack-upload.log" >&2; return 1; }
}
pack_and_upload &
PACK_PID=$!

# ── sign ────────────────────────────────────────────────────────────────
# One electron-builder call packs out/ into dist/mac-arm64/TempCode.app,
# signs it and zips it (the dmg too on --dmg), writing latest-mac.yml and
# the blockmap beside the zip. One call on purpose: electron-builder writes
# Contents/Resources/app-update.yml, the feed config electron-updater reads,
# in an afterPack hook that runs only when the targets include zip or dmg
# (app-builder-lib PublishManager). A `--dir` pack followed by a
# `--prepackaged` zip signs an app without that file; 1.0.278 shipped so and
# every update check of the installed app failed with ENOENT. The zip of a
# single call holds TempCode.app at its root, as ShipIt needs. It picks the
# certificate itself and rejects the full "Developer ID Application: ..."
# string, so hand it just the name and team. The commit this build came
# from rides in the bundled package.json (tempcodeBuild.sha;
# src/main/buildInfo.ts reads it for the hello).
begin sign
TARGETS=zip
[ "$DMG" = 1 ] && TARGETS="zip dmg"
# shellcheck disable=SC2086
bunx electron-builder --mac $TARGETS --arm64 --publish never \
  -c.extraMetadata.tempcodeBuild.sha="$SHA" \
  -c.mac.identity="${IDENTITY#Developer ID Application: }" \
  -c.mac.notarize="$([ "$NOTARIZE" = 1 ] && echo true || echo false)" \
  >"$STAGE/sign.log" 2>&1 || { tail -40 "$STAGE/sign.log" >&2; exit 1; }
APP=dist/mac-arm64/TempCode.app
[ -d "$APP" ] || { echo "electron-builder left no $APP" >&2; exit 1; }
ZIP="dist/TempCode-$VERSION-arm64.zip"
[ -f "$ZIP" ] || { echo "electron-builder left no $ZIP" >&2; exit 1; }
if [ ! -f dist/latest-mac.yml ]; then
  echo "latest-mac.yml written here (electron-builder left none)"
  SHA512=$(openssl dgst -sha512 -binary "$ZIP" | base64 | tr -d '\n')
  SIZE=$(wc -c <"$ZIP" | tr -d ' ')
  printf 'version: %s\nfiles:\n  - url: %s\n    sha512: %s\n    size: %s\npath: %s\nsha512: %s\nreleaseDate: %s\n' \
    "$VERSION" "$(basename "$ZIP")" "$SHA512" "$SIZE" "$(basename "$ZIP")" "$SHA512" "'$(date -u +%Y-%m-%dT%H:%M:%S.000Z)'" \
    >dist/latest-mac.yml
fi
end

# Before anything reaches the feed: check the zip the way Squirrel's ShipIt
# will. ShipIt copies the update out of the zip and validates the copy against
# the installed app's designated requirement with
# SecStaticCodeCheckValidityWithErrors (nested code, strict, all
# architectures); the 1.0.205 install on 2026-10-10 failed exactly there.
# /Applications/TempCode.app is the reference when it is there (same
# identity, same identifier, so the same requirement), else the signed app
# the zip was made from. scripts/sqrlcheck.swift makes the same call; without
# a Swift toolchain, codesign --verify --deep --strict is the fallback.
refuse() {
  echo "REFUSING TO PUBLISH $VERSION: $1" >&2
  exit 1
}
echo "validating the zip the way ShipIt will"
ditto -x -k "$ZIP" "$STAGE/unzipped" || refuse "the zip does not extract"
[ -d "$STAGE/unzipped/TempCode.app" ] || refuse "the zip holds no TempCode.app"
# The feed config electron-updater reads at every check. Without it the
# installed app can never see another release (1.0.278); with another repo
# in it, it would update from somewhere else.
FEED_FILE="$STAGE/unzipped/TempCode.app/Contents/Resources/app-update.yml"
[ -f "$FEED_FILE" ] || refuse "the app in the zip has no Contents/Resources/app-update.yml (electron-updater's feed config)"
for want in "provider: github" "owner: LandonDev" "repo: temp-code"; do
  grep -qx "$want" "$FEED_FILE" || refuse "Contents/Resources/app-update.yml does not say '$want'"
done
echo "app-update.yml names github LandonDev/temp-code"
REFERENCE=$APP
[ -d /Applications/TempCode.app ] && REFERENCE=/Applications/TempCode.app
if swiftc -O -o "$STAGE/sqrlcheck" scripts/sqrlcheck.swift 2>"$STAGE/swiftc.log"; then
  "$STAGE/sqrlcheck" "$REFERENCE" "$STAGE/unzipped/TempCode.app" ||
    refuse "the extracted zip fails Squirrel's validation against $REFERENCE"
else
  echo "swiftc unavailable ($(head -1 "$STAGE/swiftc.log")); falling back to codesign --verify --deep --strict" >&2
  codesign --verify --deep --strict "$STAGE/unzipped/TempCode.app" ||
    refuse "the extracted zip fails codesign --verify --deep --strict"
fi
echo "zip validates"

# ── the gate's verdict, and the tarball's upload ────────────────────────
if [ -n "$GATE_PID" ]; then
  wait "$GATE_PID" || { tail -60 "$STAGE/gate.log" >&2; refuse "the publish gate is red"; }
  GATE_PID=
fi
wait "$PACK_PID" || refuse "the box tarball was not packed and uploaded"
PACK_PID=

if [ "$DRY" = 1 ]; then
  echo "phase ✓ total $(fmt $(( $(now) - T0 ))) $VERSION"
  echo "dry run of $VERSION done: dist/ holds the zip, latest-mac.yml and the box tarball; nothing left this machine"
  exit 0
fi

# ── upload ──────────────────────────────────────────────────────────────
# Only what this run made: the zip (with its blockmap when electron-builder
# wrote one), latest-mac.yml, and the dmg on --dmg. Without latest-mac.yml
# the feed exists but no app can ever see an update. The unversioned dmg
# copy gives the README a download link that never goes stale.
begin upload
set -- "$ZIP" dist/latest-mac.yml
[ -f "$ZIP.blockmap" ] && set -- "$@" "$ZIP.blockmap"
if [ "$DMG" = 1 ]; then
  cp "dist/TempCode-$VERSION-arm64.dmg" "dist/TempCode-arm64.dmg"
  set -- "$@" "dist/TempCode-$VERSION-arm64.dmg" "dist/TempCode-arm64.dmg"
  [ -f "dist/TempCode-$VERSION-arm64.dmg.blockmap" ] && set -- "$@" "dist/TempCode-$VERSION-arm64.dmg.blockmap"
fi
gh release upload "v$VERSION" --repo "$REPO" --clobber "$@" >"$STAGE/upload.log" 2>&1 ||
  { tail -10 "$STAGE/upload.log" >&2; exit 1; }
gh release edit "v$VERSION" --repo "$REPO" --draft=false >/dev/null
DRAFTED=0
end

# ── feed ────────────────────────────────────────────────────────────────
# Verify what the app will actually fetch, rather than trusting the upload.
begin feed
sleep 5
FEED_VERSION=$(curl -sL "https://github.com/$REPO/releases/latest/download/latest-mac.yml" | sed -n 's/^version: //p')
[ "$FEED_VERSION" = "$VERSION" ] || {
  echo "feed still serves '$FEED_VERSION', expected '$VERSION'" >&2
  exit 1
}
end

echo "phase ✓ total $(fmt $(( $(now) - T0 ))) $VERSION"
echo "published $VERSION — feed verified at github.com/$REPO/releases"
