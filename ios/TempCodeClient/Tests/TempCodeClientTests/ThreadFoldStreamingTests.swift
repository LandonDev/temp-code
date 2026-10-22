import Foundation
import Testing
import TempCodeContract
@testable import TempCodeClient

/// A streaming preview of a tool call: seq -1, ephemeral, the input so far.
private func partial(_ callId: String, _ name: String, _ input: [String: JSONValue], ts: Int = 5_000) -> EventRow {
    EventRow(sessionId: "s", seq: -1, ts: ts, event: .toolCall(ToolCallEvent(callId: callId, name: name, input: .object(input), partial: true)), ephemeral: true)
}

private func row(_ seq: Int, _ event: AgentEvent, ts: Int? = nil) -> EventRow {
    EventRow(sessionId: "s", seq: seq, ts: ts ?? 1_000 + 100 * seq, event: event)
}

private func liveEdit(_ path: String, adds: Int? = nil, dels: Int? = nil, diff: String? = nil, settled: Bool? = nil, ts: Int = 9_000) -> LiveEdit.Edit {
    LiveEdit.Edit(path: path, kind: .changed, adds: adds, dels: dels, diff: diff, settled: settled, ts: ts)
}

/// `Board.stat` as a list, for one-line comparisons.
private func statOf(_ tool: ToolItem) -> [Int] {
    let stat = Board.stat(tool)
    return [stat.adds, stat.dels]
}

private func tool(_ fold: ThreadFold, _ index: Int) -> ToolItem? {
    guard fold.items.indices.contains(index), case .tool(let tool) = fold.items[index].item else { return nil }
    return tool
}

@Suite struct ThreadFoldStreamingTests {
    @Test func `a partial call gets a provisional id of its own and the final row stamps the real seq`() {
        var fold = ThreadFold()
        fold.apply(row(1, user("go")))
        fold.apply(partial("c1", "Read", ["file_path": .string("src/a")]))
        #expect(fold.items.count == 2)
        let born = tool(fold, 1)
        #expect(born?.seq == -1_000)
        #expect(born?.partial == true)
        #expect(born?.ts == 5_000)
        #expect(fold.lastSeq == 1, "an ephemeral row never moves the cursor")
        fold.apply(partial("c1", "Read", ["file_path": .string("src/a.ts")]))
        #expect(fold.items.count == 2)
        #expect(tool(fold, 1)?.seq == -1_000, "a replaced partial keeps its id")
        #expect(tool(fold, 1)?.input?["file_path"]?.stringValue == "src/a.ts")
        fold.apply(partial("c2", "Bash", ["command": .string("ls")]))
        #expect(tool(fold, 2)?.seq == -1_001, "two partials never share an id")
        let final = row(2, call("c1", "Read", ["file_path": .string("src/a.ts")]), ts: 6_000)
        fold.apply(final)
        #expect(fold.items.count == 3)
        #expect(tool(fold, 1)?.seq == 2)
        #expect(tool(fold, 1)?.ts == 6_000)
        #expect(tool(fold, 1)?.partial == false)
        #expect(fold.entryID(for: final) == 2)
        #expect(fold.lastSeq == 2)
        fold.apply(row(3, result("c1", "contents")))
        #expect(tool(fold, 1)?.status == .done)
        #expect(tool(fold, 1)?.seq == 2)
    }

    @Test func `a partial arriving after the final call changes nothing`() {
        var fold = ThreadFold()
        fold.apply(partial("c1", "Edit", ["file_path": .string("src/a.ts"), "new_string": .string("partial")]))
        fold.apply(row(1, call("c1", "Edit", ["file_path": .string("src/a.ts"), "new_string": .string("whole")])))
        let before = fold
        fold.apply(partial("c1", "Edit", ["file_path": .string("src/a.ts"), "new_string": .string("stale")]))
        #expect(fold == before)
        #expect(tool(fold, 0)?.input?["new_string"]?.stringValue == "whole")
        #expect(tool(fold, 0)?.partial == false)
    }

    @Test func `a refold from persisted rows never makes a provisional item`() {
        let fold = ThreadFold.fold([row(1, user("go")), row(2, call("c1", "Read", ["file_path": .string("a")])), row(3, result("c1"))])
        #expect(fold.items.map(\.id) == [1, 2])
    }

