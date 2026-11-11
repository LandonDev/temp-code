import Foundation
import QuartzCore
import SwiftUI
import TempCodeClient
import UIKit
import os

/// A set of samples as the reports carry it: how many, the percentiles
/// (nearest rank), the worst and the mean, rounded to hundredths.
struct PerfDist: Codable, Equatable {
    var count = 0
    var p50 = 0.0
    var p95 = 0.0
    var p99 = 0.0
    var worst = 0.0
    var mean = 0.0

    init() {}

    init(_ samples: [Double]) {
        guard !samples.isEmpty else { return }
        let sorted = samples.sorted()
        let rank = { (p: Double) in sorted[min(sorted.count - 1, max(0, Int((p * Double(sorted.count)).rounded(.up)) - 1))] }
        count = sorted.count
        p50 = Self.round(rank(0.50))
        p95 = Self.round(rank(0.95))
        p99 = Self.round(rank(0.99))
        worst = Self.round(sorted[sorted.count - 1])
        mean = Self.round(sorted.reduce(0, +) / Double(sorted.count))
    }

    static func round(_ value: Double) -> Double { (value * 100).rounded() / 100 }
}

/// A row that moved on screen by more than the scroll explains.
struct PerfJump: Codable, Equatable {
    var atS: Double
    /// Points the row moved beyond the offset's own change; negative is up.
    var pt: Double
    var rowKey: Int
    /// 0 for the cold pass, 1 for the warm one.
    var pass: Int
}

/// What a recording measured, beside the frames: the main thread's CPU per
/// display interval, the cost of each timed turn, and what the scroll
/// driver saw (`PerfRunner` adds the counters and writes the report).
struct FrameMeasure {
    var seconds = 0.0
    var maxFramesPerSecond = 60
    var expectedMs = 1000.0 / 60
    var intervals: [Double] = []
    var cpu: [Double] = []
    /// Per turn that applied pushed rows: CPU and wall milliseconds per batch, and the rows built for it.
    var batchCpu: [Double] = []
    var batchWall: [Double] = []
    var batchRows: [Double] = []
    /// Per turn that inserted a key.
    var keyCpu: [Double] = []
    var keyWall: [Double] = []
    var jumps: [PerfJump] = []
    /// Points the driver moved the list in the cold pass and the warm one.
    var travel = [0.0, 0.0]
    var jumpUps = 0

    /// Frames later than one and a half intervals, and the time they ran over.
    var late: Int { intervals.count { $0 > expectedMs * 1.5 } }
    var hitchMs: Double { intervals.reduce(0) { $0 + ($1 > expectedMs * 1.5 ? $1 - expectedMs : 0) } }
}

/// Frame intervals from a display link while a scroll runs: how many frames
/// came more than 8 ms late, and the worst one. The `scroll` driver moves
/// the offset itself (two 25 s glides); the `stream` driver moves nothing
/// and records while a turn streams with the reader pinned at the bottom
/// (`pinned` is read each frame; `seq` the thread's row count, partials
/// included). The `perf` driver is the performance proofs' and the
/// Diagnostics screen's: it also reads the main thread's CPU time at every
/// tick, times each turn a pushed batch or a key opens (`PerfCounters.mark`)
/// to the end of the commit after it with a run-loop observer, and, while
/// `mover` scrolls the list, holds every visible row to the place the
/// scroll explains (`rowAt` names the row a list item draws).
final class FrameRecorder: NSObject {
    enum Driver {
        case scroll
        case stream(pinned: () -> Bool, seq: () -> Int)
        case perf
    }

    private var driver: Driver = .scroll
    private var unpinnedFrames = 0
    private var firstUnpinnedAt: Double?
    private var repinnedAt: Double?
    private var seqStart = 0
    private var link: CADisplayLink?
    private var maxFramesPerSecond = 60
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
        /// The stream driver: frames the reader was not at the bottom, and the thread's rows (partials included) at the start and end.
        var unpinnedFrames = 0
        /// When the reader first left the bottom and when it was first back, in seconds since the run began (-1: never).
        var firstUnpinnedAtS = -1.0
        var repinnedAtS = -1.0
        var seqStart = 0
        var seqEnd = 0
        var seconds = 0.0
        /// Every interval, and the main thread's CPU time inside each, in milliseconds.
        var intervalMs = PerfDist()
        var cpuMs = PerfDist()
        /// Frames later than one and a half intervals, and the time they ran over per second of the run.
        var late = 0
        var hitchMsPerS = 0.0
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

