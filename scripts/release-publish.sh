#!/bin/sh
# Publish the release at HEAD: build a signed + notarized arm64 zip and dmg
# plus the box's temp-code-out-1.0.N.tar.gz (the same out/, no native
# parts), push them to the public repo's GitHub releases, and tag the source
# `v1.0.N`. The installed app (electron-updater, GitHub provider) offers it
# on its next check: at launch, every 30 minutes, or when a window comes
# forward after 15 idle minutes.
#
# What to publish is already decided by the local train: every green commit
# on master runs scripts/release.ts, which bumps release.json to N and
# package.json to 1.0.N and tags release-N. This script publishes whatever
# 1.0.N HEAD carries — it bumps nothing, and refuses a version the feed
# already serves.
#
# One-time setup this script checks for:
#   1. A "Developer ID Application" certificate in the Keychain
#      (developer.apple.com -> Certificates -> + -> Developer ID Application).
#   2. Notary credentials stored as Keychain profile "aliax" — the same
#      profile Aliax's release uses; see the command it prints if missing.
#   3. `gh auth login` with repo scope.
set -e
cd "$(dirname "$0")/.."
export PATH="$HOME/.bun/bin:/opt/homebrew/bin:$PATH"

# The dry run of the box packing step alone (tar + sha256 from the `out/`
# already built, nothing signed or uploaded): --pack-only [dist-dir].
if [ "${1:-}" = --pack-only ]; then
  exec scripts/release-pack-out.sh --dist "${2:-dist}"
fi

REPO="LandonDev/temp-code"
PROFILE="${APPLE_KEYCHAIN_PROFILE:-aliax}"

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
xcrun notarytool history --keychain-profile "$PROFILE" >/dev/null 2>&1 || {
  echo "no notary credentials stored as profile '$PROFILE'. Create an app-specific password at" >&2
  echo "account.apple.com -> App-Specific Passwords, then run:" >&2
  echo "  xcrun notarytool store-credentials $PROFILE --apple-id <your-apple-id> --team-id $TEAM --password <app-specific-password>" >&2
  exit 1
}
GH_TOKEN=$(gh auth token) || { echo "gh is not signed in" >&2; exit 1; }
export GH_TOKEN
export APPLE_KEYCHAIN_PROFILE="$PROFILE"

# Release what is committed, so the tag and the artifact always match. A
# detached worktree at master's tip counts (the train publishes from one
# while the main checkout carries other threads' uncommitted work).
[ -z "$(git status --porcelain)" ] || { echo "working tree is dirty — commit first" >&2; exit 1; }
git merge-base --is-ancestor HEAD master || { echo "HEAD is not on master" >&2; exit 1; }

