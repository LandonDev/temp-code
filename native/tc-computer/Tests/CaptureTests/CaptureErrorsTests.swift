@testable import Capture
import ComputerCore
import ComputerProtocol
import Foundation
@preconcurrency import ScreenCaptureKit
import Testing

private func scError(_ code: SCStreamError.Code) -> NSError {
    NSError(domain: SCStreamErrorDomain, code: code.rawValue, userInfo: [NSLocalizedDescriptionKey: "the system's words"])
}

@Suite struct CaptureErrorsTests {
    @Test func aRefusedGrantIsScreenRecordingMissing() {
        for code in [SCStreamError.Code.userDeclined, .missingEntitlements] {
            let failure = CaptureErrors.failure(scError(code), windowID: 7)
            #expect(failure.error.kind == .permissionMissing)
            #expect(failure.error.which == .screenRecording)
        }
    }

    @Test func aMissingSourceIsWindowNotFound() {
        for code in [SCStreamError.Code.noCaptureSource, .noWindowList] {
            #expect(CaptureErrors.failure(scError(code), windowID: 7).error.kind == .windowNotFound)
        }
    }

    @Test func anythingElseIsCaptureFailedWithTheSystemsWords() {
        let failure = CaptureErrors.failure(scError(.internalError), windowID: 7)
        #expect(failure.error.kind == .captureFailed)
        #expect(failure.error.message.contains("the system's words"))
        let foreign = CaptureErrors.failure(NSError(domain: "elsewhere", code: 1, userInfo: [NSLocalizedDescriptionKey: "odd"]), windowID: 7)
        #expect(foreign.error.kind == .captureFailed)
        #expect(foreign.error.message.contains("odd"))
    }

    @Test func aComputerFailurePassesThrough() {
        let timedOut = ComputerFailure.captureTimedOut
        #expect(CaptureErrors.failure(timedOut, windowID: 7) == timedOut)
    }

    @Test func aStreamsEndSaysWhy() {
        #expect(CaptureErrors.endReason(scError(.userStopped)) == .stopped)
        #expect(CaptureErrors.endReason(scError(.noCaptureSource)) == .windowClosed)
        #expect(CaptureErrors.endReason(scError(.noWindowList)) == .windowClosed)
        #expect(CaptureErrors.endReason(scError(.userDeclined)) == .permission)
        #expect(CaptureErrors.endReason(scError(.failedToStart)) == .error("the system's words"))
        #expect(StreamEndReason.windowClosed.wire.rawValue == "window-closed")
        #expect(StreamEndReason.error("x").wire.rawValue == "error")
    }
}
