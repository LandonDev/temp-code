import Foundation
import Testing
import TempCodeContract
@testable import TempCodeClient

/// The desktop's ten "no jerk in any scenario" cases
/// (AgentTranscript.scenarios.dom.test.tsx) through the phone's pure runner:
/// every row keeps its key, the end row is its message's from Send to the
/// close, and nothing scrolls while the reader is up; the reveal, the fade,
/// the drain, the phase hold and the word morph hold in every one.
private func row(_ seq: Int, _ ts: Int, _ event: AgentEvent, ephemeral: Bool = false) -> EventRow {
    EventRow(sessionId: "s", seq: seq, ts: ts, event: event, ephemeral: ephemeral ? true : nil)
}

private func thought(_ text: String, msg: String = "t1", delta: Bool = true) -> AgentEvent {
    .thinking(ThinkingEvent(text: text, delta: delta, msgId: msg, blockIndex: 0))
}

private func prose(_ text: String, msg: String = "p1", delta: Bool = true) -> AgentEvent {
    .assistantText(AssistantTextEvent(text: text, delta: delta, msgId: msg, blockIndex: 0))
}

private func tool(_ id: String, _ name: String, partial: Bool = false, _ input: [String: JSONValue] = [:]) -> AgentEvent {
    .toolCall(ToolCallEvent(callId: id, name: name, input: .object(input), partial: partial ? true : nil))
}

private func done(_ id: String, _ output: String = "ok") -> AgentEvent {
    .toolResult(ToolResultEvent(callId: id, output: .string(output), isError: false))
}

private let complete = AgentEvent.turnComplete(TurnCompleteEvent())

@MainActor
@discardableResult
private func expectClean(_ scenario: TranscriptScenario) -> ScenarioReport {
    let report = ScenarioRunner.run(scenario)
    #expect(report.violations == [], "\(scenario.name)")
    #expect(report.checked.contains(.keys))
    return report
}

@MainActor
@Suite struct TranscriptScenarioTests {
    @Test func `a turn from the composer: Sending, the echo, a thought, calls, prose, the close`() {
        expectClean(TranscriptScenario("composer turn", pushes: [
            .init(atMs: 0, "send", .send("Fix the build")),
            .init(atMs: 40, "the echo", .rows([row(1, 40, user("Fix the build"))])),
            .init(atMs: 300, "a thought", .rows([row(2, 300, thought("Look at the log."))])),
            .init(atMs: 500, "a read streams in", .rows([row(-1, 500, tool("a", "Read", partial: true, ["file_path": .string("src/a.ts")]), ephemeral: true)])),
            .init(atMs: 700, "the read's call row", .rows([row(3, 700, tool("a", "Read", ["file_path": .string("src/a.ts")]))])),
            .init(atMs: 900, "it settles", .rows([row(4, 900, done("a"))])),
            .init(atMs: 1_000, "prose", .rows([row(5, 1_000, prose("Reading it now."))])),
            .init(atMs: 1_200, "a command: the group grows", .rows([row(6, 1_200, tool("b", "Bash", ["command": .string("bun test")])), row(7, 1_250, tool("c", "Edit", ["file_path": .string("src/b.ts")]))])),
            .init(atMs: 1_800, "they settle", .rows([row(8, 1_800, done("b")), row(9, 1_850, done("c"))])),
            .init(atMs: 2_000, "the answer, then the close", .rows([row(10, 2_000, prose("Done.", msg: "p2")), row(11, 2_050, complete)])),
        ]))
    }

    @Test func `a fast turn: the echo, prose and the close inside 100 ms`() {
        let report = expectClean(TranscriptScenario("fast turn", pushes: [
            .init(atMs: 0, "send", .send("hi")),
            .init(atMs: 30, "the echo", .rows([row(1, 30, user("hi"))])),
            .init(atMs: 60, "prose", .rows([row(2, 60, prose("Hello."))])),
            .init(atMs: 90, "the close", .rows([row(3, 90, complete)])),
        ]))
        // Sending shows its 300 ms, the mark alone while the reply reveals, then the closing words.
        #expect(report.lineEvents.map { $0.split(separator: " ", maxSplits: 2).last.map(String.init) ?? "" } == ["morph sending → writing", "morph writing → closed"], "\(report.lineEvents)")
        #expect(report.lineWords.values.first == "Worked for 1s")
    }

