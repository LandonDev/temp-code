import Foundation
import Synchronization
import Testing
@testable import TempCodeClient

/// A fetch that answers from a script and counts its calls.
private final class ScriptedFetch: Sendable {
    enum Answer: Sendable {
        case body(String)
        case failure
    }

    private let state = Mutex<(calls: Int, answers: [Answer])>((0, []))

    init(_ answers: [Answer]) {
        state.withLock { $0.answers = answers }
    }

    var calls: Int { state.withLock { $0.calls } }

    var fetch: MasterReleaseWatcher.Fetch {
        { [self] _ in
            let answer = state.withLock { state -> Answer in
                state.calls += 1
                // The last answer repeats.
                return state.answers.count > 1 ? state.answers.removeFirst() : (state.answers.first ?? .failure)
            }
            switch answer {
            case .body(let text): return Data(text.utf8)
            case .failure: throw URLError(.badServerResponse)
            }
        }
    }
}

@MainActor
private func eventuallyOnMain(_ predicate: () -> Bool) async -> Bool {
    let deadline = ContinuousClock.now.advanced(by: .seconds(3))
    while ContinuousClock.now < deadline {
        if predicate() { return true }
        try? await Task.sleep(for: .milliseconds(1))
    }
    return false
}

@MainActor
@Suite struct MasterReleaseWatcherTests {
    @Test func `the first run fetches once, and a second runner shares it`() async {
        let clock = ManualClock(now: 1_000_000)
        let script = ScriptedFetch([.body(#"{"n": 273}"#)])
        let watcher = MasterReleaseWatcher(clock: clock, fetch: script.fetch)
        let first = Task { await watcher.run() }
        let second = Task { await watcher.run() }
        #expect(await eventuallyOnMain { watcher.release?.release == 273 })
        await clock.settle()
        #expect(script.calls == 1)
        #expect(watcher.release?.version == "1.0.273")
        #expect(watcher.fetchFailed == false)
        #expect(watcher.fetchedAt == 1_000_000)
        first.cancel()
        second.cancel()
    }

    @Test func `the next fetch is everyMs later`() async {
        let clock = ManualClock(now: 1_000_000)
        let script = ScriptedFetch([.body(#"{"n": 273}"#), .body(#"{"n": 274}"#)])
        let watcher = MasterReleaseWatcher(clock: clock, fetch: script.fetch)
        let run = Task { await watcher.run() }
        #expect(await eventuallyOnMain { script.calls == 1 })
        await clock.advance(ms: MasterReleaseWatcher.everyMs - 1)
        #expect(script.calls == 1)
        await clock.advance(ms: 1)
        #expect(await eventuallyOnMain { watcher.release?.release == 274 })
        #expect(script.calls == 2)
        run.cancel()
    }

    @Test func `foreground fetches only once the focus recheck has passed`() async {
        let clock = ManualClock(now: 1_000_000)
        let script = ScriptedFetch([.body(#"{"n": 273}"#)])
        let watcher = MasterReleaseWatcher(clock: clock, fetch: script.fetch)
        await watcher.foreground()
        #expect(script.calls == 1)
        await clock.advance(ms: MasterReleaseWatcher.focusRecheckMs)
        await watcher.foreground()
        #expect(script.calls == 1)
        await clock.advance(ms: 1)
        await watcher.foreground()
        #expect(script.calls == 2)
    }

    @Test func `a failure keeps the last release and says so; a body without n is a failure`() async {
        let clock = ManualClock(now: 1_000_000)
        let script = ScriptedFetch([.body(#"{"n": 273}"#), .failure, .body(#"{"notes": "no n"}"#), .body(#"{"n": 275}"#)])
        let watcher = MasterReleaseWatcher(clock: clock, fetch: script.fetch)
        await watcher.refresh()
        #expect(watcher.release?.release == 273)
        await watcher.refresh()
        #expect(watcher.fetchFailed)
        #expect(watcher.release?.release == 273)
        await watcher.refresh()
        #expect(watcher.fetchFailed)
        #expect(watcher.release?.release == 273)
        await watcher.refresh()
        #expect(watcher.fetchFailed == false)
        #expect(watcher.release?.release == 275)
        #expect(script.calls == 4)
    }

    @Test func `the feed is master's release.json on GitHub`() {
        #expect(MasterReleaseWatcher.url.absoluteString == "https://raw.githubusercontent.com/LandonDev/temp-code/master/release.json")
        #expect(MasterReleaseWatcher.everyMs == 600_000)
        #expect(MasterReleaseWatcher.focusRecheckMs == 900_000)
    }
}
