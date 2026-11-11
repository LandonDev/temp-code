import Synchronization

/// What the performance proofs count (docs/IOS-DESIGN.md "Performance"):
/// how often a view's body ran, how much of a thread was rebuilt, how many
/// pushes were applied. Compiled in every configuration, since the Release
/// build is the one measured.
public enum PerfCounter: Int, CaseIterable, Sendable {
    case projectShellBody
    case threadStripBody
    case threadScreenBody
    case transcriptBody
    case transcriptRowBody
    case bottomDockBody
    case composerBarBody
    case composerRowBody
    /// `ThreadState.refold`: every row held folded again.
    case refolds
    /// Runs of the transcript's row build, and the rows they made.
    case rowBuilds
    case rowsBuilt
    /// Blocks of pushed rows applied to a thread, the rows in them, and pages folded in (a resume, a reset).
    case batches
    case pushedRows
    case pages
    /// Writes that wake a thread's readers, and the session list's.
    case threadPublishes
    case sessionPublishes
    /// Scrolls the transcript made on its own, and those made while the reader's finger moved the list.
    case offsetWrites
    case offsetWritesMoving

    public var name: String { String(describing: self) }
}

/// An event whose turn the recorder times: from here to the end of the commit that follows.
public enum PerfEvent: Sendable {
    /// Pushed rows are about to be applied.
    case batch
    /// A key is about to be inserted.
    case key
}

/// The counts, one array increment each. A view bumps its own in its body:
/// `let _ = PerfCounters.bump(.transcriptBody)`.
@MainActor
public enum PerfCounters {
    private static var counts = [Int](repeating: 0, count: PerfCounter.allCases.count)

    /// The recorder's ear for timed events; nil outside a measured run.
    public static var onEvent: (@MainActor (PerfEvent) -> Void)?

    public static func bump(_ counter: PerfCounter, by amount: Int = 1) {
        counts[counter.rawValue] += amount
    }

    public static func mark(_ event: PerfEvent) {
        onEvent?(event)
    }

    public static func value(_ counter: PerfCounter) -> Int {
        counts[counter.rawValue]
    }

    /// Every count now, indexed by `PerfCounter.rawValue`.
    public static func snapshot() -> [Int] {
        counts
    }

    /// What was counted between two snapshots, by name.
    public static func delta(from start: [Int], to end: [Int]) -> [String: Int] {
        var named: [String: Int] = [:]
        for counter in PerfCounter.allCases { named[counter.name] = end[counter.rawValue] - start[counter.rawValue] }
        return named
    }
}

/// Counted off the main actor.
public enum PerfOffMain {
    /// Older pages and board history folded on the concurrent pool.
    public static let folds = Atomic<Int>(0)

    public static var foldCount: Int { folds.load(ordering: .relaxed) }
}