    @Test func `a long call with no output, then a burst of three`() {
        expectClean(TranscriptScenario("long call", pushes: [
            .init(atMs: 0, "send", .send("go")),
            .init(atMs: 20, "echo and a read", .rows([row(1, 20, user("go")), row(2, 40, tool("a", "Read")), row(3, 60, done("a"))])),
            .init(atMs: 100, "a long command", .rows([row(4, 100, tool("b", "Bash", ["command": .string("sleep 60")]))])),
            .init(atMs: 60_000, "it settles, a burst of three", .rows([row(5, 60_000, done("b")), row(6, 60_010, tool("c", "Read")), row(7, 60_020, tool("d", "Read")), row(8, 60_030, tool("e", "Edit"))])),
            .init(atMs: 60_200, "more", .rows([row(9, 60_200, done("c")), row(10, 60_210, done("d")), row(11, 60_220, done("e")), row(12, 60_230, tool("f", "Read"))])),
        ]))
    }

    @Test func `thinking sentences every 100 ms, then every 2 s`() {
        var pushes: [TranscriptScenario.Push] = [.init(atMs: 0, "send", .send("think")), .init(atMs: 10, "echo", .rows([row(1, 10, user("think"))]))]
        for i in 0..<10 { pushes.append(.init(atMs: 100 + 100 * i, "sentence \(i)", .rows([row(2 + i, 100 + 100 * i, thought("Sentence \(i). "))]))) }
        for i in 0..<5 { pushes.append(.init(atMs: 2_000 + 2_000 * i, "slow \(i)", .rows([row(12 + i, 2_000 + 2_000 * i, thought("Slow \(i). "))]))) }
        let report = expectClean(TranscriptScenario("thought cadence", pushes: pushes))
        // Ten sentences inside a second: the hold lets a few paint; the slow ones each paint.
        let thoughts = report.lineEvents.filter { $0.contains("→ thought:") }
        #expect(thoughts.count >= 5 && thoughts.count < 15, "\(report.lineEvents)")
    }

    @Test func `a steer, a compaction mid-turn and a Stop each change in place`() {
        let report = expectClean(TranscriptScenario("steer pause stop", pushes: [
            .init(atMs: 0, "send", .send("start")),
            .init(atMs: 20, "echo, a call", .rows([row(1, 20, user("start")), row(2, 40, tool("a", "Bash"))])),
            .init(atMs: 500, "the person steers", .send("also check the docs")),
            .init(atMs: 540, "the steer's echo", .rows([row(3, 540, user("also check the docs", steerId: "s1"))])),
            .init(atMs: 600, "steer received", .rows([row(4, 600, .steer(SteerEvent(steerId: "s1", state: .received)))])),
            .init(atMs: 900, "compaction starts", .rows([row(5, 900, .compaction(CompactionEvent(phase: .start)))])),
            .init(atMs: 31_000, "compaction repeats", .rows([row(6, 31_000, .compaction(CompactionEvent(phase: .start)))])),
            .init(atMs: 40_000, "compaction done", .rows([row(7, 40_000, .compaction(CompactionEvent(phase: .done, preTokens: 100_000, postTokens: 20_000)))])),
            .init(atMs: 41_000, "Stop", .rows([row(8, 41_000, .error(ErrorEvent(message: "stopped", stopped: true))), row(9, 41_010, complete)])),
        ]))
        // The steer's turn ends on Stopped, through one morph from the phase it was saying.
        #expect(report.lineWords.values.contains("Stopped"), "\(report.lineWords)")
        #expect(report.lineEvents.last?.hasSuffix("→ closed") == true, "\(report.lineEvents)")
    }

