import Foundation
import QuartzCore
import SwiftUI
import os

/// DEBUG-only hooks the simulator proof drives through the process
/// environment: which segment to open, what to open inside it, and the
/// scroll run that measures frames. Release builds read nothing.
enum TestHooks {
    #if DEBUG
    private static let env = ProcessInfo.processInfo.environment
    /// `board`, `chat`, `plan`, `fleet`, `log` or `sources`.
    static let segment = env["TC_TEST_SEGMENT"].flatMap(Segment.init(rawValue:))
    /// `chip` opens the first tool chip with a held-back body, `diff` pushes
    /// the first edit's diff, `agent` pushes the first subagent.
    static let open = env["TC_TEST_OPEN"].flatMap { $0.isEmpty ? nil : $0 }
    /// Scrolls the whole transcript top and back while a display link
    /// records every frame; the report lands in Documents/scroll-report.json.
    static let scroll = env["TC_TEST_SCROLL"] == "1"
    #else
    static let segment: Segment? = nil
    static let open: String? = nil
    static let scroll = false
    #endif
}

/// Frame intervals from a display link while a scroll runs: how many frames
/// came more than 8 ms late, and the worst one.
final class FrameRecorder: NSObject {
    private var link: CADisplayLink?
    private var last: CFTimeInterval?
    private var intervals: [Double] = []
    private var expected: Double = 1 / 60
    private let log = Logger(subsystem: "dev.landon.tempcode", category: "scroll")

    struct Report: Codable {
        var frames: Int
        var maxFramesPerSecond: Int
        var expectedMs: Double
        var hitches: Int
        var worstMs: Double
        var meanMs: Double
        var over16Ms: Int
        /// Scroll offsets seen and the distance between the lowest and highest: proof the run moved.
        var offsetSamples: Int
        var travelPt: Double
        /// When each late frame landed, in seconds since the run began (the first 20).
        var hitchAtS: [Double]
    }

    private var startedAt: CFTimeInterval?
    private var hitchTimes: [Double] = []

    private var minOffset = Double.greatestFiniteMagnitude
    private var maxOffset = -Double.greatestFiniteMagnitude
    private var offsetSamples = 0

    /// A scroll offset the view saw while the run was on.
    func noteOffset(_ y: CGFloat) {
        guard link != nil else { return }
        offsetSamples += 1
        minOffset = min(minOffset, y)
        maxOffset = max(maxOffset, y)
    }

    func start() {
        let link = CADisplayLink(target: self, selector: #selector(tick(_:)))
        link.preferredFrameRateRange = CAFrameRateRange(minimum: 80, maximum: 120, preferred: 120)
        link.add(to: .main, forMode: .common)
        self.link = link
    }

    @objc private func tick(_ link: CADisplayLink) {
        expected = link.targetTimestamp - link.timestamp
        if startedAt == nil { startedAt = link.timestamp }
        if let last {
            let interval = (link.timestamp - last) * 1_000
            intervals.append(interval)
            if interval - expected * 1_000 > 8, hitchTimes.count < 20 { hitchTimes.append(link.timestamp - (startedAt ?? link.timestamp)) }
        }
        last = link.timestamp
    }

    func stop() -> Report {
        link?.invalidate()
        link = nil
        let expectedMs = expected * 1_000
        let hitches = intervals.count { $0 - expectedMs > 8 }
        let worst = intervals.max() ?? 0
        let mean = intervals.isEmpty ? 0 : intervals.reduce(0, +) / Double(intervals.count)
        let travel = offsetSamples > 0 ? maxOffset - minOffset : 0
        let report = Report(frames: intervals.count, maxFramesPerSecond: UIScreen.main.maximumFramesPerSecond, expectedMs: expectedMs, hitches: hitches, worstMs: worst, meanMs: mean, over16Ms: intervals.count { $0 > 16.7 }, offsetSamples: offsetSamples, travelPt: travel, hitchAtS: hitchTimes.map { ($0 * 10).rounded() / 10 })
        log.notice("scroll frames=\(report.frames) hitches=\(report.hitches) worst=\(report.worstMs, format: .fixed(precision: 1))ms mean=\(report.meanMs, format: .fixed(precision: 2))ms travel=\(travel, format: .fixed(precision: 0))pt")
        if let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first, let data = try? JSONEncoder().encode(report) {
            try? data.write(to: documents.appending(path: "scroll-report.json"))
        }
        return report
    }
}
