#!/bin/sh
# Print the developer directory every iOS script builds with (bun run ios:xcode).
#
# The rule, in order:
#   1. DEVELOPER_DIR when set: an explicit caller wins, nothing is checked.
#   2. TC_XCODE=/Applications/<X>.app when set.
#   3. Else the /Applications/Xcode*.app whose Contents/version.plist carries
#      the highest CFBundleShortVersionString (numeric: 27.10 beats 27.9);
#      a tie goes to the bundle whose name has no "beta".
# A pick (2 or 3) below TC_XCODE_MIN (default 27.1: the iPhone Duo's window
# metrics need the 27.1 SDK, a 27.0 build loses an 80 pt rail in every pose)
# exits 2 with a line naming every installed Xcode. The package runners
# (ios:test, ios:test:client) pass TC_XCODE_MIN=0: TempCodeContract and
# TempCodeClient compile on any Xcode 26+. TC_XCODE_APPS_DIR is the test
# seam (a directory of fake bundles; default /Applications).
#
# Why `sort -V` over the file names was wrong: it sorted "Xcode-beta.app"
# after "Xcode.app" whatever the versions inside, and picked the 27.0 beta
# over the 27.1 release.
set -e
if [ -n "${DEVELOPER_DIR:-}" ]; then
  printf '%s\n' "$DEVELOPER_DIR"
  exit 0
fi
exec python3 - "${TC_XCODE_APPS_DIR:-/Applications}" "${TC_XCODE:-}" "${TC_XCODE_MIN:-27.1}" <<'PY'
import os, plistlib, re, sys
apps_dir, explicit, minimum = sys.argv[1:4]

def version_of(app):
    try:
        with open(os.path.join(app, 'Contents', 'version.plist'), 'rb') as f:
            return plistlib.load(f).get('CFBundleShortVersionString', '')
    except Exception:
        return ''

def key(v):
    return tuple(int(p) for p in re.findall(r'\d+', v)) or (0,)

installed = []
try:
    for name in sorted(os.listdir(apps_dir)):
        if re.match(r'^Xcode.*\.app$', name):
            app = os.path.join(apps_dir, name)
            v = version_of(app)
            if v:
                installed.append((app, v))
except FileNotFoundError:
    pass

if explicit:
    pick = (explicit, version_of(explicit))
    if not pick[1]:
        print(f'ios-xcode: TC_XCODE={explicit} is not an Xcode bundle (no Contents/version.plist)', file=sys.stderr)
        sys.exit(2)
else:
    if not installed:
        print(f'ios-xcode: no Xcode under {apps_dir}', file=sys.stderr)
        sys.exit(2)
    # Highest version; among equals the one whose name has no "beta".
    pick = max(installed, key=lambda x: (key(x[1]), 'beta' not in os.path.basename(x[0]).lower()))

if key(pick[1]) < key(minimum):
    have = ', '.join(f'{os.path.basename(a)} {v}' for a, v in installed) or 'none'
    print(f'ios-xcode: {os.path.basename(pick[0])} is Xcode {pick[1]}, below the {minimum} this build needs; installed: {have}', file=sys.stderr)
    sys.exit(2)
print(os.path.join(pick[0], 'Contents', 'Developer'))
PY
