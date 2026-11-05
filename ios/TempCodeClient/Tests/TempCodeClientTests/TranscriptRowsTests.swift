import Foundation
import Testing
import TempCodeContract
@testable import TempCodeClient

@Suite struct TranscriptRowsTests {
    private func userEntry(_ seq: Int, ts: Int = 1_000, completedTs: Int? = nil) -> ThreadEntry {
        item(.user(UserTurn(seq: seq, ts: ts, text: "go", attachments: [], model: nil, reasoning: nil, completedTs: completedTs, costUsd: nil)))
    }

    private func read(_ seq: Int) -> ThreadEntry {
        item(toolItem(seq, ts: 1_000 + seq, doneTs: 1_100 + seq, input: ["file_path": .string("/repo/\(seq).ts")]))
    }

    private func edit(_ seq: Int) -> ThreadEntry {
        item(toolItem(seq, ts: 1_000 + seq, doneTs: 1_100 + seq, name: "Edit", input: ["file_path": .string("/repo/a.ts"), "old_string": .string("a"), "new_string": .string("b")]))
    }

    private func kinds(_ rows: [TranscriptRowModel]) -> [String] {
        rows.map { row in
            switch row {
            case .item(let entry): "item \(entry.seq)"
            case .group(let group): "group \(group.entries.map(\.seq))\(group.live ? " live" : "")"
            case .turnEnd(let end): "end \(end.userSeq)"
            case .thinkingTail(let seq): "tail \(seq)"
            }
        }
    }

    @Test func `two reads fold into one research phase`() {
        let rows = TranscriptRows.rows([userEntry(1), read(2), read(3)], turnOpen: false)
        #expect(kinds(rows) == ["item 1", "group [2, 3]"])
        guard case .group(let group) = rows[1] else { return }
        #expect(group.kind == .research)
        #expect(group.id == TranscriptRowID(key: 2))
    }

    @Test func `one read is a phase of one`() {
        let rows = TranscriptRows.rows([userEntry(1), read(2), item(textItem(3, ts: 1_003, "done"))], turnOpen: false)
        #expect(kinds(rows) == ["item 1", "group [2]", "item 3"])
    }

    @Test func `a plan tool and an approval break the run, a stray edit and thinking join it`() {
        let plan = item(toolItem(6, ts: 1_006, doneTs: 1_106, name: "TodoWrite"))
        let approval = item(.approval(ApprovalItem(seq: 8, ts: 1_008, request: ApprovalRequestEvent(requestId: "r", toolName: "Bash"), allowed: true, auto: false)))
        let thought = item(textItem(11, ts: 1_011, "hmm", thinking: true))
        let rows = TranscriptRows.rows([userEntry(1), read(2), read(3), edit(4), read(5), plan, read(7), approval, read(9), read(10), thought, read(12)], turnOpen: false)
        #expect(kinds(rows) == ["item 1", "group [2, 3, 4, 5]", "item 6", "group [7]", "item 8", "group [9, 10, 11, 12]"])
    }

    @Test func `a group keeps its first seq when a third step appends`() {
        let before = TranscriptRows.rows([userEntry(1), read(2), read(3)], turnOpen: true)
        let after = TranscriptRows.rows([userEntry(1), read(2), read(3), read(4)], turnOpen: true)
        #expect(before[1].id == after[1].id)
        #expect(after[1].id == TranscriptRowID(key: 2))
        guard case .group(let group) = after[1] else { return }
        #expect(group.entries.count == 3)
    }

    @Test func `live is the last group of the open last turn and nothing else`() {
        let open = TranscriptRows.rows([userEntry(1), read(2), read(3)], turnOpen: true)
        #expect(kinds(open) == ["item 1", "group [2, 3] live"])
        let settled = TranscriptRows.rows([userEntry(1), read(2), read(3)], turnOpen: false)
        #expect(kinds(settled) == ["item 1", "group [2, 3]"])
        // Prose after the group: the agent moved on, the group is no longer where it works.
        let followed = TranscriptRows.rows([userEntry(1), read(2), read(3), item(textItem(4, ts: 1_004, "so", streaming: true))], turnOpen: true)
        #expect(kinds(followed) == ["item 1", "group [2, 3]", "item 4"])
        // An earlier turn's group never is, however the last turn stands.
        let earlier = TranscriptRows.rows([userEntry(1, completedTs: 1_900), read(2), read(3), userEntry(4, ts: 2_000), read(5), read(6)], turnOpen: true)
        #expect(kinds(earlier) == ["item 1", "group [2, 3]", "end 1", "item 4", "group [5, 6] live"])
    }

