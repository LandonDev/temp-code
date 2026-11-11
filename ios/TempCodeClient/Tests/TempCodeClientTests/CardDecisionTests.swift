import Foundation
import Testing
import TempCodeContract
@testable import TempCodeClient

@Suite struct CardDecisionWordsTests {
    @Test func `the approval card reads Approve, then Allowed or Denied`() {
        #expect(CardDecision.heading(allowed: nil, auto: false) == "Approve")
        #expect(CardDecision.heading(allowed: true, auto: false) == "Allowed")
        #expect(CardDecision.heading(allowed: false, auto: false) == "Denied")
        #expect(CardDecision.heading(allowed: false, auto: true) == "Denied (timed out)")
        #expect(CardDecision.refusalLine(allow: true, reason: "This key can't approve") == "Not allowed: This key can't approve")
        #expect(CardDecision.refusalLine(allow: false, reason: "gone") == "Not denied: gone")
    }

    @Test func `a held computer step reads Run now and Skip, then Ran now or Skipped`() {
        #expect(CardDecision.allow(.runSkip) == .init(title: "Run now", hint: "Use the Mac's pointer and keyboard now"))
        #expect(CardDecision.deny(.runSkip) == .init(title: "Skip", hint: "Skip this step"))
        #expect(CardDecision.heading(allowed: nil, auto: false, choices: .runSkip) == "Waiting for the Mac to be free")
        #expect(CardDecision.heading(allowed: true, auto: false, choices: .runSkip) == "Ran now")
        #expect(CardDecision.heading(allowed: false, auto: false, choices: .runSkip) == "Skipped")
        #expect(CardDecision.heading(allowed: false, auto: true, choices: .runSkip) == "Skipped automatically")
        #expect(CardDecision.refusalLine(allow: true, reason: "gone", choices: .runSkip) == "Not run: gone")
        #expect(CardDecision.refusalLine(allow: false, reason: "gone", choices: .runSkip) == "Not skipped: gone")
    }

    @Test(arguments: [ApprovalRequestEvent.Choices?.none, .allowDeny, .unknown("later-never")])
    func `any other choices read Allow and Deny`(choices: ApprovalRequestEvent.Choices?) {
        #expect(CardDecision.allow(choices) == .init(title: "Allow", hint: "Let the agent run this"))
        #expect(CardDecision.deny(choices) == .init(title: "Deny", hint: "Refuse this"))
        #expect(CardDecision.heading(allowed: nil, auto: false, choices: choices) == "Approve")
        #expect(CardDecision.heading(allowed: true, auto: false, choices: choices) == "Allowed")
        #expect(CardDecision.heading(allowed: false, auto: true, choices: choices) == "Denied (timed out)")
        #expect(CardDecision.refusalLine(allow: true, reason: "gone", choices: choices) == "Not allowed: gone")
    }

    @Test func `a held step's Live Activity line is its title as the host's question`() {
        #expect(CardDecision.question(title: #"Use your pointer and keyboard to click button "Save" in TextEdit, window "Untitled""#)
            == #"Use your pointer and keyboard to click button "Save" in TextEdit, window "Untitled"?"#)
        #expect(CardDecision.question(title: "Claude wants to read `foo.txt`.") == "Read foo.txt?")
        #expect(CardDecision.question(title: "Tabs  or\nspaces?") == "Tabs or spaces?")
        let long = CardDecision.question(title: String(repeating: "a", count: 140))
        #expect(long == "A" + String(repeating: "a", count: 98) + "…?")
        #expect(CardDecision.question(title: "  ") == "")
    }

    @Test func `a failure card offers at most three actions, Retry last`() {
        for kind in [FailureKind.rateLimited, .quota, .oauthExpired, .network, .unknown] {
            let actions = FailureActions.actions(kind: kind, routed: .claude)
            #expect(actions.count <= 3, "\(kind)")
            #expect(actions.last?.id == .retry, "\(kind)")
        }
    }
}

@MainActor
@Suite struct CardDecisionTests {
    @Test func `the decision shows on the tap, goes once, and a refusal puts the buttons back with one line`() async throws {
        let rig = try ActingRig()
        let fake = try await rig.open()
        let deciding = Task { try await rig.client.approve("s1", requestId: "r1", allow: true) }
        let request = try #require(await rig.request(fake, "session.approve"))
        #expect(rig.client.threads["s1"]?.decisions["r1"] == true, "Allowed before the host answers")
        // A second tap while the first is out sends nothing.
        try await rig.client.approve("s1", requestId: "r1", allow: false)
        #expect(fake.sentRequests.filter { $0.method == "session.approve" }.count == 1)
        fake.refuse(id: request.id, error: "the request is gone")
        await #expect(throws: ActionError.self) { try await deciding.value }
        #expect(rig.client.threads["s1"]?.decisions["r1"] == nil, "the buttons come back")
        #expect(rig.client.threads["s1"]?.refusals["r1"] == "Not allowed: the request is gone")
        #expect(rig.client.threads["s1"]?.deciding.isEmpty == true)
        // The next decision clears the line, and once the host has it nothing more goes.
        let again = Task { try await rig.client.approve("s1", requestId: "r1", allow: false) }
        let second = try #require(await rig.request(fake, "session.approve", count: 2))
        #expect(rig.client.threads["s1"]?.refusals["r1"] == nil)
        fake.answer(id: second.id, result: "null")
        try await again.value
        try await rig.client.approve("s1", requestId: "r1", allow: true)
        #expect(fake.sentRequests.filter { $0.method == "session.approve" }.count == 2, "decided once: a later tap sends nothing")
        await rig.client.stop()
    }

    @Test func `a refused Run now says Not run, under the same session.approve`() async throws {
        let rig = try ActingRig()
        let fake = try await rig.open()
        let deciding = Task { try await rig.client.approve("s1", requestId: "r2", allow: true, choices: .runSkip) }
        let request = try #require(await rig.request(fake, "session.approve"))
        fake.refuse(id: request.id, error: "the step already ran")
        await #expect(throws: ActionError.self) { try await deciding.value }
        #expect(rig.client.threads["s1"]?.refusals["r2"] == "Not run: the step already ran")
        await rig.client.stop()
    }
}
