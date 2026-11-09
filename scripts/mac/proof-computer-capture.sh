#!/usr/bin/env bash
# Capture's live proof on the Mac (plan §10): builds and runs capture-proof, which shows only its
# own inert windows (below .normal, never key, never activated), captures them and a helper process
# of itself, and writes report.json and the images to the output directory, which it removes once
# the summary is printed unless --keep is passed (to read the images). It never prompts for Screen
# Recording: without the grant it stops at once.
#   bash scripts/mac/proof-computer-capture.sh [--keep] [out-dir]
set -euo pipefail
cd "$(dirname "$0")/../.."
keep=0
out=/tmp/tc-capture-proof
for arg in "$@"; do
  case "$arg" in
    --keep) keep=1 ;;
    *) out="$arg" ;;
  esac
done
# Only a directory the proof made (its marker inside) is removed.
cleanup() { if [ "$keep" = 0 ] && [ -f "$out/.capture-proof" ]; then rm -rf "$out"; fi; }
trap cleanup EXIT
DEVELOPER_DIR="$(bash scripts/ios-xcode.sh)"
export DEVELOPER_DIR
swift build -c release --package-path native/tc-computer --product capture-proof
status=0
swift run -c release --skip-build --package-path native/tc-computer capture-proof --out "$out" || status=$?
echo
if [ -f "$out/report.json" ]; then
  /usr/bin/python3 -c 'import json,sys; r=json.load(open(sys.argv[1])); s=r["summary"]; print("capture-proof: %d pass, %d fail, %d skip, %d finding" % (s["pass"], s["fail"], s["skip"], s["finding"])); [print("  %s [%s] %s: %s" % (c["outcome"].upper(), c["scene"], c["name"], c["detail"])) for c in r["checks"] if c["outcome"] != "pass"]' "$out/report.json"
  if [ "$keep" = 1 ]; then echo "report: $out/report.json"; fi
fi
exit "$status"
