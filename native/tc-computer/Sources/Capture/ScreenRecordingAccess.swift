#if canImport(ScreenCaptureKit)

import CoreGraphics

/// The Screen Recording grant, read without ever prompting. Every Capture entry point checks it
/// before touching ScreenCaptureKit, whose calls raise the system's prompt without it.
public enum ScreenRecordingAccess {
    /// Never prompts.
    public static func granted() -> Bool {
        CGPreflightScreenCaptureAccess()
    }

    /// Shows the system's dialog (once per app; after that it answers at once).
    @discardableResult
    public static func request() -> Bool {
        CGRequestScreenCaptureAccess()
    }
}

#endif
