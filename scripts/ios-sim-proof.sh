#!/bin/bash
# The simulator proof for ios/TempCode: build the app for an iPhone simulator,
# install it, launch it with a pairing link in its environment (never a file),
# and keep a screenshot of each screen. Screenshots land in $TC_PROOF_DIR
# (/tmp/tc-ios-proof).
#
#   TC_TEST_PAIR_LINK="https://host/pair#XXXXX-XXXXX" TC_TEST_PAIR_NAME="The box" scripts/ios-sim-proof.sh
#
# TC_PROOF_SET picks the shots:
#   shell   Home, the archived list, Inbox, Search with results, Settings, Hosts
#           and a thread, in light and dark, Home once more at an accessibility
#           text size, and Home with the host gone (the status row) when
#           TC_PROOF_KILL_CMD says how to stop the host.
#           TC_TEST_THREAD="part of a title" picks the thread shot (else the newest);
#           TC_TEST_SEARCH="hello" is the query the Search shot runs;
#           TC_PROOF_KILL_CMD="curl -s -X POST http://127.0.0.1:NNNN/quit" stops the host.
#   threads The threads scripts/ios-client-test-server.ts seeds, one per type:
#           every segment, a tool chip opened, the diff screen, the agent detail,
#           each in light and dark.
#   scroll  The 2,000-row chat glides top and back while frames are recorded;
#           the report is copied out as scroll-report.json.
#   box     TC_TEST_THREADS ("title part|title part|…", else TC_TEST_THREAD):
#           both segments of each named thread, light only, for a real host.
#   all     shell, threads and scroll (the default).
# TC_SIM="TempCode L3" picks a device by name (default iPhone 17 Pro); TC_SIM_UDID one by id.
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
SET=${TC_PROOF_SET:-all}
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
if xcrun simctl boot "$TC_SIM_UDID" 2>/dev/null; then
  # A cold boot: the network and keychain daemons settle a little after bootstatus answers.
  xcrun simctl bootstatus "$TC_SIM_UDID" -b >/dev/null
  sleep 8
else
  xcrun simctl bootstatus "$TC_SIM_UDID" -b >/dev/null
fi
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

# One launch per shot. The pairing happens on the first; the key then sits in
# the simulator's keychain and the app routes itself to the asked screen.
#   shot <name> <route> [thread part] [segment] [open] [settle]
shot() {
  local name=$1 route=$2 thread=${3:-${TC_TEST_THREAD:-}} segment=${4:-} open=${5:-} settle=${6:-$SETTLE}
  SIMCTL_CHILD_TC_TEST_PAIR_LINK="${TC_TEST_PAIR_LINK:-}" \
  SIMCTL_CHILD_TC_TEST_PAIR_NAME="${TC_TEST_PAIR_NAME:-}" \
  SIMCTL_CHILD_TC_TEST_ROUTE="$route" \
  SIMCTL_CHILD_TC_TEST_THREAD="$thread" \
  SIMCTL_CHILD_TC_TEST_SEARCH="${TC_TEST_SEARCH:-}" \
  SIMCTL_CHILD_TC_TEST_SEGMENT="$segment" \
  SIMCTL_CHILD_TC_TEST_OPEN="$open" \
  SIMCTL_CHILD_TC_TEST_SCROLL="${TC_SCROLL_RUN:-}" \
    xcrun simctl launch --terminate-running-process "$TC_SIM_UDID" "$BUNDLE" >/dev/null
  sleep "$settle"
  xcrun simctl io "$TC_SIM_UDID" screenshot --type png "$OUT/shots/$name.png" >/dev/null 2>&1
  echo "ios-sim-proof: $name"
}
appearance() { xcrun simctl ui "$TC_SIM_UDID" appearance "$1" >/dev/null 2>&1 || true; }

