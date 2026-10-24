#!/bin/bash
# What an iPhone Duo pass needs on this Mac, one line each (bun run ios:duo:check).
#
#   bun run ios:duo:check              the seven items; exit 0 only when all pass
#   bun run ios:duo:check -- --create  also creates the "TempCode Duo" simulator when it is missing
#   bun run ios:duo:check -- --device  also wants Landon's Duo (iPhone19,4) connected with a compatible DDI
#
#   1. Xcode: scripts/ios-xcode.sh's pick, 27.1 at least (the Duo's window metrics need the 27.1 SDK).
#   2. An iOS 27.1+ simulator runtime (else: DEVELOPER_DIR=<dir> xcodebuild -downloadPlatform iOS).
#   3. The device type com.apple.CoreSimulator.SimDeviceType.iPhone-Duo.
#   4. A simulator named "TempCode Duo" on that runtime (--create makes it, never a second one;
#      the proof never creates it).
#   5. hinge 0.2.0+ on PATH (else: brew install artemnovichkov/tap/hinge).
#   6. xcodegen on PATH (else: brew install xcodegen).
#   7. With --device: a connected iPhone19,4 in `devicectl list devices` whose ddiServices answer
#      is compatible (Developer Mode on).
# Exit 2 names what is missing. scripts/ios-sim-proof.sh runs it (without --device) before the
# first shot when TC_DUO_POSE is set.
#
# Seams for scripts/ios-duo-check.test.ts: TC_XCODE_APPS_DIR (the picker's), TC_DUO_CHECK_XCRUN=<fake xcrun>,
# fakes for hinge and xcodegen on PATH.
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
CREATE=0; DEVICE=0
for arg in "$@"; do
  case "$arg" in
    --create) CREATE=1 ;;
    --device) DEVICE=1 ;;
    *) echo "ios-duo-check: unknown argument $arg" >&2; exit 2 ;;
  esac
done
XCRUN=${TC_DUO_CHECK_XCRUN:-xcrun}
SIM_NAME="TempCode Duo"
DUO_TYPE=com.apple.CoreSimulator.SimDeviceType.iPhone-Duo
missing=0
ok() { printf 'ok       %s\n' "$1"; }
bad() { printf 'MISSING  %s\n' "$1"; missing=2; }

# 1. Xcode
if dev=$("$here/ios-xcode.sh" 2>/tmp/tc-duo-check-xcode.err); then
  # Not exported: /usr/bin/python3 and xcrun are shims that follow DEVELOPER_DIR, and the
  # pick is only reported here (the proof scripts export their own).
  app=$(dirname "$(dirname "$dev")")
  ver=$(python3 -c 'import plistlib,sys; p=plistlib.load(open(sys.argv[1],"rb")); print(p.get("CFBundleShortVersionString",""), p.get("ProductBuildVersion",""))' "$app/Contents/version.plist" 2>/dev/null || echo "?")
  ok "xcode: $(basename "$app") $ver"
else
  bad "xcode: $(cat /tmp/tc-duo-check-xcode.err)"
fi
rm -f /tmp/tc-duo-check-xcode.err

