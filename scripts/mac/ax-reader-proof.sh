#!/bin/bash
# The AX reader's live proof on the Mac (plan .temp-code/plan-8sO1AAx_glmS.md §7.4).
# Run it from a scratch clone, never the person's checkout, by a process with
# Accessibility granted:
#
#   bash scripts/mac/ax-reader-proof.sh [textedit] [chrome] [tempcode-dev] [intellij]   (default: all four)
#
# Scratch apps only, every window read in the background and never activated.
# A launch raises Chrome, the dev window and IntelliJ whatever the flag, so each
# starts only past five minutes with no input (TC_AX_IDLE_ANY), its step is
# aborted the moment input resumes, and the run waits up to 90 minutes
# (TC_AX_IDLE_WAIT) for such gaps: an app with none is "not run: the person was
# at the Mac". IntelliJ runs only with TC_AX_INTELLIJ=1. Writes
# /tmp/tc-ax-proof/report.json (checks, timings, findings) and prints the table;
# no live observation text is kept.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
export PATH="$HOME/.bun/bin:/opt/homebrew/bin:$PATH"

# As scripts/computer-test.sh: with the Command Line Tools selected, the Xcode scripts/ios-xcode.sh picks builds.
if [ -z "${DEVELOPER_DIR:-}" ] && case "$(xcode-select -p 2>/dev/null)" in *CommandLineTools*) true ;; *) false ;; esac; then
  if xcode=$(TC_XCODE_MIN=0 "$ROOT/scripts/ios-xcode.sh"); then export DEVELOPER_DIR="$xcode"; fi
fi

WORK=$(mktemp -d /tmp/tc-ax-proof-bin.XXXXXX)
trap 'rm -rf "$WORK"' EXIT
(cd "$ROOT/native/tc-computer" && swift build -c release --product tc-ax >/dev/null)
# The fixture recorder: its `key` posts a key event to one pid (TextEdit marks a document
# edited only on a real key; AX writes leave it unedited, and an unedited document closes
# without the sheet the proof opens).
swiftc -O -o "$WORK/recorder" "$ROOT/scripts/mac/record-computer-fixture.swift"

export TC_AX_BIN="$ROOT/native/tc-computer/.build/release/tc-ax" TC_AX_RECORDER="$WORK/recorder"
bun "$ROOT/scripts/mac/ax-reader-proof.ts" "$@"
