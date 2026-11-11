import ComputerCore
import ComputerProtocol
@testable import ComputerService
import ComputerServiceKit
import Foundation
import Testing

/// The shell's half of the person guard (docs/computer-protocol.md §14.9.5): a call that may use the
/// session tier is bracketed before any step, a trip anywhere tells each call once, the restore
/// clears what it noted, and the exit path ends the guard. Fakes only: nothing here makes a tap.
@Suite struct PersonGuardShellTests {
    private let sessionClick = #"{"action":"left_click","coordinate":[10,10]}"#

    @Test func aSessionCallIsBracketedBeforeItsFirstStepAndAProcessCallIsNot() async throws {
        let rig = ServiceRig()
        await rig.ready()
        _ = try #require(await rig.call("action.run", "{\(docTarget),\"action\":\(sessionClick),\"tiers\":[\"process\"],\"wait\":\(quick)}").result)
        #expect(rig.log.count("callBegan") == 0)
        _ = try #require(await rig.call("action.run", "{\(docTarget),\"action\":\(sessionClick),\"tiers\":[\"process\",\"session\"],\"wait\":\(quick),\"personIdleMs\":1200}").result)
        let order = rig.log.all.filter { $0.hasPrefix("callBegan") || $0.hasPrefix("perform") || $0.hasPrefix("callEnded") }
        #expect(order.suffix(3) == ["callBegan 500 1", "perform left_click", "callEnded 1"])
        #expect(rig.input.seenTokens == [nil, 1])
        #expect(rig.input.seenPersonIdles == [nil, 1200])
    }

    @Test func aTripAsTheFirstStepReturnsFindsTheOwnerNotedAtTheCallsStart() async throws {
        let rig = ServiceRig()
        await rig.ready()
        let wiring = rig.input.wiring
        rig.input.onPerform = { _, target in
            // the person's key lands as the step returns: the between-calls path, with the call's token
            wiring.onPersonInput(target.pid, [target.callToken!])
            return InputOutcome(tier: .session, via: nil, clipboard: nil, cursor: [1, 1], lastInputAt: mach_absolute_time())
        }
        _ = try #require(await rig.call("action.run", "{\(docTarget),\"action\":\(sessionClick),\"tiers\":[\"session\"],\"wait\":\(quick)}").result)
        #expect(await eventually { rig.lines.notifications("session/interrupted").count == 1 })
        #expect(rig.lines.notifications("session/interrupted").first?["session"]?.stringValue == "s1")
    }

    @Test func aTripAfterAnOkStepTellsItsSessionUntilTheRestoreClearsIt() async throws {
        let rig = ServiceRig()
        await rig.ready()
        _ = try #require(await rig.call("action.run", "{\(docTarget),\"action\":\(sessionClick),\"tiers\":[\"session\"],\"wait\":\(quick)}").result)
        // no call in flight, no token: the session that last noted the pid
        rig.input.wiring.onPersonInput(500, [])
        #expect(await eventually { rig.lines.notifications("session/interrupted").count == 1 })
        _ = try #require(await rig.call("input.restoreSession", #"{"afterInterrupt":true}"#).result)
        rig.input.wiring.onPersonInput(500, [])
        try await Task.sleep(for: .milliseconds(100))
        #expect(rig.lines.notifications("session/interrupted").count == 1)
    }

    @Test func aGapTripAndTheLatchedStepAfterItSendOneNotice() async throws {
        let rig = ServiceRig()
        await rig.ready()
        let wiring = rig.input.wiring
        let steps = Box<Int>()
        steps.value = 0
        rig.input.onPerform = { _, target in
            steps.value! += 1
            if steps.value == 1 {
                // the person types in the gap after the first click
                wiring.onPersonInput(target.pid, [target.callToken!])
                return InputOutcome(tier: .session, via: nil, clipboard: nil, cursor: [1, 1], lastInputAt: mach_absolute_time())
            }
            throw ComputerError(kind: .interrupted, message: "The person took over the keyboard or mouse; the step stopped.", by: .person)
        }
        let result = try #require(await rig.call("action.batch", "{\(docTarget),\"actions\":[\(sessionClick),\(sessionClick)],\"tiers\":[\"session\"],\"stepWait\":\(quick),\"wait\":\(quick)}").result)
        #expect(result["steps"]?[1]?["error"]?["kind"]?.stringValue == "interrupted")
        try await Task.sleep(for: .milliseconds(100))
        #expect(rig.lines.notifications("session/interrupted").count == 1)
    }

    @Test func aCallBegunAfterTheTripHearsNothingOfIt() async throws {
        let rig = ServiceRig()
        await rig.ready()
        _ = await rig.call("session.open", #"{"session":"s2"}"#)
        _ = try #require(await rig.call("action.run", "{\(docTarget),\"action\":\(sessionClick),\"tiers\":[\"session\"],\"wait\":\(quick)}").result)
        let wiring = rig.input.wiring
        // the trip captured the first call's token; its callback runs during the second call
        rig.input.onPerform = { _, target in
            wiring.onPersonInput(target.pid, [1])
            return InputOutcome(tier: .session, via: nil, clipboard: nil, cursor: [1, 1], lastInputAt: mach_absolute_time())
        }
        _ = try #require(await rig.call("action.run", #"{"session":"s2","app":{"app":"Doc"},"action":\#(sessionClick),"tiers":["session"],"wait":\#(quick)}"#).result)
        #expect(await eventually { rig.lines.notifications("session/interrupted").count == 1 })
        try await Task.sleep(for: .milliseconds(100))
        #expect(rig.lines.notifications("session/interrupted").map { $0["session"]?.stringValue } == ["s1"])
    }

    @Test func theExitPathEndsTheGuardAfterLettingGoOfHeldInput() async throws {
        let rig = ServiceRig()
        await rig.ready()
        _ = await rig.call("shutdown")
        #expect(await eventually { rig.log.count("endGuard") == 1 })
    }
}
