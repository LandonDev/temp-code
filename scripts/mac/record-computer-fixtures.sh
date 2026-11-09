#!/bin/bash
# Records src/main/server/computer/fixtures/apps/ on the Mac, from scratch
# content only (docs/computer-protocol.md "Fixtures"). Never the person's own
# windows: each app runs as a separate scratch instance where it can (TextEdit,
# Chrome, a TempCode dev instance), and the recorder refuses any window but
# the exact title it is given.
#
#   scripts/mac/record-computer-fixtures.sh [textedit] [chrome] [tempcode-dev] [intellij]   (default: all four)
#
# Needs Accessibility and Screen Recording for the process that runs it. Run it
# from a clone, never the person's checkout. tempcode-dev needs a built clone:
# TC_FIXTURE_CLONE=<clone> with `bun install` and `bunx electron-vite build`
# done there (default: this checkout). Each app cleans up after itself, also on
# failure.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
FIXTURES="$ROOT/src/main/server/computer/fixtures"
OUT="$FIXTURES/apps"
WORK=$(mktemp -d /tmp/tc-fixture.XXXXXX)
REC="$WORK/recorder"
APPSHOT="$WORK/appshot-helper"
CLEANUP=()

cleanup() {
  local i
  for ((i = ${#CLEANUP[@]} - 1; i >= 0; i--)); do eval "${CLEANUP[$i]}" || true; done
  rm -rf "$WORK"
}
trap cleanup EXIT

say() { printf '› %s\n' "$*"; }

swiftc -O -o "$REC" "$ROOT/scripts/mac/record-computer-fixture.swift"
swiftc -O -o "$APPSHOT" "$ROOT/resources/native/appshot-helper.swift"

# The pid of a process whose command line holds $1 that was not running before.
new_pid() {
  local pattern=$1 before=$2 tries=0 pid
  while ((tries < 60)); do
    for pid in $(pgrep -f -- "$pattern" || true); do
      grep -qx "$pid" <<<"$before" || { echo "$pid"; return 0; }
    done
    sleep 0.5
    tries=$((tries + 1))
  done
  echo "no new process matching $pattern" >&2
  return 1
}

# record <pid> <title> <app> <state> [--appshot] [--after <state> <action>] [setup words...]
record() {
  local pid=$1 title=$2 app=$3 state=$4
  shift 4
  local args=(record --pid "$pid" --title "$title" --app "$app" --state "$state" --out "$OUT/$app/$state")
  if [[ ${1:-} == --appshot ]]; then
    "$APPSHOT" axdump --pid "$pid" --title "$title" >"$WORK/axdump.json"
    args+=(--appshot "$WORK/axdump.json")
    shift
  fi
  if [[ ${1:-} == --after ]]; then
    args+=(--after-state "$2" --after-action "$3")
    shift 3
  fi
  local step
  for step in "$@"; do args+=(--setup "$step"); done
  rm -rf "${OUT:?}/$app/$state"
  "$REC" "${args[@]}"
}

textedit() {
  say textedit
  local before pid title=Untitled area=AXTextArea
  local text=$'Hello from the probe\nSecond line'
  before=$(pgrep -x TextEdit || true)
  # A separate instance that restores none of the person's documents and opens a new one.
  open -n -g -a TextEdit --args -ApplePersistenceIgnoreState YES -NSShowAppCentricOpenPanelInsteadOfUntitledFile NO
  pid=$(new_pid 'TextEdit.app/Contents/MacOS/TextEdit' "$before")
  CLEANUP+=("kill $pid 2>/dev/null")
  "$REC" wait-window --pid "$pid" --title "$title"
  "$REC" set-value --pid "$pid" --title "$title" --role "$area" --value "$text"
  "$REC" select-range --pid "$pid" --title "$title" --role "$area" --range 0,0
  local s1='a separate TextEdit instance (open -n -g, persistence ignored) with a new document'
  local s2='the probe text set through AXValue: "Hello from the probe\nSecond line", caret at 0'
  record "$pid" "$title" textedit doc --appshot "$s1" "$s2"

  "$REC" select-range --pid "$pid" --title "$title" --role "$area" --range 32,0
  "$REC" insert-text --pid "$pid" --title "$title" --role "$area" --text '!'
  "$REC" select-range --pid "$pid" --title "$title" --role "$area" --range 15,5
  record "$pid" "$title" textedit typed --appshot --after doc 'typed "!" at the end through AXSelectedText, then selected "probe" through AXSelectedTextRange' "$s1" "$s2"

  "$REC" key --pid "$pid" --key s --mods cmd
  sleep 1.5
  record "$pid" "$title" textedit save-sheet --appshot --after typed 'Command-S posted to the pid: the Save As sheet' "$s1" "$s2"

  # Cancel the sheet, close the document without keeping it, quit that instance.
  "$REC" press --pid "$pid" --title "$title" --role AXButton --name Cancel
  sleep 0.5
  "$REC" key --pid "$pid" --key w --mods cmd
  sleep 1
  "$REC" press --pid "$pid" --title "$title" --role AXButton --name Delete || true
  sleep 0.5
  kill "$pid" 2>/dev/null || true
}

chrome() {
  say chrome
  local profile=/tmp/tc-fixture-chrome before pid title='Computer fixture form'
  rm -rf "$profile"
  CLEANUP+=("rm -rf $profile")
  before=$(pgrep -f "user-data-dir=$profile" || true)
  # A second Chrome on a throwaway profile, never the person's.
  open -na 'Google Chrome' --args --user-data-dir="$profile" --no-first-run --no-default-browser-check \
    --disable-features=Translate "file://$FIXTURES/page/form.html"
  sleep 2
  pid=$(pgrep -f "user-data-dir=$profile" | while read -r p; do ps -o command= -p "$p" | grep -q -- '--type=' || echo "$p"; done | head -1)
  [[ -n $pid ]] || { echo 'no Chrome browser process on the scratch profile' >&2; return 1; }
  CLEANUP+=("kill $pid 2>/dev/null")
  "$REC" wait-window --pid "$pid" --title "$title" --timeout 30
  local s1="a second Chrome on a throwaway profile ($profile) showing fixtures/page/form.html"
  record "$pid" "$title" chrome form --appshot "$s1"

  "$REC" press --pid "$pid" --title "$title" --role AXPopUpButton --name Medium --action AXPress
  sleep 1
  record "$pid" "$title" chrome menu-open --after form 'pressed the Size select: its menu is open' "$s1"
  "$REC" key --pid "$pid" --key escape
  sleep 0.5

  "$REC" press --pid "$pid" --title "$title" --role AXButton --name 'Load prices'
  sleep 0.3
  record "$pid" "$title" chrome loading --after form 'pressed Load prices: the spinner shows for 3 s' "$s1"
  kill "$pid" 2>/dev/null || true
}

tempcode_dev() {
  say tempcode-dev
  local clone=${TC_FIXTURE_CLONE:-$ROOT} data=/tmp/tc-fixture-dev port=9241 pid title
  rm -rf "$data"
  CLEANUP+=("rm -rf $data")
  (
    cd "$clone"
    env -u ELECTRON_RUN_AS_NODE TEMP_CODE_USER_DATA="$data" TEMP_CODE_DEBUG_PORT=$port TEMP_CODE_REMOTE_PORT=0 \
      nohup bunx electron-vite preview --skipBuild >"$WORK/dev.log" 2>&1 &
    echo $! >"$WORK/dev.pid"
  )
  CLEANUP+=("pkill -P $(cat "$WORK/dev.pid") 2>/dev/null; kill $(cat "$WORK/dev.pid") 2>/dev/null")
  # The Electron main process is the one launched with this userData.
  local tries=0
  pid=''
  while [[ -z $pid ]] && ((tries < 120)); do
    for p in $(pgrep -f 'Electron' || true); do
      ps eww -o command= -p "$p" 2>/dev/null | grep -q "TEMP_CODE_USER_DATA=$data" && ps -o command= -p "$p" | grep -vq -- '--type=' && pid=$p && break
    done
    sleep 0.5
    tries=$((tries + 1))
  done
  [[ -n $pid ]] || { echo 'the dev instance did not start' >&2; return 1; }
  title=${TC_FIXTURE_DEV_TITLE:-TempCode}
  "$REC" wait-window --pid "$pid" --title "$title" --timeout 60
  sleep 3
  local s1="an isolated TempCode dev instance (TEMP_CODE_USER_DATA=$data, built from master), fresh data"
  record "$pid" "$title" tempcode-dev first-run --appshot "$s1"

  # A scratch workspace on an empty folder and one thread in it, over CDP; no message is sent.
  mkdir -p /tmp/tc-fixture-workspace
  CLEANUP+=("rm -rf /tmp/tc-fixture-workspace")
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
  const id = created.id ?? created.session?.id
  await window.__monocode.open(id)
  return id
})()`
ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }))
const answer = await new Promise<{ result?: { result?: { value?: unknown }; exceptionDetails?: unknown } }>((r) => (ws.onmessage = (m) => r(JSON.parse(String(m.data)))))
if (answer.result?.exceptionDetails) throw new Error(JSON.stringify(answer.result.exceptionDetails))
console.log('thread', answer.result?.result?.value)
ws.close()
TS
  bun "$WORK/cdp.ts" "$port" /tmp/tc-fixture-workspace
  sleep 2
  record "$pid" "$title" tempcode-dev thread --appshot --after first-run 'added a scratch workspace on an empty folder and opened a new thread in it over CDP, no message sent' "$s1"
}

intellij() {
  say intellij
  local dir=/tmp/tc-fixture-idea/Hello pid title
  rm -rf /tmp/tc-fixture-idea
  mkdir -p "$dir/src"
  CLEANUP+=("rm -rf /tmp/tc-fixture-idea")
  cat >"$dir/src/Hello.java" <<'JAVA'
public class Hello {
    public static void main(String[] args) {
        System.out.println("Hello from the fixture");
    }
}
JAVA
  # A new window of the running IDE on the scratch project (or the IDE, launched).
  open -a 'IntelliJ IDEA' "$dir"
  pid=$(pgrep -f 'IntelliJ IDEA.app/Contents/MacOS/idea' | head -1)
  [[ -n $pid ]] || { echo 'IntelliJ is not running' >&2; return 1; }
  # A first open of a folder asks whether to trust it.
  sleep 5
  "$REC" press --pid "$pid" --title "${TC_FIXTURE_IDEA_TRUST_TITLE:-Trust and Open Project 'Hello'?}" --role AXButton --name 'Trust Project' || true
  title=${TC_FIXTURE_IDEA_TITLE:-Hello}
  "$REC" wait-window --pid "$pid" --title "$title" --timeout 90
  sleep 5
  # No appshot: axdump picks the IDE's focused or main window before it looks at a title.
  record "$pid" "$title" intellij project 'a scratch project at /tmp/tc-fixture-idea/Hello (one Hello.java) opened as a new window of the IDE, screen-reader support as the IDE has it'
  "$REC" press --pid "$pid" --title "$title" --role AXButton --subrole AXCloseButton || true
}

apps=("$@")
((${#apps[@]})) || apps=(textedit chrome tempcode-dev intellij)
for a in "${apps[@]}"; do
  case $a in
    textedit) textedit ;;
    chrome) chrome ;;
    tempcode-dev) tempcode_dev ;;
    intellij) intellij ;;
    *) echo "unknown app $a" >&2; exit 2 ;;
  esac
done
say "done: $OUT"
