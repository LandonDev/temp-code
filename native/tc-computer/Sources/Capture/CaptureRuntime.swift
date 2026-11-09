import AppKit
import CoreGraphics

/// The process state ScreenCaptureKit needs (docs/computer-protocol.md §6).
public enum CaptureRuntime {
    @MainActor private static var prepared = false

    /// ScreenCaptureKit asserts in a process that has not touched `NSApplication.shared` and
    /// `CGMainDisplayID()` before its first capture. The Service shell calls this in `main`;
    /// every Capture entry point calls it too. Idempotent.
    @MainActor public static func prepare() {
        guard !prepared else { return }
        _ = NSApplication.shared
        _ = CGMainDisplayID()
        prepared = true
    }
}

