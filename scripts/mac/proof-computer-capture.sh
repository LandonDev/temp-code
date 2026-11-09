#!/usr/bin/env bash
# Capture's live proof on the Mac (plan §10): builds and runs capture-proof, which shows only its
# own inert windows (below .normal, never key, never activated), captures them and a helper process
# of itself, and writes report.json and the images to the output directory. It never prompts for
# Screen Recording: without the grant it stops at once.
set -euo pipefail
cd "$(dirname "$0")/../.."
out="${1:-/tmp/tc-capture-proof}"
DEVELOPER_DIR="$(bash scripts/ios-xcode.sh)"
export DEVELOPER_DIR
swift build -c release --package-path native/tc-computer --product capture-proof
status=0
swift run -c release --skip-build --package-path native/tc-computer capture-proof --out "$out" || status=$?
echo
if [ -f "$out/report.json" ]; then
  grep -E '^PASS|^FAIL|^SKIP|^FIND' <<<"" >/dev/null || true
  /usr/bin/python3 -c 'import json,sys; r=json.load(open(sys.argv[1])); s=r["summary"]; print("capture-proof: %d pass, %d fail, %d skip, %d finding" % (s["pass"], s["fail"], s["skip"], s["finding"])); [print("  %s [%s] %s: %s" % (c["outcome"].upper(), c["scene"], c["name"], c["detail"])) for c in r["checks"] if c["outcome"] != "pass"]' "$out/report.json"
  echo "report: $out/report.json"
fi
exit "$status"
