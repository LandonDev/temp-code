import Foundation
import Testing

/// The Live Activity's content state (ios/TempCode/Activity/Shared/
/// ThreadActivityText.swift, compiled into this target through the symlink
/// under Shared/): the words and numbers the lock screen card shows, and
/// that a state from an older host, or a newer one, still decodes.
@Suite struct ThreadActivityStateTests {
    @Test func `the status word spells every phase, and only working hides it behind the spinner`() {
        #expect(ThreadActivityPhase.allCases.map(\.word) == ["Working", "Paused", "Waiting", "Done", "Failed", "Stopped"])
        #expect(ThreadActivityPhase.allCases.filter(\.isLive) == [.working, .paused])
        #expect(ThreadActivityPhase.allCases.filter(\.isSettled) == [.finished, .failed, .stopped])
    }

    @Test func `the tally reads done of total for either unit and never past the total`() {
        #expect(ThreadActivityText.tally(done: 3, total: 7) == "3/7")
        #expect(ThreadActivityText.tally(done: 9, total: 7) == "7/7")
        #expect(ThreadActivityText.tally(done: nil, total: 7) == "0/7")
        #expect(ThreadActivityText.tally(done: 3, total: 0) == nil)
        #expect(ThreadActivityText.tally(done: 3, total: nil) == nil)
        #expect(ThreadActivityText.fraction(done: 3, total: 4) == 0.75)
        #expect(ThreadActivityText.fraction(done: 9, total: 4) == 1)
        #expect(ThreadActivityText.fraction(done: nil, total: nil) == 0)
        #expect(ThreadActivityText.allDone(done: 7, total: 7))
        #expect(!ThreadActivityText.allDone(done: 6, total: 7))
        #expect(!ThreadActivityText.allDone(done: nil, total: nil))
        #expect(ThreadActivityText.tallyLabel(done: 3, total: 7, unit: nil) == "3 of 7 tasks done")
        #expect(ThreadActivityText.tallyLabel(done: 2, total: 4, unit: .threads) == "2 of 4 threads done")
    }

    @Test func `the line is the task while live, the reason while waiting, nothing once settled`() {
        #expect(ThreadActivityText.line(phase: .working, task: "Write the endpoint", reason: nil) == "Write the endpoint")
        #expect(ThreadActivityText.line(phase: .working, task: "", reason: nil) == nil)
        #expect(ThreadActivityText.line(phase: .paused, task: "Write the endpoint", reason: "stale") == "Write the endpoint")
        #expect(ThreadActivityText.line(phase: .waiting, task: "Write the endpoint", reason: "Needs approval: Bash — bun test") == "Needs approval: Bash — bun test")
        #expect(ThreadActivityText.line(phase: .waiting, task: "Write the endpoint", reason: nil) == "Write the endpoint")
        for phase in [ThreadActivityPhase.finished, .failed, .stopped] {
            #expect(ThreadActivityText.line(phase: phase, task: "Write the endpoint", reason: "why") == nil)
        }
        #expect(ThreadActivityText.statusLabel(phase: .working, task: "Write the endpoint", reason: nil) == "Working, Write the endpoint")
        #expect(ThreadActivityText.statusLabel(phase: .stopped, task: "Write the endpoint", reason: nil) == "Stopped")
    }

    @Test func `a state from an older host decodes without unit or reason, and the host's full state decodes whole`() throws {
        let old = Data(#"{"phase":"working","since":1759999000000,"ts":1760000000000,"seq":41,"title":"Ship it","task":"Write the endpoint","done":3,"total":7}"#.utf8)
        let state = try JSONDecoder().decode(ThreadActivityContent.self, from: old)
        #expect(state.phase == .working)
        #expect(state.unit == nil)
        #expect(state.reason == nil)
        #expect(state.tally == "3/7")
        #expect(state.tallyLabel == "3 of 7 tasks done")
        #expect(state.line == "Write the endpoint")
        let master = Data(#"{"phase":"stopped","since":1759999000000,"ts":1760000000000,"seq":12,"title":"Master","task":"gate","done":2,"total":4,"unit":"threads"}"#.utf8)
        let batch = try JSONDecoder().decode(ThreadActivityContent.self, from: master)
        #expect(batch.phase == .stopped)
        #expect(batch.unit == .threads)
        #expect(batch.tallyLabel == "2 of 4 threads done")
        #expect(batch.line == nil)
        #expect(batch.word == "Stopped")
        let bare = try JSONDecoder().decode(ThreadActivityContent.self, from: Data(#"{"phase":"finished","since":1,"ts":2}"#.utf8))
        #expect(!bare.hasTasks)
        #expect(bare.tally == nil)
        #expect(bare.fraction == 0)
    }

    @Test func `the shape is everything but the clock`() {
        let a = ThreadActivityContent(phase: .working, since: 1, ts: 1_000, seq: 4, title: "T", task: "x", done: 1, total: 2, unit: .threads, reason: nil)
        var b = a
        b.ts = 2_000
        #expect(a.shape == b.shape)
        b.unit = nil
        #expect(a.shape != b.shape)
        var c = a
        c.task = "y"
        #expect(a.shape != c.shape)
        let encoded = try? JSONEncoder().encode(a)
        let round = encoded.flatMap { try? JSONDecoder().decode(ThreadActivityContent.self, from: $0) }
        #expect(round == a)
    }
}

private extension ThreadActivityContent {
    var word: String { phase.word }
}
