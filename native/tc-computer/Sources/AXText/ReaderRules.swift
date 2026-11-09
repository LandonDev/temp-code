import ComputerProtocol
import Foundation

// The live reader's decisions that need no live element, so the box tests them
// too: which CGWindowID an AX window is, when AXManualAccessibility is retried,
// when a busy indicator shows, and the shallow signature's hash (plan §5).

/// One entry of CGWindowListCopyWindowInfo, as the match reads it.
public struct WindowListEntry: Sendable, Equatable {
    public var id: Int
    public var pid: Int32
    /// empty without Screen Recording: CG hides other apps' titles then
    public var title: String
    /// global points
    public var bounds: Rect
    public var onScreen: Bool
    public var layer: Int

    public init(id: Int, pid: Int32, title: String, bounds: Rect, onScreen: Bool, layer: Int = 0) {
        self.id = id
        self.pid = pid
        self.title = title
        self.bounds = bounds
        self.onScreen = onScreen
        self.layer = layer
    }
}

/// The public fallback for `_AXUIElementGetWindow` (plan §5.3).
public enum WindowMatch {
    /// The one window of `pid` on layer 0 whose bounds equal `frame` within a point and whose title,
    /// when CG gives one, is `title`; nil when none or several.
    public static func pick(_ entries: [WindowListEntry], pid: Int32, title: String, frame: Rect) -> Int? {
        let near = { (a: Double, b: Double) in abs(a - b) <= 1 }
        let hits = entries.filter { e in
            e.pid == pid && e.layer == 0 && (e.title.isEmpty || e.title == title)
                && near(e.bounds.x, frame.x) && near(e.bounds.y, frame.y) && near(e.bounds.w, frame.w) && near(e.bounds.h, frame.h)
        }
        return hits.count == 1 ? hits[0].id : nil
    }
}

/// AXManualAccessibility, set once per pid on its first read (plan §5.4).
/// Success marks a Chromium or Electron process; -25205 a native one. A
/// Chromium read that comes back thin within 5 s of the set is read again at
/// 250, 500, 1,000 and 1,500 ms after it, and the first one not thin wins.
public final class ManualAccessibility: @unchecked Sendable {
    public enum Process: Sendable, Equatable {
        /// set at this clock time, ms
        case chromium(setAt: Double)
        case native
    }

    public static let retryAfterMs: [Double] = [250, 500, 1_000, 1_500]
    public static let retryWindowMs: Double = 5_000

    private let lock = NSLock()
    private var processes: [Int32: Process] = [:]
    private let set: (Int32) -> Bool
    private let clock: () -> Double

    /// `set` makes the call and says whether it took; `clock` is ms on any monotonic scale.
    public init(set: @escaping (Int32) -> Bool, clock: @escaping () -> Double) {
        self.set = set
        self.clock = clock
    }

    /// The process's kind, setting the attribute on its first read.
    public func prepare(_ pid: Int32) -> Process {
        lock.lock()
        defer { lock.unlock() }
        if let known = processes[pid] { return known }
        let kind: Process = set(pid) ? .chromium(setAt: clock()) : .native
        processes[pid] = kind
        return kind
    }

    /// The clock times to read again at, for a read that came back thin now; empty when none.
    public func retries(_ pid: Int32, thin: Bool) -> [Double] {
        lock.lock()
        let kind = processes[pid]
        lock.unlock()
        guard thin, case .chromium(let at)? = kind else { return [] }
        let now = clock()
        guard now - at < Self.retryWindowMs else { return [] }
        return Self.retryAfterMs.map { at + $0 }.filter { $0 > now }
    }

    public func forget(_ pid: Int32) {
        lock.lock()
        processes[pid] = nil
        lock.unlock()
    }
}

/// When a busy indicator counts as showing (spec §7, plan §5.5).
public enum BusyRule {
    public enum Kind: Sendable { case busy, progress, webArea }

    /// `clips` are the current frames of the window and of the containers above the candidate.
    public static func showing(_ kind: Kind, frame: Rect?, hasValue: Bool, busy: Bool?, loaded: Bool?, clips: [Rect]) -> Bool {
        switch kind {
        case .webArea:
            return busy == true || loaded == false
        case .busy, .progress:
            guard let f = frame, !Viewport.isZero(f) else { return false }
            var clip: Rect?
            for c in clips where !Viewport.isZero(c) { clip = Viewport.intersect(clip, c) }
            guard Viewport.meets(f, clip) else { return false }
            return kind == .busy || !hasValue
        }
    }
}

/// The smart wait's shallow signature (spec §7) over parts the live side reads, with A7's two limits.
public struct Signature: Sendable {
    /// a focused value longer than this hashes as its length and selection
    public static let maxValueUnits = 100_000
    /// at most this many scroll areas, first in reading order, are counted
    public static let maxScrollAreas = 32

    public var focused: UInt64?
    public var value: String?
    public var valueLength: Int?
    public var selection: [Int]?
    public var title: String?
    public var windowChildren: [UInt64]
    public var counts: [Int]

    public init(focused: UInt64?, value: String?, valueLength: Int?, selection: [Int]?, title: String?, windowChildren: [UInt64], counts: [Int]) {
        self.focused = focused
        self.value = value
        self.valueLength = valueLength
        self.selection = selection
        self.title = title
        self.windowChildren = windowChildren
        self.counts = counts
    }

    public var hash: UInt64 {
        var h = StableHash()
        h.add(Int(truncatingIfNeeded: focused ?? 0))
        if let n = valueLength, n > Self.maxValueUnits {
            h.add("length")
            h.add(n)
        } else {
            h.add(value ?? "\u{0}")
        }
        for s in selection ?? [-1, -1] { h.add(s) }
        h.add(title ?? "\u{0}")
        h.add(windowChildren.count)
        for c in windowChildren { h.add(Int(truncatingIfNeeded: c)) }
        for c in counts.prefix(Self.maxScrollAreas + 1) { h.add(c) }
        return h.value
    }
}
