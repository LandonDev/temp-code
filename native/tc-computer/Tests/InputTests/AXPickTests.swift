#if canImport(AppKit)
import AppKit
import ApplicationServices
import ComputerCore
import ComputerProtocol
import Foundation
import Testing
@testable import Input

// Web controls' live seams (docs/computer-protocol.md §25.7, §25.8). The first suite needs no app; the
// second drives a scratch page and is skipped unless TC_PICK_PID names the pid of a scratch Chromium
// window whose page holds a <select> (the gate's web leg page), TC_PICK_VALUE an item of it and
// TC_PICK_TITLE, when set, that window's title. It never touches another process.

@Suite struct WebInputSeamTests {
    private func brief(_ index: Int, _ line: String) -> ResolvedElement {
        let app = AXUIElementCreateApplication(getpid())
        return ResolvedElement(index: index, element: app, role: "pop up", frame: ComputerProtocol.Rect(x: 0, y: 0, w: 10, h: 10), actions: ["AXPress"], settable: [], brief: ElementBrief(index: index, line: line))
    }

    @Test func aValueThatDidNotTakeSaysWhatItReads() {
        let f = AXTier.valueNotTaken(brief(19, "pop up \"Plan\""), reads: "Choose a plan")
        #expect(f.error == ComputerError(kind: .valueNotTaken, message: "[19] pop up \"Plan\" still reads \"Choose a plan\".", element: 19, value: "Choose a plan"))
        let none = AXTier.valueNotTaken(brief(19, "pop up \"Plan\""), reads: "Choose a plan", available: ["Starter", "Team"], note: "has no item \"Gold\"")
        #expect(none.error.message == "[19] pop up \"Plan\" has no item \"Gold\"; it still reads \"Choose a plan\".")
        #expect(none.error.available == ["Starter", "Team"])
        #expect(AXTier.valueNotTaken(brief(4, "input \"Age\""), reads: nil).error.message == "[4] input \"Age\" did not take the value.")
    }

    @Test func quotesAsALineDoes() {
        #expect(AXTier.quote(#"Say "hi" \ bye"#) == #""Say \"hi\" \\ bye""#)
    }

    @Test func aBatchedFrameRead() {
        var p = CGPoint(x: 10, y: 880), s = CGSize(width: 700, height: 24)
        let position = AXValueCreate(.cgPoint, &p), size = AXValueCreate(.cgSize, &s)
        #expect(AXTier.rect(position: position, size: size) == ComputerProtocol.Rect(x: 10, y: 880, w: 700, h: 24))
        #expect(AXTier.rect(position: nil, size: size) == nil)
        #expect(AXTier.rect(position: "x" as CFString, size: size) == nil)
    }

    @Test func theWebRolesAreTheReadersWords() {
        // the roles a scroll-into-view aims at all print as lines of their own
        for role in AXTier.intoViewRoles {
            #expect(InputTables.roleTags[role] != nil, "\(role)")
        }
        #expect(KeyCodes.escape == KeyCodes.code("Escape"))
    }
}

private let pickPid = ProcessInfo.processInfo.environment["TC_PICK_PID"].flatMap { pid_t($0) }

@Suite(.enabled(if: pickPid != nil, "TC_PICK_PID names no scratch Chromium window")) struct AXPickTests {
    /// The window's first AXPopUpButton inside a web area, breadth first, 3,000 nodes at most.
    private func popUp(_ pid: pid_t) throws -> AXUIElement {
        let app = AX.app(pid)
        let title = ProcessInfo.processInfo.environment["TC_PICK_TITLE"]
        let windows = AX.elements(app, "AXWindows").filter { title == nil || AX.string($0, "AXTitle") == title }
        var queue = windows
        var read = 0
        while !queue.isEmpty, read < 3_000 {
            let e = queue.removeFirst()
            read += 1
            if AX.string(e, "AXRole") == "AXPopUpButton", AX.inWebArea(e) { return e }
            queue += AX.elements(e, "AXChildren")
        }
        throw ComputerFailure(.noSuchElement, "no pop up in a page of pid \(pid)")
    }

    private func resolved(_ e: AXUIElement) -> ResolvedElement {
        ResolvedElement(index: 1, element: e, role: "pop up", frame: AX.frame(e) ?? ComputerProtocol.Rect(x: 0, y: 0, w: 1, h: 1), actions: AX.actions(e), settable: [], brief: ElementBrief(index: 1, line: AXHit.line(e)))
    }

    @Test func picksAnItemReadsItBackAndLeavesNoMenu() throws {
        let pid = pickPid!
        let value = ProcessInfo.processInfo.environment["TC_PICK_VALUE"] ?? "Team"
        let e = try popUp(pid)
        let picked = try AXPick.pick(resolved(e), value: value, pid: pid, clock: SystemClock())
        #expect(ReadBack.same(picked.item, AX.valueText(e) ?? AXPick.shown(e).selected ?? ""))
        #expect(AXPick.menus(of: e, app: AX.app(pid)).allSatisfy { !AXPick.isOpen($0, popUp: e) })
        // the same value again opens nothing
        #expect(try AXPick.pick(resolved(e), value: picked.item, pid: pid, clock: SystemClock()).changed == false)
    }

    @Test func anItemThatIsNotThereFailsAndClosesTheMenu() throws {
        let pid = pickPid!
        let e = try popUp(pid)
        let before = AX.valueText(e)
        #expect(throws: ComputerFailure.self) { try AXPick.pick(resolved(e), value: "No such item \(UUID().uuidString)", pid: pid, clock: SystemClock()) }
        #expect(AX.valueText(e) == before)
        #expect(AXPick.menus(of: e, app: AX.app(pid)).allSatisfy { !AXPick.isOpen($0, popUp: e) })
    }
}
#endif