    @Test func `a pause folds the line with its words and the resume opens the same line`() {
        let report = expectClean(TranscriptScenario("pause", pushes: [
            .init(atMs: 0, "send", .send("go")),
            .init(atMs: 20, "echo, a long command", .rows([row(1, 20, user("go")), row(2, 40, tool("a", "Bash", ["command": .string("sleep 60")]))])),
            .init(atMs: 2_000, "pause", .paused(true)),
            .init(atMs: 9_000, "resume", .paused(false)),
            .init(atMs: 12_000, "it settles, the close", .rows([row(3, 12_000, done("a")), row(4, 12_100, prose("Done.")), row(5, 12_200, complete)])),
        ]))
        let folds = report.lineEvents.filter { $0.contains(" fold ") || $0.contains(" open ") }
        #expect(folds.count == 2, "\(report.lineEvents)")
        #expect(folds.first?.hasSuffix("fold call:a") == true && folds.last?.hasSuffix("open call:a") == true, "\(report.lineEvents)")
        #expect(report.lineWords.values.first?.hasPrefix("Worked for") == true)
    }

    @Test func `an approval folds the line and the decision opens it again`() {
        let report = expectClean(TranscriptScenario("approval", pushes: [
            .init(atMs: 0, "send", .send("go")),
            .init(atMs: 20, "echo, a command", .rows([row(1, 20, user("go")), row(2, 40, tool("a", "Bash"))])),
            .init(atMs: 500, "it asks", .rows([row(3, 500, .approvalRequest(ApprovalRequestEvent(requestId: "r", toolName: "Bash")))])),
            .init(atMs: 4_000, "allowed", .rows([row(4, 4_000, .approvalResolved(ApprovalResolvedEvent(requestId: "r", allow: true)))])),
        ]))
        let folds = report.lineEvents.filter { $0.contains(" fold ") || $0.contains(" open ") }
        #expect(folds.count == 2 && folds.first?.contains(" fold ") == true, "\(report.lineEvents)")
    }

    @Test func `a steer word that goes back or goes away is a jerk`() {
        let report = ScenarioRunner.run(TranscriptScenario("steer back", pushes: [
            .init(atMs: 0, "send", .send("start")),
            .init(atMs: 20, "echo", .rows([row(1, 20, user("start")), row(2, 40, tool("a", "Bash"))])),
            .init(atMs: 500, "the person steers", .send("and the docs")),
            .init(atMs: 540, "echo", .rows([row(3, 540, user("and the docs", steerId: "s1"))])),
            .init(atMs: 600, "received", .rows([row(4, 600, .steer(SteerEvent(steerId: "s1", state: .received)))])),
            .init(atMs: 700, "sent again", .rows([row(5, 700, .steer(SteerEvent(steerId: "s1", state: .sent)))])),
        ]))
        #expect(report.violations.contains { $0.contains("went from received back to sent") })
    }

    @Test func `a subagent spawned, waited on and finished`() {
        expectClean(TranscriptScenario("subagent", pushes: [
            .init(atMs: 0, "send", .send("review it")),
            .init(atMs: 20, "echo, the spawn", .rows([row(1, 20, user("review it")), row(2, 40, tool("sp", "mcp__orchestrator__spawn_agent", ["task": .string("Review the payment flow")]))])),
            .init(atMs: 200, "spawned", .rows([row(3, 200, done("sp", "{\"agentId\":\"c1\"}"))])),
            .init(atMs: 300, "waiting", .rows([row(4, 300, tool("w", "mcp__orchestrator__wait_for_agent", ["agentId": .string("c1")]))])),
            .init(atMs: 60_000, "finished", .rows([row(5, 60_000, done("w", "{\"agentId\":\"c1\",\"status\":\"idle\"}")), row(6, 60_100, prose("It is fine.")), row(7, 60_200, complete)])),
        ]))
    }

    @Test func `scrolled up while it all streams: the follow rule writes nothing`() {
        var pushes: [TranscriptScenario.Push] = [.init(atMs: 0, "send", .send("go")), .init(atMs: 10, "echo", .rows([row(1, 10, user("go"))])), .init(atMs: 20, "the reader scrolls up", .readerUp(true))]
        for i in 0..<20 {
            pushes.append(.init(atMs: 100 + 50 * i, "delta \(i)", .rows([row(2 + i, 100 + 50 * i, prose("word \(i) "))])))
        }
        pushes.append(.init(atMs: 2_000, "a call and the close", .rows([row(30, 2_000, tool("a", "Read")), row(31, 2_010, done("a")), row(32, 2_020, complete)])))
        expectClean(TranscriptScenario("scrolled up", pushes: pushes))
    }

