#!/bin/sh
# The pure targets off the Mac (the box's Linux toolchain): a scratch package
# of ComputerProtocol, ComputerServiceKit, AXText and their tests, its
# directories linked back into this checkout, so the tests read the fixtures in
# place and TC_AX_GOLDEN=update rewrites them there; and Input's Foundation-only
# files ($INPUT_PURE) with their suites ($INPUT_PURE_TESTS) as InputPure, linked
# file by file. The whole of native/tc-computer builds only on the Mac (Input and
# Capture import Apple frameworks unguarded).
#
#   sh scripts/computer-text-test.sh [swift test arguments]
set -e
root=$(cd "$(dirname "$0")/.." && pwd)
work=${TC_TEXT_TEST_DIR:-/tmp/tc-computer-text-$(id -u)}
pkg="$work/native/tc-computer"
mkdir -p "$pkg/Sources" "$pkg/Tests"
ln -sfn "$root/src" "$work/src"
for d in Sources/ComputerProtocol Sources/ComputerServiceKit Sources/AXText Sources/ComputerCore Tests/ComputerProtocolTests Tests/ComputerServiceKitTests Tests/AXTextTests; do
  ln -sfn "$root/native/tc-computer/$d" "$pkg/$d"
done
INPUT_PURE="Evidence.swift InputTiming.swift InputClock.swift KeyCombo.swift KeyCodes.swift KeyLayout.swift Geometry.swift TextMatch.swift
  TierPlan.swift MenuShortcut.swift MenuSearch.swift HitPlan.swift ScrollPlan.swift PasteFlow.swift PersonMark.swift PersonGuard.swift
  FrontPlan.swift PanelPlan.swift Generated/InputTables.swift"
INPUT_PURE_TESTS="FallbackTests.swift PersonGuardTests.swift FrontRouteTests.swift FrontPlanTests.swift PanelPlanTests.swift"
rm -rf "$pkg/Sources/InputPure" "$pkg/Tests/InputPureTests"
mkdir -p "$pkg/Sources/InputPure" "$pkg/Tests/InputPureTests"
for f in $INPUT_PURE; do ln -sfn "$root/native/tc-computer/Sources/Input/$f" "$pkg/Sources/InputPure/$(basename "$f")"; done
for f in $INPUT_PURE_TESTS; do ln -sfn "$root/native/tc-computer/Tests/InputTests/$f" "$pkg/Tests/InputPureTests/$f"; done
# the one failure the pure files share with the session flow, which is the Mac's
printf '%s\n' 'import ComputerCore' 'func cancelledFailure() -> ComputerFailure { ComputerFailure(.cancelled, "Cancelled.") }' > "$pkg/Sources/InputPure/Failures.swift"
cat > "$pkg/Package.swift" <<'EOF'
// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "tc-computer-text",
    targets: [
        .target(name: "ComputerProtocol"),
        .target(name: "ComputerServiceKit", dependencies: ["ComputerProtocol"]),
        .target(name: "AXText", dependencies: ["ComputerProtocol"]),
        .target(name: "ComputerCore", dependencies: ["ComputerProtocol"]),
        .target(name: "InputPure", dependencies: ["ComputerCore", "ComputerProtocol"]),
        .testTarget(name: "ComputerProtocolTests", dependencies: ["ComputerProtocol"]),
        .testTarget(name: "ComputerServiceKitTests", dependencies: ["ComputerServiceKit", "ComputerProtocol"]),
        .testTarget(name: "AXTextTests", dependencies: ["AXText"], exclude: ["QuoteVectors.json", "Fixtures"]),
        .testTarget(name: "InputPureTests", dependencies: ["InputPure", "ComputerCore", "ComputerProtocol"])
    ]
)
EOF
cd "$pkg"
swift test "$@"
