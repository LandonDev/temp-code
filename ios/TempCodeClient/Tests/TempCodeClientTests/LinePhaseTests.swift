import Foundation
import Testing
import TempCodeContract
@testable import TempCodeClient

/// The working line's words (workingPhase.ts), a thought's newest sentence
/// (thinking.ts), the hold, the morph and the watch words, on the phone.
private func entry(_ item: TranscriptItem) -> ThreadEntry { ThreadEntry(item: item) }

@Suite struct LinePhaseTests {
    private let user = entry(userItem(1, ts: 1_000))

    @Test func `Sending while the person's message is not echoed`() {
        let pending = entry(userItem(-100_000, ts: 1_000))
        #expect(LinePhase.of(turn: [pending], activity: "Waiting for the provider").key == "sending")
    }

    @Test func `the host's words while nothing of the turn has come, keyed to the first comma`() {
        let a = LinePhase.of(turn: [user], activity: "Waiting for the provider, 25 s")
        let b = LinePhase.of(turn: [user], activity: "Waiting for the provider, 30 s")
        #expect(a.words == "Waiting for the provider, 25 s")
        #expect(a.key == b.key)
        // Once the turn has its own content, the host's words step aside.
        let started = LinePhase.of(turn: [user, entry(textItem(2, "Let me look.", thinking: true, streaming: true))], activity: "Waiting for the provider")
        #expect(started.key.hasPrefix("thought:") || started.key == "thinking")
    }

    @Test func `the wait on agents comes before calls`() {
        #expect(LinePhase.of(turn: [user, entry(toolItem(2, name: "Bash"))], activity: nil, waitWords: "Waiting on Review the flow").words == "Waiting on Review the flow")
    }

    @Test func `one running call by its verb and object, several by the group's phrase`() {
        let one = LinePhase.of(turn: [user, entry(toolItem(2, name: "Read", input: ["file_path": .string("src/format.ts")]))], activity: nil)
        #expect(one.key == "call:c2")
        #expect(one.verb != nil)
        #expect(one.words.contains("format.ts"))
        let two = LinePhase.of(turn: [user, entry(toolItem(2, name: "Read", input: ["file_path": .string("a.ts")])), entry(toolItem(3, name: "Read", input: ["file_path": .string("b.ts")]))], activity: nil)
        #expect(two.key == "calls")
        #expect(!two.words.isEmpty)
    }

    @Test func `a settled call, agent work and a call waiting on approval are not told`() {
        let done = entry(toolItem(2, doneTs: 2_000, name: "Read"))
        let spawn = entry(toolItem(3, name: "mcp__orchestrator__spawn_agent"))
        #expect(LinePhase.told([user, done, spawn]).isEmpty)
        let bash = entry(toolItem(4, name: "Bash"))
        let asking = entry(.approval(ApprovalItem(seq: 5, ts: 0, request: ApprovalRequestEvent(requestId: "r", toolName: "Bash"), allowed: nil, auto: false)))
        #expect(LinePhase.told([user, bash, asking]).isEmpty)
    }

    @Test func `a streaming thought shows its newest finished sentence, spoken as Thinking`() {
        let thought = entry(textItem(2, "First I read the file. Then I check the tests. Now the", thinking: true, streaming: true))
        let phase = LinePhase.of(turn: [user, thought], activity: nil)
        #expect(phase.words == "Then I check the tests.")
        #expect(phase.spoken == "Thinking")
        #expect(phase.key == "thought:1")
    }

    @Test func `streaming prose is the mark alone, else Thinking`() {
        #expect(LinePhase.of(turn: [user, entry(textItem(2, "Here", streaming: true))], activity: nil).words == "")
        #expect(LinePhase.of(turn: [user], activity: nil) == .thinking)
    }
}

@Suite struct ThoughtLineTests {
    @Test func `the newest finished sentence, a partial one only when it is all there is`() {
        #expect(ThoughtLine.latest("First I read the file. Then I check the tests. Now the") == "Then I check the tests.")
        #expect(ThoughtLine.latest("First I read the file. Then I check the tests.") == "Then I check the tests.")
        #expect(ThoughtLine.latest("Looking at the") == "Looking at the")
    }

    @Test func `code fences and markdown markers go`() {
        #expect(ThoughtLine.latest("Check **this** file.\n```ts\nconst a = 1;\n```") == "Check this file.")
        #expect(ThoughtLine.latest("Read `a.ts` first.\n```ts\nconst a") == "Read a.ts first.")
        #expect(ThoughtLine.latest("- Look at [the docs](https://x.dev).") == "Look at the docs.")
    }

    @Test func `empty for an empty thought and cut at 160`() {
        #expect(ThoughtLine.latest("") == "")
        #expect(ThoughtLine.latest("   \n\n") == "")
        let long = ThoughtLine.latest(String(repeating: "word ", count: 60) + "end.")
        #expect(long.count <= ThoughtLine.maxLength)
        #expect(long.hasSuffix("…"))
    }

    @Test func `the key holds while a sentence grows and moves when a later one finishes`() {
        #expect(ThoughtLine.latestKey("Looking") == ThoughtLine.latestKey("Looking at the file"))
        #expect(ThoughtLine.latestKey("Looking at the file. Then") == 0)
        #expect(ThoughtLine.latestKey("Looking at the file. Then the tests.") == 1)
        #expect(ThoughtLine.latestKey("") == -1)
    }

    @Test func `a span is never under a second and counts minutes past one`() {
        #expect(ThoughtLine.spanWords(ms: 200) == "1s")
        #expect(ThoughtLine.spanWords(ms: 59_400) == "59s")
        #expect(ThoughtLine.spanWords(ms: 124_000) == "2m 4s")
        #expect(ThoughtLine.spanWords(ms: 120_000) == "2m")
    }
}

