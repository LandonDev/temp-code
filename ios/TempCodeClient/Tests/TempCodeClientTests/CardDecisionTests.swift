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
}
