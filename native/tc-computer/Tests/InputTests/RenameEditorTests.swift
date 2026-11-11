import ComputerCore
import ComputerProtocol
import Input
import Testing

/// A row's name that will not take keyboard focus commits only in its app's own editor (Finder, §26.9).
@Suite struct RenameEditorTests {
    private func key(_ text: String) -> ComputerAction { ComputerAction(action: .key, element: 6, text: text) }

    @Test func aCommitOnARowsUnfocusableNameGoesToTheEditor() {
        #expect(RenameEditor.applies(key("Return"), role: "AXTextField", inRow: true, takesFocus: false))
        #expect(RenameEditor.applies(key("KP_Enter"), role: "AXTextField", inRow: true, takesFocus: false))
        #expect(RenameEditor.applies(ComputerAction(action: .perform, element: 6, name: "confirm"), role: "AXTextField", inRow: true, takesFocus: false))
    }

    @Test func aFieldThatTakesFocusOrIsNoRowsOrAnotherKeyKeepsItsRoute() {
        // TC Probe's rename field takes focus: Return goes to it as before
        #expect(!RenameEditor.applies(key("Return"), role: "AXTextField", inRow: true, takesFocus: true))
        #expect(!RenameEditor.applies(key("Return"), role: "AXTextField", inRow: false, takesFocus: false))
        #expect(!RenameEditor.applies(key("Tab"), role: "AXTextField", inRow: true, takesFocus: false))
        #expect(!RenameEditor.applies(key("Return"), role: "AXTextArea", inRow: true, takesFocus: false))
        #expect(!RenameEditor.applies(ComputerAction(action: .key, element: 6, text: "Return", repeat: 2), role: "AXTextField", inRow: true, takesFocus: false))
    }

    @Test func onlyTheOrdinaryRoutesFocusRefusalSendsItThere() {
        #expect(RenameEditor.isFocusRefusal(ComputerError(kind: .actionUnsupported, message: "[6]\(RenameEditor.noFocus)", element: 6)))
        #expect(!RenameEditor.isFocusRefusal(ComputerError(kind: .actionUnsupported, message: "[6] has no action \"confirm\".", element: 6)))
        #expect(!RenameEditor.isFocusRefusal(ComputerError(kind: .needsTier, message: "[6]\(RenameEditor.noFocus)", element: 6)))
    }

    @Test func theEditorIsAnotherTextField() {
        #expect(RenameEditor.isEditor(role: "AXTextField", sameAsField: false))
        #expect(!RenameEditor.isEditor(role: "AXTextField", sameAsField: true))
        #expect(!RenameEditor.isEditor(role: "AXOutline", sameAsField: false))
    }
}

#if canImport(AppKit)
@testable import Input

/// The front app by AX, never NSRunningApplication's isActive, which goes stale off main's loop.
@Suite struct FrontAppTests {
    @Test func anAppThatIsNotRunningIsNotInFront() {
        #expect(!AX.isFrontApp(999_999))
    }
}
#endif

/// The editor route's moves under a slow app (§26.9): each Return pressed again once, every wait bounded.
@Suite struct RenameEditorPlanTests {
    @Test func theWholeRouteInItsOrder() {
        var p = RenameEditorPlan()
        #expect(p.next(nowMs: 0, editorOpen: false) == .pressReturn)
        #expect(p.next(nowMs: 20, editorOpen: false) == .read(afterMs: RenameEditorPlan.pollMs))
        #expect(p.next(nowMs: 60, editorOpen: true) == .write)
        #expect(p.next(nowMs: 70, editorOpen: true) == .pressReturn)
        #expect(p.next(nowMs: 90, editorOpen: true) == .read(afterMs: RenameEditorPlan.pollMs))
        #expect(p.next(nowMs: 110, editorOpen: false) == .done)
    }

    @Test func aReturnTheAppMissedIsPressedOnceMore() {
        var p = RenameEditorPlan()
        _ = p.next(nowMs: 0, editorOpen: false)
        #expect(p.next(nowMs: RenameEditorPlan.openAgainMs, editorOpen: false) == .pressReturn)
        #expect(p.next(nowMs: RenameEditorPlan.openAgainMs + 20, editorOpen: false) == .read(afterMs: RenameEditorPlan.pollMs))
        #expect(p.next(nowMs: RenameEditorPlan.editorMaxMs, editorOpen: false) == .fail("did not open its rename editor"))
        var c = RenameEditorPlan()
        _ = c.next(nowMs: 0, editorOpen: false)
        _ = c.next(nowMs: 10, editorOpen: true)
        _ = c.next(nowMs: 20, editorOpen: true)
        #expect(c.next(nowMs: 20 + RenameEditorPlan.closeAgainMs, editorOpen: true) == .pressReturn)
        #expect(c.next(nowMs: 30 + RenameEditorPlan.closeAgainMs, editorOpen: true) == .read(afterMs: RenameEditorPlan.pollMs))
        #expect(c.next(nowMs: 20 + RenameEditorPlan.closeMaxMs, editorOpen: true) == .fail("kept its rename editor open"))
    }

    @Test func theBoundsFitInsideTheHold() {
        #expect(RenameEditorPlan.editorMaxMs + RenameEditorPlan.closeMaxMs < InputTiming.frontHoldMaxMs)
    }

    @Test func aFieldThatListsNoSettableFocusGoesToTheEditorBeforeAnythingIsPosted() {
        #expect(!RenameEditor.takesFocus(focusSettable: false))
        #expect(RenameEditor.applies(ComputerAction(action: .key, element: 6, text: "Return"), role: "AXTextField", inRow: true, takesFocus: RenameEditor.takesFocus(focusSettable: false)))
        #expect(!RenameEditor.applies(ComputerAction(action: .key, element: 6, text: "Return"), role: "AXTextField", inRow: true, takesFocus: RenameEditor.takesFocus(focusSettable: true)))
    }
}