@Suite struct HeldPhaseTests {
    private func phase(_ key: String, _ words: String? = nil) -> LinePhase { LinePhase(key: key, words: words ?? key) }

    @Test func `a painted key stays at least the hold, then the latest shows`() {
        var held = HeldPhase(phase("a"), at: 0)
        let early = held.update(phase("b"), at: 0.1)
        #expect(early.shown.key == "a")
        #expect(early.due == MotionValues.wordHold)
        let later = held.update(phase("b"), at: 0.3)
        #expect(later.shown.key == "b")
        #expect(later.due == nil)
    }

    @Test func `a key that came and went inside the hold never paints`() {
        var held = HeldPhase(phase("a"), at: 0)
        _ = held.update(phase("b"), at: 0.05)
        _ = held.update(phase("c"), at: 0.1)
        #expect(held.update(phase("c"), at: 0.31).shown.key == "c")
    }

    @Test func `new words under the shown key draw at once`() {
        var held = HeldPhase(phase("host:Waiting", "Waiting, 25 s"), at: 0)
        #expect(held.update(phase("host:Waiting", "Waiting, 30 s"), at: 0.01).shown.words == "Waiting, 30 s")
    }

    @Test func `the closing state goes through the same hold`() {
        var held = HeldPhase(phase("call:x"), at: 0)
        #expect(held.update(phase("closed"), at: 0.03).shown.key == "call:x")
        #expect(held.update(phase("closed"), at: 0.3).shown.key == "closed")
    }
}

@Suite struct MorphTextModelTests {
    @Test func `one set of words at a time: the old leave, then the new arrive`() {
        var morph = MorphModel("Thinking", reduced: false)
        morph.set("Reading a.ts", at: 0)
        #expect(morph.words == "Thinking")
        morph.tick(at: MotionValues.swapOut - 0.01)
        #expect(morph.words == "Thinking")
        morph.tick(at: MotionValues.swapOut + 0.01)
        #expect(morph.words == "Reading a.ts")
        if case .arriving = morph.stage {} else { Issue.record("arriving after the old words left") }
        morph.tick(at: MotionValues.swapOut + MotionValues.base + 0.01)
        #expect(morph.stage == .still("Reading a.ts"))
    }

    @Test func `the old words lift and fade, the new rise from below`() {
        var morph = MorphModel("A", reduced: false)
        morph.set("B", at: 0)
        let out = morph.pose(at: MotionValues.swapOut)
        #expect(out.offset == -MorphModel.lift)
        #expect(out.opacity == 0)
        morph.tick(at: MotionValues.swapOut)
        let start = morph.pose(at: MotionValues.swapOut)
        #expect(start.offset == MorphModel.lift)
        #expect(start.opacity == 0)
    }

    @Test func `reduced motion fades out then in, fast each, with no lift`() {
        var morph = MorphModel("A", reduced: true)
        morph.set("B", at: 0)
        #expect(morph.outDuration == MotionValues.fast)
        #expect(morph.inDuration == MotionValues.fast)
        #expect(morph.pose(at: 0.05).offset == 0)
        morph.tick(at: 2 * MotionValues.fast + 0.01)
        #expect(morph.stage == .still("B"))
    }

    @Test func `the same words change nothing; a retarget while leaving keeps one leaving`() {
        var morph = MorphModel("A", reduced: false)
        morph.set("A", at: 0)
        #expect(morph.stage == .still("A"))
        morph.set("B", at: 0)
        morph.set("C", at: 0.02)
        #expect(morph.stage == .leaving("A", next: "C"))
    }
}

@Suite struct WatchPhraseTests {
    private func bg(tasks: [SessionMeta.Background.Task] = [], agents: [String] = []) -> SessionMeta.Background {
        SessionMeta.Background(tasks: tasks, agents: agents, batch: nil, watchingSince: nil)
    }

    private func task(_ label: String, _ kind: SessionMeta.Background.Task.Kind) -> SessionMeta.Background.Task {
        SessionMeta.Background.Task(id: label, label: label, kind: kind, startedAt: 0)
    }

    @Test func `one task by its label, one subagent by its title, else counted`() {
        #expect(WatchWords.watchPhrase(bg(tasks: [task("dev server", .shell)])) == "dev server")
        #expect(WatchWords.watchPhrase(bg(agents: ["c1"]), titleOf: { $0 == "c1" ? "Review the payment flow" : nil }) == "Review the payment flow")
        #expect(WatchWords.watchPhrase(bg(tasks: [task("a", .monitor)], agents: ["c1", "c2", "c3"])) == "3 subagents, a monitor")
        #expect(WatchWords.watchSubject(nil) == "background work")
    }

    @Test func `a wait names one agent by title and counts several`() {
        #expect(WatchWords.waitLine(["env_abc:c1"], titleOf: { $0 == "c1" ? "Review the flow" : nil }) == "Waiting on Review the flow")
        #expect(WatchWords.waitSubject(["c1"]) == "a subagent")
        #expect(WatchWords.waitSubject(["a", "b"]) == "2 subagents")
    }

    @Test func `a long title is cut at a word`() {
        let cut = WatchWords.cutAtWord("Review the payment flow and every webhook it calls on the way", max: 48)
        #expect(cut.count <= 48)
        #expect(cut.hasSuffix("…"))
    }
}

@Suite struct TurnEndTests {
    @Test func `Worked until the time lands, then Worked for the span`() {
        #expect(TurnEndWords.worked(ms: nil) == "Worked")
        #expect(TurnEndWords.worked(ms: 124_000) == "Worked for 2m 4s")
        #expect(TurnEndWords.worked(ms: 300) == "Worked for 1s")
    }
}
