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
            case .turnEnd(let end): "\(end.open ? "line" : "end") \(end.userSeq)\(end.stopped ? " stopped" : "")\(end.last ? " last" : "")"
            }
        }
    }

    private func run(_ seq: Int, running: Bool = false) -> ThreadEntry {
        item(toolItem(seq, ts: 1_000 + seq, doneTs: running ? nil : 1_100 + seq, name: "Bash", input: ["command": .string("bun test")]))
    }

    private func group(_ rows: [TranscriptRowModel], _ at: Int) -> ActivityGroup? {
        guard rows.indices.contains(at), case .group(let group) = rows[at] else { return nil }
        return group
    }

    private func system(_ seq: Int, _ kind: SystemLine.Kind, agentId: String? = nil, detail: String? = nil) -> ThreadEntry {
        item(.system(SystemLine(seq: seq, ts: 1_000 + seq, kind: kind, text: "x", detail: detail, stopped: false, agentId: agentId)))
    }

    private func wait(_ seq: Int, output: String?) -> ThreadEntry {
        item(.tool(ToolItem(seq: seq, ts: 1_000 + seq, callId: "w\(seq)", name: "mcp__orchestrator__wait_for_agent", display: nil, input: .object(["agentId": .string("a")]), partial: false, preview: nil, parentCallId: nil, inputOmitted: false, output: output.map(BodyState.whole) ?? .none, status: output == nil ? .running : .done, reauth: nil)))
    }

    @Test func `a report and a finished task fold into the run; a failure breaks it`() {
        let rows = TranscriptRows.rows([userEntry(1), system(2, .agentReport, agentId: "a", detail: "idle"), system(3, .backgroundTask, detail: "completed"), read(4), item(errorItem(5, "boom")), read(6)], turnOpen: false)
        #expect(kinds(rows) == ["item 1", "group [2, 3, 4]", "item 5", "group [6]"])
        let reports = TranscriptRows.rows([system(2, .agentReport, agentId: "a", detail: "idle"), system(3, .agentReport, agentId: "b", detail: "idle")], turnOpen: false)
        #expect(group(reports, 0)?.kind == .agents)
    }

    @Test func `a wait is no row while open, and once it returned each agent is a step`() {
        let open = TranscriptRows.rows([userEntry(1), read(2), wait(3, output: nil)], turnOpen: true)
        #expect(kinds(open) == ["item 1", "group [2] live", "line 1 last"])
        let back = TranscriptRows.rows([userEntry(1, completedTs: 2_000), wait(3, output: #"[{"agentId":"a","status":"idle"},{"agentId":"b","status":"failed"}]"#)], turnOpen: false)
        #expect(kinds(back) == ["item 1", "group [3]", "end 1 last"])
        #expect(group(back, 1)?.lone == false)
        #expect(group(back, 1)?.stepRows == 2)
        #expect(group(back, 1)?.failed == 1)
        let nobody = TranscriptRows.rows([userEntry(1, completedTs: 2_000), wait(3, output: #"{"status":"timeout"}"#)], turnOpen: false)
        #expect(kinds(nobody) == ["item 1", "end 1 last"])
    }

    /// A real wait's result passes 2 KiB (the reply rides in it), so the host sends a remote socket its head alone.
    private func omittedWait(_ seq: Int, ids: [String], head: String, mode: String? = nil) -> ThreadEntry {
        var fields: [String: JSONValue] = ["agentIds": .array(ids.map(JSONValue.string))]
        if let mode { fields["mode"] = .string(mode) }
        let input: JSONValue = .object(fields)
        let body = OmittedBody(omitted: true, bytes: 9_400, lines: 120, head: head)
        return item(.tool(ToolItem(seq: seq, ts: 1_000 + seq, callId: "w\(seq)", name: "mcp__orchestrator__wait_for_agent", display: nil, input: input, partial: false, preview: nil, parentCallId: nil, inputOmitted: false, output: .omitted(body, seq: seq), status: .done, reauth: nil)))
    }

    @Test func `a wait whose body was omitted reads its agents from the head and their sessions`() {
        let head = #"[{"agentId":"a","status":"failed","reply":"The build broke at the linker step because the"#
        let entries = [userEntry(1, completedTs: 2_000), omittedWait(3, ids: ["a", "b", "c"], head: head)]
        // a from the head (its status then, not now), b from its session, c still running: no step.
        let statuses = ["a": "running", "b": "idle", "c": "running"]
        let rows = TranscriptRows.rows(entries, turnOpen: false, statusOf: { statuses[$0] })
        #expect(kinds(rows) == ["item 1", "group [3]", "end 1 last"])
        #expect(group(rows, 1)?.stepRows == 2)
        #expect(group(rows, 1)?.failed == 1)
        guard case .tool(let tool)? = group(rows, 1)?.calls.first?.item else { Issue.record("no wait"); return }
        #expect(WaitSteps.outcomes(tool) == [.init(id: "a", status: "failed"), .init(id: "b", status: "idle")])
    }

    @Test func `an omitted wait with no settled agent is no row, and without sessions the head still speaks`() {
        let entries = [userEntry(1, completedTs: 2_000), omittedWait(3, ids: ["b"], head: #"{"status":"timeout","note":"#)]
        #expect(kinds(TranscriptRows.rows(entries, turnOpen: false, statusOf: { _ in "running" })) == ["item 1", "end 1 last"])
        let headOnly = [userEntry(1, completedTs: 2_000), omittedWait(3, ids: ["a"], head: #"{"agentId":"a","status":"done","reply":"All"#)]
        #expect(kinds(TranscriptRows.rows(headOnly, turnOpen: false)) == ["item 1", "group [3]", "end 1 last"])
    }

    @Test func `an omitted wait keeps the outcome it was first read with, whatever the agent does later`() {
        let entries = [userEntry(1, completedTs: 2_000), omittedWait(3, ids: ["a", "b"], head: #"{"status":"#)]
        let waits = WaitOutcomeMemory()
        var statuses = ["a": "idle", "b": "running"]
        #expect(WaitSteps.unsettledAgents(entries, memory: waits) == ["a", "b"])
        let first = TranscriptRows.rows(entries, turnOpen: false, waits: waits, statusOf: { statuses[$0] })
        #expect(group(first, 1)?.stepRows == 1)
        // a settled and is kept; b still ran then, so the wait did not return
        // on it: decided too, and never asked for again.
        #expect(waits.status(call: "w3", agent: "a") == "idle")
        #expect(waits.decided(call: "w3", agent: "b"))
        #expect(waits.status(call: "w3", agent: "b") == nil)
        #expect(WaitSteps.unsettledAgents(entries, memory: waits) == [])
        // a runs again later and b settles: the steps are the ones first read.
        statuses["a"] = "running"
        statuses["b"] = "idle"
        let later = TranscriptRows.rows(entries, turnOpen: false, waits: waits, statusOf: { statuses[$0] })
        #expect(group(later, 1)?.stepRows == 1)
        guard case .tool(let tool)? = group(later, 1)?.calls.first?.item else { Issue.record("the wait's step left"); return }
        #expect(WaitSteps.outcomes(tool) == [.init(id: "a", status: "idle")])
        // An agent no host knew at the first read waits for its first read.
        let unknown = WaitOutcomeMemory()
        let cold = [userEntry(1, completedTs: 2_000), omittedWait(5, ids: ["z"], head: #"{"status":"#)]
        #expect(kinds(TranscriptRows.rows(cold, turnOpen: false, waits: unknown, statusOf: { _ in nil })) == ["item 1", "end 1 last"])
        #expect(WaitSteps.unsettledAgents(cold, memory: unknown) == ["z"])
        #expect(group(TranscriptRows.rows(cold, turnOpen: false, waits: unknown, statusOf: { _ in "done" }), 1)?.stepRows == 1)
        // Without the memory it reads the agents as they are now: a's step goes, b's comes.
        let unkept = TranscriptRows.rows(entries, turnOpen: false, statusOf: { statuses[$0] })
        guard case .tool(let now)? = group(unkept, 1)?.calls.first?.item else { Issue.record("no wait"); return }
        #expect(WaitSteps.outcomes(now) == [.init(id: "b", status: "idle")])
        // A refold keeps what the fold read.
        let fold = ThreadFold()
        fold.waitOutcomes.keep(call: "w3", agent: "a", status: "idle")
        #expect(ThreadFold(keys: fold.keys, provisionalFrom: fold).waitOutcomes.status(call: "w3", agent: "a") == "idle")
    }

    @Test func `an all wait keeps an agent whose idle meta lands after the wait's row; an any wait does not`() {
        // The parent's row lands while B's meta still reads running: the host returned the
        // `all` wait on both, so B's step comes once its idle meta lands, and stays.
        let all = [userEntry(1, completedTs: 2_000), omittedWait(3, ids: ["a", "b"], head: #"{"status":"#, mode: "all")]
        guard case .tool(let allTool) = all[1].item else { Issue.record("no wait"); return }
        #expect(WaitSteps.gathersAll(allTool))
        let waits = WaitOutcomeMemory()
        var statuses = ["a": "idle", "b": "running"]
        #expect(group(TranscriptRows.rows(all, turnOpen: false, waits: waits, statusOf: { statuses[$0] }), 1)?.stepRows == 1)
        #expect(!waits.decided(call: "w3", agent: "b"))
        #expect(WaitSteps.unsettledAgents(all, memory: waits) == ["b"])
        statuses["b"] = "idle"
        let landed = TranscriptRows.rows(all, turnOpen: false, waits: waits, statusOf: { statuses[$0] })
        #expect(group(landed, 1)?.stepRows == 2)
        #expect(waits.status(call: "w3", agent: "b") == "idle")
        // Snapshotted as before: B running again later keeps its step.
        statuses["b"] = "running"
        #expect(group(TranscriptRows.rows(all, turnOpen: false, waits: waits, statusOf: { statuses[$0] }), 1)?.stepRows == 2)
        #expect(WaitSteps.unsettledAgents(all, memory: waits) == [])
        // `any` (and no mode, the host's default): B at work at the first read was not returned on.
        for mode in ["any", nil] as [String?] {
            let any = [userEntry(1, completedTs: 2_000), omittedWait(5, ids: ["a", "b"], head: #"{"status":"#, mode: mode)]
            guard case .tool(let anyTool) = any[1].item else { Issue.record("no wait"); return }
            #expect(!WaitSteps.gathersAll(anyTool))
            let memory = WaitOutcomeMemory()
            var now = ["a": "idle", "b": "running"]
            #expect(group(TranscriptRows.rows(any, turnOpen: false, waits: memory, statusOf: { now[$0] }), 1)?.stepRows == 1)
            #expect(memory.decided(call: "w5", agent: "b"))
            now["b"] = "idle"
            #expect(group(TranscriptRows.rows(any, turnOpen: false, waits: memory, statusOf: { now[$0] }), 1)?.stepRows == 1)
        }
        // An `all` over one agent returns as `any` does.
        guard case .tool(let one) = omittedWait(7, ids: ["a"], head: "", mode: "all").item else { Issue.record("no wait"); return }
        #expect(!WaitSteps.gathersAll(one))
    }

    @Test func `the wait statuses map reads only the ids asked, and an id it has not read falls back`() {
        var asked: [String] = []
        let read = WaitStatuses.read(["a", "gone"]) { id in asked.append(id); return id == "a" ? "running" : nil }
        #expect(Set(asked) == ["a", "gone"])
        #expect(read.statuses == ["a": "running"])
        #expect(read.status("a", unread: { _ in "idle" }) == "running")
        #expect(read.status("gone", unread: { _ in "idle" }) == nil)
        #expect(read.status("new", unread: { _ in "idle" }) == "idle")
        #expect(read == WaitStatuses.read(["a", "gone"]) { $0 == "a" ? "running" : nil })
    }

    @Test func `everything between two paragraphs is one group`() {
        let rows = TranscriptRows.rows([userEntry(1), read(2), edit(3), run(4), read(5), item(textItem(6, ts: 1_006, "done")), run(7)], turnOpen: false)
        #expect(kinds(rows) == ["item 1", "group [2, 3, 4, 5]", "item 6", "group [7]"])
        // Two reads outnumber one edit and one command: the line leads with research.
        #expect(group(rows, 1)?.kind == .research)
        #expect(group(rows, 1)?.id == TranscriptRowID(key: 2))
        #expect(group(rows, 1)?.lone == false)
        #expect(group(rows, 3)?.lone == true)
    }

    @Test func `a todo update and thinking join the run, an approval and a page break it`() {
        let plan = item(toolItem(6, ts: 1_006, doneTs: 1_106, name: "TodoWrite"))
        let approval = item(.approval(ApprovalItem(seq: 8, ts: 1_008, request: ApprovalRequestEvent(requestId: "r", toolName: "Bash"), allowed: true, auto: false)))
        let thought = item(textItem(11, ts: 1_011, "hmm", thinking: true))
        let rows = TranscriptRows.rows([userEntry(1), read(2), read(3), edit(4), read(5), plan, read(7), approval, read(9), read(10), thought, read(12)], turnOpen: false)
        #expect(kinds(rows) == ["item 1", "group [2, 3, 4, 5, 6, 7]", "item 8", "group [9, 10, 11, 12]"])
    }

    @Test func `a group keeps its first step's key as steps append`() {
        let before = TranscriptRows.rows([userEntry(1), read(2), read(3)], turnOpen: true)
        let after = TranscriptRows.rows([userEntry(1), read(2), read(3), read(4)], turnOpen: true)
        #expect(before[1].id == after[1].id)
        #expect(after[1].id == TranscriptRowID(key: 2))
        #expect(group(after, 1)?.entries.count == 3)
    }

    @Test func `the open turn works in its last group, and through a card that waits on the person`() {
        let open = TranscriptRows.rows([userEntry(1), read(2), read(3)], turnOpen: true)
        #expect(kinds(open) == ["item 1", "group [2, 3] live", "line 1 last"])
        #expect(group(open, 1)?.working == true)
        #expect(group(open, 1)?.settled == false)
        let settled = TranscriptRows.rows([userEntry(1), read(2), read(3)], turnOpen: false)
        #expect(kinds(settled) == ["item 1", "group [2, 3]"])
        #expect(group(settled, 1)?.working == false)
        #expect(group(settled, 1)?.settled == true)
        // Prose after the group: the agent moved on.
        let followed = TranscriptRows.rows([userEntry(1), read(2), read(3), item(textItem(4, ts: 1_004, "so", streaming: true))], turnOpen: true)
        #expect(kinds(followed) == ["item 1", "group [2, 3]", "item 4", "line 1 last"])
        #expect(group(followed, 1)?.working == false)
        // A card waiting on the person: the group above it still works, and is not live.
        let asking = item(.approval(ApprovalItem(seq: 4, ts: 1_004, request: ApprovalRequestEvent(requestId: "r", toolName: "Bash"), allowed: nil, auto: false)))
        let waiting = TranscriptRows.rows([userEntry(1), read(2), read(3), asking], turnOpen: true)
        #expect(group(waiting, 1)?.working == true)
        #expect(group(waiting, 1)?.live == false)
        // An earlier turn's group never works, however the last turn stands.
        let earlier = TranscriptRows.rows([userEntry(1, completedTs: 1_900), read(2), read(3), userEntry(4, ts: 2_000), read(5), read(6)], turnOpen: true)
        #expect(kinds(earlier) == ["item 1", "group [2, 3]", "end 1", "item 4", "group [5, 6] live", "line 4 last"])
        #expect(group(earlier, 1)?.working == false)
    }

    private func steer(_ seq: Int, ts: Int, completedTs: Int? = nil) -> ThreadEntry {
        item(.user(UserTurn(seq: seq, ts: ts, text: "and the docs", attachments: [], model: nil, reasoning: nil, completedTs: completedTs, costUsd: nil, steerId: "s\(seq)")))
    }

    @Test func `a message that lands mid-turn joins it: one end row, the opener's, last`() {
        let open = TranscriptRows.rows([userEntry(1), read(2), steer(3, ts: 1_500), read(4)], turnOpen: true)
        #expect(kinds(open) == ["item 1", "group [2]", "item 3", "group [4] live", "line 1 last"])
        // The close stamps both at once: one turn still, its closing line under the steer.
        let closed = TranscriptRows.rows([userEntry(1, completedTs: 9_000), read(2), steer(3, ts: 1_500, completedTs: 9_000), read(4)], turnOpen: false)
        #expect(kinds(closed) == ["item 1", "group [2]", "item 3", "group [4]", "end 1 last"])
        // A message after the close is a turn of its own.
        let next = TranscriptRows.rows([userEntry(1, completedTs: 9_000), read(2), userEntry(3, ts: 10_000), read(4)], turnOpen: true)
        #expect(kinds(next) == ["item 1", "group [2]", "end 1", "item 3", "group [4] live", "line 3 last"])
    }

    @Test func `a steer's bubble and the reply after it are the opener's turn, the key its end row carries`() {
        let entries = [userEntry(1, completedTs: 9_000), read(2), steer(3, ts: 1_500, completedTs: 9_000), item(textItem(4, ts: 1_600, "Checked.")), userEntry(5, ts: 10_000), item(textItem(6, ts: 10_100, "Next."))]
        let rows = TranscriptRows.rows(entries, turnOpen: true)
        let keys = TranscriptRows.turnKeys(rows)
        #expect(kinds(rows) == ["item 1", "group [2]", "item 3", "item 4", "end 1", "item 5", "item 6", "line 5 last"])
        let first = entries[0].key, second = entries[4].key
        #expect(rows.map { keys[$0.id] } == [first, first, first, first, first, second, second, second])
        #expect(rows.compactMap { if case .turnEnd(let end) = $0 { end.userKey } else { nil } } == [first, second])
    }

    @Test func `a group never takes a key that left it: a page that settled keeps its own`() {
        let memory = RowKeyMemory()
        let running = item(toolItem(2, ts: 1_002, name: "mcp__app__html_render", callId: "r"))
        let other = item(toolItem(3, ts: 1_003, doneTs: 1_050, callId: "b"))
        let before = TranscriptRows.rows([userEntry(1), running, other], turnOpen: true, memory: memory)
        #expect(group(before, 1)?.key == 2)
        let page = ThreadEntry(item: .tool(ToolItem(seq: 2, ts: 1_002, callId: "r", name: "mcp__app__html_render", display: nil, input: nil, partial: false, preview: nil, parentCallId: nil, inputOmitted: false, output: .whole(#"{"htmlRender":{"sessionId":"s1","pageId":"p1234567890abcde","title":"Chart","height":420}}"#), status: .done, reauth: nil, doneTs: 1_100)), key: 2)
        let after = TranscriptRows.rows([userEntry(1), page, other], turnOpen: true, memory: memory)
        let ids = after.map(\.id)
        #expect(Set(ids).count == ids.count, "\(kinds(after))")
        #expect(kinds(after) == ["item 1", "item 2", "group [3] live", "line 1 last"])
    }

    @Test func `the gap above a row is the boundary's, the desktop's ROW_GAP`() {
        let rows = TranscriptRows.rows([
            userEntry(1, completedTs: 9_000), read(2), item(textItem(3, ts: 1_003, "Prose.")), read(4), steer(5, ts: 1_500, completedTs: 9_000), item(textItem(6, ts: 1_006, "Done.")),
            userEntry(7, ts: 10_000), read(8), item(errorItem(9, "boom")),
        ], turnOpen: true)
        #expect(kinds(rows) == ["item 1", "group [2]", "item 3", "group [4]", "item 5", "item 6", "end 1", "item 7", "group [8]", "item 9", "line 7 last"])
        let gaps = rows.indices.map { RowGap.above(rows[$0], after: $0 > 0 ? rows[$0 - 1] : nil) }
        #expect(gaps == [16, 16, 12, 12, 32, 16, 8, 32, 16, 12, 8])
        // Two lines sit 4 apart; a group under a thought line too.
        let lines = TranscriptRows.rows([userEntry(1), read(2), item(.compaction(CompactionItem(seq: 3, ts: 1_003, phase: .done)))], turnOpen: false)
        #expect(RowGap.above(lines[2], after: lines[1]) == 4)
    }

    @Test func `a settled turn keeps its rows from the last build while it reads the same`() {
        let memory = RowKeyMemory()
        let history = [userEntry(1, completedTs: 2_000), read(2), read(3), item(textItem(4, ts: 1_004, "Done.")), userEntry(5, ts: 3_000)]
        let first = TranscriptRows.rows(history, turnOpen: true, memory: memory)
        #expect(memory.keptTurns == 1)
        let grown = history + [read(6)]
        let second = TranscriptRows.rows(grown, turnOpen: true, memory: memory)
        #expect(memory.keptTurns == 1)
        // The same rows a build from nothing makes, the settled turn's taken whole.
        #expect(second == TranscriptRows.rows(grown, turnOpen: true))
        #expect(Array(second.prefix(4)) == Array(first.prefix(4)))
        // A settled turn whose entries changed (a replayed row) is built again.
        let replayed = [userEntry(1, completedTs: 2_000), read(2), read(7), item(textItem(4, ts: 1_004, "Done.")), userEntry(5, ts: 3_000), read(6)]
        #expect(TranscriptRows.rows(replayed, turnOpen: true, memory: memory) == TranscriptRows.rows(replayed, turnOpen: true))
    }

    @Test func `a settled turn ends with its duration and answer; the last turn, open or pending, ends on its working line`() {
        let rows = TranscriptRows.rows([
            userEntry(1, ts: 1_000, completedTs: 13_400),
            item(textItem(2, ts: 1_002, "First.")),
            read(3),
            item(textItem(4, ts: 1_004, "Second.")),
            userEntry(5, ts: 20_000),
            item(textItem(6, ts: 20_001, "streaming", streaming: true)),
            item(.user(UserTurn(seq: -100_000, ts: 30_000, text: "queued", attachments: [], model: nil, reasoning: nil, completedTs: nil, costUsd: nil))),
        ], turnOpen: true)
        // A message sent mid-turn joins it: the open turn keeps its one end row, its opener's.
        #expect(kinds(rows) == ["item 1", "item 2", "group [3]", "item 4", "end 1", "item 5", "item 6", "item -100000", "line 5 last"])
        guard case .turnEnd(let end) = rows[4] else { return }
        #expect(end.durationMs == 12_400)
        #expect(end.completedTs == 13_400)
        #expect(end.answer == "First.\n\nSecond.")
        #expect(end.id == TranscriptRowID(key: 1, end: true))
        // A completed time before the turn's start never reads negative.
        let clamped = TranscriptRows.rows([userEntry(1, ts: 5_000, completedTs: 4_000)], turnOpen: false)
        guard case .turnEnd(let zero) = clamped[1], !zero.open, zero.last else {
            Issue.record("shape \(kinds(clamped))")
            return
        }
        #expect(zero.durationMs == 0)
    }

    @Test func `the open turn's line carries the turn, its Stop and a card that waits; a settled one carries none`() {
        let approval = item(.approval(ApprovalItem(seq: 3, ts: 1_003, request: ApprovalRequestEvent(requestId: "r", toolName: "Bash"), allowed: nil, auto: false)))
        let open = TranscriptRows.rows([userEntry(1), read(2), approval], turnOpen: true)
        guard case .turnEnd(let line)? = open.last else {
            Issue.record("shape \(kinds(open))")
            return
        }
        #expect(line.open && line.awaitsUser)
        #expect(line.turn.map(\.seq) == [1, 2, 3])
        // The person's Stop is no row: the end row says Stopped.
        let stop = item(.system(SystemLine(seq: 4, ts: 1_004, kind: .error, text: "stopped", detail: nil, stopped: true)))
        let stopped = TranscriptRows.rows([userEntry(1, completedTs: 1_010), read(2), stop], turnOpen: false)
        #expect(kinds(stopped) == ["item 1", "group [2]", "end 1 stopped last"])
        guard case .turnEnd(let end)? = stopped.last else { return }
        #expect(end.turn.isEmpty)
        // A failure is a row of its own and stops nothing.
        let failed = item(.system(SystemLine(seq: 4, ts: 1_004, kind: .error, text: "boom", detail: nil, stopped: false)))
        #expect(kinds(TranscriptRows.rows([userEntry(1, completedTs: 1_010), failed], turnOpen: false)) == ["item 1", "item 4", "end 1 last"])
    }

    @Test func `while the turn is open, a streaming thought is no step and a told call no row`() {
        let thinking = item(textItem(2, ts: 1_002, "Look at the schema.", thinking: true, streaming: true))
        #expect(kinds(TranscriptRows.rows([userEntry(1), thinking], turnOpen: true)) == ["item 1", "line 1 last"])
        // The thought ended: a run of thoughts alone still draws nothing.
        let thought = item(textItem(2, ts: 1_002, "Look at the schema.", thinking: true))
        #expect(kinds(TranscriptRows.rows([userEntry(1), thought], turnOpen: true)) == ["item 1", "line 1 last"])
        // One told call alone is no row; it lands in its group once it settles, under the same key.
        let running = run(3, running: true)
        #expect(kinds(TranscriptRows.rows([userEntry(1), thought, running], turnOpen: true)) == ["item 1", "line 1 last"])
        let landed = TranscriptRows.rows([userEntry(1), thought, run(3)], turnOpen: true)
        #expect(kinds(landed) == ["item 1", "group [2, 3] live", "line 1 last"])
        // Beside a settled step it is a step of the group, named in its line, with no row.
        let rows = TranscriptRows.rows([userEntry(1), read(2), running], turnOpen: true)
        #expect(kinds(rows) == ["item 1", "group [2, 3] live", "line 1 last"])
        #expect(group(rows, 1)?.lone == false)
        #expect(group(rows, 1)?.shown(byHand: false).map(\.seq) == [2])
        // An agent call is never told: it stays a row with its state.
        let spawn = item(toolItem(3, ts: 1_003, name: "spawn_agent", input: ["task": .string("look")]))
        #expect(group(TranscriptRows.rows([userEntry(1), read(2), spawn], turnOpen: true), 1)?.shown(byHand: false).map(\.seq) == [2, 3])
    }

    @Test func `a thought shows only in a group opened by hand`() {
        let thought = item(textItem(2, ts: 1_002, "Look at the schema.", thinking: true))
        let rows = TranscriptRows.rows([userEntry(1, completedTs: 2_000), thought, read(3), read(4)], turnOpen: false)
        #expect(group(rows, 1)?.shown(byHand: false).map(\.seq) == [3, 4])
        #expect(group(rows, 1)?.shown(byHand: true).map(\.seq) == [2, 3, 4])
        // A thought does not make a step: one call with thoughts is lone.
        let lone = TranscriptRows.rows([userEntry(1, completedTs: 2_000), thought, read(3)], turnOpen: false)
        #expect(group(lone, 1)?.lone == true)
        #expect(group(lone, 1)?.kind == .research)
        #expect(group(lone, 1)?.phrase() == "Read 3.ts")
    }

    @Test func `a stopped turn's running call draws settled`() {
        let stop = item(.system(SystemLine(seq: 4, ts: 1_004, kind: .error, text: "stopped", detail: nil, stopped: true)))
        let rows = TranscriptRows.rows([userEntry(1, completedTs: 1_010), read(2), run(3, running: true), stop], turnOpen: false)
        #expect(kinds(rows) == ["item 1", "group [2, 3]", "end 1 stopped last"])
        #expect(group(rows, 1)?.settled == true)
        #expect(group(rows, 1)?.working == false)
        #expect(group(rows, 1)?.shown(byHand: false).map(\.seq) == [2, 3])
    }

    @Test func `the line counts every edit and every failure`() {
        let failed = item(.tool(ToolItem(seq: 5, ts: 1_005, callId: "c5", name: "Bash", display: nil, input: .object(["command": .string("bun test")]), partial: false, preview: nil, parentCallId: nil, inputOmitted: false, output: .none, status: .failed, reauth: nil, doneTs: 1_105)))
        let rows = TranscriptRows.rows([userEntry(1, completedTs: 2_000), edit(2), read(3), failed], turnOpen: false)
        guard let line = group(rows, 1) else {
            Issue.record("shape \(kinds(rows))")
            return
        }
        #expect(line.adds == 1 && line.dels == 1)
        #expect(line.failed == 1)
        #expect(!line.phrase().contains("failed"))
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
        #expect(TurnEndWords.worked(ms: 800) == "Worked for 1s")
        #expect(TurnEndWords.worked(ms: 12_000) == "Worked for 12s")
        #expect(TurnEndWords.worked(ms: 125_000) == "Worked for 2m 5s")
        #expect(TurnEndWords.worked(ms: 120_000) == "Worked for 2m")
    }

    @Test func `entries before the first user row fold on their own`() {
        let rows = TranscriptRows.rows([read(2), read(3), item(textItem(4, ts: 1_004, "done"))], turnOpen: false)
        #expect(kinds(rows) == ["group [2, 3]", "item 4"])
        // A subagent's transcript with no message of its own: its last group is live while it runs.
        #expect(kinds(TranscriptRows.rows([read(2), read(3)], turnOpen: true)) == ["group [2, 3] live"])
    }
}

/// `GroupFold`: how a group opens and folds (the desktop's ActionGroup with useFoldHold).
@Suite struct GroupFoldTests {
    @Test func `mounted working it is open, mounted settled closed; a lone step is always its row`() {
        #expect(GroupFold(working: true).isOpen(lone: false))
        #expect(!GroupFold(working: false).isOpen(lone: false))
        #expect(GroupFold(working: false).isOpen(lone: true))
    }

    @Test func `it folds once the hold is let go after its time, and not before`() {
        var fold = GroupFold(working: true)
        fold.set(working: false, at: 10)
        #expect(fold.isOpen(lone: false))
        #expect(fold.holding)
        let early = fold.release(at: 10 + GroupFold.hold - 0.01)
        #expect(!early)
        #expect(fold.isOpen(lone: false))
        // Past its time the hold stays until the view lets it go (a reader scrolled up waits).
        #expect(fold.isOpen(lone: false))
        let late = fold.release(at: 10 + GroupFold.hold + 5)
        #expect(late)
        #expect(!fold.isOpen(lone: false))
        #expect(!fold.holding)
        // Work coming back inside the hold keeps it open with no hold left.
        var back = GroupFold(working: true)
        back.set(working: false, at: 10)
        back.set(working: true, at: 10.2)
        #expect(back.isOpen(lone: false))
        #expect(back.heldUntil == nil)
        let none = back.release(at: 20)
        #expect(!none)
    }

    @Test func `a person's hand decides from then on`() {
        var closed = GroupFold(working: true)
        closed.toggle(lone: false)
        #expect(closed.hand == false)
        #expect(!closed.isOpen(lone: false))
        closed.set(working: false, at: 2)
        closed.set(working: true, at: 3)
        #expect(!closed.isOpen(lone: false))
        // Opening a row's body keeps it open past the hold.
        var kept = GroupFold(working: true)
        kept.decide()
        kept.set(working: false, at: 5)
        #expect(kept.isOpen(lone: false))
        #expect(!kept.holding)
        // A decision already made is not overturned by a body opening.
        var shut = GroupFold(working: false)
        shut.choose(open: false)
        shut.decide()
        #expect(shut.hand == false)
    }

    @Test func `a hand outlives the row: kept by group key, the newest kept`() {
        let book = GroupHands.Book()
        let hands = book.hands("env|s1")
        hands.set(7, open: true)
        // The row remounts: a new fold reads the choice back.
        #expect(book.hands("env|s1").choice(7) == true)
        #expect(GroupFold(working: false, hand: book.hands("env|s1").choice(7)).isOpen(lone: false))
        #expect(book.hands("env|s2").choice(7) == nil)
        for key in 0..<(GroupHands.capacity + 10) { hands.set(1_000 + key, open: false) }
        #expect(hands.count == GroupHands.capacity)
        #expect(hands.choice(7) == nil)
    }

    @Test func `a working group shows its newest five rows, a decided one every row`() {
        let rows = Array(1...8)
        let auto = GroupFold(working: true)
        #expect(Array(auto.visible(rows, lone: false)) == [4, 5, 6, 7, 8])
        var hand = auto
        hand.choose(open: true)
        #expect(Array(hand.visible(rows, lone: false)) == rows)
        #expect(Array(auto.visible([1], lone: true)) == [1])
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

    @Test func `the end row is the message's key, from the working line to the closing line`() {
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
    @Test func `rows growing below a reader at the bottom keep them there and pin`() {
        let after = FollowRule.atBottom(was: true, geometry: false, readerMoving: false, offBottomWrite: false)
        #expect(after.atBottom && after.pin)
    }

    @Test func `only the reader's own scroll or a deliberate scroll to a row leaves the bottom`() {
        #expect(FollowRule.atBottom(was: true, geometry: false, readerMoving: true, offBottomWrite: false) == (false, false))
        #expect(FollowRule.atBottom(was: true, geometry: false, readerMoving: false, offBottomWrite: true) == (false, false))
        // A reader already up stays up whatever grows, and nothing pins them.
        #expect(FollowRule.atBottom(was: false, geometry: false, readerMoving: false, offBottomWrite: false) == (false, false))
        // Reaching the bottom by any road is being there.
        #expect(FollowRule.atBottom(was: false, geometry: true, readerMoving: true, offBottomWrite: false) == (true, false))
    }

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

/// `TranscriptRows.windowStart`: the list's window holds its top row while rows arrive below.
@Suite struct TranscriptWindowTests {
    private func rows(_ keys: ClosedRange<Int>) -> [TranscriptRowModel] {
        keys.map { .item(ThreadEntry(item: textItem($0, ts: $0, "p\($0)"), key: $0)) }
    }

    @Test func `rows arriving below never push the top row out`() {
        let before = rows(1...100)
        let start = TranscriptRows.windowStart(before, top: nil, count: 75)
        #expect(start == 25)
        let top = before[start].id
        #expect(TranscriptRows.windowStart(rows(1...110), top: top, count: 75) == 25)
    }

    @Test func `a top row that left, or a resize, takes the newest rows`() {
        #expect(TranscriptRows.windowStart(rows(30...110), top: TranscriptRowID(key: 26), count: 75) == 6)
        #expect(TranscriptRows.windowStart(rows(1...10), top: nil, count: 75) == 0)
    }
}

@Suite struct TranscriptQuestionCallTests {
    @Test func `a question call whose card follows is no step`() {
        let ask = item(toolItem(2, ts: 1_002, doneTs: 1_102, name: "AskUserQuestion"))
        let card = item(.question(QuestionItem(seq: 3, ts: 1_003, request: QuestionRequestEvent(requestId: "q", questions: []), answers: nil, resolved: false)))
        let rows = TranscriptRows.rows([item(userItem(1, ts: 1_000)), ask, card], turnOpen: true)
        #expect(rows.map(\.id.key) == [1, 3, 1])
        // With no card after it the call stays a step.
        #expect(TranscriptRows.rows([item(userItem(1, ts: 1_000)), ask], turnOpen: false).count == 2)
    }
}
