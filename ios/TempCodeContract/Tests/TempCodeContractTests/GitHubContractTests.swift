import Foundation
import Testing
@testable import TempCodeContract

@Suite("GitHub contract")
struct GitHubContractTests {
    @Test func recursiveThreadKeepsRepliesAndNullLines() throws {
        let json = #"""
        {"comments":[
          {"id":"root","kind":"review","author":"alice","authorAvatarUrl":"","body":"Review",
           "createdAt":"2026-10-19T00:00:00Z","url":"","state":"COMMENTED","path":"",
           "line":null,"resolved":false,"threadId":"thread","replies":[
             {"id":"reply","kind":"comment","author":"bob","authorAvatarUrl":"","body":"Reply",
              "createdAt":"2026-10-19T00:01:00Z","url":"","state":"","path":"src/app.ts",
              "line":7,"resolved":true,"threadId":"thread","replies":[]}
           ]}
        ],"truncated":false,"reviewDecision":"","baseRefName":"main","headRefName":"feature"}
        """#
        let data = Data(json.utf8)
        let thread = try JSONDecoder().decode(Methods.GithubThread.Output.self, from: data)
        let comment = try #require(thread.comments.first)
        #expect(comment.line == nil)
        let reply = try #require(comment.replies.first)
        #expect(reply.id == "reply")
        #expect(reply.line == 7)
        #expect(reply.resolved)
        #expect(reply.replies.isEmpty)
        let before = try JSONDecoder().decode(JSONValue.self, from: data)
        #expect(try JSONValue(thread).canonicalJSON(dropNulls: false) == before.canonicalJSON(dropNulls: false))
    }

    @Test(arguments: ["SUCCESS", "FAILURE", "PENDING", "ERROR", "EXPECTED", "FUTURE"])
    func checksKeepWireValues(raw: String) throws {
        let value = GithubInboxChecks(rawValue: raw)
        let data = try JSONEncoder().encode(value)
        #expect(try JSONDecoder().decode(String.self, from: data) == raw)
        #expect(try JSONDecoder().decode(GithubInboxChecks.self, from: data) == value)
    }

    @Test func checksCanBeNull() throws {
        let values = try JSONDecoder().decode([GithubInboxChecks?].self, from: Data(#"[null,"SUCCESS","FUTURE"]"#.utf8))
        #expect(values == [nil, .success, .unknown("FUTURE")])
    }

    @Test(arguments: ["", "APPROVED", "CHANGES_REQUESTED", "REVIEW_REQUIRED", "FUTURE"])
    func reviewDecisionsKeepWireValues(raw: String) throws {
        let value = GithubInboxReviewDecision(rawValue: raw)
        let data = try JSONEncoder().encode(value)
        #expect(try JSONDecoder().decode(String.self, from: data) == raw)
        #expect(try JSONDecoder().decode(GithubInboxReviewDecision.self, from: data) == value)
    }

    @Test func enumCaseNames() {
        #expect(GithubInboxChecks(rawValue: "SUCCESS") == .success)
        #expect(GithubInboxChecks(rawValue: "FAILURE") == .failure)
        #expect(GithubInboxChecks(rawValue: "PENDING") == .pending)
        #expect(GithubInboxChecks(rawValue: "ERROR") == .error)
        #expect(GithubInboxChecks(rawValue: "EXPECTED") == .expected)
        #expect(GithubInboxReviewDecision(rawValue: "") == .none)
        #expect(GithubInboxReviewDecision(rawValue: "APPROVED") == .approved)
        #expect(GithubInboxReviewDecision(rawValue: "CHANGES_REQUESTED") == .changesRequested)
        #expect(GithubInboxReviewDecision(rawValue: "REVIEW_REQUIRED") == .reviewRequired)
    }
}