    @Test func `a live edit stamps the running edit whose path matches, and the preview wins once the result lands`() {
        var fold = ThreadFold()
        fold.apply(row(1, call("e1", "Edit", ["file_path": .string("/repo/src/a.ts"), "old_string": .string("x"), "new_string": .string("y\nz")])))
        #expect(statOf(tool(fold, 0)!) == [2, 1], "the input's line counts before any push")
        let changed1 = fold.applyLiveEdit(liveEdit("src/a.ts", adds: 12, dels: 3, diff: "@@ -1,1 +1,2 @@\n-x\n+y\n+z\n"))
        #expect(changed1)
        let live = tool(fold, 0)?.live
        #expect(live?.adds == 12)
        #expect(live?.dels == 3)
        #expect(live?.startedTs == 9_000)
        #expect(statOf(tool(fold, 0)!) == [12, 3])
        let card = Board.wholeChange(path: "/repo/src/a.ts", edits: [tool(fold, 0)!])
        #expect(card.lines?.map(\.text) == ["x", "y", "z"], "the live diff while the edit runs")
        #expect(card.lines?.map(\.kind) == [.del, .add, .add])
        // A push without counts keeps the previous ones; a later ts moves ts alone.
        let changed2 = fold.applyLiveEdit(liveEdit("src/a.ts", diff: "@@ -1,1 +1,3 @@\n-x\n+y\n+z\n+w\n", ts: 9_100))
        #expect(changed2)
        #expect(tool(fold, 0)?.live?.adds == 12)
        #expect(tool(fold, 0)?.live?.startedTs == 9_000)
        #expect(tool(fold, 0)?.live?.ts == 9_100)
        fold.apply(row(2, call("e1", "Edit", ["file_path": .string("/repo/src/a.ts")], preview: editPreview("/repo/src/a.ts", adds: 20, dels: 4, lines: ["y", "z", "w"]))))
        fold.apply(row(3, result("e1")))
        #expect(tool(fold, 0)?.status == .done)
        #expect(statOf(tool(fold, 0)!) == [20, 4], "the result's preview wins")
        #expect(tool(fold, 0)?.live?.adds == 12, "the live state stays on the item")
        let changed3 = fold.applyLiveEdit(liveEdit("src/a.ts", adds: 13))
        #expect(!changed3, "nothing running matches any more")
    }

    @Test func `a live edit before its call is kept and stamped when the call lands`() {
        var fold = ThreadFold()
        let changed4 = fold.applyLiveEdit(liveEdit("src/b.ts", adds: 4, dels: 0))
        #expect(!changed4)
        #expect(fold.liveEdits["src/b.ts"]?.adds == 4)
        fold.apply(partial("e2", "Edit", ["file_path": .string("src/b.ts")]))
        #expect(tool(fold, 0)?.live?.adds == 4, "a partial-born edit takes the stored state")
        #expect(statOf(tool(fold, 0)!) == [4, 0])
        fold.apply(row(1, call("e3", "Write", ["file_path": .string("/repo/src/b.ts"), "content": .string("a\nb")])))
        #expect(tool(fold, 1)?.live?.adds == 4, "an absolute path matches the relative one")
    }

    @Test func `a settled push keeps the state and the cap drops the oldest`() {
        var fold = ThreadFold()
        fold.apply(row(1, call("e1", "Edit", ["file_path": .string("src/a.ts")])))
        fold.applyLiveEdit(liveEdit("src/a.ts", adds: 2, dels: 1))
        fold.applyLiveEdit(liveEdit("src/a.ts", settled: true, ts: 9_500))
        #expect(tool(fold, 0)?.live?.settled == true)
        #expect(tool(fold, 0)?.live?.adds == 2)
        #expect(statOf(tool(fold, 0)!) == [2, 1])
        for i in 0..<LiveEdits.max { fold.applyLiveEdit(liveEdit("other/\(i).ts", adds: 1)) }
        #expect(fold.liveEdits.count == LiveEdits.max)
        #expect(fold.liveEdits["src/a.ts"] == nil, "the oldest path left")
        #expect(fold.liveEdits["other/0.ts"] != nil)
        #expect(tool(fold, 0)?.live?.adds == 2, "the item keeps what it was stamped with")
    }

    @Test func `the live edits carry over a refold`() {
        var fold = ThreadFold()
        fold.apply(row(1, call("e1", "Edit", ["file_path": .string("src/a.ts")])))
        fold.applyLiveEdit(liveEdit("src/a.ts", adds: 7, dels: 2))
        var rebuilt = ThreadFold.fold([row(1, call("e1", "Edit", ["file_path": .string("src/a.ts")]))])
        #expect(tool(rebuilt, 0)?.live == nil)
        rebuilt.carryLiveEdits(from: fold)
        #expect(tool(rebuilt, 0)?.live?.adds == 7)
        #expect(rebuilt.liveEdits.count == 1)
    }

    @Test func `the path match is equal or one under the other`() {
        #expect(LiveEdits.matches("src/a.ts", "src/a.ts"))
        #expect(LiveEdits.matches("src/a.ts", "/repo/src/a.ts"))
        #expect(LiveEdits.matches("/repo/src/a.ts", "src/a.ts"))
        #expect(!LiveEdits.matches("a.ts", "src/ba.ts"))
        #expect(!LiveEdits.matches("src/a.ts", "src/b.ts"))
    }
}
