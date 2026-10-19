#!/bin/sh
# Build and test ios/TempCodeContract (bun run ios:test).
#
# The Command Line Tools' swift-package on this Mac cannot load
# BuildServerProtocol.framework, so when the selected developer directory
# is the CLT and an Xcode is installed, the newest Xcode's toolchain runs
# the build instead. `xcode-select -s` on an Xcode makes this moot.
set -e
cd "$(dirname "$0")/../ios/TempCodeContract"
if [ -z "$DEVELOPER_DIR" ] && case "$(xcode-select -p 2>/dev/null)" in *CommandLineTools*) true;; *) false;; esac; then
  xcode=$(ls -d /Applications/Xcode*.app 2>/dev/null | sort -V | tail -1)
  if [ -n "$xcode" ]; then
    export DEVELOPER_DIR="$xcode/Contents/Developer"
    echo "ios:test: using $xcode"
  fi
fi
swift build
swift test "$@"
