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
#           TC_TEST_SEARCH_SCOPE=files opens the Search tab on the Files scope;
#           TC_PROOF_KILL_CMD="curl -s -X POST http://127.0.0.1:NNNN/quit" stops the host.
#   threads The threads scripts/ios-client-test-server.ts seeds, one per type:
#           every segment, a tool chip opened, the diff screen, the agent detail,
#           each in light and dark.
#   scroll  The 2,000-row chat glides top and back while frames are recorded;
#           the report is copied out as scroll-report.json.
#   box     TC_TEST_THREADS ("title part|title part|…", else TC_TEST_THREAD):
#           both segments of each named thread, light only, for a real host.
#   actions The steering shots: a read key's disabled composer and card, then
#           the app re-paired with TC_TEST_PAIR_LINK_OPERATE (a key that may act):
#           a send landing as the user row, Stop mid-turn, approve and deny,
#           a question answered, Start from the plan into a build, a new chat
#           from the workspace, a message to an agent, pin, archive and rename;
#           the key shots in dark too. TC_TEST_CONTROL_URL is the test server's
#           control panel; the set reads back what landed.
#   f4      Old and missing search hits, full board history, then the scroll budget.
#   settings Settings, Hosts, a host's detail (TC_TEST_OPEN=host) and the pairing
#           sheet (TC_TEST_SHEET=pair, and pair-error for a refused code), light
#           and dark, then Settings and the detail at the accessibility size.
#   host-extras The host detail's Activity sections (iOS 21): first with the
#           read key (every reason in the footers, no deploy row live), then
#           the app re-paired with TC_TEST_PAIR_LINK_ADMIN: Build with the
#           finished deploy's row, Devices with the fixture Mac's booted
#           simulator and paired iPhone, Sync with the never-synced peer, light
#           and dark; the deploy log sheet (TC_TEST_SHEET=deploy-log) light and
#           dark; the detail at the accessibility size. The Mac bridge section
#           needs a paired Mac serving the host, so a single test server has none.
#   diff    The diff screen: the small edit of the dark-mode thread and the
#           3,600-line edit of the gateway-router thread, light and dark, then
#           the big one at the accessibility size.
#   page    An agent's html_render page: inline in the chat that published it
#           (the test server's "Why is the build slow?") and pushed full screen
#           (TC_TEST_OPEN=page), light and dark.
#   push    A notification tap (L6): a payload shaped like the hub's, routed
#           through the delegate at launch, lands on the named thread's row;
#           the navigation report proves the seq; Settings shows the row.
#   features The screens the 2026-10-22 batch added (master board and rules,
#           project plan, notices, failures, preamble, handoff, streaming, notes,
#           the account menu, resources, queued, stopped, the gate row, the
#           fleet confirm), light and dark, the busiest at the accessibility size;
#           then, with TC_TEST_PAIR_LINK_SECOND (the test server's second host),
#           both hosts paired: Home's one row for the linked project with both
#           hosts' threads and their glyphs, and Thread A with its host chip.
#   glass   The chrome the Liquid Glass pass touched: a chat thread with the
#           keyboard down (read key) and up (re-paired with the acting key,
#           TC_TEST_OPEN=composer), a running, a paused, a queued and a stopped thread,
#           Home, Search, Hosts, an implementation board, a master's board,
#           the subagent list and the New thread sheet, light and dark, then
#           the chat and Home at the accessibility size. The bottom dock's
#           height lands in dock-*.json (tenths of a point).
#   return  A thread's transcript always comes back at its bottom: the
#           2,000-row thread opened on a middle row (TC_TEST_TARGET_SEQ), the
#           app sent to the background (Settings comes forward) for 5 s and
#           for 60 s and brought back, then killed and cold-launched plainly
#           so it restores that thread from its saved stack. Each step's
#           transcript-report.json (atBottom) lands in return-*.json.
#   duo     The iPhone Duo in every pose (docs/IOS-DESIGN.md "iPhone Duo"): for
#           folded, unfolded, unfolded-portrait and folded-landscape, light Home,
#           the thread (TC_TEST_THREAD, chat), Inbox, Search and Settings, dark
#           Home and the thread, then what plans 1-3 add in duo_shots_shell,
#           duo_shots_thread and duo_shots_sheets; half-open: the thread; then
#           duo_fold_cycle (one launch of the 2,000-row chat folded and unfolded
#           twice with the app running, four shots, a .mov of the unfold, the
#           layout events asserted). Every shot's layout report must match the
#           pose's row (pose_check); the set fails on the first that does not.
#   all     shell, threads, scroll, actions and push (the default).
# TC_SIM="TempCode L3" picks a device by name (default iPhone 17 Pro); TC_SIM_UDID one by id.
# TC_DUO_POSE=<pose> is the iPhone Duo axis for ANY set: the device defaults to
# "TempCode Duo" (bun run ios:duo:check -- --create makes it; the proof never
# does), the check runs first, the simulator is put in that pose before the
# first shot (folded|fp, folded-landscape|fl, unfolded|ul, unfolded-portrait|up,
# half-open|ho; scripts/ios-duo-pose.sh), every shot captures the LIT panel
# (`simctl io … --display=`: the default capture is the dark inner panel when
# folded, a valid black PNG), shots land in $OUT/shots/<pose>/, each shot's
# layout-report.json in $OUT/layout/<pose>/<name>.json, and pose_check holds
# the report and the PNG to the pose's row. `fold <pose>` inside a set moves
# the device with the app running. scripts/ios-sim-proof-local.ts passes the
# environment through unchanged, so `TC_DUO_POSE=unfolded TC_PROOF_SET=features
# bun scripts/ios-sim-proof-local.ts` is the whole invocation.
#
# simctl drives it rather than XCUITest: with the Command Line Tools selected
# as the developer directory, xcodebuild's test runner cannot reach the
# simulator's service hub (ios/TempCode/UITests holds the XCUITest version
# for a Mac with an Xcode selected). Nothing here prints the link or a key.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
cd "$here/../ios/TempCode"
# The Xcode: scripts/ios-xcode.sh (DEVELOPER_DIR passes through; else the highest-versioned bundle, 27.1 at least).
DEVELOPER_DIR=$("$here/ios-xcode.sh")
export DEVELOPER_DIR
# The iPhone Duo axis (TC_DUO_POSE): the Duo simulator, the prerequisite check, the pose table.
POSE=""; LIT=""
duo_canonical() {
  case "$1" in
    folded|fp) echo folded ;; folded-landscape|fl) echo folded-landscape ;;
    unfolded|ul) echo unfolded ;; unfolded-portrait|up) echo unfolded-portrait ;;
    half-open|ho) echo half-open ;; *) return 1 ;;
  esac
}
# The duo set is the axis itself: it starts unfolded unless told otherwise.
[ "${TC_PROOF_SET:-all}" = duo ] && TC_DUO_POSE=${TC_DUO_POSE:-unfolded}
if [ -n "${TC_DUO_POSE:-}" ]; then
  POSE=$(duo_canonical "$TC_DUO_POSE") || { echo "ios-sim-proof: unknown TC_DUO_POSE $TC_DUO_POSE (folded|fp, folded-landscape|fl, unfolded|ul, unfolded-portrait|up, half-open|ho)" >&2; exit 2; }
  "$here/ios-duo-check.sh" || { echo "ios-sim-proof: the Duo check failed; fix the MISSING lines above" >&2; exit 2; }
