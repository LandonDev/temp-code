import Testing
import TempCodeContract
@testable import TempCodeClient

@Suite struct SearchResultsTests {
    @Test func `imported session and project ids stay distinct across hosts`() {
        let first = SessionSearchHit(sessionId: "shared", seq: 7, role: .assistant, snippet: "mac", ts: 1)
        let second = SessionSearchHit(sessionId: "shared", seq: 7, role: .assistant, snippet: "box", ts: 2)
        let groups = ThreadHits.group(environmentId: "mac", hits: [first, first], sessions: [meta("shared", title: "Mac thread")])
            + ThreadHits.group(environmentId: "box", hits: [second], sessions: [meta("shared", title: "Box thread")])
        #expect(groups.count == 2)
        #expect(Set(groups.map(\.id)).count == 2)
        #expect(groups.map(\.environmentId) == ["mac", "box"])
        #expect(groups.map(\.title) == ["Mac thread", "Box thread"])
        #expect(groups.map { $0.hits.count } == [2, 1])
        #expect(groups[1].hits[0].snippet == "box")
        #expect(EnvironmentResourceID(environmentId: "mac", resourceId: "project") != EnvironmentResourceID(environmentId: "box", resourceId: "project"))
    }
}
