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
        // AX tree → indexed text, the diff, the element map, the change monitor.
        .target(name: "AXReader", dependencies: ["ComputerCore"]),
        // The ax, process and session tiers, the key table, the clipboard paste.
        .target(name: "Input", dependencies: ["ComputerCore"]),
        // Window screenshots, the preview stream and the pixel watch (ScreenCaptureKit).
        .target(name: "Capture", dependencies: ["ComputerProtocol", "ComputerCore"]),
        // The stdio server, the smart wait, the clipboard lock, TCC, the lifecycle.
        .target(name: "ComputerService", dependencies: ["ComputerProtocol", "ComputerCore", "AXReader", "Input", "Capture"]),
        .executableTarget(name: "tc-computer", dependencies: ["ComputerService"]),
        // Capture's live proof on the Mac (scripts/mac/proof-computer-capture.sh); never shipped:
        // the app's build makes --product tc-computer alone.
        .executableTarget(name: "capture-proof", dependencies: ["Capture", "ComputerCore", "ComputerProtocol"]),
        .testTarget(name: "ComputerProtocolTests", dependencies: ["ComputerProtocol"]),
        .testTarget(name: "CaptureTests", dependencies: ["Capture", "ComputerCore", "ComputerProtocol"])
    ]
)