fi
SIM=${TC_SIM:-${POSE:+TempCode Duo}}
SIM=${SIM:-iPhone 17 Pro}
OUT=${TC_PROOF_DIR:-/tmp/tc-ios-proof}
SETTLE=${TC_PROOF_SETTLE:-10}
A11Y_SIZE=${TC_PROOF_A11Y_SIZE:-accessibility-large}
SET=${TC_PROOF_SET:-all}
DERIVED=${TC_PROOF_DERIVED_DATA:-$OUT/DerivedData}
BUNDLE=dev.landon.tempcode.ios
mkdir -p "$OUT"
# Rebuild incrementally, but never carry a report or screenshot into a new pass.
rm -rf "$OUT/shots" "$OUT/layout" "$OUT"/*.mov
rm -f "$OUT"/*.json "$OUT/scroll-sample.txt"
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
  -derivedDataPath "$DERIVED" -quiet 2>&1 | scrub
APP="$DERIVED/Build/Products/Debug-iphonesimulator/TempCode.app"
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

# The Duo axis. `fold <pose>` puts the simulator in a pose (before a launch or
# with the app running) and remembers the pose and its lit panel; `snap <name>`
# captures the lit panel and the app's layout report without a launch and
# checks both against the pose's row; `duo_shot` is `shot` under the axis, the
# one helper plans 1-3 add lines to (the directory is the pose, so one name in
# two poses never collides).
# A pose that never settles is the guest's panel switch stuck (scripts/ios-duo-pose.sh's
# header): between shots `fold` reboots the simulator once and tries again; with the app
# running (`fold <pose> live`, the fold cycle) a reboot would void the run, so it fails.
fold() {
  POSE=$(duo_canonical "$1") || { echo "ios-sim-proof: unknown pose $1" >&2; exit 2; }
  if ! LIT=$("$here/ios-duo-pose.sh" "$TC_SIM_UDID" "$POSE"); then
    [ "${2:-}" = live ] && { echo "ios-sim-proof: $POSE did not settle with the app running" >&2; exit 1; }
    echo "ios-sim-proof: $POSE did not settle; rebooting the simulator once" >&2
    xcrun simctl shutdown "$TC_SIM_UDID" >/dev/null 2>&1 || true
    xcrun simctl boot "$TC_SIM_UDID" && xcrun simctl bootstatus "$TC_SIM_UDID" -b >/dev/null
    sleep 8
    xcrun simctl status_bar "$TC_SIM_UDID" override --time "9:41" --batteryState charged --batteryLevel 100 --cellularBars 4 --wifiBars 3 >/dev/null 2>&1 || true
    LIT=$("$here/ios-duo-pose.sh" "$TC_SIM_UDID" "$POSE")
  fi
  echo "ios-sim-proof: fold $POSE ($LIT lit)"
}
# The report's window, size classes and classified pose must be the row for $POSE, and the
# PNG the window times the scale (± 1 px: the inner panel's one-pixel axis difference).
pose_check() {
  local png=$1 report=$2 label=$3
  python3 - "$png" "$report" "$POSE" "$label" <<'CHECK'
import json, struct, sys
png, report, pose, label = sys.argv[1:5]
rows = {
    'folded': (466, 678, 'compact', 'regular'),
    'folded-landscape': (678, 466, 'compact', 'compact'),
    'unfolded': (951, 669, 'regular', 'regular'),
    'unfolded-portrait': (669, 951, 'regular', 'regular'),
    'half-open': (951, 669, 'regular', 'regular'),
}
w, h, hs, vs = rows[pose]
try:
    r = json.load(open(report))
except Exception as e:
    print(f'ios-sim-proof: {pose}/{label}: no layout report ({e})', file=sys.stderr); sys.exit(1)
with open(png, 'rb') as f:
    f.seek(16); pw, ph = struct.unpack('>II', f.read(8))
got = (r.get('window', {}).get('w'), r.get('window', {}).get('h'), r.get('hSize'), r.get('vSize'))
ok = got == (w, h, hs, vs) and r.get('classified') == pose and abs(pw - w * 3) <= 1 and abs(ph - h * 3) <= 1
line = f"{pose}/{label} {got[0]}×{got[1]} {got[2]}×{got[3]} png {pw}×{ph} classified {r.get('classified')} hinge {(r.get('hinge') or {}).get('state')}"
if not ok:
    print(f'ios-sim-proof: POSE MISMATCH {line}', file=sys.stderr)
    print(f'ios-sim-proof: expected {pose} {w}×{h} {hs}×{vs} png {w*3}×{h*3}', file=sys.stderr)
    print(json.dumps(r, indent=1, sort_keys=True), file=sys.stderr)
    sys.exit(1)
print(f'ios-sim-proof: {line} ok')
CHECK
}
# A capture with no launch: the shot and the report go under the pose's directories.
snap() {
  local name=$1
  if [ -n "$POSE" ]; then
    mkdir -p "$OUT/shots/$POSE" "$OUT/layout/$POSE"
    xcrun simctl io "$TC_SIM_UDID" screenshot --display="$LIT" --type png "$OUT/shots/$POSE/$name.png" >/dev/null 2>&1
    local container
    container=$(xcrun simctl get_app_container "$TC_SIM_UDID" "$BUNDLE" data 2>/dev/null || true)
    [ -n "$container" ] && cp "$container/Documents/layout-report.json" "$OUT/layout/$POSE/$name.json" 2>/dev/null || true
    pose_check "$OUT/shots/$POSE/$name.png" "$OUT/layout/$POSE/$name.json" "$name"
  else
    xcrun simctl io "$TC_SIM_UDID" screenshot --type png "$OUT/shots/$name.png" >/dev/null 2>&1
    echo "ios-sim-proof: $name"
  fi
}
duo_shot() { shot "$@"; }

# One launch per shot. The pairing happens on the first; the key then sits in
# the simulator's keychain and the app routes itself to the asked screen.
#   shot <name> <route> [thread part] [segment] [open] [settle]
shot() {
  local name=$1 route=$2 thread=${3:-${TC_TEST_THREAD:-}} segment=${4:-} open=${5:-} settle=${6:-$SETTLE}
  SIMCTL_CHILD_TC_DUO_POSE="$POSE" \
  SIMCTL_CHILD_TC_TEST_PAIR_LINK="${TC_TEST_PAIR_LINK:-}" \
  SIMCTL_CHILD_TC_TEST_PAIR_NAME="${TC_TEST_PAIR_NAME:-}" \
  SIMCTL_CHILD_TC_TEST_PAIR_LINK_SECOND="${TC_PAIR_SECOND:-}" \
  SIMCTL_CHILD_TC_TEST_PAIR_NAME_SECOND="${TC_PAIR_SECOND:+Second test host}" \
  SIMCTL_CHILD_TC_TEST_HOME_SCROLL="${TC_HOME_SCROLL:-}" \
  SIMCTL_CHILD_TC_TEST_ROUTE="$route" \
  SIMCTL_CHILD_TC_TEST_THREAD="$thread" \
  SIMCTL_CHILD_TC_TEST_SEARCH="${TC_TEST_SEARCH:-}" \
  SIMCTL_CHILD_TC_TEST_SEARCH_SCOPE="${TC_TEST_SEARCH_SCOPE:-}" \
  SIMCTL_CHILD_TC_TEST_SEGMENT="$segment" \
  SIMCTL_CHILD_TC_TEST_OPEN="$open" \
  SIMCTL_CHILD_TC_TEST_TARGET_SEQ="${TC_TARGET_SEQ:-}" \
  SIMCTL_CHILD_TC_TEST_HISTORY="${TC_HISTORY_RUN:-}" \
  SIMCTL_CHILD_TC_TEST_SCROLL="${TC_SCROLL_RUN:-}" \
  SIMCTL_CHILD_TC_TEST_ACTION="${TC_ACTION:-}" \
  SIMCTL_CHILD_TC_TEST_SHEET="${TC_SHEET:-}" \
  SIMCTL_CHILD_TC_TEST_NOTIFICATION="${TC_NOTIFY:-}" \
    xcrun simctl launch --terminate-running-process "$TC_SIM_UDID" "$BUNDLE" >/dev/null
  if [ "${TC_PROOF_PROFILE:-}" = 1 ] && [ "$name" = long-scrolled ]; then
    proof_pid=$(pgrep -f "/CoreSimulator/Devices/$TC_SIM_UDID/data/Containers/Bundle/Application/.*/TempCode.app/TempCode" | head -1)
    if [ -n "$proof_pid" ]; then
      sample "$proof_pid" 56 1 -mayDie -file "$OUT/scroll-sample.txt" >/dev/null 2>&1 &
    fi
  fi
  sleep "$settle"
  snap "$name"
}
appearance() { xcrun simctl ui "$TC_SIM_UDID" appearance "$1" >/dev/null 2>&1 || true; }

