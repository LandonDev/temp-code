import Foundation
import TempCodeClient
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
    static let segment = env["TC_TEST_SEGMENT"].flatMap(ThreadSegment.init(rawValue:))
    /// `chip` opens the first tool chip with a held-back body, `group` opens
    /// the first activity group and lands on it, `diff` pushes
    /// the first edit's diff, `agent` pushes the first subagent, `agents`
    /// pushes the subagent list from the toolbar button once the thread has
    /// children, `rename` opens the inline title field once the thread is
    /// loaded (the proof types nothing), `report` opens the research report,
    /// `source` the first source's page, `account` opens the header's
    /// account menu sheet, `composer` focuses the chat field (the keyboard
    /// up; an operate key). On a master's board, `rules`, `add-thread`,
    /// `adopt` and `archive-done` open that sheet once the batch has landed.
    static let open = env["TC_TEST_OPEN"].flatMap { $0.isEmpty ? nil : $0 }
    /// Scrolls the whole transcript top and back while a display link
    /// records every frame; the report lands in Documents/scroll-report.json.
    static let scroll = env["TC_TEST_SCROLL"] == "1"
    static let targetSeq = env["TC_TEST_TARGET_SEQ"].flatMap(Int.init)
    static let history = env["TC_TEST_HISTORY"] == "1"
    /// An action the thread screen performs once its rows are in, through the
    /// same calls the buttons make: `send:<text>`, `stop`, `approve`, `deny`,
    /// `answer:<label>`, `start-build`, `rename:<title>`, `pin`, `archive`,
    /// `start-now` (a queued thread), `resume` (a stopped or paused one),
    /// `stop-step` (a master's running step), `set-master` (toggles the pin; an admin key).
    static let action = env["TC_TEST_ACTION"].flatMap { $0.isEmpty ? nil : $0 }
    /// A sheet to open for the shot: `start` on a planning thread, `new` on Home,
    /// `fleet:pause|fleet:stop|fleet:archive` (the fleet confirm on Home),
    /// `resources` (the Resources sheet on a thread), `archive` (the archive prompt on a thread with resources).
    /// Actions, in the list above: `batch:pause|batch:resume|batch:stop|batch:archive` on Home run the host-scope
    /// batch without the sheet; `archive-remove` and `remove-resources` on a thread.
    static let sheet = env["TC_TEST_SHEET"].flatMap { $0.isEmpty ? nil : $0 }
    /// With `TC_TEST_ROUTE=notification`: "title part|seq", a payload the delegate routes like a tap.
    static let notification = env["TC_TEST_NOTIFICATION"].flatMap { $0.isEmpty ? nil : $0 }
    #else
    static let segment: ThreadSegment? = nil
    static let open: String? = nil
    static let scroll = false
    static let targetSeq: Int? = nil
    static let history = false
    static let action: String? = nil
    static let sheet: String? = nil
    static let notification: String? = nil
    #endif
    /// `pause`, `resume`, `stop` or `archive` as the fleet's action.
    static func batchAction(_ name: String) -> BatchAction? {
        switch name {
        case "pause": .pause
        case "resume": .resume
        case "stop": .stop
        case "archive": .archiveDone
        default: nil
        }
    }

    /// The bottom dock's height in points (the chat bar's resting height
    /// when nothing is typed), written once it settles: dock-report.json
    /// holds it in tenths of a point beside the composer's focus state.
    static func recordDock(height: CGFloat, focused: Bool) {
        #if DEBUG
        guard env["TC_TEST_ROUTE"] == "thread" else { return }
        writeReport(focused ? "dock-report-focused" : "dock-report", ["height10": Int((height * 10).rounded())])
        #endif
    }

    static func recordNavigation(target: Int, item: Int?, oldest: Int?) {
        #if DEBUG
        guard targetSeq != nil || notification != nil else { return }
        writeReport("navigation-report", ["target": target, "item": item ?? -1, "oldest": oldest ?? -1])
        #endif
    }

    static func recordHistory(_ thread: ThreadState) {
        #if DEBUG
        guard history, !thread.rows.isEmpty, !thread.isLoading, !thread.isLoadingHistory else { return }
        writeReport("board-history-report", ["oldest": thread.rows.first?.seq ?? -1, "rows": thread.rows.count,
            "rounds": thread.fold.board.rounds.count, "todos": thread.fold.board.todos.count,
            "sources": thread.fold.board.sources.count, "complete": thread.moreBefore ? 0 : 1])
        #endif
    }

    #if DEBUG
    private static func writeReport(_ name: String, _ fields: [String: Int]) {
        guard let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first,
              let data = try? JSONEncoder().encode(fields) else { return }
        try? data.write(to: documents.appending(path: "\(name).json"), options: .atomic)
    }
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
        var driver: String
        var initialOffset: Double
        var curve: String
        var scrollFrames: Int
        var scrollHitches: Int
        var scrollWorstMs: Double
        var lateFrames: [LateFrame]
        var sourceRows: Int
        var items: Int
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

    struct LateFrame: Codable {
        var atS: Double
        var intervalMs: Double
        var offset: Double
        var previousOffset: Double
        var moving: Bool
    }

    private var movingIntervals: [Double] = []
    private var lateFrames: [LateFrame] = []
    private weak var scrollView: UIScrollView?
    private var initialOffset = 0.0
    private var lastOffset: Double?
    private var sourceRows = 0
    private var items = 0
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

    func start(sourceRows: Int, items: Int, scrollView: UIScrollView) {
        self.scrollView = scrollView
        initialOffset = scrollView.contentOffset.y
        self.sourceRows = sourceRows
        self.items = items
        let link = CADisplayLink(target: self, selector: #selector(tick(_:)))
        link.preferredFrameRateRange = CAFrameRateRange(minimum: 80, maximum: 120, preferred: 120)
        link.add(to: .main, forMode: .common)
        self.link = link
    }

    @objc private func tick(_ link: CADisplayLink) {
        expected = link.targetTimestamp - link.timestamp
        if startedAt == nil { startedAt = link.timestamp }
        let elapsed = link.timestamp - (startedAt ?? link.timestamp)
        let offset = scrollView?.contentOffset.y ?? 0
        let previous = lastOffset ?? offset
        let moving = abs(offset - previous) > 0.01
        if let last {
            let interval = (link.timestamp - last) * 1_000
            intervals.append(interval)
            if moving { movingIntervals.append(interval) }
            if interval - expected * 1_000 > 8 {
                if hitchTimes.count < 20 { hitchTimes.append(elapsed) }
                if lateFrames.count < 20 { lateFrames.append(LateFrame(atS: elapsed, intervalMs: interval, offset: offset, previousOffset: previous, moving: moving)) }
            }
        }
        last = link.timestamp
        lastOffset = offset
        if let scrollView {
            let top = -scrollView.adjustedContentInset.top
            let bottom = max(top, scrollView.contentSize.height - scrollView.bounds.height + scrollView.adjustedContentInset.bottom)
            let target = elapsed < 26
                ? initialOffset + (top - initialOffset) * min(1, elapsed / 25)
                : top + (bottom - top) * min(1, (elapsed - 26) / 25)
            scrollView.setContentOffset(CGPoint(x: scrollView.contentOffset.x, y: target), animated: false)
        }
    }

    func stop() -> Report {
        link?.invalidate()
        link = nil
        let expectedMs = expected * 1_000
        let hitches = intervals.count { $0 - expectedMs > 8 }
        let worst = intervals.max() ?? 0
        let mean = intervals.isEmpty ? 0 : intervals.reduce(0, +) / Double(intervals.count)
        let travel = offsetSamples > 0 ? maxOffset - minOffset : 0
        let report = Report(driver: "native-list-offset", initialOffset: initialOffset, curve: "linear", scrollFrames: movingIntervals.count, scrollHitches: movingIntervals.count { $0 - expectedMs > 8 }, scrollWorstMs: movingIntervals.max() ?? 0, lateFrames: lateFrames, sourceRows: sourceRows, items: items, frames: intervals.count, maxFramesPerSecond: UIScreen.main.maximumFramesPerSecond, expectedMs: expectedMs, hitches: hitches, worstMs: worst, meanMs: mean, over16Ms: intervals.count { $0 > 16.7 }, offsetSamples: offsetSamples, travelPt: travel, hitchAtS: hitchTimes.map { ($0 * 10).rounded() / 10 })
        log.notice("scroll frames=\(report.frames) hitches=\(report.hitches) worst=\(report.worstMs, format: .fixed(precision: 1))ms mean=\(report.meanMs, format: .fixed(precision: 2))ms travel=\(travel, format: .fixed(precision: 0))pt")
        if let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first, let data = try? JSONEncoder().encode(report) {
            try? data.write(to: documents.appending(path: "scroll-report.json"))
        }
        return report
    }
}

/// Finds the native scroll view containing the proof's bottom sentinel.
struct ScrollProofProbe: UIViewRepresentable {
    let found: @MainActor (UIScrollView) -> Void

    func makeUIView(context: Context) -> ProbeView {
        let view = ProbeView()
        view.found = found
        return view
    }

    func updateUIView(_ view: ProbeView, context: Context) {
        view.found = found
        view.resolve()
    }

    final class ProbeView: UIView {
        var found: (@MainActor (UIScrollView) -> Void)?

        override func didMoveToWindow() {
            super.didMoveToWindow()
            resolve()
        }

        func resolve() {
            var parent = superview
            while let view = parent {
                if let scroll = view as? UIScrollView {
                    let callback = found
                    found = nil
                    Task { callback?(scroll) }
                    return
                }
                parent = view.superview
            }
        }
    }
}
