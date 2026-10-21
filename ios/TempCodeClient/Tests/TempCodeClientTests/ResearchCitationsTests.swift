import Foundation
import Testing
import TempCodeContract
@testable import TempCodeClient

private func source(_ callId: String, url: String? = nil, query: String? = nil, agentId: String = "a1", agentLabel: String = "Angle one", title: String? = nil, claim: String? = nil) -> ResearchSource {
    ResearchSource(callId: callId, url: url, query: query, agentId: agentId, agentLabel: agentLabel, title: title, claim: claim)
}

@Suite struct ResearchCitationsTests {
    @Test func `markers name one or several numbers and leave links and checkboxes alone`() {
        let text = "GRDB maps rows [1]. Both agree [2, 5] but see [the docs](https://x.dev) and [ ] a box."
        let found = text.matches(of: ReportCitations.marker).map { ReportCitations.numbers(in: $0.1) }
        #expect(found == [[1], [2, 5]])
    }

    @Test func `the report's own sources list wins, in every shape an agent writes`() {
        let body = """
        # Report

        Findings [2].

        ## Sources

        1. [GRDB.swift](https://github.com/groue/GRDB.swift)
        2. https://bun.sh/docs/api/sqlite — SQLite – Bun Docs
        [7] Write-Ahead Logging: https://www.sqlite.org/wal.html.

        ## Open questions

        - [Not a source](https://example.com)
        """
        let index = ReportCitations.index(body: body, board: .empty)
        #expect(index[1] == Citation(number: 1, url: "https://github.com/groue/GRDB.swift", title: "GRDB.swift"))
        #expect(index[2] == Citation(number: 2, url: "https://bun.sh/docs/api/sqlite", title: "SQLite – Bun Docs"))
        #expect(index[7] == Citation(number: 7, url: "https://www.sqlite.org/wal.html", title: "Write-Ahead Logging"))
        #expect(index.count == 3)
    }

    @Test func `without a sources section the board's distinct urls stand in, in arrival order`() {
        let board = ResearchBoard.fold([
            source("q1", query: "a"),
            source("s1", url: "https://a.dev", title: "A"),
            source("s2", url: "https://b.org", agentId: "a2", agentLabel: "Two"),
            source("cite:1", url: "https://a.dev", claim: "again")
        ])
        let index = ReportCitations.index(body: "# Report\n\nA says so [1], B too [2].", board: board)
        #expect(index[1] == Citation(number: 1, url: "https://a.dev", title: "A"))
        #expect(index[2] == Citation(number: 2, url: "https://b.org"))
        #expect(index.count == 2)
    }

    @Test func `unnumbered items take their position; items without a url are skipped`() {
        let body = "## References\n\n- https://one.dev\n- just words\n- [Two](https://two.dev)\n"
        let listed = ReportCitations.sourcesList(body)
        #expect(listed.map(\.number) == [1, 2])
        #expect(listed.map(\.url) == ["https://one.dev", "https://two.dev"])
        #expect(listed[0].title == nil)
    }

    @Test func `coverage names what has happened and nothing else`() {
        #expect(ResearchBoard.coverage(sources: 0, searches: 0, angles: 0, done: 0) == "")
        #expect(ResearchBoard.coverage(sources: 1, searches: 1, angles: 0, done: 0) == "1 source · 1 search")
        #expect(ResearchBoard.coverage(sources: 15, searches: 4, angles: 3, done: 1) == "15 sources · 4 searches · 1 of 3 angles done")
    }

    @Test func `an angle is searching under a bare query and reading once pages land`() {
        let board = ResearchBoard.fold([source("q1", query: "a"), source("s1", url: "https://a.dev"), source("q2", query: "b")])
        #expect(board.angles[0].activity == .searching)
        let reading = ResearchBoard.fold([source("q1", query: "a"), source("s1", url: "https://a.dev")])
        #expect(reading.angles[0].activity == .reading)
        #expect(ResearchAngle(agentId: "x", label: "", queries: []).activity == nil)
    }
}
