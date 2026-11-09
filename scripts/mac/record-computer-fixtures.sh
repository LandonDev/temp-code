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

# The pids whose executable path ends with $1. Never `pgrep -f`: a command line is any
# text, and a shell that merely mentions the path (the one running this) matches it.
exe_pids() {
  ps -axo pid=,comm= | awk -v e="$1" '{ p = $1; $1 = ""; sub(/^ /, ""); if (length($0) >= length(e) && substr($0, length($0) - length(e) + 1) == e) print p }'
}

# The pid of a process running the executable $1 that was not running before ($2).
new_pid() {
  local exe=$1 before=$2 tries=0 pid
  while ((tries < 60)); do
    for pid in $(exe_pids "$exe"); do
      grep -qx "$pid" <<<"$before" || { echo "$pid"; return 0; }
    done
    sleep 0.5
    tries=$((tries + 1))
  done
  echo "no new process running $exe" >&2
  return 1
}

# record <pid> <title> <app> <state> [--contains AXRole=Name] [--appshot] [--after <state> <action>] [setup words...]
record() {
  local pid=$1 title=$2 app=$3 state=$4
  shift 4
  local args=(record --pid "$pid" --title "$title" --app "$app" --state "$state" --out "$OUT/$app/$state")
  if [[ ${1:-} == --contains ]]; then
    args+=(--contains "$2")
    shift 2
  fi
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

TEXTEDIT_WHERE=''

textedit() {
  say textedit
  local before pid title=${TC_FIXTURE_TEXTEDIT_TITLE:-Untitled} area=AXTextArea
  local text=$'Hello from the probe\nSecond line'
  local exe=TextEdit.app/Contents/MacOS/TextEdit
  before=$(exe_pids "$exe")
  # A separate instance that restores none of the person's documents and opens a new one.
  # NSDocumentSaveNewDocumentsToCloud NO: otherwise a stray Command-S saves the untitled
  # document straight into iCloud Drive's TextEdit folder with no sheet.
  open -n -g -a TextEdit --args -ApplePersistenceIgnoreState YES -NSShowAppCentricOpenPanelInsteadOfUntitledFile NO \
    -NSDocumentSaveNewDocumentsToCloud NO
  pid=$(new_pid "$exe" "$before")
  # On any failure too: close the document unsaved, then the instance.
  CLEANUP+=("textedit_discard $pid '$title'")
  "$REC" wait-window --pid "$pid" --title "$title"
  "$REC" set-value --pid "$pid" --title "$title" --role "$area" --value "$text"
  "$REC" select-range --pid "$pid" --title "$title" --role "$area" --range 0,0
  local s1='a separate TextEdit instance (open -n -g, persistence ignored, new documents not saved to iCloud) with a new document'
  local s2='the probe text set through AXValue: "Hello from the probe\nSecond line", caret at 0'
  record "$pid" "$title" textedit doc --appshot "$s1" "$s2"

  "$REC" select-range --pid "$pid" --title "$title" --role "$area" --range 32,0
  # A key event posted to the pid, not AXSelectedText: text set through AX leaves the
  # document unedited, so the close button would close it without a sheet.
  "$REC" key --pid "$pid" --key 1 --mods shift
  sleep 0.5
  "$REC" select-range --pid "$pid" --title "$title" --role "$area" --range 15,5
  record "$pid" "$title" textedit typed --appshot --after doc 'typed "!" at the end as a key event posted to the pid, then selected "probe" through AXSelectedTextRange' "$s1" "$s2"

  # The window's close button: the keep-document sheet (Delete, Cancel, Save). Not
  # Command-S: Save… is disabled while the instance is in the background, and bringing
  # it forward would take the person's keystrokes into the scratch window. Save is
  # never pressed: on this macOS it writes the file to the last folder with no panel.
  "$REC" press --pid "$pid" --title "$title" --role AXButton --subrole AXCloseButton
  "$REC" wait-element --pid "$pid" --title "$title" --role AXButton --name Delete
  # The sheet's Where names the person's last save folder: show Documents for the
  # recording, then pick their folder back (the choice outlives the sheet).
  TEXTEDIT_WHERE=$("$REC" pick --pid "$pid" --title "$title" --popup 'Where:' --item Documents)
  sleep 1
  record "$pid" "$title" textedit save-sheet --appshot --after typed 'pressed the window close button through AX: the sheet asking whether to keep the new document (Delete, Cancel, Save), Where set to Documents' "$s1" "$s2"
  textedit_discard "$pid" "$title"
}

# Close the document through its close button and Delete it (no autosave lingers in
# TextEdit's container), then end the instance. Never Save.
textedit_discard() {
  local pid=$1 title=$2
  kill -0 "$pid" 2>/dev/null || return 0
  if [[ -n ${TEXTEDIT_WHERE:-} ]]; then
    "$REC" pick --pid "$pid" --title "$title" --popup 'Where:' --item "$TEXTEDIT_WHERE" >/dev/null && TEXTEDIT_WHERE=''
    sleep 0.5
  fi
  "$REC" wait-element --pid "$pid" --title "$title" --role AXButton --name Delete --timeout 1 2>/dev/null ||
    "$REC" press --pid "$pid" --title "$title" --role AXButton --subrole AXCloseButton 2>/dev/null &&
    "$REC" wait-element --pid "$pid" --title "$title" --role AXButton --name Delete --timeout 3 2>/dev/null &&
    "$REC" press --pid "$pid" --title "$title" --role AXButton --name Delete
  sleep 0.5
  kill "$pid" 2>/dev/null || true
}

chrome() {
  say chrome
  # Chrome's AX window title carries the app's name; the window server's does not
  # (the recorder accepts exactly that pair for the screenshot).
  local profile=/tmp/tc-fixture-chrome pid='' tries=0 title=${TC_FIXTURE_CHROME_TITLE:-'Computer fixture form - Google Chrome'}
  rm -rf "$profile"
  CLEANUP+=("rm -rf $profile")
  # A second Chrome on a throwaway profile, never the person's; -g keeps it from coming
  # forward. --force-renderer-accessibility: without it the page's content is never in
  # the AX tree (Chrome refuses AXManualAccessibility).
  open -n -g -a 'Google Chrome' --args --user-data-dir="$profile" --no-first-run --no-default-browser-check \
    --disable-features=Translate --force-renderer-accessibility "file://$FIXTURES/page/form.html"
  # The browser process: Chrome's own executable (helpers are others) on this profile.
  while [[ -z $pid ]] && ((tries < 60)); do
    for p in $(exe_pids 'Google Chrome.app/Contents/MacOS/Google Chrome'); do
      ps -o command= -p "$p" | grep -qF -- "--user-data-dir=$profile" && { pid=$p; break; }
    done
    [[ -n $pid ]] || sleep 0.5
    tries=$((tries + 1))
  done
  [[ -n $pid ]] || { echo 'no Chrome browser process on the scratch profile' >&2; return 1; }
  CLEANUP+=("kill $pid 2>/dev/null")
  "$REC" wait-window --pid "$pid" --title "$title" --timeout 30
  # The page's tree lands a few seconds after the window.
  "$REC" wait-element --pid "$pid" --title "$title" --role AXButton --name 'Load prices' --timeout 30
  sleep 1
  local s1="a second Chrome on a throwaway profile ($profile, --force-renderer-accessibility) showing fixtures/page/form.html"
  record "$pid" "$title" chrome form --appshot "$s1"

  # The select's menu is a popup window of its own; the recorder shoots it with the window.
  "$REC" press --pid "$pid" --title "$title" --role AXPopUpButton --name Medium --action AXPress
  sleep 1
  record "$pid" "$title" chrome menu-open --appshot --after form 'pressed the Size select: its menu is open' "$s1"
  "$REC" key --pid "$pid" --key escape
  sleep 0.5

  "$REC" press --pid "$pid" --title "$title" --role AXButton --name 'Load prices'
  sleep 0.3
  record "$pid" "$title" chrome loading --appshot --after form 'pressed Load prices: the spinner shows for 3 s' "$s1"
  kill "$pid" 2>/dev/null || true
  tries=0
  while kill -0 "$pid" 2>/dev/null && ((tries < 20)); do sleep 0.5; tries=$((tries + 1)); done
}

tempcode_dev() {
  say tempcode-dev
  local clone=${TC_FIXTURE_CLONE:-$ROOT} data=/tmp/tc-fixture-dev port=9241 pid title
  rm -rf "$data"
  mkdir -p "$data/aliax" "$data/claude" "$data/codex"
  CLEANUP+=("rm -rf $data")
  # Its own Aliax vault and CLI config dirs, so no account of the person's shows in the window.
  # TEMP_CODE_SOAK_WINDOW=1 (src/main/soakWindow.ts): the window opens inactive, never takes
  # the person's focus, and keeps painting behind their windows; occluded, Chromium stops
  # painting it and the screenshot is a stale frame with a 13-node tree.
  (
    cd "$clone"
    env -u ELECTRON_RUN_AS_NODE TEMP_CODE_USER_DATA="$data" TEMP_CODE_DEBUG_PORT=$port TEMP_CODE_REMOTE_PORT=0 \
      TEMP_CODE_ALIAX_DATA_DIR="$data/aliax" ALIAX_CREDENTIAL_BACKEND=file CLAUDE_CONFIG_DIR="$data/claude" \
      CODEX_HOME="$data/codex" TEMP_CODE_WARM_HARNESS=0 TEMP_CODE_SOAK_WINDOW=1 \
      nohup bunx electron-vite preview --skipBuild >"$WORK/dev.log" 2>&1 &
    echo $! >"$WORK/dev.pid"
  )
  CLEANUP+=("pkill -P $(cat "$WORK/dev.pid") 2>/dev/null; kill $(cat "$WORK/dev.pid") 2>/dev/null")
  # The Electron main process: the clone's own Electron binary (helpers are others, and
  # no other app runs it), launched with this userData.
  local tries=0
  pid=''
  while [[ -z $pid ]] && ((tries < 120)); do
    for p in $(exe_pids "$clone/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"); do
      ps eww -o command= -p "$p" 2>/dev/null | grep -q "TEMP_CODE_USER_DATA=$data" && pid=$p && break
    done
    [[ -n $pid ]] || sleep 0.5
    tries=$((tries + 1))
  done
  [[ -n $pid ]] || { echo 'the dev instance did not start' >&2; return 1; }
  CLEANUP+=("kill $pid 2>/dev/null")
  # The window is titled by what it shows: "New thread" on a fresh start, then the thread's title.
  title=${TC_FIXTURE_DEV_TITLE:-New thread}
  "$REC" wait-window --pid "$pid" --title "$title" --timeout 60
  sleep 4
  local s1="an isolated TempCode dev instance (TEMP_CODE_USER_DATA=$data, its own Aliax vault and CLI config dirs, built from master), fresh data"
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
  title=${TC_FIXTURE_DEV_THREAD_TITLE:-Scratch thread}
  "$REC" wait-window --pid "$pid" --title "$title" --timeout 30
  sleep 3
  record "$pid" "$title" tempcode-dev thread --appshot --after first-run 'added a scratch workspace on an empty folder and opened a new thread in it over CDP, no message sent' "$s1"
  # Down now, not at exit: the instance and the bunx parent (the chat thread's harness goes with it).
  kill "$pid" 2>/dev/null || true
  local t=0
  while kill -0 "$pid" 2>/dev/null && ((t < 20)); do sleep 0.5; t=$((t + 1)); done
}

intellij() {
  say intellij
  local dir=/tmp/tc-fixture-idea/Hello pid='' before tries=0 started=0
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
  # A new window of the running IDE on the scratch project, or the IDE launched for it
  # (and quit afterwards). -g: not brought forward on purpose.
  local exe='IntelliJ IDEA.app/Contents/MacOS/idea'
  before=$(exe_pids "$exe" | head -1)
  open -g -a 'IntelliJ IDEA' "$dir"
  while [[ -z $pid ]] && ((tries < 60)); do
    pid=$(exe_pids "$exe" | head -1)
    [[ -n $pid ]] || sleep 1
    tries=$((tries + 1))
  done
  [[ -n $pid ]] || { echo 'IntelliJ did not start' >&2; return 1; }
  if [[ -z $before ]]; then
    started=1
    CLEANUP+=("kill $pid 2>/dev/null")
  fi
  # A first open of a folder may ask whether to trust it (2026.1 opened /tmp without asking).
  sleep 5
  "$REC" press --pid "$pid" --title "${TC_FIXTURE_IDEA_TRUST_TITLE:-Trust and Open Project 'Hello'?}" --role AXButton --name 'Trust Project' 2>/dev/null || true
  # 2026.1's project frame has an empty title, in AX and in the window server alike: name it
  # by the empty title plus an element inside it; more than one such window is refused, so
  # with the person's projects open this records nothing. Never touched: the license prompt
  # an expired subscription opens beside it (the person's decision).
  local title=${TC_FIXTURE_IDEA_TITLE:-} mark=${TC_FIXTURE_IDEA_CONTAINS:-AXButton=Project}
  "$REC" wait-window --pid "$pid" --title "$title" --contains "$mark" --timeout 120
  sleep 5
  # The Project tool window, so the scratch tree shows.
  "$REC" press --pid "$pid" --title "$title" --contains "$mark" --role AXButton --name Project
  sleep 4
  # No appshot: axdump picks the IDE's focused or main window before it looks at a title.
  record "$pid" "$title" intellij project --contains "$mark" 'a scratch project at /tmp/tc-fixture-idea/Hello (one Hello.java) opened in the IDE, its Project tool window open, screen-reader support as the IDE has it'
  if ((started)); then
    kill "$pid" 2>/dev/null || true
    tries=0
    while kill -0 "$pid" 2>/dev/null && ((tries < 30)); do sleep 1; tries=$((tries + 1)); done
  else
    "$REC" press --pid "$pid" --title "$title" --contains "$mark" --role AXButton --subrole AXCloseButton || true
  fi
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
