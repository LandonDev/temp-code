// capture-proof: Capture's live proof on the Mac (docs/computer-protocol.md §6, plan §10).
// Never shipped: the app's build makes --product tc-computer alone.
//
//   capture-proof --out /tmp/tc-capture-proof   the scenes; report.json and the images in --out
//   capture-proof --target <title>              the helper: one inert window to capture
//
// An accessory app: it never activates, and every window it shows is inert (SceneWindow.swift).
#if canImport(ScreenCaptureKit)

import AppKit
import Foundation

let arguments = CommandLine.arguments
func argument(_ name: String) -> String? {
    arguments.firstIndex(of: name).flatMap { $0 + 1 < arguments.count ? arguments[$0 + 1] : nil }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)

if let title = argument("--target") {
    MainActor.assumeIsolated { TargetWindow.show(title: title) }
} else {
    let out = URL(fileURLWithPath: argument("--out") ?? "/tmp/tc-capture-proof", isDirectory: true)
    // Shots are never replaced, so each run starts from an empty output directory.
    try? FileManager.default.removeItem(at: out)
    try FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
    Task { @MainActor in
        let only = argument("--scenes").map { Set($0.split(separator: ",").map(String.init)) }
        let code = await Proof(out: out, only: only, screen: argument("--screen").flatMap(Int.init)).run()
        exit(code)
    }
}
app.run()

#endif
