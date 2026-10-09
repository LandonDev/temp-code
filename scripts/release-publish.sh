#!/bin/sh
# Publish the release at HEAD: build a signed + notarized arm64 zip and dmg,
# push them to the public repo's GitHub releases, and tag the source
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

# Push the source first: GitHub creates the v1.0.N tag at master's remote tip
# the moment the release leaves draft, so master must already be there or the
# tag lands on the previous commit and the final tag push is rejected.
git tag -f "v$VERSION"
git push -q origin master && git push -q -f origin "v$VERSION"

bun run build
rm -rf dist
# electron-builder picks the certificate itself and rejects the full
# "Developer ID Application: ..." string, so hand it just the name and team.
bunx electron-builder --mac \
  -c.mac.identity="${IDENTITY#Developer ID Application: }" \
  --publish always

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