VERSION=$(sed -n 's/^  "version": "\(1\.0\.[0-9]*\)",$/\1/p' package.json)
[ -n "$VERSION" ] || { echo "package.json version is not 1.0.N" >&2; exit 1; }
N=${VERSION#1.0.}
[ "$(sed -n 's/^  "n": \([0-9]*\),$/\1/p' release.json)" = "$N" ] || {
  echo "release.json n and package.json version disagree — let the train bump them" >&2; exit 1
}
if gh release view "v$VERSION" --repo "$REPO" >/dev/null 2>&1; then
  echo "v$VERSION is already published — commit something and let the train bump first" >&2
  exit 1
fi
echo "publishing $VERSION signed as $IDENTITY (team $TEAM)"

# The publish tier of the gate (scripts/gate.ts): the remote fence proof, the
# hub tests and the iOS packages. The commit tier already ran in the train;
# this is what it leaves to publish, so it runs here before anything is
# signed or pushed. GATE_SKIP=1 skips it for a re-run of a failed upload.
[ -n "$GATE_SKIP" ] || bun run gate --tier publish

# Push the source first: GitHub creates the v1.0.N tag at master's remote tip
# the moment the release leaves draft, so master must already be there or the
# tag lands on the previous commit and the final tag push is rejected.
git tag -f "v$VERSION"
git push -q origin master && git push -q -f origin "v$VERSION"

bun run build
rm -rf dist
# electron-builder picks the certificate itself and rejects the full
# "Developer ID Application: ..." string, so hand it just the name and team.
# The commit this build came from rides in the bundled package.json
# (tempcodeBuild.sha; src/main/buildInfo.ts reads it for the hello).
bunx electron-builder --mac \
  -c.extraMetadata.tempcodeBuild.sha="$(git rev-parse HEAD)" \
  -c.mac.identity="${IDENTITY#Developer ID Application: }" \
  --publish always
# The same out/ for the box: temp-code-out-1.0.N.tar.gz and its sha256,
# which box-update v1.0.N downloads instead of cloning and building
# (scripts/release-pack-out.sh; docs/box.md "Updating").
scripts/release-pack-out.sh --dist dist

# Before anything reaches the feed: check the zip the way Squirrel's ShipIt
# will. ShipIt copies the update out of the zip and validates the copy against
# the installed app's designated requirement with
# SecStaticCodeCheckValidityWithErrors (nested code, strict, all
# architectures); the 1.0.205 install on 2026-10-10 failed exactly there. The
# dmg's app stands in for the installed one (same identity, same identifier,
# so the same requirement), and /Applications/TempCode.app is read as a second
# reference when it is there. scripts/sqrlcheck.swift makes the same call;
# without a Swift toolchain, codesign --verify --deep --strict is the fallback.
echo "validating the zip the way ShipIt will"
STAGE=$(mktemp -d "${TMPDIR:-/tmp}/tc-publish-check.XXXXXX")
cleanup_stage() {
  hdiutil detach "$STAGE/dmg" -quiet 2>/dev/null || true
  rm -rf "$STAGE"
}
refuse() {
  echo "REFUSING TO PUBLISH $VERSION: $1" >&2
  cleanup_stage
  # Drop the draft electron-builder opened, so a fixed build can run again.
  gh api "repos/$REPO/releases" \
    --jq ".[] | select(.draft and .tag_name==\"v$VERSION\") | .id" |
    while read -r id; do gh api -X DELETE "repos/$REPO/releases/$id" >/dev/null; done
  exit 1
}
ditto -x -k "dist/TempCode-$VERSION-arm64.zip" "$STAGE" || refuse "the zip does not extract"
[ -d "$STAGE/TempCode.app" ] || refuse "the zip holds no TempCode.app"
hdiutil attach -nobrowse -readonly -mountpoint "$STAGE/dmg" "dist/TempCode-$VERSION-arm64.dmg" >/dev/null ||
  refuse "the dmg does not mount"
if swiftc -O -o "$STAGE/sqrlcheck" scripts/sqrlcheck.swift 2>"$STAGE/swiftc.log"; then
  "$STAGE/sqrlcheck" "$STAGE/dmg/TempCode.app" "$STAGE/TempCode.app" ||
    refuse "the extracted zip fails Squirrel's validation against the dmg's app"
  if [ -d /Applications/TempCode.app ]; then
    "$STAGE/sqrlcheck" /Applications/TempCode.app "$STAGE/TempCode.app" ||
      refuse "the extracted zip fails Squirrel's validation against the installed app"
  fi
else
  echo "swiftc unavailable ($(head -1 "$STAGE/swiftc.log")); falling back to codesign --verify --deep --strict" >&2
  codesign --verify --deep --strict "$STAGE/TempCode.app" ||
    refuse "the extracted zip fails codesign --verify --deep --strict"
fi
cleanup_stage
echo "zip validates"

# electron-builder leaves the release as a draft and, in practice, uploads only
# the blockmap — so finish the job here. Without latest-mac.yml and the zip the
# feed exists but no app can ever see an update. The unversioned dmg copy gives
# the README a download link that never goes stale.
echo "uploading artifacts"
cp "dist/TempCode-$VERSION-arm64.dmg" "dist/TempCode-arm64.dmg"
gh release upload "v$VERSION" --repo "$REPO" --clobber \
  "dist/TempCode-$VERSION-arm64.zip" \
  "dist/TempCode-$VERSION-arm64.zip.blockmap" \
  "dist/TempCode-$VERSION-arm64.dmg" \
  "dist/TempCode-$VERSION-arm64.dmg.blockmap" \
  "dist/TempCode-arm64.dmg" \
  "dist/temp-code-out-$VERSION.tar.gz" \
  "dist/temp-code-out-$VERSION.tar.gz.sha256" \
  dist/latest-mac.yml

# Title and notes from the commits since the last published release; the
# auto-release commits are noise to a reader, so they stay out.
PREV_TAG=$(git tag --list 'v1.0.*' --sort=-v:refname | head -1)
NOTES=$(git log --no-merges --pretty='- %s' ${PREV_TAG:+$PREV_TAG..}HEAD | grep -v '^- release: ' | cut -c1-400 || true)
[ -n "$NOTES" ] || NOTES="- TempCode $VERSION"
gh release edit "v$VERSION" --repo "$REPO" --draft=false \
  --title "TempCode $VERSION" --notes "$NOTES" >/dev/null

# electron-builder's two publish passes leave a second, stray draft under the
# same tag; delete every draft still standing once the real release is live.
gh api "repos/$REPO/releases" \
  --jq ".[] | select(.draft and .tag_name==\"v$VERSION\") | .id" |
  while read -r id; do gh api -X DELETE "repos/$REPO/releases/$id" >/dev/null; done

# Verify what users will actually fetch, rather than trusting the upload.
sleep 5
FEED_VERSION=$(curl -sL "https://github.com/$REPO/releases/latest/download/latest-mac.yml" | sed -n 's/^version: //p')
[ "$FEED_VERSION" = "$VERSION" ] || {
  echo "feed still serves '$FEED_VERSION', expected '$VERSION'" >&2
  exit 1
}

echo "published $VERSION — feed verified at github.com/$REPO/releases"
