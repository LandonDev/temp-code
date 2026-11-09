import ComputerCore
import ComputerProtocol

/// The failures Capture throws, as the wire says them (docs/computer-protocol.md §8).
extension ComputerFailure {
    /// The Screen Recording grant is off. Thrown before any ScreenCaptureKit call, which would
    /// raise the system's prompt.
    static let screenRecordingMissing = ComputerFailure(
        ComputerError(
            kind: .permissionMissing,
            message: "Screen Recording is off for TempCode; turn it on in System Settings, Privacy & Security, Screen & System Audio Recording.",
            which: .screenRecording
        )
    )

    static func windowGone(_ windowID: UInt32) -> ComputerFailure {
        ComputerFailure(.windowNotFound, "Window \(windowID) is gone; list the app's windows again.")
    }

    static func captureFailed(_ message: String) -> ComputerFailure {
        ComputerFailure(.captureFailed, message)
    }

    static let captureTimedOut = captureFailed("The capture timed out.")
}
