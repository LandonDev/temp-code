#!/bin/bash
# Input's live proof on this Mac (docs/computer-protocol.md "Input tiers measured").
#
#   scripts/mac/input-proof.sh [--session] [--tempcode] [--finder] [--active]
#
# Builds tc-input-proof, opens scratch windows, runs the legs, cleans up, and writes
# /tmp/tc-input-proof/report.json, report.md and run.log:
#   - TextEdit: its own instance (open -n -g, persistence ignored), an untitled document
#     the proof fills with 200 numbered lines through AX;
#   - Chrome: its own profile under /tmp, the fixture form page;
#   - with --tempcode, a TempCode dev instance of this clone (bun install and
#     electron-vite build first), its own userData under /tmp, a scratch workspace on an
#     empty folder with one thread, so its composer exists;
#   - with --finder, a Finder window on a scratch folder of three files;
#   - with --active, the legs that need the app in front (docs/computer-protocol.md §26), each
#     only after five minutes with no input, else "skipped: the person is active": TextEdit's
#     save_as into the scratch folder (and where its untitled autosave lived), a typed line saved
#     with ⌘S at front, and whether a click posted to its pid lands while it is active; with
#     --finder, a rename by Return, New Folder and Move to Trash on the scratch folder, each put
#     back; with TC_INPUT_INTELLIJ=1, IntelliJ's Save All; each leg records its hold;
#   - with TC_INPUT_INTELLIJ=1 and no IntelliJ running, the IDE on a scratch project
#     (its project windows have no title to tell them from the person's, so it is never
#     opened beside theirs), quit afterwards.
# The background fallbacks' legs (docs/computer-protocol.md §24) run last on every
# scratch window, at ax alone, and the report records each route, whether the window
# changed and whether the app stayed in the background (§14.8's table, §24.9).
# Nothing of the person's is opened, and the scratch apps are named to the proof by pid.
#
# The person's rules: a launch may still bring a window in front, so nothing is launched
# until the Mac has had no input for 2 minutes (HIDIdleTime), and a launch that took the
# front gives it straight back. Tier 1 and 2 legs need no wait but must leave the frontmost
# app and the pointer where they were. The session leg (--session) acts only while the
# person has been quiet 2 minutes, checked before every step, else "skipped: the person is
# active". Cleanup leaves no file, prompt or recent entry: the scratch apps are killed (no
# save sheet), their profiles and data removed, and TextEdit autosaves made during the run
# deleted.
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$here/../.." && pwd)
OUT=/tmp/tc-input-proof
WORK=$OUT/work
SESSION=''
ACTIVE=''
TEMPCODE=0
FINDER=0
for a in "$@"; do
  case $a in
    --session) SESSION=--session ;;
    --tempcode) TEMPCODE=1 ;;
    --finder) FINDER=1 ;;
    --active) ACTIVE=--active ;;
    *) echo "usage: $0 [--session] [--tempcode] [--finder] [--active]" >&2; exit 2 ;;
  esac
