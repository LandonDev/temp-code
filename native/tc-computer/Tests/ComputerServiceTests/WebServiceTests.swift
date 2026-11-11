import ApplicationServices
import ComputerCore
import ComputerProtocol
@testable import ComputerService
import ComputerServiceKit
import Foundation
import Testing

// §25 in the shell: a ref naming a browser tab, the slot a selection holds, `tab_in_use`, `page` and
// `selectedTab` on the observation, the page holding the smart wait, `expectFocus` and Input's effect.

let browserPid: pid_t = 700

/// A rig with a browser at pid 700: one window, its tabs Front (selected), Report and Notes.
func browserRig(features: [String]? = nil) async -> ServiceRig {
    let rig = ServiceRig()
    rig.workspace.apps.append(RunningApp(pid: browserPid, bundleId: "com.example.Browser", name: "Browser", path: "/Applications/Browser.app", active: false, hidden: false))
    rig.windows.setTabs(browserPid, window: window(11, "Front - Browser"), ["Front", "Report", "Notes"])
    await rig.ready(session: "s1", features: features)
    _ = await rig.call("session.open", #"{"session":"s2"}"#)
    return rig
}

func browser(_ session: String = "s1", tab: String) -> String { #""session":"\#(session)","app":{"app":"Browser"},"window":{"title":"\#(tab)"}"# }

@Suite struct TabReadTests {
    @Test func aReadNamingABackgroundTabSelectsItAndSaysSo() async throws {
        let rig = await browserRig()
        let result = try #require(await rig.call("state.get", "{\(browser(tab: "Report")),\"wait\":\(quick)}").result)
        #expect(result["selectedTab"]?.stringValue == "Report")
        #expect(result["page"]?["tab"]?.stringValue == "Report")
        #expect(result["page"]?["state"]?.stringValue == "loaded")
        #expect(result["text"]?.stringValue?.contains("tab \"Report\"") == true)
        // the switched window's page holds the smart wait (the fake's page stays busy)
        #expect(result["waited"]?["busy"]?.boolValue == true)
        let order = rig.log.all
        let selected = try #require(order.firstIndex(of: "selected Report"))
        let watched = try #require(order.firstIndex(of: "watchPage"))
        let observed = try #require(order.firstIndex { $0.hasPrefix("observe page=") })
        #expect(selected < watched && watched < observed)
        #expect(rig.log.all.contains("selectTab Report background"))
    }

    @Test func aReadNamingTheSelectedTabSelectsNothing() async throws {
        let rig = await browserRig()
        let result = try #require(await rig.call("state.get", "{\(browser(tab: "Front")),\"wait\":\(quick)}").result)
        #expect(result["selectedTab"] == nil)
        #expect(result["page"]?["tab"]?.stringValue == "Front")
        #expect(rig.log.count("selectTab") == 0)
        // an app that is no browser has no page
        let doc = try #require(await rig.call("state.get", "{\(docTarget),\"wait\":\(quick)}").result)
        #expect(doc["page"] == nil && doc["selectedTab"] == nil)
    }

    @Test func thePersonsFrontWindowRefusesAReadAndABackgroundAct() async throws {
        let rig = await browserRig()
        rig.windows.personsWindow = true
        let read = await rig.call("state.get", "{\(browser(tab: "Report")),\"wait\":\(quick)}")
        #expect(read.error?.data?.kind == .tabInUse)
        let shot = await rig.call("capture.screenshot", "{\(browser(tab: "Report"))}")
        #expect(shot.error?.data?.kind == .tabInUse)
        let act = await rig.call("action.run", "{\(browser(tab: "Report")),\"action\":{\"action\":\"key\",\"text\":\"a\"},\"tiers\":[\"process\"],\"wait\":\(quick)}")
        #expect(act.error?.data?.kind == .tabInUse)
        #expect(rig.log.count("perform") == 0)
        // the host's admit after the gate: `tabs: any`
        let admitted = try #require(await rig.call("action.run", "{\(browser(tab: "Report")),\"tabs\":\"any\",\"action\":{\"action\":\"key\",\"text\":\"a\"},\"tiers\":[\"process\"],\"wait\":\(quick)}").result)
        #expect(admitted["step"]?["status"]?.stringValue == "ok")
        #expect(admitted["observation"]?["selectedTab"]?.stringValue == "Report")
        // the slot was let go after each refusal: another session's read goes through
        #expect(await rig.call("state.get", "{\(browser("s2", tab: "Report")),\"wait\":\(quick)}").result != nil)
    }
}

@Suite struct TabSlotTests {
    /// s1's act selects Report and works slowly; s2's read of Notes, which must select, waits for the act and
    /// its observation, and each observation is of its own tab.
    @Test func aReadSelectingATabWaitsForAnotherSessionsAct() async throws {
        let rig = await browserRig()
        rig.input.onPerform = { _, _ in
            usleep(150_000)
            return InputOutcome(tier: .process, via: nil, clipboard: nil, cursor: nil, lastInputAt: mach_absolute_time())
        }
        let act = rig.send("action.run", "{\(browser(tab: "Report")),\"action\":{\"action\":\"key\",\"text\":\"a\"},\"tiers\":[\"process\"],\"wait\":\(quick)}")
        #expect(await eventually { rig.log.all.contains("perform key") })
        let read = rig.send("state.get", "{\(browser("s2", tab: "Notes")),\"wait\":\(quick)}")
        let acted = try #require(await rig.answer(act).result)
        let observed = try #require(await rig.answer(read).result)
        #expect(acted["observation"]?["selectedTab"]?.stringValue == "Report")
        #expect(acted["observation"]?["page"]?["tab"]?.stringValue == "Report")
        #expect(acted["observation"]?["text"]?.stringValue?.contains("tab \"Report\"") == true)
        #expect(observed["selectedTab"]?.stringValue == "Notes")
        #expect(observed["text"]?.stringValue?.contains("tab \"Notes\"") == true)
        let order = rig.log.all
        let actRead = try #require(order.firstIndex(of: "observe page=Report"))
        let notes = try #require(order.firstIndex(of: "selectTab Notes background"))
        #expect(actRead < notes, "the read selected nothing until the act had read its own tab")
    }

    /// s2's read names Front, selected when it resolved, and takes the shared lease behind s1's act, which
    /// switches to Report: holding the lease, the read sees Front unselected and comes back exclusive to select it.
    @Test func aSharedReadWhoseTabAnActSwitchedSelectsItBack() async throws {
        let rig = await browserRig()
        rig.input.onPerform = { _, _ in
            usleep(150_000)
            return InputOutcome(tier: .process, via: nil, clipboard: nil, cursor: nil, lastInputAt: mach_absolute_time())
        }
        // the act's selection takes a while: the read resolves Front while it is still selected
        rig.windows.selectDelay = .milliseconds(150)
        let act = rig.send("action.run", "{\(browser(tab: "Report")),\"action\":{\"action\":\"key\",\"text\":\"a\"},\"tiers\":[\"process\"],\"wait\":\(quick)}")
        #expect(await eventually { rig.log.all.contains("selectTab Report background") })
        let read = rig.send("state.get", "{\(browser("s2", tab: "Front")),\"wait\":\(quick)}")
        #expect(try #require(await rig.answer(act).result)["observation"]?["page"]?["tab"]?.stringValue == "Report")
        let observed = try #require(await rig.answer(read).result)
        #expect(observed["selectedTab"]?.stringValue == "Front")
        #expect(observed["page"]?["tab"]?.stringValue == "Front")
        let order = rig.log.all
        #expect(try #require(order.firstIndex(of: "observe page=Report")) < #require(order.firstIndex(of: "selectTab Front background")))
    }
}

@Suite struct ExpectFocusTests {
    @Test func theExpectationBindsTheFirstKeyStepAloneOnAChromiumApp() async throws {
        let rig = await browserRig()
        let reader = rig.reader("s1", pid: browserPid)
        reader.focusedBrief = ElementBrief(index: 9, line: "input \"Address and search bar\"")
        // every step changes the window, so §27.8 never stops the keys after it
        rig.input.onPerform = { _, _ in
            let at = mach_absolute_time()
            reader.signal.notify()
            return InputOutcome(tier: .process, via: nil, clipboard: nil, cursor: nil, lastInputAt: at - 1)
        }
        let epoch = rig.service.epoch
        let keys = #"[{"action":"key","text":"Tab"},{"action":"type","text":"hi"}]"#
        let batch = try #require(await rig.call("action.batch", "{\(browser(tab: "Front")),\"actions\":\(keys),\"expectFocus\":4,\"epoch\":\"\(epoch)\",\"tiers\":[\"process\"],\"wait\":\(quick)}").result)
        #expect(batch["steps"]?.arrayValue?.count == 2)
        #expect(rig.input.seenWeb.map { $0.expect } == [4, nil])
        #expect(rig.input.seenWeb.allSatisfy { $0.chromium })
        #expect(rig.input.seenWeb.first?.brief?.index == 9)
        // a click first: focus is whatever it left, nothing binds
        let clickFirst = #"[{"action":"left_click","coordinate":[5,5]},{"action":"type","text":"hi"}]"#
        _ = await rig.call("action.batch", "{\(browser(tab: "Front")),\"actions\":\(clickFirst),\"expectFocus\":4,\"epoch\":\"\(epoch)\",\"tiers\":[\"process\"],\"wait\":\(quick)}")
        #expect(rig.input.seenWeb.suffix(2).map { $0.expect } == [nil, nil])
        // an app that is no browser: Input hears so
        _ = await rig.call("action.run", "{\(docTarget),\"action\":{\"action\":\"key\",\"text\":\"a\"},\"tiers\":[\"process\"],\"wait\":\(quick)}")
        #expect(rig.input.seenWeb.last?.chromium == false)
    }

    @Test func anExpectationFromAnotherEpochIsStaleBeforeAnyInput() async throws {
        let rig = await browserRig()
        let stale = await rig.call("action.run", "{\(browser(tab: "Front")),\"action\":{\"action\":\"type\",\"text\":\"hi\"},\"expectFocus\":4,\"epoch\":\"before\",\"tiers\":[\"process\"],\"wait\":\(quick)}")
        #expect(stale.error?.data?.kind == .staleElement)
        #expect(stale.error?.data?.element == 4)
        let none = await rig.call("action.run", "{\(browser(tab: "Front")),\"action\":{\"action\":\"type\",\"text\":\"hi\"},\"expectFocus\":4,\"tiers\":[\"process\"],\"wait\":\(quick)}")
        #expect(none.error?.code == -32602)
        // an expected element gone from the app fails its step as any element would
        rig.reader("s1", pid: browserPid).stale = [4]
        let gone = try #require(await rig.call("action.run", "{\(browser(tab: "Front")),\"action\":{\"action\":\"type\",\"text\":\"hi\"},\"expectFocus\":4,\"epoch\":\"\(rig.service.epoch)\",\"tiers\":[\"process\"],\"wait\":\(quick)}").result)
        #expect(gone["step"]?["error"]?["kind"]?.stringValue == "stale_element")
        #expect(rig.log.count("perform") == 0)
    }
}

@Suite struct InputEffectTests {
    /// §25.7: a web toggle's value read back is the step's effect, whatever else changed in the window.
    @Test func inputsOwnEffectStandsInForTheWaits() async throws {
        let rig = ServiceRig()
        await rig.ready()
        let reader = rig.reader()
        rig.input.onPerform = { _, _ in
            let at = mach_absolute_time()
            reader.signal.notify()
            return InputOutcome(tier: .ax, via: .hit, clipboard: nil, cursor: nil, lastInputAt: at - 1, effect: StepEffect.none)
        }
        _ = await rig.call("state.get", "{\(docTarget),\"wait\":\(quick)}")
        let one = try #require(await rig.call("action.run", "{\(docTarget),\"action\":{\"action\":\"left_click\",\"element\":2},\"epoch\":\"\(rig.service.epoch)\",\"tiers\":[\"ax\"],\"wait\":\(quick)}").result)
        #expect(one["step"]?["effect"]?.stringValue == "none")
        let two = #"[{"action":"left_click","element":2},{"action":"left_click","element":3}]"#
        let batch = try #require(await rig.call("action.batch", "{\(docTarget),\"actions\":\(two),\"epoch\":\"\(rig.service.epoch)\",\"tiers\":[\"ax\"],\"wait\":\(quick)}").result)
        #expect(batch["steps"]?.arrayValue?.map { $0["effect"]?.stringValue } == ["none", "none"])
    }
}

/// §26 beside §25: a front hold on a named tab, and web content with no commit check or save_as.
@Suite struct FrontOnWebTests {
    private let all = ["front", "commit", "save_as"]

    @Test func aFrontStepOnANamedTabSelectsTheTabBeforeAnythingActs() async throws {
        let rig = await browserRig(features: all)
        rig.input.onPerform = { _, _ in InputOutcome(tier: .front, via: .menu, clipboard: nil, cursor: nil, lastInputAt: mach_absolute_time(), on: "File › Print…") }
        let result = try #require(await rig.call("action.run", "{\(browser(tab: "Report")),\"action\":{\"action\":\"key\",\"text\":\"super+p\"},\"tiers\":[\"ax\",\"process\",\"front\"],\"wait\":\(quick)}").result)
        #expect(result["step"]?["tier"]?.stringValue == "front")
        let order = rig.log.all
        let selected = try #require(order.firstIndex(of: "selectTab Report background"))
        let acted = try #require(order.firstIndex(of: "perform key"))
        #expect(selected < acted, "the tab is selected under the slot before the hold brings the window forward")
    }

    @Test func aFrontStepNeverActivatesATabThePersonHasInFront() async throws {
        let rig = await browserRig(features: all)
        rig.windows.personsWindow = true
        let act = await rig.call("action.run", "{\(browser(tab: "Report")),\"action\":{\"action\":\"key\",\"text\":\"super+p\"},\"tiers\":[\"ax\",\"process\",\"front\"],\"wait\":\(quick)}")
        #expect(act.error?.data?.kind == .tabInUse)
        #expect(rig.log.count("perform") == 0)
    }

    @Test func webContentGetsNoCommitCheck() async throws {
        let rig = await browserRig(features: all)
        let read = Box<Int>()
        rig.service.documentReader = { _ in
            read.value = (read.value ?? 0) + 1
            return DocumentState(url: "https://example.com/report", edited: nil)
        }
        rig.input.onPerform = { _, target in
            #expect(target.commitExpected == nil)
            return InputOutcome(tier: .ax, via: nil, clipboard: nil, cursor: nil, lastInputAt: mach_absolute_time())
        }
        let result = try #require(await rig.call("action.run", "{\(browser(tab: "Front")),\"action\":{\"action\":\"key\",\"text\":\"super+s\"},\"tiers\":[\"ax\",\"process\",\"front\"],\"wait\":\(quick)}").result)
        #expect(result["step"]?["disk"] == nil)
        #expect(result["step"]?["effect"]?.stringValue != "uncommitted")
        #expect(read.value == nil)
    }

    @Test func saveAsIsRefusedOnWebContentBeforeInput() async throws {
        let rig = await browserRig(features: all)
        let result = try #require(await rig.call("action.run", "{\(browser(tab: "Front")),\"action\":{\"action\":\"save_as\",\"path\":\"/tmp/page.html\"},\"tiers\":[\"ax\",\"process\",\"front\"],\"wait\":\(quick)}").result)
        #expect(result["step"]?["status"]?.stringValue == "failed")
        #expect(result["step"]?["error"]?["kind"]?.stringValue == "action_unsupported")
        #expect(rig.log.count("perform") == 0)
    }

    @Test func aPageURLIsNoDocumentSoNothingIsExpected() {
        // the pure seam: a Chromium window's AXDocument names a page, never a file
        for url in ["https://example.com/report", "about:blank", "chrome://newtab/"] {
            #expect(CommitCheck.begin(CommitContext(action: ComputerAction(action: .key, text: "super+s")), state: DocumentState(url: url, edited: nil)) == nil)
        }
        let typed = CommitContext(action: ComputerAction(action: .setValue, value: "x"), element: CommitElement(role: "input"))
        #expect(CommitRule.expects(typed) == nil)
    }
}
