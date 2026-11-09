// swift-tools-version: 6.0
// tc-computer: TempCode's computer-use service on the Mac (docs/computer-protocol.md).
// Every target is declared here; each sibling thread fills its own.
import PackageDescription

let package = Package(
    name: "tc-computer",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "tc-computer", targets: ["tc-computer"]),
        .library(name: "ComputerProtocol", targets: ["ComputerProtocol"])
    ],
    targets: [
        // The wire: Generated/ from src/shared/computer/protocol.ts, plus the framing. Foundation only.
        .target(name: "ComputerProtocol"),
        // The seams the Service shell joins (Seams.swift); no implementation.
        .target(name: "ComputerCore", dependencies: ["ComputerProtocol"]),
        // The AX reader's rules that need no live element: keep, index, fold, budget, render, diff.
        // Foundation only, so the box tests it on its Linux toolchain.
        .target(name: "AXText", dependencies: ["ComputerProtocol"]),
        // AX tree → indexed text, the diff, the element map, the change monitor. Every file sits under
        // `#if canImport(ApplicationServices)`, so the package still builds on Linux.
        .target(name: "AXReader", dependencies: ["ComputerCore", "AXText"]),
        // The AX reader's dev tool for the live proof and the timings (scripts/mac/ax-reader-proof.sh); never shipped.
        .executableTarget(name: "tc-ax", dependencies: ["AXReader", "AXText", "ComputerCore"]),
        // The ax, process and session tiers, the key table, the clipboard paste.
        .target(
            name: "Input",
            dependencies: ["ComputerCore"],
            linkerSettings: [.linkedFramework("AppKit"), .linkedFramework("Carbon"), .linkedFramework("ApplicationServices")]
        ),
        // Window screenshots, the preview stream and the pixel watch (ScreenCaptureKit).
        .target(name: "Capture", dependencies: ["ComputerProtocol", "ComputerCore"]),
        // The stdio server, the smart wait, the clipboard lock, TCC, the lifecycle.
        .target(name: "ComputerService", dependencies: ["ComputerProtocol", "ComputerCore", "AXReader", "Input", "Capture"]),
        .executableTarget(name: "tc-computer", dependencies: ["ComputerService"]),
        // Capture's live proof on the Mac (scripts/mac/proof-computer-capture.sh); never shipped:
        // the app's build makes --product tc-computer alone.
        .executableTarget(name: "capture-proof", dependencies: ["Capture", "ComputerCore", "ComputerProtocol"]),
        // Input's live proof on scratch windows (scripts/mac/input-proof.sh); never shipped, as capture-proof.
        .executableTarget(name: "tc-input-proof", dependencies: ["Input"]),
        .testTarget(name: "ComputerProtocolTests", dependencies: ["ComputerProtocol"]),
        .testTarget(name: "CaptureTests", dependencies: ["Capture", "ComputerCore", "ComputerProtocol"]),
        // Input's offline suites; fixtures are read by path from the repository through #filePath.
        .testTarget(name: "InputTests", dependencies: ["Input"]),
        // The reader's rules on hand-built snapshots and the recorded fixtures' goldens; runs on the box and the Mac.
        .testTarget(name: "AXTextTests", dependencies: ["AXText"], exclude: ["QuoteVectors.json"]),
        // The live side without a live app: error mapping, handles, window ids, the change signal. Mac only.
        .testTarget(name: "AXReaderTests", dependencies: ["AXReader", "AXText"])
    ]
)