# Under the Duo axis the device takes the asked pose before the first launch.
[ -n "$POSE" ] && fold "$POSE"

# The first launch pairs. The app logs the outcome under its subsystem (never
# the code or a key); read it back, try once more if nothing landed, and stop
# early rather than shoot a matrix of empty screens.
PAIR_SINCE=$(date '+%Y-%m-%d %H:%M:%S')
pairing_log() {
  xcrun simctl spawn "$TC_SIM_UDID" log show --start "$PAIR_SINCE" \
    --predicate 'subsystem == "dev.landon.tempcode" AND category == "pairing"' --style compact 2>/dev/null | scrub
}
pair() {
  local attempt
  PAIR_SINCE=$(date '+%Y-%m-%d %H:%M:%S')
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
  rm -f "$OUT/shots/00-pairing.png" "$OUT/shots/$POSE/00-pairing.png" "$OUT/layout/$POSE/00-pairing.json"
fi

shell_set() {
  appearance light
  xcrun simctl ui "$TC_SIM_UDID" content_size large >/dev/null
  shot 01-home-light home
  shot 02-archived-light archived
  shot 03-inbox-light inbox
  shot 03b-inbox-item-light inbox "" "" item
  shot 03c-inbox-diff-light inbox "" "" item-diff
  shot 04-search-light search
  shot 05-settings-light settings
  shot 06-hosts-light hosts
  shot 07-thread-light thread
  appearance dark
  shot 08-home-dark home
  shot 09-archived-dark archived
  shot 10-inbox-dark inbox
  shot 10b-inbox-item-dark inbox "" "" item
  shot 10c-inbox-diff-dark inbox "" "" item-diff
  shot 11-search-dark search
  shot 12-settings-dark settings
  shot 13-hosts-dark hosts
  shot 14-thread-dark thread
  appearance light
  xcrun simctl ui "$TC_SIM_UDID" content_size "$A11Y_SIZE" >/dev/null
  shot 15-home-a11y home
  shot 15b-inbox-a11y inbox
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
  TC_SCROLL_RUN=1 shot "long-scrolled" thread "2,000 rows" "" "" 62
  container=$(xcrun simctl get_app_container "$TC_SIM_UDID" "$BUNDLE" data 2>/dev/null || true)
  if [ -n "$container" ] && [ -f "$container/Documents/scroll-report.json" ]; then
    cp "$container/Documents/scroll-report.json" "$OUT/scroll-report.json"
    echo "ios-sim-proof: scroll report $(cat "$OUT/scroll-report.json")"
  else
    echo "ios-sim-proof: no scroll report" >&2
  fi
}

# Exact old-row navigation and complete boards, read back from DEBUG reports.
f4_set() {
  appearance light
  TC_TARGET_SEQ=41 shot "search-old-hit" thread "2,000 rows" chat
  container=$(xcrun simctl get_app_container "$TC_SIM_UDID" "$BUNDLE" data)
  cp "$container/Documents/navigation-report.json" "$OUT/navigation-found.json"
  TC_TARGET_SEQ=1 shot "search-board-hit" thread "dark mode"
  cp "$container/Documents/navigation-report.json" "$OUT/navigation-board.json"
  TC_TARGET_SEQ=0 shot "search-missing-hit" thread "2,000 rows" chat
  cp "$container/Documents/navigation-report.json" "$OUT/navigation-missing.json"
  rm -f "$container/Documents/board-history-report.json"
  TC_HISTORY_RUN=1 shot "history-implementation" thread "dark mode" board
  cp "$container/Documents/board-history-report.json" "$OUT/history-implementation.json"
  rm -f "$container/Documents/board-history-report.json"
  TC_HISTORY_RUN=1 shot "history-research" thread "SQLite on the phone" sources
  cp "$container/Documents/board-history-report.json" "$OUT/history-research.json"
  python3 - "$OUT" <<'CHECK'
import json, pathlib, sys
out = pathlib.Path(sys.argv[1])
found = json.loads((out / 'navigation-found.json').read_text())
missing = json.loads((out / 'navigation-missing.json').read_text())
board = json.loads((out / 'navigation-board.json').read_text())
impl = json.loads((out / 'history-implementation.json').read_text())
research = json.loads((out / 'history-research.json').read_text())
assert found['target'] == found['item'] == 41 and found['oldest'] <= 41, found
assert board['target'] == board['item'] == 1 and board['oldest'] == 1, board
assert missing['target'] == 0 and missing['item'] == -1, missing
assert impl['complete'] == 1 and impl['oldest'] == 1 and impl['rounds'] >= 1 and impl['todos'] >= 2, impl
assert research['complete'] == 1 and research['oldest'] == 1 and research['sources'] >= 4, research
print('ios-sim-proof: old and missing search hits and both complete boards PASS')
CHECK
  scroll_set
  python3 - "$OUT/scroll-report.json" <<'CHECK'
import json, sys
r = json.load(open(sys.argv[1]))
assert r['sourceRows'] >= 2000 and r['items'] >= 1500, r
assert r['initialOffset'] >= r['travelPt'] * 0.9, r
assert r['frames'] > 1000 and r['travelPt'] > 1000 and r['scrollFrames'] > 2000, r
assert r['hitches'] == 0 and r['worstMs'] < r['expectedMs'] + 8, r
print('ios-sim-proof: scroll budget PASS')
CHECK
}

f4_ui_set() {
  appearance light
  shot "cold-tail" thread "2,000 rows"
  shot "chat-chip" thread "gateway refuse" "" chip
  shot "impl-diff" thread "dark mode" board diff
  shot "agent-detail" thread "thread screens" fleet agent
  appearance dark
  shot "cold-tail-dark" thread "2,000 rows"
  appearance light
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

# The steering shots. Each launch performs one action through the same calls
# the buttons make (TC_TEST_ACTION), or opens a sheet (TC_TEST_SHEET); the
# screen is read back off the simulator and the control panel says what landed.
control() { curl -s -X POST "$TC_TEST_CONTROL_URL$1" -H 'Content-Type: application/json' -d "${2:-{\}}"; }
actions_set() {
  [ -n "${TC_TEST_PAIR_LINK_OPERATE:-}" ] && [ -n "${TC_TEST_CONTROL_URL:-}" ] || { echo "ios-sim-proof: the actions set needs TC_TEST_PAIR_LINK_OPERATE and TC_TEST_CONTROL_URL" >&2; return 2; }
  appearance light
  # The read key first: nothing hidden, everything disabled with the reason.
  shot "ro-composer-light" thread "gateway refuse"
  shot "ro-approval-light" thread "Run the test suite"
  appearance dark
  shot "ro-composer-dark" thread "gateway refuse"
  appearance light
  # Then a key that may act: the app starts over and pairs again.
  xcrun simctl terminate "$TC_SIM_UDID" "$BUNDLE" >/dev/null 2>&1 || true
  xcrun simctl uninstall "$TC_SIM_UDID" "$BUNDLE" >/dev/null 2>&1 || true
  xcrun simctl install "$TC_SIM_UDID" "$APP"
  TC_TEST_PAIR_LINK="$TC_TEST_PAIR_LINK_OPERATE" TC_TEST_PAIR_NAME="${TC_TEST_PAIR_NAME:-} (acting)" pair || { echo "ios-sim-proof: the app did not pair with the acting key" >&2; return 3; }
  rm -f "$OUT/shots/00-pairing.png"
  control /actions/clear >/dev/null
  TC_ACTION="send:Hello from the phone" shot "act-send-light" thread "Thread B"
  TC_ACTION="stop" shot "act-stop-light" thread "Thread B"
  TC_ACTION="approve" shot "act-approve-light" thread "Run the test suite"
  control /ask '{"sessionId":"ios-waiting","kind":"approval"}' >/dev/null
  TC_ACTION="deny" shot "act-deny-light" thread "Run the test suite"
  TC_ACTION="answer:Half up" shot "act-answer-light" thread "Fix the invoice totals"
  control /ask '{"sessionId":"ios-question","kind":"question"}' >/dev/null
  shot "act-question-open-light" thread "Fix the invoice totals"
  TC_SHEET="start" shot "act-start-sheet-light" thread "history onto the box"
  TC_ACTION="start-build" shot "act-start-light" thread "history onto the box" "" "" 20
  TC_SHEET="new" shot "act-new-sheet-light" home
  TC_ACTION="new-chat" shot "act-new-chat-light" home "" "" "" 20
  TC_ACTION="send:Check the tests too" shot "act-agent-light" thread "thread screens" fleet agent
  TC_ACTION="pin" shot "act-pin-thread-light" thread "gateway refuse"
  shot "act-pin-home-light" home
  TC_ACTION="rename:Renamed from the phone" shot "act-rename-light" thread "gateway refuse"
  TC_ACTION="archive" shot "act-archive-thread-light" thread "Renamed from the phone"
  shot "act-archive-home-light" home
  shot "act-archived-list-light" archived
  appearance dark
  TC_ACTION="send:And in the dark" shot "act-send-dark" thread "Thread B"
  control /ask '{"sessionId":"ios-waiting","kind":"approval"}' >/dev/null
  shot "act-approval-dark" thread "Run the test suite"
  TC_SHEET="start" shot "act-start-sheet-dark" thread "history onto the box"
  TC_SHEET="new" shot "act-new-sheet-dark" home
  appearance light
  # What landed, by kind: the proof's own check of every action above.
  python3 - "$(control /actions)" <<'PY'
import json, sys
kinds = [a["kind"] for a in json.loads(sys.argv[1])["actions"]]
want = {"send": 4, "stop": 1, "approve": 2, "answer": 1, "create": 2, "pin": 1, "rename": 1, "archive": 1}
counts = {k: kinds.count(k) for k in want}
missing = {k: v for k, v in want.items() if counts[k] < v}
print("ios-sim-proof: actions landed " + json.dumps(counts))
if missing:
    print("ios-sim-proof: MISSING " + json.dumps(missing), file=sys.stderr)
    sys.exit(4)
PY
}

# A notification tap lands on the card: the launch feeds the delegate a
# hub-shaped payload for the named thread and row, the transcript's
# navigation report says which row it opened on.
push_set() {
  appearance light
  container=$(xcrun simctl get_app_container "$TC_SIM_UDID" "$BUNDLE" data)
  rm -f "$container/Documents/navigation-report.json"
  TC_NOTIFY="2,000 rows|41" shot "push-tap-old-row" notification "" "" "" 14
  cp "$container/Documents/navigation-report.json" "$OUT/push-navigation.json"
  rm -f "$container/Documents/navigation-report.json"
  TC_NOTIFY="Run the test suite|0" shot "push-tap-approval" notification "" "" "" 14
  cp "$container/Documents/navigation-report.json" "$OUT/push-navigation-approval.json" 2>/dev/null || echo '{}' > "$OUT/push-navigation-approval.json"
  shot "push-settings-row" settings
  # A real delivery through the notification centre's delegate while the app
  # is in the foreground (simctl push): the delegate must answer on the main
  # thread, else UIKit aborts the app; the process is still there afterwards.
  shot "push-foreground-before" home
  printf '{"aps":{"alert":{"title":"L6 proof","body":"Permission: Bash"},"sound":"default"},"tc":{"event":"needs_you","hostId":"box","environmentId":"env_proof","threadId":"nope","seq":1,"ts":1}}' > "$OUT/push-payload.json"
  # simctl can push only to an app the person has allowed notifications for;
  # nothing scripts that tap, so a fresh simulator skips this step and the
  # delegate's real path is the phone's (the owner's tap). A simulator that
  # was allowed once (TC_PROOF_PUSH=1 to insist) runs it.
  if pushed=$(xcrun simctl push "$TC_SIM_UDID" "$BUNDLE" "$OUT/push-payload.json" 2>&1); then
    sleep 3
    xcrun simctl io "$TC_SIM_UDID" screenshot --type png "$OUT/shots/push-foreground-after.png" >/dev/null 2>&1
    if pgrep -f "/CoreSimulator/Devices/$TC_SIM_UDID/data/Containers/Bundle/Application/.*/TempCode.app/TempCode" >/dev/null; then
      echo "ios-sim-proof: foreground delivery through the delegate kept the app alive PASS"
    else
      echo "ios-sim-proof: the app died on a foreground delivery" >&2
      exit 4
    fi
  elif echo "$pushed" | /usr/bin/grep -q "not authorized" && [ "${TC_PROOF_PUSH:-}" != 1 ]; then
    echo "ios-sim-proof: foreground delivery skipped (the simulator has not allowed notifications)"
  else
    echo "ios-sim-proof: simctl push failed: $pushed" >&2
    exit 4
  fi
  python3 - "$OUT" <<'CHECK'
import json, pathlib, sys
out = pathlib.Path(sys.argv[1])
old = json.loads((out / 'push-navigation.json').read_text())
assert old['target'] == old['item'] == 41 and old['oldest'] <= 41, old
print('ios-sim-proof: notification tap landed on row 41 PASS')
CHECK
}

# The live steering pass against a real host (scripts/ios-sim-proof-box.ts
# mints the pairings and the threads): one cheap real turn sent from the
# phone and its reply, then the app re-paired with a key that may approve,
# a turn that asks for a tool, the approval decided, and the tool's result.
box_actions_set() {
  appearance light
  # Over a real tunnel the thread takes a few seconds to load and go live; the action fires only then.
  TC_ACTION="send:Reply with exactly one word: pong" shot "box-act-send" thread "${TC_BOX_THREAD:-L5 phone pass}" "" "" "${TC_BOX_ACT_WAIT:-25}"
  shot "box-act-reply" thread "${TC_BOX_THREAD:-L5 phone pass}" "" "" "${TC_BOX_REPLY_WAIT:-40}"
  if [ -n "${TC_TEST_PAIR_LINK_OPERATE:-}" ]; then
    xcrun simctl terminate "$TC_SIM_UDID" "$BUNDLE" >/dev/null 2>&1 || true
    xcrun simctl uninstall "$TC_SIM_UDID" "$BUNDLE" >/dev/null 2>&1 || true
    xcrun simctl install "$TC_SIM_UDID" "$APP"
    TC_TEST_PAIR_LINK="$TC_TEST_PAIR_LINK_OPERATE" TC_TEST_PAIR_NAME="${TC_TEST_PAIR_NAME:-} (approving)" pair || { echo "ios-sim-proof: the app did not pair with the approving key" >&2; return 3; }
    rm -f "$OUT/shots/00-pairing.png"
    TC_ACTION="send:Use the Bash tool to run exactly this command and then tell me its output: echo approved-from-the-phone" shot "box-act-ask" thread "${TC_BOX_APPROVE_THREAD:-L5 approval pass}" "" "" "${TC_BOX_REPLY_WAIT:-40}"
    TC_ACTION="approve" shot "box-act-approve" thread "${TC_BOX_APPROVE_THREAD:-L5 approval pass}" "" "" "${TC_BOX_ACT_WAIT:-25}"
    shot "box-act-approved" thread "${TC_BOX_APPROVE_THREAD:-L5 approval pass}" "" "" "${TC_BOX_REPLY_WAIT:-40}"
  fi
}

settings_set() {
  for mode in light dark; do
    appearance "$mode"
    shot "settings-$mode" settings
    shot "hosts-$mode" hosts
    shot "host-detail-$mode" hosts "" "" host
    TC_SHEET=pair shot "pair-sheet-$mode" hosts
    TC_SHEET=pair-error shot "pair-sheet-error-$mode" hosts
  done
  appearance light
  xcrun simctl ui "$TC_SIM_UDID" content_size "$A11Y_SIZE" >/dev/null
  shot settings-a11y settings
  shot host-detail-a11y hosts "" "" host
  xcrun simctl ui "$TC_SIM_UDID" content_size large >/dev/null
}

host_extras_set() {
  [ -n "${TC_TEST_PAIR_LINK_ADMIN:-}" ] || { echo "ios-sim-proof: the host-extras set needs TC_TEST_PAIR_LINK_ADMIN" >&2; return 2; }
  appearance light
  # The read key: the Build row disabled, the deploy, sync and device reasons in the footers.
  shot "host-detail-activity-read" hosts "" "" host
  xcrun simctl uninstall "$TC_SIM_UDID" "$BUNDLE" >/dev/null 2>&1 || true
  xcrun simctl install "$TC_SIM_UDID" "$APP"
  TC_TEST_PAIR_LINK="$TC_TEST_PAIR_LINK_ADMIN" TC_TEST_PAIR_NAME="${TC_TEST_PAIR_NAME:-} (admin)" pair || { echo "ios-sim-proof: the app did not pair with the admin key" >&2; return 3; }
  rm -f "$OUT/shots/00-pairing.png"
  for mode in light dark; do
    appearance "$mode"
    # Build: Master, Deploy Master, the finished deploy's row; Devices: the booted
    # iPhone 17 Pro's green dot and CPU, the paired iPhone; Sync: the peer never synced.
    shot "host-detail-activity-$mode" hosts "" "" host
    # The log: twelve mono lines ending in the ending line, following the tail.
    TC_SHEET=deploy-log shot "deploy-log-$mode" hosts "" "" host
  done
  appearance light
  xcrun simctl ui "$TC_SIM_UDID" content_size "$A11Y_SIZE" >/dev/null
  shot "host-detail-activity-a11y" hosts "" "" host
  xcrun simctl ui "$TC_SIM_UDID" content_size large >/dev/null
}

diff_set() {
  for mode in light dark; do
    appearance "$mode"
    shot "diff-small-$mode" thread "dark mode" board diff
    shot "diff-big-$mode" thread "gateway router" board diff
  done
  appearance light
  xcrun simctl ui "$TC_SIM_UDID" content_size "$A11Y_SIZE" >/dev/null
  shot "diff-big-a11y" thread "gateway router" board diff
  xcrun simctl ui "$TC_SIM_UDID" content_size large >/dev/null
}

page_set() {
  for mode in light dark; do
    appearance "$mode"
    shot "page-inline-$mode" thread "build slow"
    shot "page-full-$mode" thread "build slow" "" page
  done
  appearance light
}

# The screens the 2026-10-22 batch added, on the test server's seeds: the
# master's board with its rules sheet, the project plan, the host's notice
# rows (review, gate, batch, account gone), every failure card, the preamble
# row, the plan's handoff, a streaming turn, thread notes, the account chip's
# menu, the resources sheet, a queued and a stopped root, a paused master,
# the gate row opened, and Home's fleet switch confirm; light and dark, then
# the busiest at the accessibility size.
features_set() {
  for mode in light dark; do
    appearance "$mode"
    shot "master-board-$mode" thread "Ship the stats pipeline" board
    shot "master-chat-$mode" thread "Ship the stats pipeline" chat
    shot "master-rules-$mode" thread "Ship the stats pipeline" board rules
    shot "master-paused-$mode" thread "Port the admin pages"
    shot "project-plan-$mode" thread "Project plan: the billing" plan
    shot "notices-$mode" thread "Land the export endpoint" chat
    shot "failures-$mode" thread "Every way a turn fails"
    shot "preamble-$mode" thread "config keys (with rules)" chat
    shot "handoff-$mode" thread "Plan the passkey rollout" chat
    shot "streaming-$mode" thread "Streaming on the phone"
    shot "notes-$mode" thread "Thread notes on the phone"
    shot "account-$mode" thread "On the work account" "" account
    TC_SHEET=resources shot "resources-$mode" thread "Build the share sheet"
    shot "queued-$mode" thread "Backfill the rollups"
    shot "stopped-$mode" thread "Rename the config keys again"
    shot "gate-$mode" thread "dark mode" board gate
    TC_SHEET=fleet:pause shot "fleet-pause-$mode" home
  done
  appearance light
  xcrun simctl ui "$TC_SIM_UDID" content_size "$A11Y_SIZE" >/dev/null
  shot master-board-a11y thread "Ship the stats pipeline" board
  shot failures-a11y thread "Every way a turn fails"
  shot account-a11y thread "On the work account" "" account
  shot notices-a11y thread "Land the export endpoint" chat
  xcrun simctl ui "$TC_SIM_UDID" content_size large >/dev/null
  linked_set
}

# One project across two hosts: the test server's second host carries the
# same link ids on its copy of ios-workspace and ios-project. Paired last, so
# every shot before it shows one host.
linked_set() {
  [ -n "${TC_TEST_PAIR_LINK_SECOND:-}" ] || { echo "ios-sim-proof: no second host, the linked shots are skipped"; return 0; }
  PAIR_SINCE=$(date '+%Y-%m-%d %H:%M:%S')
  TC_PAIR_SECOND="$TC_TEST_PAIR_LINK_SECOND" shot 00-second-pairing home >/dev/null
  pairing_log | /usr/bin/grep -q "second pairing done" || { echo "ios-sim-proof: the app did not pair the second host" >&2; return 3; }
  rm -f "$OUT/shots/00-second-pairing.png"
  for mode in light dark; do
    appearance "$mode"
    TC_HOME_SCROLL=ios-workspace shot "linked-home-$mode" home
    shot "linked-thread-$mode" thread "Thread A"
  done
  appearance light
  xcrun simctl ui "$TC_SIM_UDID" content_size "$A11Y_SIZE" >/dev/null
  TC_HOME_SCROLL=ios-workspace shot linked-home-a11y home
  xcrun simctl ui "$TC_SIM_UDID" content_size large >/dev/null
}

# The glass pass's screens (see the header). dock <name> copies the dock
# report the last thread shot wrote.
dock() {
  local container
  container=$(xcrun simctl get_app_container "$TC_SIM_UDID" "$BUNDLE" data 2>/dev/null || true)
  for f in dock-report dock-report-focused; do
    if [ -n "$container" ] && [ -f "$container/Documents/$f.json" ]; then
      cp "$container/Documents/$f.json" "$OUT/$1-$f.json"
      echo "ios-sim-proof: $1 $f $(cat "$container/Documents/$f.json")"
      rm -f "$container/Documents/$f.json"
    fi
  done
}
glass_set() {
  for mode in light dark; do
    appearance "$mode"
    shot "glass-chat-$mode" thread "gateway refuse"; dock "glass-chat-$mode"
    shot "glass-running-$mode" thread "Index the archive"; dock "glass-running-$mode"
    shot "glass-paused-$mode" thread "Migrate the stats pipeline"; dock "glass-paused-$mode"
    shot "glass-queued-$mode" thread "Backfill the rollups"
    shot "glass-stopped-$mode" thread "Rename the config keys again"
    shot "glass-home-$mode" home
    shot "glass-search-$mode" search
    shot "glass-hosts-$mode" hosts
    shot "glass-board-$mode" thread "dark mode" board
    shot "glass-master-$mode" thread "Ship the stats pipeline" board
    shot "glass-agents-$mode" thread "thread screens" fleet agents
    TC_SHEET=new shot "glass-new-sheet-$mode" home
  done
  appearance light
  xcrun simctl ui "$TC_SIM_UDID" content_size "$A11Y_SIZE" >/dev/null
  shot glass-chat-a11y thread "gateway refuse"; dock glass-chat-a11y
  shot glass-running-a11y thread "Index the archive"
  shot glass-home-a11y home
  xcrun simctl ui "$TC_SIM_UDID" content_size large >/dev/null
  if [ -n "${TC_TEST_PAIR_LINK_OPERATE:-}" ]; then
    xcrun simctl terminate "$TC_SIM_UDID" "$BUNDLE" >/dev/null 2>&1 || true
    xcrun simctl uninstall "$TC_SIM_UDID" "$BUNDLE" >/dev/null 2>&1 || true
    xcrun simctl install "$TC_SIM_UDID" "$APP"
    TC_TEST_PAIR_LINK="$TC_TEST_PAIR_LINK_OPERATE" TC_TEST_PAIR_NAME="${TC_TEST_PAIR_NAME:-} (acting)" pair || { echo "ios-sim-proof: the app did not pair with the acting key" >&2; return 3; }
    rm -f "$OUT/shots/00-pairing.png"
    for mode in light dark; do
      appearance "$mode"
      shot "glass-chat-operate-$mode" thread "gateway refuse"; dock "glass-chat-operate-$mode"
      shot "glass-keyboard-$mode" thread "gateway refuse" "" composer 14; dock "glass-keyboard-$mode"
    done
    appearance light
  fi
}

# The return rule (see the header): middle row, background, foreground, cold launch.
transcript_report() {
  local container
  container=$(xcrun simctl get_app_container "$TC_SIM_UDID" "$BUNDLE" data 2>/dev/null || true)
  if [ -n "$container" ] && [ -f "$container/Documents/transcript-report.json" ]; then
    cp "$container/Documents/transcript-report.json" "$OUT/$1.json"
    echo "ios-sim-proof: $1 $(cat "$container/Documents/transcript-report.json")"
    rm -f "$container/Documents/transcript-report.json"
  else
    echo "ios-sim-proof: $1 no transcript report"
  fi
}
return_set() {
  appearance light
  TC_TARGET_SEQ=${TC_RETURN_SEQ:-1000} shot "return-0-middle" thread "2,000 rows" chat "" 14
  transcript_report return-0-middle
  for away in 5 60; do
    xcrun simctl launch "$TC_SIM_UDID" com.apple.Preferences >/dev/null
    sleep "$away"
    # Brings the running app forward again; no relaunch, so it is the warm return.
    xcrun simctl launch "$TC_SIM_UDID" "$BUNDLE" >/dev/null
    sleep 3
    xcrun simctl io "$TC_SIM_UDID" screenshot --type png "$OUT/shots/return-$away-s.png" >/dev/null 2>&1
    transcript_report "return-$away-s"
  done
  # Cold: a plain launch restores the Home stack with the thread (and the row its route named).
  xcrun simctl terminate "$TC_SIM_UDID" "$BUNDLE" >/dev/null 2>&1 || true
  SIMCTL_CHILD_TC_TEST_TRANSCRIPT_REPORT=1 xcrun simctl launch "$TC_SIM_UDID" "$BUNDLE" >/dev/null
  sleep 12
  xcrun simctl io "$TC_SIM_UDID" screenshot --type png "$OUT/shots/return-cold.png" >/dev/null 2>&1
  transcript_report return-cold
}

# The iPhone Duo set. Plans 1-3 add their shots inside the three functions
# (called once per pose with the pose in $POSE); the seed list is this file's.
duo_shots_shell() { :; }   # plan 1: the shell in every pose
duo_shots_thread() { :; }  # plan 2: the thread screen in every pose
duo_shots_sheets() { :; }  # plan 3: sheets, Settings, Inbox, Search and the bars
duo_set() {
  xcrun simctl ui "$TC_SIM_UDID" content_size large >/dev/null
  local pose
  for pose in folded unfolded unfolded-portrait folded-landscape; do
    fold "$pose"
    appearance light
    duo_shot home-light home
    duo_shot thread-light thread "" chat
    duo_shot inbox-light inbox
    duo_shot search-light search
    duo_shot settings-light settings
    appearance dark
    duo_shot home-dark home
    duo_shot thread-dark thread "" chat
    appearance light
    duo_shots_shell
    duo_shots_thread
    duo_shots_sheets
  done
  fold half-open
  duo_shot thread-light thread "" chat
  duo_shots_thread
  duo_fold_cycle
  echo "ios-sim-proof: duo set PASS ($(find "$OUT/layout" -name '*.json' | wc -l | tr -d ' ') pose checks); shots in $OUT/shots/<pose>/, reports in $OUT/layout/<pose>/"
}

# The fold cycle: one launch of the 2,000-row chat, folded and unfolded twice
# with the app running, four shots, the unfold recorded, the layout events
# asserted. The draft step (TC_TEST_ACTION=draft:<text>) is plan 2's: until
# it lands the cycle runs with an empty composer and says so.
duo_fold_cycle() {
  appearance light
  fold ul
  echo "ios-sim-proof: fold cycle (draft step: not yet, plan 2's draft: action)"
  shot cycle-1-unfolded thread "2,000 rows" chat
  local container
  container=$(xcrun simctl get_app_container "$TC_SIM_UDID" "$BUNDLE" data)
  fold fp live; sleep 3; snap cycle-2-folded
  xcrun simctl io "$TC_SIM_UDID" recordVideo --display=LCD-1 --codec h264 --force "$OUT/cycle-unfold.mov" >/dev/null 2>"$OUT/record.err" &
  local recorder=$!
  sleep 1
  fold ul live; sleep 3; snap cycle-3-unfolded
  kill -INT "$recorder" 2>/dev/null; wait "$recorder" 2>/dev/null || true
  rm -f "$OUT/record.err"
  fold fp live; sleep 3; snap cycle-4-folded
  cp "$container/Documents/layout-events.json" "$OUT/layout/cycle-events.json"
  python3 - "$OUT/layout" <<'CHECK'
import json, pathlib, sys
out = pathlib.Path(sys.argv[1])
A = json.loads((out / 'unfolded' / 'cycle-1-unfolded.json').read_text())
B = json.loads((out / 'folded' / 'cycle-2-folded.json').read_text())
C = json.loads((out / 'unfolded' / 'cycle-3-unfolded.json').read_text())
D = json.loads((out / 'folded' / 'cycle-4-folded.json').read_text())
events = json.loads((out / 'cycle-events.json').read_text())
# The stack and the thread survived every change.
routes = [r['route'] for r in (A, B, C, D)]
assert all(r == routes[0] for r in routes), routes
assert routes[0].get('thread') and routes[0].get('segment') == 'chat', routes[0]
# A thread comes back at its bottom; a width change is a come-back.
for name, r in (('B', B), ('C', C), ('D', D)):
    assert r.get('transcriptAtBottom') == 1, (name, r.get('transcriptAtBottom'))
# The draft survives (plan 2 writes notes.draftChars).
drafts = {r.get('notes', {}).get('draftChars') for r in (A, B, C, D)}
assert len(drafts) == 1, drafts
# Each step is exactly one hSize flip and one window change; a second flip inside a step is the flicker.
steps = [(A['t'], B['t'], 'regular', 'compact', '466x678'), (B['t'], C['t'], 'compact', 'regular', '951x669'), (C['t'], D['t'], 'regular', 'compact', '466x678')]
for start, end, frm, to, window in steps:
    inside = [e for e in events if start < e['t'] <= end]
    flips = [e for e in inside if e['key'] == 'hSize']
    assert len(flips) == 1 and flips[0]['from'] == frm and flips[0]['to'] == to, (start, end, flips)
    windows = [e for e in inside if e['key'] == 'window']
    assert len(windows) == 1 and windows[0]['to'] == window, (start, end, windows)
# The sidebar (plan 1 writes notes.sidebar): never a frame without it.
sidebar = [e for e in events if e['key'] == 'sidebar']
if sidebar:
    for start, end, frm, to in ((A['t'], B['t'], 'visible', 'hidden'), (B['t'], C['t'], 'hidden', 'visible'), (C['t'], D['t'], 'visible', 'hidden')):
        inside = [e for e in sidebar if start < e['t'] <= end]
        assert len(inside) == 1 and inside[0]['from'] == frm and inside[0]['to'] == to, (start, end, inside)
    print('ios-sim-proof: fold cycle PASS (route kept, at bottom after every fold, one flip per step, sidebar once per step)')
else:
    print('ios-sim-proof: fold cycle PASS (route kept, at bottom after every fold, one flip per step; sidebar: not reported)')
CHECK
  echo "ios-sim-proof: the unfold is recorded in $OUT/cycle-unfold.mov"
}

case "$SET" in
  duo) duo_set ;;
  f4) f4_set ;;
  settings) settings_set ;;
  diff) diff_set ;;
  page) page_set ;;
  host-extras) host_extras_set ;;
  f4-ui) f4_ui_set ;;
  shell) shell_set; host_gone_set ;;
  threads) threads_set ;;
  scroll) scroll_set ;;
  box) box_set ;;
  actions) actions_set ;;
  box-actions) box_actions_set ;;
  push) push_set ;;
  features) features_set ;;
  glass) glass_set ;;
  return) return_set ;;
  all) shell_set; threads_set; scroll_set; actions_set; push_set; host_gone_set ;;
  *) echo "ios-sim-proof: unknown TC_PROOF_SET $SET" >&2; exit 2 ;;
esac

echo "ios-sim-proof: screenshots in $OUT/shots"
ls "$OUT/shots"
