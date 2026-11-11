import Foundation
import Testing
import TempCodeContract
@testable import TempCodeClient

@Suite struct ApprovalShapeTests {
    @Test(arguments: [
        "computer_session", "computer_act", "computer_batch", "computer_apps", "computer_observe",
        "mcp__app__computer_act", "mcp__app__computer_batch", "app.computer_observe",
        "computer_left_click", "mcp__app__computer_type", "computer_select_text"
    ])
    func `a computer tool's card is its title alone`(name: String) {
        #expect(ApprovalShape.titleOnly(name))
    }

    @Test(arguments: [
        "Bash", "Edit", "mcp__linear__create_issue", "mcp__app__computer_result", "computer_fly",
        "mcp__other__computer_act_now", "computer", "computer_"
    ])
    func `any other tool keeps its detail`(name: String) {
        #expect(!ApprovalShape.titleOnly(name))
    }
}

@Suite struct PushCategoriesTests {
    @Test func `the approval decides with Approve and Deny, a held step with Run now and Skip`() {
        #expect(PushCategories.approval.id == "tc.approval")
        #expect(PushCategories.approval.actions.map(\.title) == ["Approve", "Deny"])
        #expect(PushCategories.approval.hiddenPreview == "Needs approval")
        #expect(PushCategories.approval.choices == nil)
        #expect(PushCategories.runSkip.id == "tc.run-skip")
        #expect(PushCategories.runSkip.actions.map(\.title) == ["Run now", "Skip"])
        #expect(PushCategories.runSkip.hiddenPreview == "Waiting for the Mac")
        #expect(PushCategories.runSkip.choices == .runSkip)
        for category in [PushCategories.approval, PushCategories.runSkip] {
            #expect(category.actions.map(\.id) == [PushCategories.approveAction, PushCategories.denyAction], "one pair of identifiers")
            #expect(category.actions.map(\.option) == [.authenticationRequired, .destructive])
        }
        #expect(PushCategories.thread.actions.isEmpty)
    }

    @Test func `a category is found by its id, and an action says which way it decides`() {
        #expect(PushCategories.named("tc.run-skip") == PushCategories.runSkip)
        #expect(PushCategories.named("tc.later") == nil)
        #expect(Set(PushCategories.all.map(\.id)).count == PushCategories.all.count)
        #expect(PushCategories.allow(action: "tc.approve") == true)
        #expect(PushCategories.allow(action: "tc.deny") == false)
        #expect(PushCategories.allow(action: "com.apple.UNNotificationDefaultActionIdentifier") == nil)
    }
}