    @Test func `a settled turn ends with its duration and answer, the open and pending turns do not`() {
        let rows = TranscriptRows.rows([
            userEntry(1, ts: 1_000, completedTs: 13_400),
            item(textItem(2, ts: 1_002, "First.")),
            read(3),
            item(textItem(4, ts: 1_004, "Second.")),
            userEntry(5, ts: 20_000),
            item(textItem(6, ts: 20_001, "streaming", streaming: true)),
            item(.user(UserTurn(seq: -100_000, ts: 30_000, text: "queued", attachments: [], model: nil, reasoning: nil, completedTs: nil, costUsd: nil))),
        ], turnOpen: true)
        #expect(kinds(rows) == ["item 1", "item 2", "group [3]", "item 4", "end 1", "item 5", "item 6", "item -100000"])
        guard case .turnEnd(let end) = rows[4] else { return }
        #expect(end.durationMs == 12_400)
        #expect(end.completedTs == 13_400)
        #expect(end.answer == "First.\n\nSecond.")
        #expect(end.id == TranscriptRowID(key: 1, end: true))
        // A completed time before the turn's start never reads negative.
        let clamped = TranscriptRows.rows([userEntry(1, ts: 5_000, completedTs: 4_000)], turnOpen: false)
        guard case .turnEnd(let zero) = clamped[1] else {
            Issue.record("shape \(kinds(clamped))")
            return
        }
        #expect(zero.durationMs == 0)
    }

    @Test func `rowID finds the group for a hidden chip and the item for prose`() {
        let rows = TranscriptRows.rows([userEntry(1), read(2), read(3), item(textItem(4, ts: 1_004, "done"))], turnOpen: false)
        #expect(TranscriptRows.rowID(containing: 2, in: rows) == TranscriptRowID(key: 2))
        #expect(TranscriptRows.rowID(containing: 3, in: rows) == TranscriptRowID(key: 2))
        #expect(TranscriptRows.rowID(containing: 4, in: rows) == TranscriptRowID(key: 4))
        #expect(TranscriptRows.rowID(containing: 1, in: rows) == TranscriptRowID(key: 1))
        #expect(TranscriptRows.rowID(containing: 9, in: rows) == nil)
    }

    @Test func `the labels read as on the desktop`() {
        #expect(TranscriptRows.workedLabel(ms: 800) == "Worked for 1s")
        #expect(TranscriptRows.workedLabel(ms: 12_000) == "Worked for 12s")
        #expect(TranscriptRows.workedLabel(ms: 125_000) == "Worked for 2m 5s")
        #expect(TranscriptRows.workedLabel(ms: 120_000) == "Worked for 2m")
    }

    @Test func `entries before the first user row fold on their own`() {
        let rows = TranscriptRows.rows([read(2), read(3), item(textItem(4, ts: 1_004, "done"))], turnOpen: false)
        #expect(kinds(rows) == ["group [2, 3]", "item 4"])
    }
}

/// The row ids are one key space: an item, a group and the step it grew
/// from share a key; the end row is its message's key with `end` set.
@Suite struct TranscriptRowKeyTests {
    private func readEntry(_ seq: Int, key: Int? = nil) -> ThreadEntry {
        ThreadEntry(item: toolItem(seq, ts: 1_000 + seq, doneTs: 1_100 + seq), key: key)
    }

    @Test func `a lone call and the group it becomes share one key`() {
        let user = ThreadEntry(item: userItem(1, ts: 1_000))
        let lone = TranscriptRows.rows([user, readEntry(2, key: -1_000)], turnOpen: true)
        let grown = TranscriptRows.rows([user, readEntry(2, key: -1_000), readEntry(3)], turnOpen: true)
        #expect(lone[1].id == TranscriptRowID(key: -1_000))
        #expect(grown[1].id == lone[1].id)
    }

    @Test func `the end row is the message's key, from the thinking tail to the closing line`() {
        let open = ThreadEntry(item: userItem(4, ts: 1_000), key: -100_000)
        let tail = TranscriptRows.rows([open], turnOpen: true)
        #expect(tail.last?.id == TranscriptRowID(key: -100_000, end: true))
        let closed = ThreadEntry(item: .user(UserTurn(seq: 4, ts: 1_000, text: "go", attachments: [], model: nil, reasoning: nil, completedTs: 2_000, costUsd: nil)), key: -100_000)
        let ended = TranscriptRows.rows([closed, ThreadEntry(item: textItem(5, ts: 1_500, "done"))], turnOpen: false)
        #expect(ended.last?.id == TranscriptRowID(key: -100_000, end: true))
        #expect(ended.first?.id == TranscriptRowID(key: -100_000))
    }

