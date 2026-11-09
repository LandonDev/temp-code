#!/bin/sh
# The pure targets off the Mac (the box's Linux toolchain): a scratch package
# of ComputerProtocol, ComputerServiceKit, AXText and their tests, its
# directories linked back into this checkout, so the tests read the fixtures in
# place and TC_AX_GOLDEN=update rewrites them there. The whole of native/tc-computer builds
# only on the Mac (Input and Capture import Apple frameworks unguarded).
#
#   sh scripts/computer-text-test.sh [swift test arguments]
set -e
root=$(cd "$(dirname "$0")/.." && pwd)
work=${TC_TEXT_TEST_DIR:-/tmp/tc-computer-text-$(id -u)}
pkg="$work/native/tc-computer"
mkdir -p "$pkg/Sources" "$pkg/Tests"
ln -sfn "$root/src" "$work/src"
for d in Sources/ComputerProtocol Sources/ComputerServiceKit Sources/AXText Tests/ComputerProtocolTests Tests/ComputerServiceKitTests Tests/AXTextTests; do
  ln -sfn "$root/native/tc-computer/$d" "$pkg/$d"
done
cat > "$pkg/Package.swift" <<'EOF'
// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "tc-computer-text",
    targets: [
        .target(name: "ComputerProtocol"),
        .target(name: "ComputerServiceKit", dependencies: ["ComputerProtocol"]),
        .target(name: "AXText", dependencies: ["ComputerProtocol"]),
        .testTarget(name: "ComputerProtocolTests", dependencies: ["ComputerProtocol"]),
        .testTarget(name: "ComputerServiceKitTests", dependencies: ["ComputerServiceKit", "ComputerProtocol"]),
        .testTarget(name: "AXTextTests", dependencies: ["AXText"], exclude: ["QuoteVectors.json", "Fixtures"])
    ]
)
EOF
cd "$pkg"
swift test "$@"
