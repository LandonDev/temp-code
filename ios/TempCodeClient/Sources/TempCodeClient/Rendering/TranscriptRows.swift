import Foundation

/// A row's identity in the transcript list, stable as a turn grows: an item
/// keeps its seq, a group keeps its first chip's seq however many chips
/// append, a turn's closing line keeps the user row's seq.
public struct TranscriptRowID: Hashable, Sendable {
    public enum Kind: UInt8, Hashable, Sendable {
        case item
        case group
        case turnEnd
    }

    public var kind: Kind
    /// item: the entry's seq; group: the first chip's seq; turnEnd: the user turn's seq.
    public var seq: Int

    public init(kind: Kind, seq: Int) {
        self.kind = kind
        self.seq = seq
    }
}

/// A run of two or more settled tool chips between two other rows, the
/// desktop's activity group: the newest call shows, the rest fold behind
/// "+N previous tool calls".
public struct ActivityGroup: Hashable, Sendable {
    /// In order; always two or more.
    public var entries: [ThreadEntry]
    /// The group the agent is in: it opens by itself. True for the last
    /// group of a turn that is still open, with nothing after it.
    public var live: Bool

    public init(entries: [ThreadEntry], live: Bool) {
        self.entries = entries
        self.live = live
    }

    /// The newest call: the one chip that shows when the group is closed.
    public var latest: ThreadEntry { entries[entries.count - 1] }
    /// Everything before it, behind the fold.
    public var hidden: ArraySlice<ThreadEntry> { entries.dropLast() }
    public var id: TranscriptRowID { TranscriptRowID(kind: .group, seq: entries[0].seq) }
}

/// A settled turn's closing line: "Worked for 12s", and the clock time at its trailing edge.
public struct TurnEnd: Hashable, Sendable {
    public var userSeq: Int
    /// The user turn's `completedTs` less its `ts`, never negative.
    public var durationMs: Int
    public var completedTs: Int
    /// The turn's assistant prose joined by blank lines: what Copy answer copies.
    public var answer: String

    public init(userSeq: Int, durationMs: Int, completedTs: Int, answer: String) {
        self.userSeq = userSeq
        self.durationMs = durationMs
        self.completedTs = completedTs
        self.answer = answer
    }

    public var id: TranscriptRowID { TranscriptRowID(kind: .turnEnd, seq: userSeq) }
}

/// What the transcript list shows, one row each: a thread entry on its own,
/// a fold of tool chips, or a turn's closing line.
public enum TranscriptRowModel: Identifiable, Hashable, Sendable {
    case item(ThreadEntry)
    case group(ActivityGroup)
    case turnEnd(TurnEnd)

    public var id: TranscriptRowID {
        switch self {
        case .item(let entry): TranscriptRowID(kind: .item, seq: entry.seq)
        case .group(let group): group.id
        case .turnEnd(let end): end.id
        }
    }
}

/// Entries → rows, the desktop's `transcriptRows.ts` and
/// `transcriptActivity.ts` for the phone. Pure and linear: run on every
/// change of the entries, on the main actor, well under a millisecond for
/// two thousand entries.
public enum TranscriptRows {
    /// An entry that joins a run of chips: a tool call that is neither an
    /// edit (its own card) nor a plan tool (a quiet line). Everything else
    /// breaks the run and stands as its own row.
    public static func folds(_ entry: ThreadEntry) -> Bool {
        guard case .tool(let tool) = entry.item else { return false }
        return Board.editPath(tool) == nil && !tool.isPlanTool
    }

    /// The rows for `entries`. `turnOpen` is the fold's `board.turnOpen`:
    /// while true, the last group of the last turn (with nothing after it)
    /// is live and opens by itself.
    public static func rows(_ entries: [ThreadEntry], turnOpen: Bool) -> [TranscriptRowModel] {
        var rows: [TranscriptRowModel] = []
        rows.reserveCapacity(entries.count + 8)
        var run: [ThreadEntry] = []
        var turnUser: UserTurn?
        var answer: [String] = []
        /// The index in `rows` of the last group of the turn being built.
        var lastGroup: Int?

        func flushRun() {
            if run.count >= 2 {
                lastGroup = rows.count
                rows.append(.group(ActivityGroup(entries: run, live: false)))
            } else if let only = run.first {
                rows.append(.item(only))
            }
            run = []
        }
        func closeTurn() {
            flushRun()
            if let turnUser, turnUser.seq >= 0, let completedTs = turnUser.completedTs {
                rows.append(.turnEnd(TurnEnd(userSeq: turnUser.seq, durationMs: max(0, completedTs - turnUser.ts), completedTs: completedTs, answer: answer.joined(separator: "\n\n"))))
            }
            turnUser = nil
            answer = []
            lastGroup = nil
        }

        for entry in entries {
            if case .user(let turn) = entry.item {
                closeTurn()
                turnUser = turn
                rows.append(.item(entry))
                continue
            }
            if folds(entry) {
                run.append(entry)
                continue
            }
            flushRun()
            if case .assistant(let block) = entry.item, !block.text.isEmpty { answer.append(block.text) }
            rows.append(.item(entry))
        }
        // The last turn: its trailing run is live while the turn is open.
        flushRun()
        if turnOpen, let lastGroup, lastGroup == rows.count - 1, case .group(var group) = rows[lastGroup] {
            group.live = true
            rows[lastGroup] = .group(group)
        }
        closeTurn()
        return rows
    }

    /// The row that shows a seq: its own item row, or the group it is inside.
    public static func rowID(containing seq: Int, in rows: [TranscriptRowModel]) -> TranscriptRowID? {
        for row in rows {
            switch row {
            case .item(let entry):
                if entry.seq == seq { return row.id }
            case .group(let group):
                if group.entries.contains(where: { $0.seq == seq }) { return row.id }
            case .turnEnd:
                continue
            }
        }
        return nil
    }

    /// "+3 previous tool calls", "+1 previous tool call".
    public static func previousLabel(_ count: Int) -> String {
        "+\(count) previous tool call\(count == 1 ? "" : "s")"
    }

    /// "Worked for 12s", "Worked for 2m 5s", "Worked for 2m"; under a second rounds up to 1s.
    public static func workedLabel(ms: Int) -> String {
        let total = max(1, Int((Double(ms) / 1_000).rounded()))
        if total < 60 { return "Worked for \(total)s" }
        let minutes = total / 60
        let seconds = total % 60
        return seconds == 0 ? "Worked for \(minutes)m" : "Worked for \(minutes)m \(seconds)s"
    }
}

extension ToolItem {
    /// The harness's own task-list tools: mechanics, not work. A quiet line
    /// in the transcript, never a chip, never part of a group.
    public var isPlanTool: Bool {
        ["TodoWrite", "update_plan", "TaskCreate", "TaskUpdate", "TaskList", "TaskGet"].contains(name)
    }
}
