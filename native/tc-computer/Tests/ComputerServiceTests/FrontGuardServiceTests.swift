import ComputerCore
import ComputerProtocol
@testable import ComputerService
import ComputerServiceKit
import Foundation
import Testing

/// A wait long enough for the guard's 30 ms grace and its restore to land before the result.
private let settle = #"{"minMs":250,"quietMs":10,"maxMs":400,"busyMaxMs":400}"#

private let session = SessionChange(frontmost: .init(), pointer: .init(before: [0, 0], after: [0, 0]), restorable: true)

/// `apps.launch` and the actions under the front guard (docs/computer-protocol.md §22). The person works in
/// pid 100; Doc (500) runs; Notes is installed and launches as 600.
@Suite struct FrontGuardLaunchTests {
    @Test func aBareLaunchReportsItsFirstWindowAndNoSteal() async throws {
        let rig = ServiceRig()
        await rig.ready()
        let result = try #require(await rig.call("apps.launch", #"{"app":"Notes","session":"s1"}"#).result)
        #expect(result["launched"]?.boolValue == true)
        #expect(result["pid"]?.intValue == 600)
        #expect(result["front"]?["raised"]?.boolValue == false)
        #expect(result["window"]?["id"]?.intValue == 9)
        #expect(result["window"]?["title"]?.stringValue == "Notes")
        #expect(result["others"] == nil)
        #expect(rig.workspace.launchCount == 1)
        #expect(rig.front.calls.isEmpty)
    }

    @Test func anOpenIsOneCallWithItsItemsAndNamesTheWindowItOpened() async throws {
        let rig = ServiceRig()
        rig.front.set("/tmp/report.pdf", FileFacts(exists: true))
        let windows = rig.windows
        rig.workspace.onLaunch = { _ in windows.set(500, [window(7, "Doc"), window(8, "Other — Edited"), window(10, "report.pdf")]) }
        await rig.ready()
        let result = try #require(await rig.call("apps.launch", #"{"app":"Doc","open":["/tmp/report.pdf"],"session":"s1"}"#).result)
        #expect(rig.workspace.launches.count == 1)
        #expect(rig.workspace.launches.first?.open == ["/tmp/report.pdf"])
        #expect(result["launched"]?.boolValue == false)
        #expect(result["window"]?["id"]?.intValue == 10)
        #expect(result["window"]?["title"]?.stringValue == "report.pdf")
        #expect(result["others"]?.arrayValue?.map { $0["title"]?.stringValue } == ["Other — Edited"])
    }

    @Test func aStealBeforeTheResultIsUndoneAndReported() async throws {
        let rig = ServiceRig()
        rig.workspace.launchDelay = .milliseconds(250)
        rig.workspace.onLaunch = { [rig] pid in rig.activate(pid, bundleId: "com.example.Notes") }
        await rig.ready()
        let result = try #require(await rig.call("apps.launch", #"{"app":"Notes","session":"s1"}"#).result)
        #expect(result["front"]?["raised"]?.boolValue == true)
        #expect(result["front"]?["restored"]?.stringValue == "restored")
        #expect((result["front"]?["ms"]?.intValue ?? 1_000) < 400)
        #expect(rig.front.calls == ["frontmost 100"])
        #expect(rig.front.frontmost() == 100)
        try await Task.sleep(for: .milliseconds(150))
        #expect(rig.lines.notifications("apps/frontRestored").isEmpty, "the result told it")
    }

    @Test func aStealAfterTheResultIsToldAsANotification() async throws {
        let rig = ServiceRig()
        await rig.ready()
        let result = try #require(await rig.call("apps.launch", #"{"app":"Notes","session":"s1"}"#).result)
        #expect(result["front"]?["raised"]?.boolValue == false)
        rig.activate(600)
        #expect(await eventually { !rig.lines.notifications("apps/frontRestored").isEmpty })
        let notice = try #require(rig.lines.notifications("apps/frontRestored").first)
        #expect(notice["session"]?.stringValue == "s1")
        #expect(notice["pid"]?.intValue == 600)
        #expect(notice["name"]?.stringValue == "Notes")
        #expect(notice["front"]?["raised"]?.boolValue == true)
        #expect(notice["front"]?["restored"]?.stringValue == "restored")
        #expect(rig.front.calls == ["frontmost 100"])
    }

