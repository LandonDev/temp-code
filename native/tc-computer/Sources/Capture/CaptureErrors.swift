import ComputerCore
import ComputerProtocol
import Foundation
import ScreenCaptureKit

/// ScreenCaptureKit's errors, as the wire says them (docs/computer-protocol.md §6, §8).
public enum CaptureErrors {
    /// A screenshot's or a stream start's failure.
    public static func failure(_ error: any Error, windowID: UInt32) -> ComputerFailure {
        if let failure = error as? ComputerFailure { return failure }
        switch code(of: error) {
        case .userDeclined?, .missingEntitlements?:
            return .screenRecordingMissing
        case .noCaptureSource?, .noWindowList?:
            return .windowGone(windowID)
        default:
            return .captureFailed("ScreenCaptureKit refused the capture: \(error.localizedDescription)")
        }
    }

    /// Why a running stream ended, from the error its delegate got.
    public static func endReason(_ error: any Error) -> StreamEndReason {
        switch code(of: error) {
        case .userStopped?:
            return .stopped
        case .noCaptureSource?, .noWindowList?:
            return .windowClosed
        case .userDeclined?, .missingEntitlements?:
            return .permission
        default:
            return .error(error.localizedDescription)
        }
    }

    /// The ScreenCaptureKit code of an error, if it is one of its.
    static func code(of error: any Error) -> SCStreamError.Code? {
        let error = error as NSError
        guard error.domain == SCStreamErrorDomain else { return nil }
        return SCStreamError.Code(rawValue: error.code)
    }
}
