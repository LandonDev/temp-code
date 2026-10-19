#!/bin/bash
# The simulator proof for ios/TempCode: build the app for an iPhone simulator,
# install it, launch it with a pairing link in its environment (never a file),
# and keep a screenshot of each screen: Home, the archived list, Inbox, Search
# with results, Settings, Hosts and a thread, in light and dark, Home once more
# at an accessibility text size, and Home with the host gone (the status row)
# when TC_PROOF_KILL_CMD says how to stop the host. Screenshots land in
# $TC_PROOF_DIR (/tmp/tc-ios-proof).
#
#   TC_TEST_PAIR_LINK="https://host/pair#XXXXX-XXXXX" TC_TEST_PAIR_NAME="The box" scripts/ios-sim-proof.sh
#   TC_TEST_THREAD="part of a title" picks the thread for the thread shot (else the newest).
#   TC_TEST_SEARCH="hello" is the query the Search shot runs.
#   TC_PROOF_KILL_CMD="curl -s -X POST http://127.0.0.1:NNNN/quit" stops the host before the last shot.
#
# simctl drives it rather than XCUITest: with the Command Line Tools selected
# as the developer directory, xcodebuild's test runner cannot reach the
# simulator's service hub (ios/TempCode/UITests holds the XCUITest version
# for a Mac with an Xcode selected). Nothing here prints the link or a key.
set -euo pipefail
cd "$(dirname "$0")/../ios/TempCode"
if [ -z "${DEVELOPER_DIR:-}" ]; then
  xcode=$(ls -d /Applications/Xcode*.app 2>/dev/null | sort -V | tail -1)
  [ -n "$xcode" ] && export DEVELOPER_DIR="$xcode/Contents/Developer"
fi
SIM=${TC_SIM:-iPhone 17 Pro}
OUT=${TC_PROOF_DIR:-/tmp/tc-ios-proof}
SETTLE=${TC_PROOF_SETTLE:-10}
A11Y_SIZE=${TC_PROOF_A11Y_SIZE:-accessibility-large}
BUNDLE=dev.landon.tempcode.ios
rm -rf "$OUT"
mkdir -p "$OUT/shots"
scrub() { sed -E -e 's#pair\#[A-Za-z0-9-]+#pair\#<code>#g' -e 's#tc_[A-Za-z0-9]+\.[A-Za-z0-9_-]+#tc_<key>#g'; }

# The device: TC_SIM_UDID, else the newest runtime's "$SIM", booted and waited for.
if [ -z "${TC_SIM_UDID:-}" ]; then
  TC_SIM_UDID=$(xcrun simctl list devices -j available | python3 -c '
import json, sys
name = sys.argv[1]
devices = json.load(sys.stdin)["devices"]
found = [(rt, d["udid"]) for rt, ds in devices.items() for d in ds if d["name"] == name]
found.sort()
print(found[-1][1] if found else "")' "$SIM")
fi
[ -n "$TC_SIM_UDID" ] || { echo "ios-sim-proof: no simulator named $SIM" >&2; exit 2; }
xcrun simctl boot "$TC_SIM_UDID" 2>/dev/null || true
xcrun simctl bootstatus "$TC_SIM_UDID" -b >/dev/null
open -g -a "$DEVELOPER_DIR/Applications/Simulator.app" --args -CurrentDeviceUDID "$TC_SIM_UDID" 2>/dev/null || true

xcodegen generate --quiet
echo "ios-sim-proof: building for $SIM ($TC_SIM_UDID)"
xcodebuild build -project TempCode.xcodeproj -scheme TempCode \
  -destination "platform=iOS Simulator,id=$TC_SIM_UDID" \
  -derivedDataPath "$OUT/DerivedData" -quiet 2>&1 | scrub
APP="$OUT/DerivedData/Build/Products/Debug-iphonesimulator/TempCode.app"
[ -d "$APP" ] || { echo "ios-sim-proof: no app at $APP" >&2; exit 1; }

xcrun simctl uninstall "$TC_SIM_UDID" "$BUNDLE" >/dev/null 2>&1 || true
xcrun simctl install "$TC_SIM_UDID" "$APP"
xcrun simctl status_bar "$TC_SIM_UDID" override --time "9:41" --batteryState charged --batteryLevel 100 --cellularBars 4 --wifiBars 3 >/dev/null 2>&1 || true
restore() {
  xcrun simctl terminate "$TC_SIM_UDID" "$BUNDLE" >/dev/null 2>&1 || true
  # The key lives in the app's keychain on the simulator: remove the app so the proof leaves nothing behind.
  xcrun simctl uninstall "$TC_SIM_UDID" "$BUNDLE" >/dev/null 2>&1 || true
  xcrun simctl status_bar "$TC_SIM_UDID" clear >/dev/null 2>&1 || true
  xcrun simctl ui "$TC_SIM_UDID" appearance light >/dev/null 2>&1 || true
  xcrun simctl ui "$TC_SIM_UDID" content_size large >/dev/null 2>&1 || true
}
trap restore EXIT

# One launch per screen. The pairing happens on the first; the key then sits
# in the simulator's keychain and the app routes itself to the asked screen.
shot() {
  local route=$1 name=$2
  SIMCTL_CHILD_TC_TEST_PAIR_LINK="${TC_TEST_PAIR_LINK:-}" \
  SIMCTL_CHILD_TC_TEST_PAIR_NAME="${TC_TEST_PAIR_NAME:-}" \
  SIMCTL_CHILD_TC_TEST_ROUTE="$route" \
  SIMCTL_CHILD_TC_TEST_THREAD="${TC_TEST_THREAD:-}" \
  SIMCTL_CHILD_TC_TEST_SEARCH="${TC_TEST_SEARCH:-}" \
    xcrun simctl launch --terminate-running-process "$TC_SIM_UDID" "$BUNDLE" >/dev/null
  sleep "$SETTLE"
  xcrun simctl io "$TC_SIM_UDID" screenshot --type png "$OUT/shots/$name.png" >/dev/null 2>&1
  echo "ios-sim-proof: $name"
}
appearance() { xcrun simctl ui "$TC_SIM_UDID" appearance "$1" >/dev/null; }

appearance light
xcrun simctl ui "$TC_SIM_UDID" content_size large >/dev/null
shot home 01-home-light
shot archived 02-archived-light
shot inbox 03-inbox-light
shot search 04-search-light
shot settings 05-settings-light
shot hosts 06-hosts-light
shot thread 07-thread-light
appearance dark
shot home 08-home-dark
shot archived 09-archived-dark
shot inbox 10-inbox-dark
shot search 11-search-dark
shot settings 12-settings-dark
shot hosts 13-hosts-dark
shot thread 14-thread-dark
appearance light
xcrun simctl ui "$TC_SIM_UDID" content_size "$A11Y_SIZE" >/dev/null
shot home 15-home-a11y
xcrun simctl ui "$TC_SIM_UDID" content_size large >/dev/null
if [ -n "${TC_PROOF_KILL_CMD:-}" ]; then
  sh -c "$TC_PROOF_KILL_CMD" >/dev/null 2>&1 || true
  sleep 2
  shot home 16-home-host-gone
fi

echo "ios-sim-proof: screenshots in $OUT/shots"
ls "$OUT/shots"
