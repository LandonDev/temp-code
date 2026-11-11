import ComputerCore
import ComputerProtocol
@testable import ComputerService
import Foundation
import Testing

/// §27 through the shell, over the fakes: the stop rule, `named` and `menu`, the live focus and the call's record.
@Suite struct FewerCallsServiceTests {
    func batch(_ rig: ServiceRig, _ actions: String, extra: String = "") async throws -> JSONValue {
        try #require(await rig.call("action.batch", "{\(docTarget),\"actions\":\(actions),\"epoch\":\"\(rig.service.epoch)\",\"tiers\":[\"ax\"],\"stepWait\":\(quick),\"wait\":\(quick)\(extra)}").result)
    }

    /// The window changes after every step the fake input performs.
    func changing(_ rig: ServiceRig) {
        let reader = rig.reader()
        rig.input.onPerform = { _, _ in
            let at = mach_absolute_time()
            reader.signal.notify()
            return InputOutcome(tier: .ax, via: nil, clipboard: nil, cursor: nil, lastInputAt: at - 1)
        }
    }

    /// §27.8: a click that changed nothing stops the keys after it, and every step after them.
    @Test func keysAfterAStepThatChangedNothingDoNotRun() async throws {
        let rig = ServiceRig()
        await rig.ready()
        _ = await rig.call("state.get", "{\(docTarget),\"wait\":\(quick)}")
        let result = try await batch(rig, #"[{"action":"left_click","element":2},{"action":"key","text":"Tab"},{"action":"type","text":"x"}]"#)
        let steps = try #require(result["steps"]?.arrayValue)
        #expect(steps.map { $0["status"]?.stringValue } == ["ok", "not-run", "not-run"])
        #expect(steps[1]["stopped"]?["afterStep"]?.intValue == 0)
        #expect(steps[2]["stopped"]?["reason"]?.stringValue == "no-change")
        #expect(rig.log.count("perform") == 1)
        #expect(result["observation"] != nil)
    }

    /// A later segment's `prior` stops it the same way.
    @Test func priorsNoChangeStopsTheNextSegment() async throws {
        let rig = ServiceRig()
        await rig.ready()
        _ = await rig.call("state.get", "{\(docTarget),\"wait\":\(quick)}")
        let result = try await batch(rig, #"[{"action":"type","text":"x"}]"#, extra: #","prior":{"effect":"none","targeted":[2]}"#)
        #expect(result["steps"]?.arrayValue?.first?["status"]?.stringValue == "not-run")
        #expect(rig.log.count("perform") == 0)
    }

    /// §27.9: a named target resolves when its step runs, Input acts on the element, the step reports it.
    @Test func aNamedTargetResolvesAtItsStep() async throws {
        let rig = ServiceRig()
        await rig.ready()
        changing(rig)
        rig.reader().namedTargets = ["Team": 4]
        _ = await rig.call("state.get", "{\(docTarget),\"wait\":\(quick)}")
        let result = try await batch(rig, #"[{"action":"left_click","element":2},{"action":"left_click","named":"Team"}]"#)
        let steps = try #require(result["steps"]?.arrayValue)
        #expect(steps[1]["resolved"]?.intValue == 4)
        #expect(rig.log.count("named Team") == 1 && rig.log.count("resolve 4") >= 1)
        let missing = try await batch(rig, #"[{"action":"left_click","named":"Nobody"}]"#)
        #expect(missing["steps"]?.arrayValue?.first?["error"]?["kind"]?.stringValue == "named_target")
        #expect(missing["steps"]?.arrayValue?.first?["error"]?["reason"]?.stringValue == "no-match")
    }

    /// §27.10: a menu path resolves to its item, which the step presses whatever its verb; a disabled item is Input's
    /// to judge (§26.3), so the step reaches Input with the item as its element.
    @Test func aMenuPathResolvesToItsItem() async throws {
        let rig = ServiceRig()
        await rig.ready()
        changing(rig)
        rig.reader().menuTargets = ["File > Save…": 5]
        _ = await rig.call("state.get", "{\(docTarget),\"wait\":\(quick)}")
        let result = try await batch(rig, #"[{"action":"perform","name":"pick","menu":"File > Save…"}]"#)
        let step = try #require(result["steps"]?.arrayValue?.first)
        #expect(step["action"]?.stringValue == "perform")
        #expect(step["resolved"]?.intValue == 5)
        #expect(rig.log.count("menu File > Save…") == 1)
    }

    /// §27.7: keys after a step go to a focus no step aimed at nowhere; §27.7a: never into a password field.
    @Test func blindTextAtAnUnplannedFocusOrAPasswordIsRefused() async throws {
        let rig = ServiceRig()
        await rig.ready()
        changing(rig)
        let reader = rig.reader()
        _ = await rig.call("state.get", "{\(docTarget),\"wait\":\(quick)}")
        reader.live = (inScope: true, targeted: false, secure: false, index: 9)
        let unplanned = try await batch(rig, #"[{"action":"left_click","element":2},{"action":"type","text":"x"}]"#)
        let refused = try #require(unplanned["steps"]?.arrayValue?[1]["error"])
        #expect(refused["kind"]?.stringValue == "focus_moved" && refused["reason"]?.stringValue == "unplanned" && refused["element"]?.intValue == 9)
        reader.live = (inScope: true, targeted: true, secure: true, index: 12)
        let secure = try await batch(rig, #"[{"action":"left_click","element":2},{"action":"type","text":"x"}]"#)
        #expect(secure["steps"]?.arrayValue?[1]["error"]?["reason"]?.stringValue == "secure")
        reader.live = (inScope: true, targeted: true, secure: false, index: 3)
        let planned = try await batch(rig, #"[{"action":"left_click","element":3},{"action":"type","text":"x"}]"#)
        #expect(planned["steps"]?.arrayValue?.map { $0["status"]?.stringValue } == ["ok", "ok"])
        // a focus that could not be read is no planned place, and nothing is typed
        reader.live = nil
        let performed = rig.log.count("perform type")
        let unreadable = try await batch(rig, #"[{"action":"left_click","element":3},{"action":"type","text":"x"}]"#)
        let error = try #require(unreadable["steps"]?.arrayValue?[1]["error"])
        #expect(error["kind"]?.stringValue == "focus_moved" && error["reason"]?.stringValue == "unplanned" && error["element"] == nil)
        #expect(rig.log.count("perform type") == performed)
    }

    /// §27.4: the call's record starts before the first step's input and the closing read asks for its menus.
    @Test func theCallRecordsWhatItsStepsOpen() async throws {
        let rig = ServiceRig()
        await rig.ready()
        changing(rig)
        _ = await rig.call("state.get", "{\(docTarget),\"wait\":\(quick)}")
        _ = try await batch(rig, #"[{"action":"left_click","element":2}]"#)
        let order = rig.log.all
        let begin = try #require(order.firstIndex(of: "record begin")), step = try #require(order.firstIndex(of: "record step 0"))
        let performed = try #require(order.firstIndex(of: "perform left_click")), end = try #require(order.firstIndex(of: "record end"))
        #expect(begin < step && step < performed && performed < end)
        #expect(rig.reader().openedMenusAsked)
    }
}
