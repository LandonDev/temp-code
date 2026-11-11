@testable import AXText
import Testing

/// §27.7 (b): the focused table holds the row a step targeted.
@Suite struct HeldItemTests {
    @Test func aTableHoldingTheFocusHoldsItsTargetedRowOrCell() {
        #expect(HeldItem.held(focusedRole: "AXTable", targetRole: "AXRow", focusedIsAncestor: true))
        #expect(HeldItem.held(focusedRole: "AXOutline", targetRole: "AXCell", focusedIsAncestor: true))
    }

    @Test func onlyAnAncestorContainerAndOnlyARowOrCell() {
        #expect(!HeldItem.held(focusedRole: "AXTable", targetRole: "AXRow", focusedIsAncestor: false))
        #expect(!HeldItem.held(focusedRole: "AXGroup", targetRole: "AXRow", focusedIsAncestor: true))
        #expect(!HeldItem.held(focusedRole: "AXTable", targetRole: "AXButton", focusedIsAncestor: true))
    }
}
