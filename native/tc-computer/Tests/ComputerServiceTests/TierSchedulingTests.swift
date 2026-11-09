import ComputerCore
import ComputerProtocol
@testable import ComputerService
import ComputerServiceKit
import Foundation
import Testing

/// The shell's half of the tier-scheduling amendment (plan §6): the restore's `afterInterrupt`, the
/// call's `pasteQuietMs`, and the pasteboard watch's word on a recent foreign copy.
@Suite struct TierSchedulingShellTests {
    @Test func restoreSessionPassesAfterInterruptAndAnEmptyCallStaysPlain() async throws {
        let rig = ServiceRig()
        await rig.ready()
        _ = try #require(await rig.call("input.restoreSession", #"{"afterInterrupt":true}"#).result)
        _ = try #require(await rig.call("input.restoreSession").result)
        _ = try #require(await rig.call("input.restoreSession", #"{"afterInterrupt":false}"#).result)
        #expect(rig.log.all.filter { $0.hasPrefix("restoreSession") } == ["restoreSession afterInterrupt", "restoreSession", "restoreSession"])
    }

    @Test func pasteQuietMsReachesInputForEveryStepOfARunAndABatch() async throws {
        let rig = ServiceRig()
        await rig.ready()
        let click = #"{"action":"left_click","coordinate":[10,10]}"#
        _ = try #require(await rig.call("action.run", "{\(docTarget),\"action\":\(click),\"tiers\":[\"process\"],\"wait\":\(quick),\"pasteQuietMs\":5000}").result)
        _ = try #require(await rig.call("action.batch", "{\(docTarget),\"actions\":[\(click),\(click)],\"tiers\":[\"process\"],\"stepWait\":\(quick),\"wait\":\(quick),\"pasteQuietMs\":4000}").result)
        _ = try #require(await rig.call("action.run", "{\(docTarget),\"action\":\(click),\"tiers\":[\"process\"],\"wait\":\(quick)}").result)
        #expect(rig.input.seenPasteQuiets == [5000, 4000, 4000, nil])
    }

    @Test func aFreshWatchCountsAsAChangeAndQuietsWithTime() async throws {
        let rig = ServiceRig(timing: { $0.clipboardPoll = .milliseconds(10) })
        await rig.ready()
        let recent = rig.input.wiring.recentForeignCopy
        // the watch just began: a copy made before it is invisible to it, so it is not quiet yet
        #expect(recent(5_000))
        try await Task.sleep(for: .milliseconds(400))
        #expect(!recent(200))
    }

    @Test func aCopyIsSeenAtOnceWithoutWaitingForThePoll() async throws {
        // a poll so slow it never runs during the test: the check looks at the pasteboard itself
        let rig = ServiceRig(timing: { $0.clipboardPoll = .seconds(60) })
        await rig.ready()
        let recent = rig.input.wiring.recentForeignCopy
        try await Task.sleep(for: .milliseconds(400))
        #expect(!recent(200))
        rig.system.copy()
        #expect(recent(200))
        // the same rule clipboard.state reports
        let state = try #require(await rig.call("clipboard.state").result)
        #expect(state["foreignChangeAt"]?.doubleValue != nil)
    }

    @Test func thePastesOwnWritesUnderTheLockAreNotForeign() async throws {
        let rig = ServiceRig(timing: { $0.clipboardPoll = .seconds(60) })
        await rig.ready()
        let wiring = rig.input.wiring
        try await Task.sleep(for: .milliseconds(400))
        let hold = try #require(wiring.clipboardLock.acquire(within: 1))
        rig.system.copy() // the paste's write
        rig.system.copy() // and its restore
        hold.release()
        #expect(!wiring.recentForeignCopy(200))
        let state = try #require(await rig.call("clipboard.state").result)
        #expect(state["foreignChangeAt"] == .null || state["foreignChangeAt"] == nil)
    }

    @Test func aCopyWhileThePasteWaitedForTheLockIsForeignEvenIfThePollRunsDuringTheHold() async throws {
        // a quick poll: it runs while the lock is held, when it takes every change for the service's own
        let rig = ServiceRig(timing: { $0.clipboardPoll = .milliseconds(10) })
        await rig.ready()
        let wiring = rig.input.wiring
        try await Task.sleep(for: .milliseconds(400))
        rig.system.copy() // the person copies while the paste waits for the lock
        let hold = try #require(wiring.clipboardLock.acquire(within: 1))
        defer { hold.release() }
        try await Task.sleep(for: .milliseconds(40))
        #expect(wiring.recentForeignCopy(5_000))
    }

    @Test func aCopyBetweenTwoPastesIsForeign() async throws {
        let rig = ServiceRig(timing: { $0.clipboardPoll = .seconds(60) })
        await rig.ready()
        let wiring = rig.input.wiring
        try await Task.sleep(for: .milliseconds(400))
        let first = try #require(wiring.clipboardLock.acquire(within: 1))
        rig.system.copy()
        first.release()
        rig.system.copy() // the person, after the first paste let the lock go
        let second = try #require(wiring.clipboardLock.acquire(within: 1))
        defer { second.release() }
        #expect(wiring.recentForeignCopy(200))
    }
}
