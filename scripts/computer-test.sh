#!/bin/sh
# Build and test native/tc-computer (bun run computer:test), the computer-use
# service's Swift package. As scripts/ios-test.sh: when the selected developer
# directory is the Command Line Tools (whose swift-package cannot load
# BuildServerProtocol.framework on this Mac) and an Xcode is installed, the
# Xcode scripts/ios-xcode.sh picks runs the build instead.
set -e
here=$(cd "$(dirname "$0")" && pwd)
cd "$here/../native/tc-computer"
if [ -z "$DEVELOPER_DIR" ] && case "$(xcode-select -p 2>/dev/null)" in *CommandLineTools*) true;; *) false;; esac; then
  if xcode=$(TC_XCODE_MIN=0 "$here/ios-xcode.sh"); then
    export DEVELOPER_DIR="$xcode"
    echo "computer:test: using $xcode"
  fi
fi
swift build
swift test "$@"
