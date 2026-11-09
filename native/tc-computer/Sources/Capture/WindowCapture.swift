#if canImport(ScreenCaptureKit)

import ComputerCore
import ComputerProtocol
import CoreGraphics
import Foundation
import os
@preconcurrency import ScreenCaptureKit

/// Capture's ScreenCaptureKit side (docs/computer-protocol.md §6, §7): window screenshots, the
/// preview stream and the pixel watch, for one target window, never the whole desktop.
///
/// Nothing here touches ScreenCaptureKit while the Screen Recording grant is off: its calls raise
/// the system's prompt, and prompting is the host's decision. Every entry point checks `granted`
/// first and throws `permission_missing`.
public final class ScreenCaptureKitCapture: WindowCapturing, PixelWatching, @unchecked Sendable {
    private let granted: @Sendable () -> Bool
    private let windows: any ShareableWindowSource
    private let log: @Sendable (String) -> Void
    private let trace: CaptureTraceHandler?
    private let watches = OSAllocatedUnfairLock<[UInt32: WatchStream]>(initialState: [:])

    /// `log` reaches the shell's `log` notification; `trace` hears what the streams do
    /// (`CaptureTrace`), for the proof and a debug log.
    public init(
        granted: @escaping @Sendable () -> Bool = ScreenRecordingAccess.granted,
        windows: any ShareableWindowSource = ShareableWindows(),
        log: @escaping @Sendable (String) -> Void = { _ in },
        trace: CaptureTraceHandler? = nil
    ) {
        self.granted = granted
        self.windows = windows
        self.log = log
        self.trace = trace
    }

    /// The shell calls this on `window/changed`.
    public func invalidate() {
        windows.invalidate()
    }

    // MARK: Screenshots