done
rm -rf "$OUT"
mkdir -p "$WORK"
CLEANUP=()
cleanup() {
  for ((i = ${#CLEANUP[@]} - 1; i >= 0; i--)); do eval "${CLEANUP[$i]}" || true; done
  rm -rf "$WORK"
}
trap cleanup EXIT

say() { printf '\n== %s\n' "$*"; }
idle() { ioreg -c IOHIDSystem | awk '/HIDIdleTime/ { print int($NF / 1000000000); exit }'; }
front_pid() { lsappinfo info -only pid "$(lsappinfo front)" | awk -F= '{ print $2 }'; }
front_bundle() { lsappinfo info -only bundleid "$(lsappinfo front)" | awk -F'"' '{ print $4 }'; }

# Waits for `$1` seconds of no input, at most `$2`; 1 when the person stayed busy.
wait_idle() {
  local needed=$1 max=$2 start=$SECONDS
  while (( $(idle) < needed )); do
    (( SECONDS - start >= max )) && return 1
    sleep 2
  done
}

# A launch that took the front gives it back to the person's app; only when a scratch app
# is in front, never over a switch the person made.
SCRATCH_PIDS=''
give_front_back() {
  local now
  now=$(front_pid)
  # a scratch app in front with no input since: a launch put it there, not the person
  if [[ -n $PERSON_FRONT_PID && $now != "$PERSON_FRONT_PID" && " $SCRATCH_PIDS " == *" $now "* ]] && (( $(idle) >= 120 )); then
    echo "a launch took the front (pid $now); giving it back to $PERSON_FRONT_BUNDLE"
    [[ -n $PERSON_FRONT_BUNDLE ]] && open -g -b "$PERSON_FRONT_BUNDLE" && open -b "$PERSON_FRONT_BUNDLE"
  fi
}

say build
XCODE=$(TC_XCODE_MIN=0 "$ROOT/scripts/ios-xcode.sh") || XCODE=''
[[ -n $XCODE ]] && export DEVELOPER_DIR=$XCODE
(cd "$ROOT/native/tc-computer" && swift build --product tc-input-proof 2>&1 | tail -3) || exit 1
BIN="$(cd "$ROOT/native/tc-computer" && swift build --show-bin-path)/tc-input-proof"

if (( TEMPCODE )); then
  say build TempCode for its dev instance
  (cd "$ROOT" && bun install >/dev/null && bunx electron-vite build >/dev/null) || { echo 'the TempCode build failed' >&2; exit 1; }
fi

say "waiting for 2 minutes with no input before launching anything (at most 10)"
if ! wait_idle 120 600; then
  printf '{"pass": true, "skipped": "skipped: the person is active", "legs": [], "probes": [], "notes": []}\n' >"$OUT/report.json"
  echo 'skipped: the person is active'
  exit 0
fi
PERSON_FRONT_PID=$(front_pid)
PERSON_FRONT_BUNDLE=$(front_bundle)
LOCKDIR="${TMPDIR:-/tmp}/tc-computer"
[[ -d $LOCKDIR ]] || CLEANUP+=("rm -rf '$LOCKDIR'")
AUTOSAVE="$HOME/Library/Containers/com.apple.TextEdit/Data/Library/Autosave Information"
ls -1 "$AUTOSAVE" 2>/dev/null | sort >"$WORK/autosave.before"
# only autosaves made during the run that hold this run's marker; the person's own stay
export TC_INPUT_PROOF_MARKER="tc-input-proof-$(uuidgen)"
CLEANUP+=("comm -13 '$WORK/autosave.before' <(ls -1 \"$AUTOSAVE\" 2>/dev/null | sort) | while read -r f; do grep -rqs '$TC_INPUT_PROOF_MARKER' \"$AUTOSAVE/\$f\" && rm -rf \"$AUTOSAVE/\$f\"; done")

say TextEdit
before=$(pgrep -x TextEdit | sort)
open -n -g -a TextEdit --args -ApplePersistenceIgnoreState YES -NSShowAppCentricOpenPanelInsteadOfUntitledFile NO
TE=''
for _ in $(seq 60); do
  TE=$(comm -13 <(echo "$before") <(pgrep -x TextEdit | sort) | head -1)
  [[ -n $TE ]] && break
  sleep 0.5
done
[[ -n $TE ]] || { echo 'TextEdit did not start' >&2; exit 1; }
CLEANUP+=("kill -9 $TE 2>/dev/null")
SCRATCH_PIDS="$SCRATCH_PIDS $TE"
sleep 2
give_front_back

# a launch may bring a window in front: each one waits for the person's quiet again
still_idle() {
  if (( $(idle) < 120 )); then
    echo 'skipped: the person is active' | tee -a "$OUT/run.log"
    exit 0
  fi
}

say Chrome
still_idle
profile=/tmp/tc-input-chrome
rm -rf "$profile"
CLEANUP+=("rm -rf $profile")
open -g -na 'Google Chrome' --args --user-data-dir="$profile" --no-first-run --no-default-browser-check --force-renderer-accessibility "file://$ROOT/src/main/server/computer/fixtures/page/form.html"
CH=''
for _ in $(seq 60); do
  CH=$(pgrep -f "user-data-dir=$profile" | while read -r p; do ps -o command= -p "$p" | grep -q -- '--type=' || echo "$p"; done | head -1)
  [[ -n $CH ]] && break
  sleep 0.5
done
[[ -n $CH ]] || { echo 'Chrome did not start' >&2; exit 1; }
CLEANUP+=("kill $CH 2>/dev/null; sleep 1; pkill -9 -f 'user-data-dir=$profile' 2>/dev/null")
SCRATCH_PIDS="$SCRATCH_PIDS $CH"
sleep 3
give_front_back
PIDS="textedit=$TE,chrome=$CH"

if (( TEMPCODE )); then
  say TempCode dev instance
  still_idle
  data=/tmp/tc-input-dev port=9243
  rm -rf "$data"
  CLEANUP+=("rm -rf $data")
  (
    cd "$ROOT"
    env -u ELECTRON_RUN_AS_NODE TEMP_CODE_USER_DATA="$data" TEMP_CODE_DEBUG_PORT=$port TEMP_CODE_REMOTE_PORT=0 \
      nohup bunx electron-vite preview --skipBuild >"$WORK/dev.log" 2>&1 &
    echo $! >"$WORK/dev.pid"
  )
  CLEANUP+=("pkill -P $(cat "$WORK/dev.pid") 2>/dev/null; kill $(cat "$WORK/dev.pid") 2>/dev/null")
  TC=''
  for _ in $(seq 120); do
    for p in $(pgrep -f Electron || true); do
      ps eww -o command= -p "$p" 2>/dev/null | grep -q "TEMP_CODE_USER_DATA=$data" && ps -o command= -p "$p" | grep -vq -- '--type=' && TC=$p && break
    done
    [[ -n $TC ]] && break
    sleep 0.5
  done
  if [[ -n $TC ]]; then
    CLEANUP+=("kill $TC 2>/dev/null")
    SCRATCH_PIDS="$SCRATCH_PIDS $TC"
    sleep 6
    give_front_back
    mkdir -p /tmp/tc-input-workspace
    CLEANUP+=("rm -rf /tmp/tc-input-workspace")
    cat >"$WORK/cdp.ts" <<'TS'
const [port, folder] = process.argv.slice(2)
const targets = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()) as { type: string; url: string; webSocketDebuggerUrl: string }[]
const page = targets.find((t) => t.type === 'page' && !t.url.startsWith('devtools'))
if (!page) throw new Error('no page target')
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r) => (ws.onopen = r))
const expression = `(async () => {
  const link = window.__monocode.registry.primary()
  const workspace = await link.request('workspace.create', { path: ${JSON.stringify(folder)}, name: 'Scratch' })
  const created = await link.request('session.create', { workspaceId: workspace.id, threadType: 'chat', title: 'Scratch thread' })
  await window.__monocode.open(created.id ?? created.session?.id)
})()`
ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }))
await new Promise((r) => (ws.onmessage = r))
ws.close()
TS
    bun "$WORK/cdp.ts" "$port" /tmp/tc-input-workspace && sleep 2 && PIDS="$PIDS,tempcode=$TC"
  else
    echo 'the TempCode dev instance did not start; its legs are left out' | tee -a "$OUT/run.log"
  fi
