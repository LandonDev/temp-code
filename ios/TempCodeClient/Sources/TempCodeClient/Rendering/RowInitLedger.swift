/// The transcript proof's count of each row's state inits, appearances and
/// disappearances by row key (the app's DEBUG `LayoutProbe` holds one, fed
/// by `rowInitProbe` on every row of the transcript). A row that scrolls
/// off and comes back may be made again; a row whose state is made again
/// while it is still on screen lost its identity in place, which is a
/// violation: an init while its appearances outnumber its disappearances.
public struct RowInitLedger: Sendable {
    public struct Count: Sendable, Equatable {
        public var inits = 0
        public var appears = 0
        public var disappears = 0

        /// On screen now: appeared more often than it disappeared.
        public var onScreen: Bool { appears > disappears }
    }

    public struct Violation: Sendable, Equatable {
        public var key: String
        /// When it happened, in the caller's clock (the probe's ms since launch).
        public var at: Int
        /// The row's inits counting this one.
        public var inits: Int
    }

    public private(set) var rows: [String: Count] = [:]
    public private(set) var violations: [Violation] = []

    public init() {}

    public var inits: Int { rows.values.reduce(0) { $0 + $1.inits } }

    public mutating func inited(_ key: String, at: Int) {
        var row = rows[key, default: Count()]
        row.inits += 1
        if row.inits > 1, row.onScreen { violations.append(Violation(key: key, at: at, inits: row.inits)) }
        rows[key] = row
    }

    public mutating func appeared(_ key: String) { rows[key, default: Count()].appears += 1 }

    public mutating func disappeared(_ key: String) { rows[key, default: Count()].disappears += 1 }

    /// The key the probe files a row under: its message key, `e` after it for the turn's end row.
    public static func key(_ id: TranscriptRowID) -> String { id.end ? "\(id.key)e" : "\(id.key)" }
}
