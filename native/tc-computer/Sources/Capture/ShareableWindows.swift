#if canImport(ScreenCaptureKit)

import ComputerCore
import Foundation
import os
@preconcurrency import ScreenCaptureKit

/// Where ScreenCaptureKitCapture finds a window's `SCWindow`. The tests substitute one that
/// counts its calls, to prove no ScreenCaptureKit call happens while the grant is off.
public protocol ShareableWindowSource: Sendable {
    func window(id: UInt32, expectedSize: CGSize) async throws -> SCWindow
    /// Drops the cache; the shell calls it on `window/changed`.
    func invalidate()
}

/// The last shareable-content list, kept because asking costs about 44 ms. It lists windows on
/// every Space (`onScreenWindowsOnly: false`), and a window is picked by its CGWindowID alone.
public final class ShareableWindows: ShareableWindowSource, @unchecked Sendable {
    private let cache = OSAllocatedUnfairLock<SCShareableContent?>(uncheckedState: nil)
    private let list: @Sendable () async throws -> SCShareableContent
    private let timeout: Duration

    /// `list` asks ScreenCaptureKit for every window (the tests give one that never answers), within `timeout`.
    public init(
        list: @escaping @Sendable () async throws -> SCShareableContent = { try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false) },
        timeout: Duration = CaptureTuning.listTimeout
    ) {
        self.list = list
        self.timeout = timeout
    }

    /// The window, refreshing the list once when it is missing or its size has moved more than
    /// 0.5 pt from the live bounds; still missing, `window_not_found`.
    public func window(id: UInt32, expectedSize: CGSize) async throws -> SCWindow {
        if let cached = cache.withLockUnchecked({ $0 }), let window = Self.find(id, in: cached), Self.fits(window, expectedSize) {
            return window
        }
        let fresh = try await withDeadline(timeout, failure: ComputerFailure.captureTimedOut, list)
        cache.withLockUnchecked { $0 = fresh }
        guard let window = Self.find(id, in: fresh) else { throw ComputerFailure.windowGone(id) }
        return window
    }

    public func invalidate() {
        cache.withLockUnchecked { $0 = nil }
    }

    static func find(_ id: UInt32, in content: SCShareableContent) -> SCWindow? {
        content.windows.first { $0.windowID == id }
    }

    static func fits(_ window: SCWindow, _ size: CGSize) -> Bool {
        abs(window.frame.width - size.width) <= 0.5 && abs(window.frame.height - size.height) <= 0.5
    }
}

#endif