fi

if (( FINDER )); then
  say Finder on a scratch folder
  still_idle
  folder=/tmp/tc-input-finder
  rm -rf "$folder" && mkdir -p "$folder" && touch "$folder/one.txt" "$folder/two.txt" "$folder/three.txt"
  CLEANUP+=("osascript -e 'tell application \"Finder\" to close (every window whose name is \"tc-input-finder\")' 2>/dev/null; rm -rf $folder")
  open -g "$folder"
  sleep 2
  give_front_back
  PIDS="$PIDS,finder=$(pgrep -x Finder | head -1)"
fi

if [[ ${TC_INPUT_INTELLIJ:-} == 1 ]]; then
  say IntelliJ on a scratch project
  exe='IntelliJ IDEA.app/Contents/MacOS/idea'
  if pgrep -f "$exe" >/dev/null; then
    echo 'IntelliJ is running: its legs are left out (a scratch project window cannot be told from the person'"'"'s)' | tee -a "$OUT/run.log"
  else
    still_idle
    project=/tmp/tc-input-idea/Hello
    rm -rf /tmp/tc-input-idea && mkdir -p "$project/src"
    printf 'public class Hello {\n    public static void main(String[] args) {}\n}\n' >"$project/src/Hello.java"
    CLEANUP+=("rm -rf /tmp/tc-input-idea")
    open -g -a 'IntelliJ IDEA' "$project"
    IJ=''
    for _ in $(seq 120); do IJ=$(pgrep -f "$exe" | head -1); [[ -n $IJ ]] && break; sleep 0.5; done
    if [[ -n $IJ ]]; then
      CLEANUP+=("kill $IJ 2>/dev/null")
      SCRATCH_PIDS="$SCRATCH_PIDS $IJ"
      sleep 20
      give_front_back
      PIDS="$PIDS,intellij=$IJ"
    else
      echo 'IntelliJ did not start; its legs are left out' | tee -a "$OUT/run.log"
    fi
  fi
fi

say "legs ($PIDS)"
"$BIN" run --pids "$PIDS" --tiers ax,process $SESSION $ACTIVE --work "$WORK" --report "$OUT/report.json" 2>&1 | tee -a "$OUT/run.log"
status=${PIPESTATUS[0]}
give_front_back
exit "$status"
