#!/bin/bash
# Build ios/TempCode for the owner's iPhone and install it (bun run ios:device).
#
#   TEMP_CODE_APPLE_TEAM=XXXXXXXXXX bun run ios:device
#   # or, once: printf 'DEVELOPMENT_TEAM = XXXXXXXXXX\n' > ios/TempCode/Local.xcconfig
#
# The team id comes from TEMP_CODE_APPLE_TEAM or the untracked
# ios/TempCode/Local.xcconfig and never from the repo. Signing is automatic
# with -allowProvisioningUpdates: xcodebuild registers the two bundle ids
# (the app with Push Notifications, its Live Activity extension) and the
# connected device, and fetches development profiles through the Apple ID
# signed in to Xcode (Xcode → Settings → Accounts; or pass an App Store
# Connect API key with TC_AUTH_KEY_PATH, TC_AUTH_KEY_ID, TC_AUTH_ISSUER_ID).
# TC_DEVICE_METHOD=ad-hoc archives a Release build and exports it with
# automatic distribution signing (Xcode makes the Apple Distribution
# certificate and the Ad Hoc profile with the phone in it): the app then
# holds a production APNs token (aps-environment production), which the
# owner's Production-only APNs key needs; a Release build has no DEBUG hooks,
# and a pairing from an earlier Debug install carries over in the keychain.
# The toolchain is the newest Xcode's through DEVELOPER_DIR; xcode-select is
# never changed. The device is TC_DEVICE_UDID, else the first connected or
# Wi-Fi-paired iPhone devicectl lists, and the build targets it so the
# profiles carry it; TC_DEVICE_SKIP_INSTALL=1 builds for the generic device
# and installs nothing. The phone needs Developer Mode on (Settings →
# Privacy & Security; `idevicedevmodectl reveal` from libimobiledevice makes
# the item appear when it is hidden).
set -euo pipefail
cd "$(dirname "$0")/../ios/TempCode"
if [ -z "${DEVELOPER_DIR:-}" ]; then
  xcode=$(ls -d /Applications/Xcode*.app 2>/dev/null | sort -V | tail -1)
  [ -n "$xcode" ] && export DEVELOPER_DIR="$xcode/Contents/Developer"
fi
TEAM=${TEMP_CODE_APPLE_TEAM:-}
if [ -z "$TEAM" ] && [ -f Local.xcconfig ]; then
  TEAM=$(sed -n -E 's/^[[:space:]]*DEVELOPMENT_TEAM[[:space:]]*=[[:space:]]*([A-Z0-9]+).*/\1/p' Local.xcconfig | head -n 1)
fi
if ! [[ "$TEAM" =~ ^[A-Z0-9]{10}$ ]]; then
  echo "ios-device: no team id. Set TEMP_CODE_APPLE_TEAM or write 'DEVELOPMENT_TEAM = <10 chars>' to ios/TempCode/Local.xcconfig (untracked)." >&2
  exit 2
fi
BUNDLE=dev.landon.tempcode.ios
DERIVED=${TC_DEVICE_DERIVED_DATA:-/tmp/tc-ios-device/DerivedData}
CONFIG=${TC_DEVICE_CONFIG:-Debug}
auth=()
if [ -n "${TC_AUTH_KEY_PATH:-}" ]; then
  auth=(-authenticationKeyPath "$TC_AUTH_KEY_PATH" -authenticationKeyID "${TC_AUTH_KEY_ID:?}" -authenticationKeyIssuerID "${TC_AUTH_ISSUER_ID:?}")
fi

# The device: TC_DEVICE_UDID, else the first iPhone devicectl lists as paired
# or reachable. Found before the build, because the build must target it:
# -allowProvisioningDeviceRegistration registers the destination device in
# the profiles, and a generic build registers nothing.
find_device() {
  [ -n "${TC_DEVICE_UDID:-}" ] && { echo "$TC_DEVICE_UDID"; return; }
  local listing
  listing=$(mktemp)
  xcrun devicectl list devices --json-output "$listing" >/dev/null 2>&1 || true
  python3 -c '
import json, sys
try:
    rows = json.load(open(sys.argv[1]))["result"]["devices"]
except Exception:
    rows = []
phones = [r for r in rows if r.get("hardwareProperties", {}).get("deviceType") == "iPhone"]
ready = [r for r in phones if "available" in r.get("connectionProperties", {}).get("tunnelState", "") or r.get("connectionProperties", {}).get("pairingState") == "paired"]
rows = ready or phones
print(rows[0]["identifier"] if rows else "")' "$listing"
  rm -f "$listing"
}
UDID=""
[ "${TC_DEVICE_SKIP_INSTALL:-}" = 1 ] || UDID=$(find_device)
if [ -n "$UDID" ]; then destination="id=$UDID"; else destination="generic/platform=iOS"; fi

