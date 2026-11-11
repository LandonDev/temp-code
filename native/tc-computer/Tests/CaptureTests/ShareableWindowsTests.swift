#if canImport(ScreenCaptureKit)

@testable import Capture
import ComputerCore
import Foundation
@preconcurrency import ScreenCaptureKit
import Testing

/// ScreenCaptureKit's window list is bounded: a list that never answers fails the lookup on time, so a read goes on
/// without the window's pixels instead of hanging (a web leg's read on 2026-11-11).
@Suite struct ShareableWindowsTests {
    @Test func aWindowListThatNeverAnswersTimesOut() async {
        let windows = ShareableWindows(list: {
            try await Task.sleep(for: .seconds(60))
            throw CancellationError()
        }, timeout: .milliseconds(100))
        let started = ContinuousClock.now
        await #expect(throws: ComputerFailure.self) { _ = try await windows.window(id: 1, expectedSize: .zero) }
        #expect(ContinuousClock.now - started < .seconds(2))
    }
}

#endif