    // The perf driver's measures.
    private var cpu: [Double] = []
    private var lastCPU: UInt64?
    private var measure = FrameMeasure()
    private var observer: CFRunLoopObserver?
    private var turn: OpenTurn?
    /// Moves the list by a step from where it is and answers the step the list took (`ScrollDriver`).
    var mover: ((UIScrollView, _ elapsed: Double) -> Double)?
    /// The pass the mover is in: 0 cold, 1 warm.
    var pass = 0
    /// The row a list item draws, given the list's item count; nil when the list and the window disagree.
    var rowAt: ((_ item: Int, _ items: Int) -> TranscriptRowID?)?
    private var tops: [TranscriptRowID: Double] = [:]
    private var lastStep = 0.0
    private var drop: (from: Double, at: Double)?

    private struct OpenTurn {
        var batches = 0
        var keys = 0
        var cpu: UInt64
        var wall: CFTimeInterval
        var rowsBuilt: Int
        var ticks = 0
        var waits = 0
    }

    /// A drop the next pin puts right inside two frames never reaches the screen (the trace's rule).
    private static let visible = 0.034

    private static func threadCPU() -> UInt64 { clock_gettime_nsec_np(CLOCK_THREAD_CPUTIME_ID) }

    func start(sourceRows: Int, items: Int, scrollView: UIScrollView, driver: Driver = .scroll) {
        self.driver = driver
        if case .stream(_, let seq) = driver { seqStart = seq() }
        self.scrollView = scrollView
        // The panel the scroll view sits on (the Duo's inner panel is ProMotion, the outer is not); UIScreen.main is deprecated.
        maxFramesPerSecond = scrollView.window?.screen.maximumFramesPerSecond ?? 60
        initialOffset = scrollView.contentOffset.y
        self.sourceRows = sourceRows
        self.items = items
        if case .perf = driver { watchTurns() }
        let link = CADisplayLink(target: self, selector: #selector(tick(_:)))
        link.preferredFrameRateRange = CAFrameRateRange(minimum: 80, maximum: 120, preferred: 120)
        link.add(to: .main, forMode: .common)
        self.link = link
    }

    /// Times each marked turn: from its first event to the first time the
    /// run loop goes back to waiting after a display tick, which is past
    /// the SwiftUI update the event caused and Core Animation's commit. An
    /// interval that holds several batches is one sample, divided by them.
    private func watchTurns() {
        PerfCounters.onEvent = { [weak self] event in self?.begin(event) }
        let observer = CFRunLoopObserverCreateWithHandler(kCFAllocatorDefault, CFRunLoopActivity.beforeWaiting.rawValue, true, CFIndex.max) { [weak self] _, _ in
            MainActor.assumeIsolated { self?.waiting() }
        }
        CFRunLoopAddObserver(CFRunLoopGetMain(), observer, .commonModes)
        self.observer = observer
    }

    private func begin(_ event: PerfEvent) {
        var open = turn ?? OpenTurn(cpu: Self.threadCPU(), wall: CACurrentMediaTime(), rowsBuilt: PerfCounters.value(.rowsBuilt))
        switch event {
        case .batch: open.batches += 1
        case .key: open.keys += 1
        }
        turn = open
    }

    private func waiting() {
        guard var open = turn else { return }
        open.waits += 1
        turn = open
        // With no display tick (a list off screen) the third wait ends it.
        if open.ticks > 0 || open.waits >= 3 { close(open) }
    }

    private func close(_ open: OpenTurn) {
        turn = nil
        let cpuMs = Double(Self.threadCPU() - open.cpu) / 1_000_000
        let wallMs = (CACurrentMediaTime() - open.wall) * 1_000
        if open.keys > 0 {
            measure.keyCpu.append(cpuMs / Double(open.keys))
            measure.keyWall.append(wallMs)
        } else if open.batches > 0 {
            measure.batchCpu.append(cpuMs / Double(open.batches))
            measure.batchWall.append(wallMs)
            measure.batchRows.append(Double(PerfCounters.value(.rowsBuilt) - open.rowsBuilt) / Double(open.batches))
        }
    }

    @objc private func tick(_ link: CADisplayLink) {
        expected = link.targetTimestamp - link.timestamp
        if startedAt == nil { startedAt = link.timestamp }
        let elapsed = link.timestamp - (startedAt ?? link.timestamp)
        let offset = scrollView?.contentOffset.y ?? 0
        let previous = lastOffset ?? offset
        let moving = abs(offset - previous) > 0.01
        // The recorder reads the offset itself: no scroll handler runs for it.
        offsetSamples += 1
        minOffset = min(minOffset, offset)
        maxOffset = max(maxOffset, offset)
        let cpuNow = Self.threadCPU()
        if let last {
            let interval = (link.timestamp - last) * 1_000
            intervals.append(interval)
            if let lastCPU { cpu.append(Double(cpuNow - lastCPU) / 1_000_000) }
            if moving { movingIntervals.append(interval) }
            if interval - expected * 1_000 > 8 {
                if hitchTimes.count < 20 { hitchTimes.append(elapsed) }
                if lateFrames.count < 20 { lateFrames.append(LateFrame(atS: elapsed, intervalMs: interval, offset: offset, previousOffset: previous, moving: moving)) }
            }
        }
        let sinceLast = last.map { link.timestamp - $0 } ?? 0
        last = link.timestamp
        lastCPU = cpuNow
        lastOffset = offset
        switch driver {
        case .stream(let pinned, _):
            if !pinned() {
                unpinnedFrames += 1
                if firstUnpinnedAt == nil { firstUnpinnedAt = elapsed }
            } else if firstUnpinnedAt != nil, repinnedAt == nil {
                repinnedAt = elapsed
            }
        case .scroll:
            if let scrollView {
                let top = -scrollView.adjustedContentInset.top
                let bottom = max(top, scrollView.contentSize.height - scrollView.bounds.height + scrollView.adjustedContentInset.bottom)
                let target = elapsed < 26
                    ? initialOffset + (top - initialOffset) * min(1, elapsed / 25)
                    : top + (bottom - top) * min(1, (elapsed - 26) / 25)
                scrollView.setContentOffset(CGPoint(x: scrollView.contentOffset.x, y: target), animated: false)
            }
        case .perf:
            if var open = turn {
                open.ticks += 1
                turn = open
                // A run loop that never waits (timers back to back) still ends the turn, two ticks on.
                if open.ticks >= 3 { close(open) }
            }
            watchJumpUp(offset: offset, previous: previous, elapsed: elapsed)
            if let scrollView, let mover {
                trackRows(scrollView, elapsed: elapsed)
                lastStep = mover(scrollView, sinceLast)
                measure.travel[min(1, pass)] += abs(lastStep)
            } else {
                tops = [:]
                lastStep = 0
            }
        }
    }

    /// The offset fell more than 200 pt beyond the driver's own step and
    /// stayed down two frames: the transcript trace's `jumpUp`, counted in
    /// every configuration.
    private func watchJumpUp(offset: Double, previous: Double, elapsed: Double) {
        if var open = drop {
            // The driver's own travel since is no part of the drop.
            open.from += lastStep
            if offset >= open.from - 200 {
                drop = nil
            } else if elapsed - open.at >= Self.visible {
                measure.jumpUps += 1
                drop = nil
            } else {
                drop = open
            }
        } else if (previous - offset) + lastStep > 200 {
            drop = (previous + lastStep, elapsed)
        }
    }

    /// Each visible row's top on screen (its presentation frame less the
    /// presentation offset) against the last frame's: the driver's step
    /// explains a move of that size, and anything more than 2 pt beyond it
    /// is a jump. One jump a frame, the largest.
    private func trackRows(_ scroll: UIScrollView, elapsed: Double) {
        guard let list = scroll as? UICollectionView, list.numberOfSections == 1, let rowAt else {
            tops = [:]
            return
        }
        let items = list.numberOfItems(inSection: 0)
        let offset = Double(scroll.layer.presentation()?.bounds.origin.y ?? scroll.contentOffset.y)
        var now: [TranscriptRowID: Double] = [:]
        var worst: (pt: Double, id: TranscriptRowID)?
        for cell in list.visibleCells {
            guard let item = list.indexPath(for: cell)?.item, let id = rowAt(item, items) else { continue }
            let top = Double((cell.layer.presentation() ?? cell.layer).frame.minY) - offset
            now[id] = top
            guard let before = tops[id] else { continue }
            let moved = (top - before) + lastStep
            if abs(moved) > 2, abs(moved) > abs(worst?.pt ?? 0) { worst = (moved, id) }
        }
        tops = now
        if let worst { measure.jumps.append(PerfJump(atS: PerfDist.round(elapsed), pt: PerfDist.round(worst.pt), rowKey: worst.id.key, pass: min(1, pass))) }
    }

    private func end() {
        link?.invalidate()
        link = nil
        if let observer {
            CFRunLoopRemoveObserver(CFRunLoopGetMain(), observer, .commonModes)
            PerfCounters.onEvent = nil
            self.observer = nil
        }
    }

    /// The perf driver's result.
    func finish() -> FrameMeasure {
        end()
        measure.seconds = startedAt.map { (last ?? $0) - $0 } ?? 0
        measure.maxFramesPerSecond = maxFramesPerSecond
        measure.expectedMs = expected * 1_000
        measure.intervals = intervals
        measure.cpu = cpu
        return measure
    }

    func stop() -> Report {
        end()
        let expectedMs = expected * 1_000
        let hitches = intervals.count { $0 - expectedMs > 8 }
        let worst = intervals.max() ?? 0
        let mean = intervals.isEmpty ? 0 : intervals.reduce(0, +) / Double(intervals.count)
        let travel = offsetSamples > 0 ? maxOffset - minOffset : 0
        let streaming: Bool
        var seqEnd = 0
        if case .stream(_, let seq) = driver { streaming = true; seqEnd = seq() } else { streaming = false }
        var report = Report(driver: streaming ? "stream-pinned" : "native-list-offset", initialOffset: initialOffset, curve: "linear", scrollFrames: movingIntervals.count, scrollHitches: movingIntervals.count { $0 - expectedMs > 8 }, scrollWorstMs: movingIntervals.max() ?? 0, lateFrames: lateFrames, sourceRows: sourceRows, items: items, frames: intervals.count, maxFramesPerSecond: maxFramesPerSecond, expectedMs: expectedMs, hitches: hitches, worstMs: worst, meanMs: mean, over16Ms: intervals.count { $0 > 16.7 }, offsetSamples: offsetSamples, travelPt: travel, hitchAtS: hitchTimes.map { ($0 * 10).rounded() / 10 })
        report.unpinnedFrames = unpinnedFrames
        report.firstUnpinnedAtS = firstUnpinnedAt.map { ($0 * 10).rounded() / 10 } ?? -1
        report.repinnedAtS = repinnedAt.map { ($0 * 10).rounded() / 10 } ?? -1
        report.seqStart = seqStart
        report.seqEnd = seqEnd
        report.seconds = (startedAt.map { (last ?? $0) - $0 } ?? 0)
        report.intervalMs = PerfDist(intervals)
        report.cpuMs = PerfDist(cpu)
        var late = FrameMeasure()
        late.intervals = intervals
        late.expectedMs = expectedMs
        report.late = late.late
        report.hitchMsPerS = report.seconds > 0 ? PerfDist.round(late.hitchMs / report.seconds) : 0
        log.notice("\(streaming ? "stream" : "scroll") frames=\(report.frames) hitches=\(report.hitches) worst=\(report.worstMs, format: .fixed(precision: 1))ms mean=\(report.meanMs, format: .fixed(precision: 2))ms travel=\(travel, format: .fixed(precision: 0))pt")
        if let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first, let data = try? JSONEncoder().encode(report) {
            try? data.write(to: documents.appending(path: streaming ? "stream-report.json" : "scroll-report.json"))
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
        /// The scroll view once found, held weakly: an update after that walks nothing and tells no one.
        private weak var scroll: UIScrollView?

        /// A new place in the tree may be under another scroll view: look again.
        override func didMoveToWindow() {
            super.didMoveToWindow()
            scroll = nil
            resolve()
        }

        func resolve() {
            guard scroll == nil else { return }
            var parent = superview
            while let view = parent {
                if let scroll = view as? UIScrollView {
                    self.scroll = scroll
                    let callback = found
                    Task { callback?(scroll) }
                    return
                }
                parent = view.superview
            }
        }
    }
}