xcodegen generate --quiet
if [ "${TC_DEVICE_METHOD:-}" = ad-hoc ]; then
  OUT=${TC_DEVICE_EXPORT:-/tmp/tc-ios-device/export}
  ARCHIVE=/tmp/tc-ios-device/TempCode.xcarchive
  rm -rf "$ARCHIVE" "$OUT"
  mkdir -p "$OUT"
  cat > "$OUT/exportOptions.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>method</key><string>release-testing</string>
  <key>teamID</key><string>$TEAM</string>
  <key>signingStyle</key><string>automatic</string>
  <key>destination</key><string>export</string>
  <key>thinning</key><string>&lt;none&gt;</string>
</dict></plist>
PLIST
  echo "ios-device: archiving Release for the Ad Hoc export with $(basename "$(dirname "$(dirname "$DEVELOPER_DIR")")")"
  xcodebuild archive -project TempCode.xcodeproj -scheme TempCode -configuration Release \
    -destination 'generic/platform=iOS' -archivePath "$ARCHIVE" -derivedDataPath "$DERIVED" \
    -allowProvisioningUpdates -allowProvisioningDeviceRegistration ${auth[@]+"${auth[@]}"} \
    DEVELOPMENT_TEAM="$TEAM" CODE_SIGN_STYLE=Automatic CODE_SIGN_IDENTITY="Apple Development" \
    CODE_SIGNING_REQUIRED=YES CODE_SIGNING_ALLOWED=YES AD_HOC_CODE_SIGNING_ALLOWED=NO \
    -quiet 2>&1 | sed -E "s/$TEAM/<team>/g"
  xcodebuild -exportArchive -archivePath "$ARCHIVE" -exportPath "$OUT" -exportOptionsPlist "$OUT/exportOptions.plist" \
    -allowProvisioningUpdates -allowProvisioningDeviceRegistration ${auth[@]+"${auth[@]}"} -quiet 2>&1 | sed -E "s/$TEAM/<team>/g"
  IPA="$OUT/TempCode.ipa"
  [ -f "$IPA" ] || { echo "ios-device: no ipa at $IPA" >&2; exit 1; }
  echo "ios-device: exported $IPA"
  [ "${TC_DEVICE_SKIP_INSTALL:-}" = 1 ] && exit 0
  [ -n "$UDID" ] || { echo "ios-device: no iPhone is connected or paired (plug it in or set TC_DEVICE_UDID)" >&2; exit 3; }
  xcrun devicectl device install app --device "$UDID" "$IPA"
  xcrun devicectl device process launch --device "$UDID" --terminate-existing "$BUNDLE" >/dev/null 2>&1 || true
  echo "ios-device: installed and launched $BUNDLE (Ad Hoc)"
  exit 0
fi
echo "ios-device: building $CONFIG for ${UDID:+the connected iPhone}${UDID:-the generic device} with $(basename "$(dirname "$(dirname "$DEVELOPER_DIR")")")"
xcodebuild build -project TempCode.xcodeproj -scheme TempCode -configuration "$CONFIG" \
  -destination "$destination" -derivedDataPath "$DERIVED" \
  -allowProvisioningUpdates -allowProvisioningDeviceRegistration ${auth[@]+"${auth[@]}"} \
  DEVELOPMENT_TEAM="$TEAM" CODE_SIGN_STYLE=Automatic CODE_SIGN_IDENTITY="Apple Development" \
  CODE_SIGNING_REQUIRED=YES CODE_SIGNING_ALLOWED=YES AD_HOC_CODE_SIGNING_ALLOWED=NO \
  -quiet 2>&1 | sed -E "s/$TEAM/<team>/g"
APP="$DERIVED/Build/Products/$CONFIG-iphoneos/TempCode.app"
[ -d "$APP" ] || { echo "ios-device: no app at $APP" >&2; exit 1; }
echo "ios-device: built $APP"
[ "${TC_DEVICE_SKIP_INSTALL:-}" = 1 ] && exit 0
[ -n "$UDID" ] || { echo "ios-device: no iPhone is connected or paired (plug it in or set TC_DEVICE_UDID; xcrun devicectl list devices)" >&2; exit 3; }
echo "ios-device: installing on $UDID"
xcrun devicectl device install app --device "$UDID" "$APP"
xcrun devicectl device process launch --device "$UDID" --terminate-existing "$BUNDLE" >/dev/null 2>&1 || true
echo "ios-device: installed and launched $BUNDLE"