    public func screenshot(windowID: UInt32, maxEdge: Int, regionPoints: Rect?, format: ShotFormat?, to stem: String) async throws -> Shot {
        let (window, bounds) = try await target(windowID)
        let filter = SCContentFilter(desktopIndependentWindow: window)
        let pointPixelScale = Double(filter.pointPixelScale)
        let size: ShotSize
        var crop: CGRect?
        if let region = regionPoints {
            let zoom = ShotGeometry.zoom(
                window: bounds.size,
                region: CGRect(x: region.x, y: region.y, width: region.w, height: region.h),
                pointPixelScale: pointPixelScale,
                maxEdge: maxEdge
            )
            size = zoom.capture
            crop = zoom.crop
        } else {
            size = ShotGeometry.output(points: bounds.size, pointPixelScale: pointPixelScale, maxEdge: ShotGeometry.clampEdge(maxEdge))
        }
        let configuration = Self.configuration(width: size.width, height: size.height, pixelFormat: kCVPixelFormatType_32BGRA)
        var image: CGImage
        do {
            image = try await withDeadline(CaptureTuning.shotTimeout, failure: ComputerFailure.captureTimedOut) {
                UncheckedImage(try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration))
            }.image
        } catch {
            throw CaptureErrors.failure(error, windowID: windowID)
        }
        let capturedAt = Int(epochMs())
        if let crop {
            guard let cut = image.cropping(to: crop) else { throw ComputerFailure.captureFailed("The zoom's region could not be cut from the window.") }
            image = cut
        }
        let bitmap = Bitmap(image: image)
        let blank = bitmap.map { PixelStats.isBlank($0) } ?? true
        let flatness = format == nil ? bitmap.map { PixelStats.flatness($0) } : nil
        let encoded = try ImageEncoding.encode(image, format: format, flatness: flatness)
        let path = "\(stem).\(ShotNaming.ext(encoded.format))"
        try ShotFile.write(encoded.data, to: path)
        return Shot(
            path: path,
            format: encoded.format,
            width: image.width,
            height: image.height,
            bytes: encoded.data.count,
            scale: size.scale,
            window: Shot.Window(id: Int(windowID), frame: Rect(bounds)),
            region: nil,
            blank: blank,
            capturedAt: capturedAt
        )
    }

    // MARK: The preview stream

    public func startStream(windowID: UInt32, fps: Int, maxEdge: Int, onFrame: @escaping @Sendable (Frame) -> Void) async throws -> any StreamHandle {
        let (window, bounds) = try await target(windowID)
        let stream = PreviewStream(
            windowID: windowID,
            filter: SCContentFilter(desktopIndependentWindow: window),
            points: bounds.size,
            fps: Self.clamp(fps, CaptureTuning.streamFPSRange),
            maxEdge: Self.clamp(maxEdge, CaptureTuning.streamEdgeRange),
            onFrame: onFrame,
            log: log,
            trace: trace
        )
        do {
            try await stream.start()
        } catch {
            throw CaptureErrors.failure(error, windowID: windowID)
        }
        return stream
    }

    // MARK: The pixel watch

    /// Returns at once: starts the window's watch, or renews a running one and returns it.
    public func watch(windowID: UInt32) async throws -> any PixelChangeSignal {
        guard granted() else { throw ComputerFailure.screenRecordingMissing }
        if let running = watches.withLock({ $0[windowID] }), !running.stopped {
            running.touch()
            return running
        }
        let (window, bounds) = try await target(windowID)
        let fresh = WatchStream(windowID: windowID, filter: SCContentFilter(desktopIndependentWindow: window), points: bounds.size, trace: trace) { [weak self] ended in
            self?.watches.withLock { watches in
                if watches[windowID] === ended { watches[windowID] = nil }
            }
        }
        let chosen = watches.withLock { watches -> WatchStream in
            if let running = watches[windowID], !running.stopped { return running }
            watches[windowID] = fresh
            return fresh
        }
        if chosen === fresh {
            Task { await fresh.start() }
        } else {
            chosen.touch()
        }
        return chosen
    }

    // MARK: Shared

    /// The grant, the runtime, the live bounds and the SCWindow, in that order.
    private func target(_ windowID: UInt32) async throws -> (SCWindow, CGRect) {
        guard granted() else { throw ComputerFailure.screenRecordingMissing }
        await CaptureRuntime.prepare()
        guard let bounds = LiveWindows.bounds(windowID) else { throw ComputerFailure.windowGone(windowID) }
        do {
            return (try await windows.window(id: windowID, expectedSize: bounds.size), bounds)
        } catch {
            throw CaptureErrors.failure(error, windowID: windowID)
        }
    }

    /// The configuration every capture shares: no cursor, no shadow margin (it would shift every
    /// coordinate), the whole window even past a screen edge, best resolution, sRGB.
    static func configuration(width: Int, height: Int, pixelFormat: OSType) -> SCStreamConfiguration {
        let configuration = SCStreamConfiguration()
        configuration.width = width
        configuration.height = height
        configuration.showsCursor = false
        configuration.ignoreShadowsSingleWindow = true
        configuration.ignoreGlobalClipSingleWindow = true
        configuration.captureResolution = .best
        configuration.pixelFormat = pixelFormat
        configuration.colorSpaceName = CGColorSpace.sRGB
        return configuration
    }

    static func clamp(_ value: Int, _ range: ClosedRange<Int>) -> Int {
        min(max(value, range.lowerBound), range.upperBound)
    }
}

/// A CGImage across the deadline's task boundary.
struct UncheckedImage: @unchecked Sendable {
    let image: CGImage

    init(_ image: CGImage) {
        self.image = image
    }
}

extension Rect {
    init(_ rect: CGRect) {
        self.init(x: Double(rect.minX), y: Double(rect.minY), w: Double(rect.width), h: Double(rect.height))
    }
}

/// Writing a shot so the host never reads half a file and no shot is ever replaced.
enum ShotFile {
    static func write(_ data: Data, to path: String) throws {
        let directory = (path as NSString).deletingLastPathComponent
        do {
            try FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            try data.write(to: URL(fileURLWithPath: path + ".tmp"))
        } catch {
            throw ComputerFailure.captureFailed("The shot could not be written: \(error.localizedDescription)")
        }
        guard renamex_np(path + ".tmp", path, UInt32(RENAME_EXCL)) == 0 else {
            let code = errno
            unlink(path + ".tmp")
            throw ComputerFailure.captureFailed(code == EEXIST
                ? "A shot already exists at \(path); shots are never replaced."
                : "The shot could not be written: \(String(cString: strerror(code))).")
        }
    }
}

#endif
