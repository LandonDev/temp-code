import Foundation

/// The transcript's rows, built once per change and only where the thread
/// changed. The view holds one beside its `RowKeyMemory` and calls `update`
/// in its body: a pass that finds the thread as the last pass left it reads
/// the rows it has, and one that finds a change rebuilds from the turn the
/// change sits in. The rows are `TranscriptRows.rows` exactly (the tests
/// play every timeline against a whole build, and a DEBUG build samples the
/// same check on a live thread).
///
/// What the rows are built from, and so what a pass compares (`Key`): the
/// fold's items, by its `FoldChanges` (a fold rebuilt from its rows is
/// another fold and builds whole); the pending turns; `board.turnOpen`,
/// which flips with no item changing and, in a thread with no message of
/// the person's, alone decides whether its rows are live; and the agents'
/// statuses an omitted wait still needs.
///
/// A rebuild starts at the earliest of: the turn that holds the lowest item
/// written; the turn that was last (when a new turn opens, the old last
/// turn's working line becomes its closing line and its groups settle);
/// and any turn that holds a wait with an agent still undecided, so
/// `WaitSteps.resolved` decides each agent at the pass it would have in a
/// whole build. Everything before that turn is kept as it is: its rows,
/// the keys its groups drew, its place in the list.
public final class TranscriptModel {
    public private(set) var rows: [TranscriptRowModel] = []
    /// The agents whose status the omitted waits still need, after the last build kept what it read.
    public private(set) var waitIds: Set<String> = []
    /// Rows the last `update` built; 0 when it found nothing changed.
    public private(set) var built = 0
    /// Builds so far, and those that built every turn (test seams).
    public private(set) var builds = 0
    public private(set) var wholeBuilds = 0
    public let memory: RowKeyMemory

    private struct Turn {
        /// Its first entry's key: the opener's, which its end row carries.
        var key: Int
        /// Where it starts in the fold's items, and in `rows`.
        var start: Int
        var rowStart: Int
        var groupKeys: [Int]
        /// It starts with the person's row: its rows have a turn (`turnKey`).
        var opened: Bool
        /// It holds a wait with an agent no pass has decided yet.
        var undecided: Bool
    }

    private struct Key: Equatable {
        var epoch: Int
        var generation: Int
        var pending: [PendingTurn]
        var turnOpen: Bool
        var waits: WaitStatuses
    }

    private var turns: [Turn] = []
    private var key: Key?
    /// Every group key in `rows`: a key is drawn once.
    private var drawn: Set<Int> = []
    /// Where each row sits, by id.
    private var index: [TranscriptRowID: Int] = [:]
    /// The end row that carries `last`.
    private var lastEnd: Int?
    /// What the last build took out, from the row it started at (`changedIDs`).
    private var replaced: (from: Int, rows: [TranscriptRowModel]) = (0, [])
    private var gapsFor: (build: Int, start: Int, gaps: [TranscriptRowID: Double])?

    public init(memory: RowKeyMemory = RowKeyMemory()) {
        self.memory = memory
    }

    /// Brings the rows up to `thread`. True when something was rebuilt.
    @discardableResult
    public func update(_ thread: ThreadState, waits: WaitStatuses = WaitStatuses(), statusOf: ((String) -> String?)? = nil) -> Bool {
        let changes = thread.fold.changes
        let next = Key(epoch: changes.epoch, generation: changes.generation, pending: thread.pending, turnOpen: thread.fold.board.turnOpen, waits: waits)
        guard next != key else {
            built = 0
            return false
        }
        let items = thread.fold.items
        var from = 0
        var whole = true
        if let key, key.epoch == next.epoch, !turns.isEmpty {
            whole = false
            from = turns.count - 1
            if let dirty = changes.dirtyFrom(since: key.generation) { from = turn(holding: dirty, in: items, upTo: from) }
            if let waiting = turns.firstIndex(where: \.undecided), waiting < from { from = waiting }
        }
        build(from: from, whole: whole, items: items, pending: thread.pending, turnOpen: next.turnOpen, waitMemory: thread.fold.waitOutcomes, statusOf: statusOf ?? { _ in nil })
        key = next
        return true
    }

