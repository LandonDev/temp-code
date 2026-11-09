@testable import Capture
import ComputerCore
import ComputerProtocol
import Foundation
import os
@preconcurrency import ScreenCaptureKit
import Testing

/// A shareable-window source that only counts: any call at all is a failure here.
private final class CountingWindows: ShareableWindowSource, @unchecked Sendable {
    let calls = OSAllocatedUnfairLock(initialState: 0)

    func window(id: UInt32, expectedSize: CGSize) async throws -> SCWindow {
        calls.withLock { $0 += 1 }
        throw ComputerFailure.captureFailed("the fake has no windows")
    }

    func invalidate() {}
}

private func expectScreenRecordingMissing(_ body: () async throws -> Void) async {
    do {
        try await body()
        Issue.record("expected permission_missing")
    } catch let failure as ComputerFailure {
        #expect(failure.error.kind == .permissionMissing)
        #expect(failure.error.which == .screenRecording)
    } catch {
        Issue.record("expected a ComputerFailure, got \(error)")
    }
}

@Suite struct PermissionGateTests {
    @Test func noCaptureCallReachesScreenCaptureKitWithTheGrantOff() async {
        let windows = CountingWindows()
        let capture = ScreenCaptureKitCapture(granted: { false }, windows: windows)
        await expectScreenRecordingMissing {
            _ = try await capture.screenshot(windowID: 1, maxEdge: 1_280, regionPoints: nil, format: nil, to: "/tmp/never/0001-observe")
        }
        await expectScreenRecordingMissing {
            _ = try await capture.startStream(windowID: 1, fps: 4, maxEdge: 960) { _ in }
        }
        await expectScreenRecordingMissing {
            _ = try await capture.watch(windowID: 1)
        }
        #expect(windows.calls.withLock { $0 } == 0)
        #expect(!FileManager.default.fileExists(atPath: "/tmp/never"))
    }
}

@Suite struct ShotFileTests {
    @Test func aShotIsWrittenWholeAndNeverReplaced() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("tc-shot-file-\(UUID().uuidString)").path
        let path = "\(directory)/shots/s/0001-observe.jpg"
        try ShotFile.write(Data([1, 2, 3]), to: path)
        #expect(FileManager.default.contents(atPath: path) == Data([1, 2, 3]))
        #expect(!FileManager.default.fileExists(atPath: path + ".tmp"))
        let mode = try FileManager.default.attributesOfItem(atPath: "\(directory)/shots/s")[.posixPermissions] as? Int
        #expect(mode == 0o700)
        #expect(throws: ComputerFailure.self) { try ShotFile.write(Data([9]), to: path) }
        #expect(FileManager.default.contents(atPath: path) == Data([1, 2, 3]))
        #expect(!FileManager.default.fileExists(atPath: path + ".tmp"))
    }
}
