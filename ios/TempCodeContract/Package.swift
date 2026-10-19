// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "TempCodeContract",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "TempCodeContract", targets: ["TempCodeContract"])
    ],
    targets: [
        .target(name: "TempCodeContract"),
        .testTarget(
            name: "TempCodeContractTests",
            dependencies: ["TempCodeContract"],
            path: "Tests",
            sources: ["TempCodeContractTests"],
            resources: [.copy("Fixtures")]
        )
    ]
)