    @Test func `a resync replaying the same rows keeps every key`() {
        expectClean(TranscriptScenario("resync", pushes: [
            .init(atMs: 0, "send", .send("go")),
            .init(atMs: 10, "a partial call", .rows([row(1, 10, user("go")), row(-1, 20, tool("a", "Edit", partial: true), ephemeral: true)])),
            .init(atMs: 100, "its final row", .rows([row(2, 100, tool("a", "Edit")), row(3, 150, done("a"))])),
            .init(atMs: 200, "a resync", .refold),
            .init(atMs: 300, "a remount", .refold),
        ]))
    }

    @Test func `reduced motion: the same keys, the word steps, no fade`() {
        expectClean(TranscriptScenario("reduced motion", reducedMotion: true, pushes: [
            .init(atMs: 0, "send", .send("go")),
            .init(atMs: 10, "echo", .rows([row(1, 10, user("go"))])),
            .init(atMs: 100, "prose", .rows([row(2, 100, prose("One. "))])),
            .init(atMs: 200, "more prose", .rows([row(3, 200, prose("Two."))])),
            .init(atMs: 300, "the close", .rows([row(4, 300, complete)])),
        ]))
    }

    @Test func `a burst lands whole and the turn ends 30 ms later`() {
        let burst = String(repeating: "word ", count: 326)
        let scenario = TranscriptScenario("burst then end", pushes: [
            .init(atMs: 0, "send", .send("write")),
            .init(atMs: 10, "echo", .rows([row(1, 10, user("write"))])),
            .init(atMs: 500, "1,632 characters at once", .rows([row(2, 500, prose(burst))])),
            .init(atMs: 530, "the close", .rows([row(3, 530, prose(burst, delta: false)), row(4, 530, complete)])),
        ])
        expectClean(scenario)
        // The closing line waits: the burst is paced past the close, then its last fade.
        let drained = ScenarioRunner.run(scenario).drainedAt.values.max() ?? 0
        #expect(drained > 530 + StreamRevealLedger.fade * 1_000)
        #expect(drained < 530 + RevealProbes.deadlineMs)
    }

    @Test func `history joining above a group keeps the group's key`() {
        // A page cut fell inside a run: the tail held the third read alone.
        let scenario = TranscriptScenario("history", history: [row(5, 500, tool("c", "Read")), row(6, 510, done("c"))], pushes: [
            .init(atMs: 1_000, "the page above lands", .history([row(1, 100, user("go")), row(2, 200, tool("a", "Read")), row(3, 210, done("a")), row(4, 300, tool("b", "Read"))])),
            .init(atMs: 1_100, "another call", .rows([row(7, 1_100, tool("d", "Read"))])),
        ])
        let report = ScenarioRunner.run(scenario)
        #expect(report.violations == [])
        let groups = report.rows.compactMap { if case .group(let group) = $0 { group } else { nil } }
        #expect(groups.count == 1)
        #expect(groups.first?.key == 5)
    }

    @Test func `the runner catches a key that moves`() {
        let old: [TranscriptRowModel] = [.item(ThreadEntry(item: userItem(1, ts: 0, "go"), key: 1))]
        let new: [TranscriptRowModel] = [.item(ThreadEntry(item: userItem(1, ts: 0, "go"), key: 9))]
        let seen = ["user:go": TranscriptRowID(key: 1)]
        #expect(ScenarioRunner.keyJerks(from: old, to: new, seen: seen, at: "t").count == 1)
    }

    @Test func `every check is built`() {
        #expect(TranscriptScenario.Check.built == [.keys, .endRow, .follow, .reveal, .fade, .hold, .morph, .drain, .steer])
    }
}

private func user(_ text: String, steerId: String) -> AgentEvent {
    .userText(UserTextEvent(text: text, steerId: steerId))
}
