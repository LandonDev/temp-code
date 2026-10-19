import Foundation
import Testing
import TempCodeContract
@testable import TempCodeClient

private func source(_ callId: String, url: String? = nil, query: String? = nil, agentId: String = "a1", agentLabel: String = "ResearchAngle one", title: String? = nil, claim: String? = nil) -> ResearchSource {
    ResearchSource(callId: callId, url: url, query: query, agentId: agentId, agentLabel: agentLabel, title: title, claim: claim)
}

@Suite struct ResearchBoardTests {
    @Test func `returns the empty board for no rows`() {
        #expect(ResearchBoard.fold([]) == .empty)
    }

    @Test func `groups queries per agent with sources under the latest query`() {
        let board = ResearchBoard.fold([
            source("q1", query: "react 19"),
            source("s1", url: "https://react.dev/blog", title: "React blog"),
            source("q2", query: "react compiler"),
            source("s2", url: "https://react.dev/compiler"),
            source("s3", url: "https://www.example.com", agentId: "a2", agentLabel: "ResearchAngle two")
        ])
        #expect(board.angles.map { [$0.agentId, $0.label] } == [["a1", "ResearchAngle one"], ["a2", "ResearchAngle two"]])
        #expect(board.angles[0].queries == [
            QueryGroup(query: "react 19", sources: [SourceRow(callId: "s1", url: "https://react.dev/blog", title: "React blog")]),
            QueryGroup(query: "react compiler", sources: [SourceRow(callId: "s2", url: "https://react.dev/compiler")])
        ])
        #expect(board.angles[1].queries == [QueryGroup(query: nil, sources: [SourceRow(callId: "s3", url: "https://www.example.com")])])
        #expect(board.sources == 3)
        #expect(board.searches == 2)
    }

    @Test func `a repeat callId enriches the earlier row and unique urls and queries count once`() {
        let board = ResearchBoard.fold([
            source("q1", query: "same"),
            source("s1", url: "https://a.dev"),
            source("s1", url: "https://a.dev", title: "A"),
            source("q1b", query: "same", agentId: "a2", agentLabel: "Two"),
            source("s2", url: "https://a.dev", agentId: "a2", agentLabel: "Two")
        ])
        #expect(board.angles[0].queries[0].sources == [SourceRow(callId: "s1", url: "https://a.dev", title: "A")])
        #expect(board.angles[1].queries[0].sources.count == 1)
        #expect(board.sources == 1)
        #expect(board.searches == 1)
    }

    @Test func `a cited fetch stays one row with its claim; a further claim is its own row`() {
        let board = ResearchBoard.fold([
            source("q1", query: "a pricing"),
            source("s1", url: "https://a.dev/x"),
            source("s1", url: "https://a.dev/x", title: "A pricing", claim: "A charges $42 a seat"),
            source("cite:1", url: "https://a.dev/x", claim: "A has a free tier"),
            source("cite:2", url: "https://b.org", claim: "B has none")
        ])
        #expect(board.angles[0].queries[0].sources == [
            SourceRow(callId: "s1", url: "https://a.dev/x", title: "A pricing", claim: "A charges $42 a seat"),
            SourceRow(callId: "cite:1", url: "https://a.dev/x", claim: "A has a free tier"),
            SourceRow(callId: "cite:2", url: "https://b.org", claim: "B has none")
        ])
        #expect(board.sources == 2)
        #expect(board.searches == 1)
    }

    @Test func `host strips www and survives bad urls`() {
        #expect(ResearchBoard.host(of: "https://www.react.dev/x") == "react.dev")
        #expect(ResearchBoard.host(of: "not a url") == "")
    }

    @Test func `mergeAngles lists every spawned child in spawn order after the root's own group`() {
        let board = ResearchBoard.fold([
            source("r1", query: "overview", agentId: "root", agentLabel: "Research"),
            source("b1", url: "https://b.dev", agentId: "b", agentLabel: "ResearchAngle B")
        ])
        let angles = ResearchBoard.mergeAngles(board, agents: ["a", "b", "c"])
        #expect(angles.map(\.agentId) == ["root", "a", "b", "c"])
        #expect(angles[1] == ResearchAngle(agentId: "a", label: "", queries: []))
        #expect(angles[2].queries[0].sources.map(\.url) == ["https://b.dev"])
        let own = ResearchBoard.fold([source("s1", url: "https://a.dev")])
        #expect(ResearchBoard.mergeAngles(own, agents: []) == own.angles)
    }
}