# The first launch pairs. The app logs the outcome under its subsystem (never
# the code or a key); read it back, try once more if nothing landed, and stop
# early rather than shoot a matrix of empty screens.
pairing_log() {
  xcrun simctl spawn "$TC_SIM_UDID" log show --last 3m \
    --predicate 'subsystem == "dev.landon.tempcode" AND category == "pairing"' --style compact 2>/dev/null | scrub
}
pair() {
  local attempt
  for attempt in 1 2; do
    shot 00-pairing home >/dev/null
    if pairing_log | /usr/bin/grep -q "pairing done"; then return 0; fi
    if pairing_log | /usr/bin/grep -q "pairing failed"; then
      echo "ios-sim-proof: $(pairing_log | /usr/bin/grep 'pairing failed' | tail -n 1 | sed -E 's/^.*\] //')" >&2
      return 3
    fi
    echo "ios-sim-proof: no pairing outcome after launch $attempt" >&2
  done
  return 3
}
if [ -n "${TC_TEST_PAIR_LINK:-}" ]; then
  pair || { echo "ios-sim-proof: the app did not pair" >&2; exit 3; }
  rm -f "$OUT/shots/00-pairing.png"
fi

shell_set() {
  appearance light
  xcrun simctl ui "$TC_SIM_UDID" content_size large >/dev/null
  shot 01-home-light home
  shot 02-archived-light archived
  shot 03-inbox-light inbox
  shot 04-search-light search
  shot 05-settings-light settings
  shot 06-hosts-light hosts
  shot 07-thread-light thread
  appearance dark
  shot 08-home-dark home
  shot 09-archived-dark archived
  shot 10-inbox-dark inbox
  shot 11-search-dark search
  shot 12-settings-dark settings
  shot 13-hosts-dark hosts
  shot 14-thread-dark thread
  appearance light
  xcrun simctl ui "$TC_SIM_UDID" content_size "$A11Y_SIZE" >/dev/null
  shot 15-home-a11y home
  xcrun simctl ui "$TC_SIM_UDID" content_size large >/dev/null
}

# Home with the host gone: the kill ends the server, so this shot comes last.
host_gone_set() {
  if [ -n "${TC_PROOF_KILL_CMD:-}" ]; then
    appearance light
    sh -c "$TC_PROOF_KILL_CMD" >/dev/null 2>&1 || true
    sleep 2
    shot 16-home-host-gone home
  fi
}

threads_set() {
  for mode in light dark; do
    appearance "$mode"
    shot "impl-board-$mode" thread "dark mode" board
    shot "impl-chat-$mode" thread "dark mode" chat
    shot "impl-diff-$mode" thread "dark mode" board diff
    shot "plan-plan-$mode" thread "history onto the box" plan
    shot "plan-chat-$mode" thread "history onto the box" chat
    shot "orch-fleet-$mode" thread "thread screens" fleet
    shot "orch-log-$mode" thread "thread screens" log
    shot "orch-agent-$mode" thread "thread screens" fleet agent
    shot "research-sources-$mode" thread "SQLite on the phone" sources
    shot "research-chat-$mode" thread "SQLite on the phone" chat
    shot "chat-$mode" thread "gateway refuse"
    shot "chat-chip-$mode" thread "gateway refuse" "" chip
  done
  appearance light
}

scroll_set() {
  appearance light
  TC_SCROLL_RUN=1 shot "long-scrolled" thread "2,000 rows" "" "" 58
  container=$(xcrun simctl get_app_container "$TC_SIM_UDID" "$BUNDLE" data 2>/dev/null || true)
  if [ -n "$container" ] && [ -f "$container/Documents/scroll-report.json" ]; then
    cp "$container/Documents/scroll-report.json" "$OUT/scroll-report.json"
    echo "ios-sim-proof: scroll report $(cat "$OUT/scroll-report.json")"
  else
    echo "ios-sim-proof: no scroll report" >&2
  fi
}

box_set() {
  appearance light
  IFS='|' read -r -a names <<< "${TC_TEST_THREADS:-${TC_TEST_THREAD:-}}"
  n=0
  for part in "${names[@]}"; do
    n=$((n + 1))
    shot "box-$n-home" home "$part"
    shot "box-$n-a" thread "$part"
    shot "box-$n-b" thread "$part" chat
  done
}

case "$SET" in
  shell) shell_set; host_gone_set ;;
  threads) threads_set ;;
  scroll) scroll_set ;;
  box) box_set ;;
  all) shell_set; threads_set; scroll_set; host_gone_set ;;
  *) echo "ios-sim-proof: unknown TC_PROOF_SET $SET" >&2; exit 2 ;;
esac

echo "ios-sim-proof: screenshots in $OUT/shots"
ls "$OUT/shots"
