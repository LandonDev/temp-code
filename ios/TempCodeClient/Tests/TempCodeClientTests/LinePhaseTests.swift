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

    @Test func `the host's words read the detail first and the older separators as a comma`() {
        #expect(LinePhase.hostWords(statusDetail: "Waiting for the provider, 25 s", activity: "Waiting for the provider  25 s") == "Waiting for the provider, 25 s")
        #expect(LinePhase.hostWords(statusDetail: nil, activity: "Rate limited · retry 3 in 32 s") == "Rate limited, retry 3 in 32 s")
        #expect(LinePhase.hostWords(statusDetail: nil, activity: "Starting the CLI") == "Starting the CLI")
        #expect(LinePhase.hostWords(statusDetail: nil, activity: "Compacting  context") == "Compacting, context")
        #expect(LinePhase.hostWords(statusDetail: " ", activity: nil) == nil)
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

    @Test func `new words under one key are drawn at once, never morphed`() {
        var morph = MorphModel("Waiting, 25 s", reduced: false)
        morph.replace("Waiting, 30 s")
        #expect(morph.stage == .still("Waiting, 30 s"))
        morph.set("Reading a.ts", at: 0)
        morph.replace("Reading b.ts")
        #expect(morph.stage == .leaving("Waiting, 30 s", next: "Reading b.ts"))
        morph.tick(at: MotionValues.swapOut)
        morph.replace("Reading c.ts")
        #expect(morph.stage == .arriving("Reading c.ts"))
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

    @Test func `watching is the status, or a settled thread whose subagents still work`() {
        func meta(_ status: SessionStatus, agents: [String] = []) -> SessionMeta {
            SessionMeta(id: "t", parentId: nil, projectId: "p1", workspaceId: nil, threadType: .chat, planPath: nil, provider: .claude, model: "claude-sonnet-5-5", reasoning: .low, agentType: .implementer, title: "A thread", cwd: "/tmp/repo", status: status, pinned: false, archived: false, permission: .edits, fast: false, ultrafast: false, context1m: false, busySince: nil, pausedAt: nil, frozenActiveElapsed: nil, nativeId: nil, background: bg(agents: agents), createdAt: 1, updatedAt: 1)
        }
        #expect(WatchWords.isWatching(meta(.watching)))
        #expect(!WatchWords.isWatching(meta(.idle)))
        #expect(WatchWords.isWatching(meta(.idle, agents: ["c1"])))
        #expect(WatchWords.isWatching(meta(.done, agents: ["c1"])))
        #expect(!WatchWords.isWatching(meta(.running, agents: ["c1"])))
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
        #expect(TurnEndWords.stopped == "Stopped")
    }
}

/// The end row from Send to close: `TurnLineInput.of` (TurnEnd.tsx's
/// rules) and `TurnLineModel` (WorkingLine.tsx's `TurnLine`).
@Suite struct TurnLineTests {
    private func end(open: Bool, ms: Int? = 12_000, stopped: Bool = false, awaits: Bool = false) -> TurnEnd {
        TurnEnd(userSeq: 1, open: open, durationMs: open ? nil : ms, completedTs: open ? nil : 13_000, answer: "", stopped: stopped, awaitsUser: awaits)
    }

    private let reading = LinePhase(key: "call:a", words: "Reading a.ts")

    @Test func `open: the phase; held by a pause or a card; over and revealing: the mark alone; over: the closing words`() {
        let live = TurnLineInput.of(end(open: true), paused: false, revealing: false, phase: reading)
        #expect(live.live && !live.held && live.phase == reading && live.closing == nil)
        #expect(TurnLineInput.of(end(open: true), paused: true, revealing: false, phase: reading).held)
        #expect(TurnLineInput.of(end(open: true, awaits: true), paused: false, revealing: false, phase: reading).held)
        let draining = TurnLineInput.of(end(open: false), paused: false, revealing: true, phase: reading)
        #expect(draining.live && draining.phase == TurnLineInput.draining && draining.closing == nil)
        #expect(TurnLineInput.of(end(open: false), paused: false, revealing: false, phase: reading).closing == "Worked for 12s")
        // A Stop is over before the host settles the turn, and a pause cannot hold it.
        let stopped = TurnLineInput.of(end(open: true, stopped: true), paused: true, revealing: false, phase: reading)
        #expect(!stopped.held && stopped.closing == "Stopped")
    }

    @Test func `a line live in this row morphs into its closing words only after the hold`() {
        let open = TurnLineInput.of(end(open: true), paused: false, revealing: false, phase: reading)
        var model = TurnLineModel(open, at: 0)
        #expect(model.look.saying && model.look.visible && model.look.open && model.look.words == "Reading a.ts")
        let closed = TurnLineInput.of(end(open: false), paused: false, revealing: false, phase: .thinking)
        let early = model.update(closed, at: 0.1)
        #expect(early.look.saying && early.look.key == "call:a")
        #expect(early.due == MotionValues.wordHold)
        let late = model.update(closed, at: MotionValues.wordHold)
        #expect(!late.look.saying && late.look.key == TurnLineModel.closedKey && late.look.words == "Worked for 12s")
    }

    @Test func `a settled turn's row shows its closing line at once; a pending one waits unless it was live`() {
        let settled = TurnLineInput.of(end(open: false), paused: false, revealing: false, phase: .thinking)
        let model = TurnLineModel(settled, at: 5)
        #expect(model.look.visible && !model.look.saying && model.look.words == "Worked for 12s")
        let pending = TurnLineInput.of(end(open: false, ms: nil), paused: false, revealing: false, phase: .thinking)
        #expect(pending.pending && pending.closing == "Worked")
        #expect(!TurnLineModel(pending, at: 0).look.visible)
        var live = TurnLineModel(TurnLineInput.of(end(open: true), paused: false, revealing: false, phase: reading), at: 0)
        #expect(live.update(pending, at: 1).look.words == "Worked")
    }

    @Test func `a held line folds with its words kept and opens again on the same key`() {
        var model = TurnLineModel(TurnLineInput.of(end(open: true), paused: false, revealing: false, phase: reading), at: 0)
        let folded = model.update(TurnLineInput.of(end(open: true), paused: true, revealing: false, phase: reading), at: 1)
        #expect(folded.look.visible && !folded.look.open && folded.look.saying && folded.look.key == "call:a")
        let back = model.update(TurnLineInput.of(end(open: true), paused: false, revealing: false, phase: reading), at: 2)
        #expect(back.look.open && back.look.key == "call:a")
    }

    @Test func `the drain keeps the mark and says nothing more`() {
        var model = TurnLineModel(TurnLineInput.of(end(open: true), paused: false, revealing: false, phase: reading), at: 0)
        let draining = model.update(TurnLineInput.of(end(open: false), paused: false, revealing: true, phase: reading), at: 1)
        #expect(draining.look.saying && draining.look.words == "")
        let done = model.update(TurnLineInput.of(end(open: false), paused: false, revealing: false, phase: reading), at: 2)
        #expect(!done.look.saying && done.look.words == "Worked for 12s")
    }

    @Test func `the tracker waits a reveal step after the end for a row that saw its turn open, and looks again while it drains`() {
        var tracker = TurnLineTracker()
        _ = tracker.update(end(open: true), paused: false, revealing: false, phase: reading, at: 0)
        // The end lands before its last text row has reported: the mark stays one step.
        let first = tracker.update(end(open: false), paused: false, revealing: false, phase: .thinking, at: 1)
        #expect(first.look.saying && first.look.words == "")
        #expect(first.due == 1 + MotionValues.revealStep)
        let draining = tracker.update(end(open: false), paused: false, revealing: true, phase: .thinking, at: 1.2)
        #expect(draining.due == 1.2 + MotionValues.revealStep)
        let done = tracker.update(end(open: false), paused: false, revealing: false, phase: .thinking, at: 1.6)
        #expect(!done.look.saying && done.look.words == "Worked for 12s" && done.due == nil)
        // A row that mounts on a settled turn draws its closing line at once.
        var settled = TurnLineTracker()
        let mounted = settled.update(end(open: false), paused: false, revealing: false, phase: .thinking, at: 5)
        #expect(!mounted.look.saying && mounted.look.visible && mounted.due == nil && !settled.everLive)
    }
}