    /// The turn a rebuild for a write to item `dirty` starts at, no later
    /// than `last`. A write to a turn's own opener can make it join the
    /// turn before it (`TranscriptRows.joins`), which then rebuilds too.
    private func turn(holding dirty: Int, in items: [ThreadEntry], upTo last: Int) -> Int {
        var at = last
        while at > 0, turns[at].start > dirty { at -= 1 }
        while at > 0, turns[at].start == dirty, turns[at].opened, turns[at - 1].opened, dirty < items.count,
              case .user(let user) = items[dirty].item, case .user(let before) = items[turns[at - 1].start].item,
              TranscriptRows.joins(user, opener: before) {
            at -= 1
        }
        return at
    }

    private func build(from first: Int, whole: Bool, items: [ThreadEntry], pending: [PendingTurn], turnOpen: Bool, waitMemory: WaitOutcomeMemory, statusOf: (String) -> String?) {
        builds += 1
        if whole { wholeBuilds += 1 }
        let entryStart = first < turns.count ? turns[first].start : 0
        let rowStart = first < turns.count ? turns[first].rowStart : 0
        // What is rebuilt leaves first: its rows, their places, the group keys it drew.
        replaced = (rowStart, Array(rows[rowStart...]))
        for row in rows[rowStart...] { index[row.id] = nil }
        rows.removeSubrange(rowStart...)
        for turn in turns[first...] { drawn.subtract(turn.groupKeys) }
        turns.removeSubrange(first...)
        if let end = lastEnd, end >= rowStart { lastEnd = nil }

        var slice = Array(items[min(entryStart, items.count)...])
        for turn in pending { slice.append(turn.entry) }
        let entries = WaitSteps.resolved(slice, statusOf: statusOf, memory: waitMemory)
        let starts = TranscriptRows.turnStarts(entries)
        // The open last turn, as `TranscriptRows.rows` reads it.
        let lastOpener: Int? = starts.last.flatMap { at in
            if case .user = entries[at].item { return at } else { return nil }
        }
        let openTurn: Bool = lastOpener.map { at in
            guard case .user(let user) = entries[at].item else { return false }
            return user.seq < 0 || (turnOpen && user.completedTs == nil)
        } ?? turnOpen
        var kept: [Int: RowKeyMemory.SettledTurn] = [:]
        var waiting: Set<String> = []
        for (number, start) in starts.enumerated() {
            let end = number + 1 < starts.count ? starts[number + 1] : entries.count
            let last = number == starts.count - 1
            let turn = entries[start..<end]
            let above = rows.last.map(RowKeyMemory.SettledTurn.shape)
            let turnKey = turn.first?.key ?? 0
            let from = rows.count
            let groupKeys: [Int]
            // A fold made anew (history joined above, a trim, a fresh tail) holds most turns as they were: those keep their rows.
            if whole, !last, let cached = memory.turns[turnKey], cached.above == above, cached.entries.count == turn.count, cached.entries.elementsEqual(turn) {
                rows.append(contentsOf: cached.rows)
                drawn.formUnion(cached.groupKeys)
                groupKeys = cached.groupKeys
                kept[turnKey] = cached
            } else {
                let open = last && openTurn
                let told: Set<String> = open ? Set(LinePhase.told(Array(turn)).map(\.callId)) : []
                groupKeys = TranscriptRows.appendTurn(turn, open: open, turnOpen: turnOpen, told: told, memory: memory, drawn: &drawn, into: &rows)
                if !last {
                    let settled = RowKeyMemory.SettledTurn(entries: Array(turn), above: above, rows: Array(rows[from...]), groupKeys: groupKeys)
                    if whole { kept[turnKey] = settled } else { memory.turns[turnKey] = settled }
                }
            }
            for at in from..<rows.count { index[rows[at].id] = at }
            let undecided = WaitSteps.unsettledAgents(turn, memory: waitMemory)
            waiting.formUnion(undecided)
            let opened: Bool = if case .user? = turn.first?.item { true } else { false }
            turns.append(Turn(key: turnKey, start: entryStart + start, rowStart: from, groupKeys: groupKeys, opened: opened, undecided: !undecided.isEmpty))
        }
        if whole { memory.turns = kept }
        // The thread's last end row carries the Watching line: one row, whichever turn it closes.
        let end = rows.lastIndex { if case .turnEnd = $0 { true } else { false } }
        if let old = lastEnd, old != end, old < rows.count, case .turnEnd(var row) = rows[old] {
            row.last = false
            rows[old] = .turnEnd(row)
        }
        if let end, case .turnEnd(var row) = rows[end], !row.last {
            row.last = true
            rows[end] = .turnEnd(row)
        }
        lastEnd = end
        waitIds = waiting
        built = rows.count - rowStart
    }