    @Test func thePersonsOwnPickIsLeftAlone() async throws {
        let rig = ServiceRig()
        await rig.ready()
        _ = await rig.call("apps.launch", #"{"app":"Notes","session":"s1"}"#)
        rig.front.person(.personKey(at: rig.front.now(), command: true, control: false, tab: true))
        rig.activate(600)
        #expect(await eventually { !rig.lines.notifications("apps/frontRestored").isEmpty })
        #expect(rig.lines.notifications("apps/frontRestored").first?["front"]?["restored"]?.stringValue == "person-chose")
        #expect(rig.front.calls.isEmpty)
    }

    @Test func refusedItemsAndAppsOpenNothing() async throws {
        let rig = ServiceRig()
        rig.front.set("/tmp/go.command", FileFacts(exists: true, executeBit: true, conformsToExecutable: true))
        rig.front.set("/tmp/report.pdf", FileFacts(exists: true))
        rig.workspace.apps.append(RunningApp(pid: ServiceRig.hostPid, bundleId: "dev.landon.tempcode", name: "TempCode", path: "/Applications/TempCode.app", active: false, hidden: false))
        await rig.ready()
        let cases: [(String, ErrorReason?)] = [
            (#"{"app":"Doc","open":["/tmp/nothing.pdf"]}"#, .missing),
            (#"{"app":"Doc","open":["/tmp/report.pdf","/tmp/go.command"]}"#, .executable),
            (#"{"app":"Doc","open":["ftp://example.com/a"]}"#, .scheme),
            (#"{"app":"Doc","open":[\#(Array(repeating: #""/tmp/report.pdf""#, count: 9).joined(separator: ","))]}"#, nil),
            (#"{"app":"Notes","open":["/tmp/report.pdf"],"refuse":["com.example.Notes"]}"#, .app),
            (#"{"app":"/Applications/TempCode.app","open":["/tmp/report.pdf"]}"#, .app),
            (#"{"app":"TempCode"}"#, .app)
        ]
        for (params, reason) in cases {
            let answer = await rig.call("apps.launch", params)
            #expect(answer.error?.data?.kind == .openRefused, "\(params)")
            #expect(answer.error?.data?.reason == reason, "\(params)")
        }
        #expect(rig.workspace.launchCount == 0, "nothing opened or launched")
    }

    @Test func anOpenIntoTheFrontAppWhoseNewWindowTookTheKeyWindowIsPutBack() async throws {
        let rig = ServiceRig()
        rig.front.set(front: 500)
        rig.front.set(focused: 7, of: 500)
        rig.front.set("/tmp/b.txt", FileFacts(exists: true))
        let windows = rig.windows, windowEvents = rig.windowEvents, front = rig.front
        rig.workspace.launchDelay = .milliseconds(200)
        rig.workspace.onLaunch = { pid in
            windows.set(500, [window(7, "a.txt"), window(8, "Other"), window(10, "b.txt")])
            front.set(focused: 10, of: pid)
            windowEvents.send(WindowEvent(pid: pid, windowID: 10, change: .focused))
        }
        await rig.ready()
        let result = try #require(await rig.call("apps.launch", #"{"app":"Doc","open":["/tmp/b.txt"],"session":"s1"}"#).result)
        #expect(rig.front.calls == ["raise 500 7"])
        #expect(rig.front.focusedWindow(pid: 500) == 7)
        #expect(result["front"]?["raised"]?.boolValue == true)
        #expect(result["front"]?["restored"]?.stringValue == "restored")
        #expect(result["window"]?["title"]?.stringValue == "b.txt")
    }

    @Test func anOldLaunchResultWithoutFrontStillDecodes() throws {
        let old = try JSONDecoder().decode(Methods.AppsLaunch.Output.self, from: Data(#"{"pid":5,"launched":true}"#.utf8))
        #expect(old.front == nil)
        #expect(old.window == nil)
        #expect(old.others == nil)
    }
}

@Suite struct FrontGuardActionTests {
    @Test func anAxBatchWhoseAppComesForwardDuringItsClosingWaitCarriesFront() async throws {
        let rig = ServiceRig()
        await rig.ready()
        rig.input.onPerform = { [rig] _, _ in
            DispatchQueue.global().asyncAfter(deadline: .now() + .milliseconds(10)) { rig.activate(500) }
            return InputOutcome(tier: .ax, via: nil, clipboard: nil, cursor: nil, lastInputAt: mach_absolute_time())
        }
        _ = await rig.call("state.get", "{\(docTarget),\"wait\":\(quick)}")
        let result = try #require(await rig.call("action.batch", "{\(docTarget),\"actions\":[{\"action\":\"left_click\",\"element\":2}],\"epoch\":\"\(rig.service.epoch)\",\"tiers\":[\"ax\"],\"wait\":\(settle),\"observe\":{\"mode\":\"none\"}}").result)
        #expect(result["front"]?["raised"]?.boolValue == true)
        #expect(result["front"]?["restored"]?.stringValue == "restored")
        #expect(rig.front.calls == ["frontmost 100"])
    }

    @Test func aCallWhoseAppStaysBackCarriesNoFront() async throws {
        let rig = ServiceRig()
        await rig.ready()
        _ = await rig.call("state.get", "{\(docTarget),\"wait\":\(quick)}")
        let result = try #require(await rig.call("action.run", "{\(docTarget),\"action\":{\"action\":\"left_click\",\"element\":2},\"epoch\":\"\(rig.service.epoch)\",\"tiers\":[\"ax\"],\"wait\":\(quick)}").result)
        #expect(result["front"] == nil)
    }

    @Test func performRaiseIsNotWatched() async throws {
        let rig = ServiceRig()
        await rig.ready()
        rig.input.onPerform = { [rig] _, _ in
            rig.activate(500)
            return InputOutcome(tier: .ax, via: nil, clipboard: nil, cursor: nil, lastInputAt: mach_absolute_time())
        }
        _ = await rig.call("state.get", "{\(docTarget),\"wait\":\(quick)}")
        let result = try #require(await rig.call("action.run", "{\(docTarget),\"action\":{\"action\":\"perform\",\"element\":2,\"name\":\"raise\"},\"epoch\":\"\(rig.service.epoch)\",\"tiers\":[\"ax\"],\"wait\":\(settle)}").result)
        #expect(result["front"] == nil)
        try await Task.sleep(for: .milliseconds(200))
        #expect(rig.front.calls.isEmpty)
        #expect(FrontRun.raises(ComputerAction(action: .perform, element: 1, name: "AXRaise")))
        #expect(!FrontRun.raises(ComputerAction(action: .perform, element: 1, name: "press")))
    }

    @Test func nothingIsRestoredWhileASessionTierRequestIsOutAndAStealDuringItIsUndoneAfter() async throws {
        let rig = ServiceRig()
        await rig.ready()
        rig.input.onPerform = { [rig] _, _ in
            rig.activate(500)
            usleep(150_000)
            return InputOutcome(tier: .ax, via: nil, clipboard: nil, cursor: nil, lastInputAt: mach_absolute_time())
        }
        _ = await rig.call("state.get", "{\(docTarget),\"wait\":\(quick)}")
        let id = rig.send("action.run", "{\(docTarget),\"action\":{\"action\":\"left_click\",\"element\":2},\"epoch\":\"\(rig.service.epoch)\",\"tiers\":[\"ax\",\"session\"],\"wait\":\(quick)}")
        try await Task.sleep(for: .milliseconds(120))
        #expect(rig.front.calls.isEmpty, "paused from the request's start")
        let answer = await rig.answer(id)
        #expect(answer.result?["front"] == nil, "a steal while paused is no report of the call")
        #expect(await eventually { rig.front.calls == ["frontmost 100"] }, "no step ran at session: the record was kept and the steal undone at the next tick")
        #expect(await eventually { !rig.lines.notifications("apps/frontRestored").isEmpty })
    }

    @Test func afterAStepAtSessionTheGuardWaitsForTheRestoreAndReadsTheFrontAgain() async throws {
        let rig = ServiceRig()
        await rig.ready()
        rig.input.onPerform = { [rig] _, _ in
            rig.activate(500)
            return InputOutcome(tier: .session, via: nil, clipboard: nil, cursor: [1, 1], session: session, lastInputAt: mach_absolute_time())
        }
        _ = await rig.call("action.run", "{\(docTarget),\"action\":{\"action\":\"left_click\",\"coordinate\":[1,1]},\"tiers\":[\"session\"],\"wait\":\(quick)}")
        try await Task.sleep(for: .milliseconds(250))
        #expect(rig.front.calls.isEmpty, "held until the host's restore answers")
        _ = await rig.call("input.restoreSession", "{}")
        try await Task.sleep(for: .milliseconds(250))
        #expect(rig.front.calls.isEmpty, "the front read again is the record: Doc stays")
    }
}