# 2. Runtime
runtime=$("$XCRUN" simctl list runtimes -j 2>/dev/null | python3 -c '
import json, sys
try:
    rows = json.load(sys.stdin)["runtimes"]
except Exception:
    rows = []
def key(v): return tuple(int(p) for p in v.split(".") if p.isdigit())
ios = [r for r in rows if r.get("platform") == "iOS" and r.get("isAvailable") and key(r.get("version", "0")) >= (27, 1)]
ios.sort(key=lambda r: key(r["version"]))
print(ios[-1]["identifier"] + " " + ios[-1]["version"] if ios else "")' 2>/dev/null)
if [ -n "$runtime" ]; then
  ok "runtime: ${runtime#* } (${runtime% *})"
  RUNTIME_ID=${runtime% *}
else
  bad "runtime: no iOS 27.1+ simulator runtime; run: DEVELOPER_DIR=${dev:-<xcode>/Contents/Developer} xcodebuild -downloadPlatform iOS"
  RUNTIME_ID=""
fi

# 3. Device type
if "$XCRUN" simctl list devicetypes -j 2>/dev/null | python3 -c '
import json, sys
rows = json.load(sys.stdin).get("devicetypes", [])
sys.exit(0 if any(r.get("identifier") == sys.argv[1] for r in rows) else 1)' "$DUO_TYPE" 2>/dev/null; then
  ok "device type: iPhone Duo ($DUO_TYPE)"
else
  bad "device type: $DUO_TYPE is not listed (the Xcode's simulator runtime is older than 27.1)"
fi

# 4. The simulator
find_sim() {
  "$XCRUN" simctl list devices -j 2>/dev/null | python3 -c '
import json, sys
name, runtime = sys.argv[1], sys.argv[2]
devices = json.load(sys.stdin).get("devices", {})
for rt, rows in devices.items():
    if runtime and rt != runtime: continue
    for d in rows:
        if d.get("name") == name and d.get("isAvailable", True):
            print(d["udid"] + " " + d.get("state", "")); sys.exit(0)
print("")' "$SIM_NAME" "$RUNTIME_ID" 2>/dev/null
}
sim=$(find_sim)
if [ -z "$sim" ] && [ "$CREATE" = 1 ] && [ -n "$RUNTIME_ID" ]; then
  if "$XCRUN" simctl create "$SIM_NAME" "$DUO_TYPE" "$RUNTIME_ID" >/dev/null 2>&1; then
    sim=$(find_sim)
    [ -n "$sim" ] && echo "created  simulator: $SIM_NAME on $RUNTIME_ID"
  fi
fi
if [ -n "$sim" ]; then
  ok "simulator: $SIM_NAME ${sim% *} (${sim#* })"
else
  bad "simulator: no \"$SIM_NAME\" on ${RUNTIME_ID:-an iOS 27.1+ runtime}; run: bun run ios:duo:check -- --create"
fi

# 5. hinge
if command -v hinge >/dev/null 2>&1; then
  hv=$(hinge --version 2>/dev/null | head -n 1)
  if python3 -c '
import sys
def key(v): return tuple(int(p) for p in v.strip().split(".") if p.isdigit())
sys.exit(0 if key(sys.argv[1]) >= (0, 2, 0) else 1)' "$hv" 2>/dev/null; then
    ok "hinge: $hv ($(command -v hinge))"
  else
    bad "hinge: $hv is older than 0.2.0; run: brew upgrade artemnovichkov/tap/hinge"
  fi
else
  bad "hinge: not on PATH; run: brew install artemnovichkov/tap/hinge"
fi

# 6. xcodegen
if command -v xcodegen >/dev/null 2>&1; then
  ok "xcodegen: $(command -v xcodegen)"
else
  bad "xcodegen: not on PATH; run: brew install xcodegen"
fi

# 7. The phone
if [ "$DEVICE" = 1 ]; then
  listing=$(mktemp)
  "$XCRUN" devicectl list devices --json-output "$listing" >/dev/null 2>&1 || true
  phone=$(python3 -c '
import json, sys
try:
    rows = json.load(open(sys.argv[1]))["result"]["devices"]
except Exception:
    rows = []
hw = lambda r: r.get("hardwareProperties", {})
# The Duo simulator lists as an iPhone19,4 too, as "simulated"; the phone is "physical".
duos = [r for r in rows if hw(r).get("productType") == sys.argv[2] and hw(r).get("deviceType") == "iPhone"
        and hw(r).get("reality", "physical") == "physical"]
connected = [r for r in duos if r.get("connectionProperties", {}).get("tunnelState") == "connected"]
pick = (connected or duos or [None])[0]
if pick is None: print("")
else:
    cp = pick.get("connectionProperties", {}); dp = pick.get("deviceProperties", {})
    print(pick["identifier"], cp.get("tunnelState", "?"), dp.get("osVersionNumber", "?"), "connected" if connected else "")' "$listing" iPhone19,4)
  rm -f "$listing"
  if [ -z "$phone" ]; then
    bad "device: no iPhone19,4 in devicectl list devices (plug the Duo in, unlock it, trust this Mac)"
  else
    read -r id state os conn <<<"$phone"
    if [ "$conn" != connected ]; then
      bad "device: the Duo $id is $state (iOS $os); plug it in and unlock it"
    else
      ddi=$(mktemp)
      "$XCRUN" devicectl device info ddiServices --device "$id" --json-output "$ddi" >/dev/null 2>&1 || true
      verdict=$(python3 -c '
import json, sys
try:
    r = json.load(open(sys.argv[1]))["result"]
    print("ok" if r.get("contentIsCompatible") else "incompatible " + str(r.get("buildUpdate", "")))
except Exception:
    print("unanswered")' "$ddi")
      rm -f "$ddi"
      case "$verdict" in
        ok) ok "device: Duo $id connected, iOS $os, DDI compatible" ;;
        unanswered) bad "device: Duo $id connected (iOS $os) but ddiServices did not answer: Developer Mode off, or the phone is locked" ;;
        *) bad "device: Duo $id connected (iOS $os) but the Xcode's DDI is not compatible ($verdict); install a newer Xcode beside this one" ;;
      esac
    fi
  fi
fi
exit $missing