    // MARK: - what the view reads

    public func index(of id: TranscriptRowID) -> Int? {
        index[id]
    }

    /// The row's turn: the key of its turn's opener, which the turn's end
    /// row carries (`TranscriptRows.turnKeys`). Rows before any opener have none.
    public func turnKey(of id: TranscriptRowID) -> Int? {
        guard let at = index[id] else { return nil }
        var low = 0
        var high = turns.count
        while low + 1 < high {
            let middle = (low + high) / 2
            if turns[middle].rowStart <= at { low = middle } else { high = middle }
        }
        guard low < turns.count, turns[low].opened else { return nil }
        return turns[low].key
    }

    /// Where the list's window starts (`TranscriptRows.windowStart`): at the row it started at, else the newest `count` rows.
    public func windowStart(top: TranscriptRowID?, count: Int) -> Int {
        if let top, let at = index[top] { return at }
        return max(0, rows.count - count)
    }

    /// The row that shows a seq (`TranscriptRows.rowID`).
    public func rowID(containing seq: Int) -> TranscriptRowID? {
        TranscriptRows.rowID(containing: seq, in: rows)
    }

    /// The gap above each row from `start` on (`RowGap.above`), read from
    /// the row before it in the whole list; kept until the rows are built
    /// again or the window starts elsewhere.
    public func gaps(from start: Int) -> [TranscriptRowID: Double] {
        if let gapsFor, gapsFor.build == builds, gapsFor.start == start { return gapsFor.gaps }
        var gaps: [TranscriptRowID: Double] = [:]
        gaps.reserveCapacity(max(0, rows.count - start))
        for at in rows.indices.dropFirst(start) {
            gaps[rows[at].id] = RowGap.above(rows[at], after: at > 0 ? rows[at - 1] : nil)
        }
        gapsFor = (builds, start, gaps)
        return gaps
    }

    /// The earliest, in list order, of the rows on screen that the window
    /// from `start` holds (`TranscriptReflow.topRow`), found by each row's place.
    public func topRow(onScreen: Set<TranscriptRowID>, from start: Int = 0) -> TranscriptRowID? {
        var top: (id: TranscriptRowID, at: Int)?
        for id in onScreen {
            guard let at = index[id], at >= start else { continue }
            if top == nil || at < top!.at { top = (id, at) }
        }
        return top?.id
    }

    /// The rows the last build changed or added, by id: what a list that
    /// reconfigures its cells by id is told. A row it took out is in none.
    public func changedIDs() -> Set<TranscriptRowID> {
        let old = Dictionary(replaced.rows.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        var changed: Set<TranscriptRowID> = []
        for row in rows[min(replaced.from, rows.count)...] where old[row.id] != row { changed.insert(row.id) }
        return changed
    }

    /// The rows of the thread's last turn: what a build in a streaming turn may cost.
    public var lastTurnRows: Int {
        turns.last.map { rows.count - $0.rowStart } ?? 0
    }
}
