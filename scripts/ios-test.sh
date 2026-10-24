#!/bin/sh
# Build and test ios/TempCodeContract (bun run ios:test).
#
# The Command Line Tools' swift-package on this Mac cannot load
# BuildServerProtocol.framework, so when the selected developer directory
# is the CLT and an Xcode is installed, the Xcode scripts/ios-xcode.sh picks
# (the highest version) runs the build instead. `xcode-select -s` on an Xcode makes this moot.
set -e
here=$(cd "$(dirname "$0")" && pwd)
cd "$here/../ios/TempCodeContract"
if [ -z "$DEVELOPER_DIR" ] && case "$(xcode-select -p 2>/dev/null)" in *CommandLineTools*) true;; *) false;; esac; then
  # scripts/ios-xcode.sh picks the highest-versioned Xcode; the package builds on any, so no minimum.
  if xcode=$(TC_XCODE_MIN=0 "$here/ios-xcode.sh"); then
    export DEVELOPER_DIR="$xcode"
    echo "ios:test: using $xcode"
  fi
fi
swift build
swift test "$@"