    @Test func `a group keeps its key when history adds steps before its first`() {
        let memory = RowKeyMemory()
        let tail = TranscriptRows.rows([readEntry(5), readEntry(6)], turnOpen: false, memory: memory)
        #expect(tail[0].id == TranscriptRowID(key: 5))
        let joined = TranscriptRows.rows([ThreadEntry(item: userItem(1, ts: 1_000)), readEntry(2), readEntry(3), readEntry(5), readEntry(6)], turnOpen: false, memory: memory)
        #expect(joined[1].id == TranscriptRowID(key: 5))
    }

    @Test func `two groups never draw under one remembered key`() {
        let memory = RowKeyMemory()
        _ = TranscriptRows.rows([readEntry(2), readEntry(3)], turnOpen: false, memory: memory)
        let split = TranscriptRows.rows([readEntry(2), ThreadEntry(item: textItem(9, ts: 1_200, "a paragraph")), readEntry(3)], turnOpen: false, memory: memory)
        let ids = split.map(\.id)
        #expect(Set(ids).count == ids.count)
        #expect(split.first?.id == TranscriptRowID(key: 2))
    }
}

/// `FollowRule`: the offset follows only a reader at the bottom.
@Suite struct FollowRuleTests {
    @Test func `rows changing pin a reader at the bottom and leave one who is up`() {
        #expect(FollowRule.write(for: .rowsChanged, atBottom: true) == .pin)
        #expect(FollowRule.write(for: .rowsChanged, atBottom: false) == .none)
    }

    @Test func `a landing or a reflow in flight is never moved`() {
        #expect(FollowRule.write(for: .rowsChanged, atBottom: true, landing: true) == .none)
        #expect(FollowRule.write(for: .rowsChanged, atBottom: true, reflowHeld: true) == .none)
        #expect(FollowRule.write(for: .opened, atBottom: true, landing: true) == .none)
        #expect(FollowRule.write(for: .opened, atBottom: true) == .snap)
    }

    @Test func `the jump glides and leaving the app snaps only a reader who is up`() {
        #expect(FollowRule.write(for: .jump, atBottom: false) == .glide)
        #expect(FollowRule.write(for: .enteringBackground, atBottom: false) == .snap)
        #expect(FollowRule.write(for: .enteringBackground, atBottom: true) == .none)
    }
}

@Suite struct BornRowsTests {
    @Test func `a placeholder and a loading page cannot mark history as born live`() {
        let born = BornRows()
        born.open(thread: nil)
        #expect(born.openedAt == nil)
        var thread = ThreadState()
        thread.isLoading = true
        born.open(thread: thread)
        #expect(born.openedAt == nil)
        thread.append([EventRow(sessionId: "s", seq: 10, ts: 1_000,
            event: .userText(UserTextEvent(text: "history")))], trim: false)
        thread.isLoading = false
        born.open(thread: thread)
        #expect(born.openedAt == 10)
        #expect(!born.isUnclaimed(row(10)))
        #expect(born.isUnclaimed(row(11)))
    }

    private func row(_ seq: Int, key: Int? = nil) -> TranscriptRowModel {
        .item(ThreadEntry(item: textItem(seq, ts: 1_000, "hello world "), key: key))
    }

    @Test func `an empty unsubscribed state waits but a loaded empty thread opens at zero`() {
        let born = BornRows()
        var thread = ThreadState()
        born.open(thread: thread)
        #expect(born.openedAt == nil)
        thread.isLive = true
        born.open(thread: thread)
        #expect(born.openedAt == 0)
    }

    @Test func `preparing a live row twice keeps its reveal until it appears`() {
        let born = BornRows()
        born.open(at: 10)
        let live = row(11)
        #expect(born.isUnclaimed(live))
        #expect(born.isUnclaimed(live), "preparing a view must not claim it")
        #expect(born.claim(live))
        #expect(!born.isUnclaimed(live), "a row scrolled back in shows whole")
        #expect(!born.claim(live))
    }

    @Test func `opening waits for loaded rows and keeps history outside the reveal`() {
        let born = BornRows()
        born.open(at: nil)
        #expect(!born.isUnclaimed(row(11)))
        born.open(at: 10)
        born.open(at: 20)
        #expect(born.openedAt == 10)
        #expect(!born.isUnclaimed(row(10)))
        #expect(!born.isUnclaimed(row(5)))
        #expect(born.isUnclaimed(row(11)))
    }

    @Test func `a provisional row keeps its claim when its final seq arrives`() {
        let born = BornRows()
        born.open(at: 10)
        #expect(born.claim(row(-1_000, key: -1_000)))
        #expect(!born.isUnclaimed(row(12, key: -1_000)))
    }
}
