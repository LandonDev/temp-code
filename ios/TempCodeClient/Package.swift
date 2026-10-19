// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "TempCodeClient",
    platforms: [.iOS(.v18), .macOS(.v15)],
    products: [
        .library(name: "TempCodeClient", targets: ["TempCodeClient"])
    ],
    dependencies: [
        .package(path: "../TempCodeContract")
    ],
    targets: [
        .target(
            name: "TempCodeClient",
            dependencies: [.product(name: "TempCodeContract", package: "TempCodeContract")],
            swiftSettings: [
                // Approachable concurrency: an async function runs where it was
                // called from; only `@concurrent` moves work off the caller's actor.
                .enableUpcomingFeature("NonisolatedNonsendingByDefault"),
                .enableUpcomingFeature("InferIsolatedConformances")
            ]
        ),
        .testTarget(
            name: "TempCodeClientTests",
            dependencies: ["TempCodeClient"],
            swiftSettings: [
                .enableUpcomingFeature("NonisolatedNonsendingByDefault"),
                .enableUpcomingFeature("InferIsolatedConformances")
            ]
        )
    ]
)
