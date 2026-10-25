#!/bin/bash
# Put the iPhone Duo simulator in a pose, or read it (the proof's `fold`).
#
#   scripts/ios-duo-pose.sh <udid> <pose>   sets the pose, prints the lit panel (LCD or LCD-1)
#   scripts/ios-duo-pose.sh <udid> lit      prints the panel devicectl marks active
#   scripts/ios-duo-pose.sh <udid> state    prints one JSON line { angle, orientation, lit }
#
# The poses (docs/IOS-DESIGN.md "iPhone Duo" has the window each one gives
# an app linked against the 27.1 SDK); the long tag or its alias:
#
#   pose               alias  hinge  device orientation  lit panel
#   folded             fp     0°     portrait            LCD   (display 1)
#   folded-landscape   fl     0°     landscape-left      LCD   (display 1)
#   unfolded           ul     180°   portrait            LCD-1 (display 3)
#   unfolded-portrait  up     180°   landscape-left      LCD-1 (display 3)
#   half-open          ho     130°   portrait            LCD-1 (display 3), reached from 0°
#
# The driver is `hinge` (brew install artemnovichkov/tap/hinge, 0.2.0+): it
# sends the Device Hub's own HID event for the angle and the orientation and
# reads the angle back inside the guest, so it needs no `devicectl device
# motion` (absent from Xcode 27.1 release), no XCTest runner and no window.
# Which panel is lit is read from `xcrun devicectl device info displays`
# (`active` per panel), never inferred from the angle: the lit panel is
# path-dependent around 100-105°, which is why half-open always closes first.
# The pose is settled when hinge reports the angle and orientation asked and
# devicectl marks the expected panel active (10 s budget), then one second
# more for the scene to follow; a pose that never settles is exit 1 with the
# last reading. An unknown tag is exit 2.
#
# Measured on this Mac (2026-10-24, Xcode 27.1, TempCode Duo on iOS 27.1):
# the first `hinge` call after a brew install takes about 2.5 s (it compiles
# its in-guest helper into ~/.cache/hinge), then close/open 0.45 s, orient
# 1.0 s, posture 0.4 s; devicectl displays 0.3 s. A pose change end to end
# is 2-4 s including the settle second. Seen twice on 2026-10-24: the guest
# stopped switching panels (angle 0, LCD-1 still active, through every path,
# for minutes), both times after a close while the device was turned; every
# pose then fails to settle with "on LCD-1". `simctl shutdown` + `boot`
# cleared it and nothing short of that did; the proof's `fold` does that
# once between shots. Turning to portrait before the angle moves avoided it
# in every run since.
#
# Fakes for the vitest (scripts/ios-duo-pose.test.ts) go on PATH as `hinge`
# and `xcrun`; TC_DUO_SETTLE_BUDGET=<s> shortens the wait.
set -euo pipefail
UDID=${1:-}
WHAT=${2:-}
[ -n "$UDID" ] && [ -n "$WHAT" ] || { echo "usage: ios-duo-pose.sh <udid> <pose>|lit|state" >&2; exit 2; }
BUDGET=${TC_DUO_SETTLE_BUDGET:-10}

# One hinge call that changes the device: a 5 s confirm window (hinge's own 2 s
# default ran out once closing from unfolded-portrait under load) and one retry.
move() {
  hinge -d "$UDID" -t 5 "$@" >/dev/null 2>&1 || hinge -d "$UDID" -t 5 "$@" >/dev/null
}

# The table: tag → "angle orientation panel". Aliases map to the long tag.
canonical() {
  case "$1" in
    folded|fp) echo folded ;;
    folded-landscape|fl) echo folded-landscape ;;
    unfolded|ul) echo unfolded ;;
    unfolded-portrait|up) echo unfolded-portrait ;;
    half-open|ho) echo half-open ;;
    *) return 1 ;;
  esac
}
row() {
  case "$1" in
    folded) echo "0 portrait LCD" ;;
    folded-landscape) echo "0 landscape-left LCD" ;;
    unfolded) echo "180 portrait LCD-1" ;;
    unfolded-portrait) echo "180 landscape-left LCD-1" ;;
    half-open) echo "130 portrait LCD-1" ;;
  esac
}

# devicectl's `active` panel: LCD, LCD-1, or "" when neither or both read active.
active_panel() {
  xcrun devicectl device info displays --device "$UDID" --json-output - 2>/dev/null | python3 -c '
import json, sys
try:
    rows = json.load(sys.stdin)["result"]["displays"]
except Exception:
    rows = []
active = [d["name"] for d in rows if d.get("active")]
print(active[0] if len(active) == 1 else "")' 2>/dev/null || true
}
# hinge posture → "angle orientation" (angle as an integer).
posture() {
  hinge -d "$UDID" posture 2>/dev/null | python3 -c '
import sys
angle, orientation = "", ""
for line in sys.stdin:
    k, _, v = line.partition(":")
    if k.strip() == "angle": angle = str(int(round(float(v.strip()))))
    if k.strip() == "orientation": orientation = v.strip()
print(angle, orientation)' 2>/dev/null || true
}
# The lit panel: devicectl's word, else the table by angle (the half-open path reads as open).
lit() {
  local panel
  panel=$(active_panel)
  if [ -z "$panel" ]; then
    read -r angle _ <<<"$(posture)"
    if [ -n "$angle" ] && [ "$angle" -ge 100 ]; then panel=LCD-1; else panel=LCD; fi
  fi
  echo "$panel"
}

case "$WHAT" in
  lit) lit; exit 0 ;;
  state)
    read -r angle orientation <<<"$(posture)"
    printf '{"angle":%s,"orientation":"%s","lit":"%s"}\n' "${angle:-null}" "$orientation" "$(lit)"
    exit 0 ;;
esac

pose=$(canonical "$WHAT") || { echo "ios-duo-pose: unknown pose $WHAT (folded|fp, folded-landscape|fl, unfolded|ul, unfolded-portrait|up, half-open|ho)" >&2; exit 2; }
read -r angle orientation panel <<<"$(row "$pose")"
# The angle, always from portrait: closing while the device is turned (unfolded-portrait → folded)
# twice left the guest at 0° with the inner panel still lit. half-open goes through closed first:
# above ~100° the lit panel depends on the way in.
read -r now_angle now_orientation <<<"$(posture)"
if [ "$now_angle" != "$angle" ] && [ -n "$now_orientation" ] && [ "$now_orientation" != portrait ]; then
  move orient portrait
fi
case "$angle" in
  0) move close ;;
  180) move open ;;
  *) move close; move "$angle" ;;
esac
move orient "$orientation"

# Settle: hinge agrees on the angle and orientation, devicectl on the panel.
deadline=$(( $(date +%s) + BUDGET ))
got_angle=""; got_orientation=""; got_panel=""
while :; do
  read -r got_angle got_orientation <<<"$(posture)"
  got_panel=$(active_panel)
  if [ "$got_angle" = "$angle" ] && [ "$got_orientation" = "$orientation" ] && [ "$got_panel" = "$panel" ]; then
    sleep "${TC_DUO_SCENE_SETTLE:-1}"
    echo "$panel"
    exit 0
  fi
  [ "$(date +%s)" -lt "$deadline" ] || break
  sleep 0.5
done
echo "ios-duo-pose: $pose did not settle in ${BUDGET}s: asked angle $angle $orientation on $panel, read angle ${got_angle:-?} ${got_orientation:-?} on ${got_panel:-neither}" >&2
exit 1
