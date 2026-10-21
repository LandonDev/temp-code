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
#   actions The steering shots: a read key's disabled composer and card, then
#           the app re-paired with TC_TEST_PAIR_LINK_OPERATE (a key that may act):
#           a send landing as the user row, Stop mid-turn, approve and deny,
#           a question answered, Start from the plan into a build, a new chat
#           from the workspace, a message to an agent, pin, archive and rename;
#           the key shots in dark too. TC_TEST_CONTROL_URL is the test server's
#           control panel; the set reads back what landed.
#   f4      Old and missing search hits, full board history, then the scroll budget.
#   push    A notification tap (L6): a payload shaped like the hub's, routed
#           through the delegate at launch, lands on the named thread's row;
#           the navigation report proves the seq; Settings shows the row.
#   all     shell, threads, scroll, actions and push (the default).
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
DERIVED=${TC_PROOF_DERIVED_DATA:-$OUT/DerivedData}
BUNDLE=dev.landon.tempcode.ios
mkdir -p "$OUT"
# Rebuild incrementally, but never carry a report or screenshot into a new pass.
rm -rf "$OUT/shots"
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
  xcrun simctl io "$TC_SIM_UDID" screenshot --type png "$OUT/shots/$name.png" >/dev/null 2>&1
  echo "ios-sim-proof: $name"
}
appearance() { xcrun simctl ui "$TC_SIM_UDID" appearance "$1" >/dev/null 2>&1 || true; }

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
  rm -f "$OUT/shots/00-pairing.png"
fi

shell_set() {
  appearance light
  xcrun simctl ui "$TC_SIM_UDID" content_size large >/dev/null
  shot 01-home-light home
  shot 02-archived-light archived
  shot 03-inbox-light inbox
  shot 03b-inbox-item-light inbox "" "" item
  shot 03c-inbox-changes-light inbox "" "" item-changes
  shot 04-search-light search
  shot 05-settings-light settings
  shot 06-hosts-light hosts
  shot 07-thread-light thread
  appearance dark
  shot 08-home-dark home
  shot 09-archived-dark archived
  shot 10-inbox-dark inbox
  shot 10b-inbox-item-dark inbox "" "" item
  shot 10c-inbox-changes-dark inbox "" "" item-changes
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

case "$SET" in
  f4) f4_set ;;
  f4-ui) f4_ui_set ;;
  shell) shell_set; host_gone_set ;;
  threads) threads_set ;;
  scroll) scroll_set ;;
  box) box_set ;;
  actions) actions_set ;;
  box-actions) box_actions_set ;;
  push) push_set ;;
  all) shell_set; threads_set; scroll_set; actions_set; push_set; host_gone_set ;;
  *) echo "ios-sim-proof: unknown TC_PROOF_SET $SET" >&2; exit 2 ;;
esac

echo "ios-sim-proof: screenshots in $OUT/shots"
ls "$OUT/shots"
