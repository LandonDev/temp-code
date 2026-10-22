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
        #expect(ResearchBoard.coverage(sources: 15, searches: 4, angles: 3, done: 1) == "15 sources, 4 searches, 1 of 3 angles done")
    }

    @Test func `an angle is searching under a bare query and reading once pages land`() {
        let board = ResearchBoard.fold([source("q1", query: "a"), source("s1", url: "https://a.dev"), source("q2", query: "b")])
        #expect(board.angles[0].activity == .searching)
        let reading = ResearchBoard.fold([source("q1", query: "a"), source("s1", url: "https://a.dev")])
        #expect(reading.angles[0].activity == .reading)
        #expect(ResearchAngle(agentId: "x", label: "", queries: []).activity == nil)
    }

    @Test func `decorate links every marker by scheme and leaves inline code and links alone`() {
        let document = MarkdownDocument.parse("GRDB maps rows [1] and `rows[0]` is an index; see [the docs](https://x.dev) too [9].")
        let citations = [1: Citation(number: 1, url: "https://github.com/groue/GRDB.swift", title: "GRDB")]
        let decorated = ReportCitations.decorate(document, citations: citations)
        guard case .paragraph(let text) = decorated.blocks[0] else { Issue.record("not a paragraph"); return }
        let plain = String(text.characters)
        #expect(plain == "GRDB maps rows \u{2009}1 and rows[0] is an index; see the docs too \u{2009}9.")
        let links = text.runs.compactMap { $0.link }.map(\.absoluteString)
        #expect(links == ["tempcode-cite://1", "https://x.dev", "tempcode-cite-missing://9"], "in document order")
        #expect(decorated.textHash == document.textHash)
    }

    @Test func `a marker naming two numbers becomes two linked runs with a comma between`() {
        let document = MarkdownDocument.parse("Both agree [2, 5].")
        let citations = [2: Citation(number: 2, url: "https://two.dev"), 5: Citation(number: 5, url: "https://five.dev")]
        guard case .paragraph(let text) = ReportCitations.decorate(document, citations: citations).blocks[0] else { Issue.record("not a paragraph"); return }
        #expect(String(text.characters) == "Both agree \u{2009}2,5.")
        let linked = text.runs.filter { $0.link != nil }.map { (String(text[$0.range].characters), $0.link?.host()) }
        #expect(linked.map(\.0) == ["2", "5"])
        #expect(linked.map(\.1) == ["2", "5"])
    }

    @Test func `decorate reaches headings, list items and quotes and passes code and rules through`() {
        let document = MarkdownDocument.parse("## Findings [1]\n\n- One [1]\n- Two\n\n> Quoted [1]\n\n---\n\n```\nrows[1]\n```\n")
        let decorated = ReportCitations.decorate(document, citations: [1: Citation(number: 1, url: "https://one.dev")])
        func links(_ text: AttributedString) -> [String] { text.runs.compactMap { $0.link?.absoluteString } }
        guard case .heading(2, let heading) = decorated.blocks[0], case .list(let items, false) = decorated.blocks[1],
              case .quote(let quote) = decorated.blocks[2] else { Issue.record("unexpected blocks \(decorated.blocks)"); return }
        #expect(links(heading) == ["tempcode-cite://1"])
        #expect(links(items[0]) == ["tempcode-cite://1"])
        #expect(links(items[1]).isEmpty)
        #expect(links(quote) == ["tempcode-cite://1"])
        #expect(decorated.blocks[3] == .rule)
        #expect(decorated.blocks[4] == .code("rows[1]", language: nil))
    }

    @Test func `pieces drops the title's H1, swaps the matching sources list and groups the rest`() {
        let body = "# SQLite\n\nIntro.\n\n## Findings\n\n- A [1]\n\n## Sources\n\n1. [A](https://a.dev)\n2. [B](https://b.dev)\n\nAfter.\n"
        let listed = ReportCitations.sourcesList(body)
        let pieces = ReportLayout.pieces(MarkdownDocument.parse(body).blocks, title: "SQLite", listed: listed)
        #expect(pieces.count == 3)
        guard case .blocks(let head) = pieces[0], case .sources(let rows) = pieces[1], case .blocks(let tail) = pieces[2] else { Issue.record("unexpected pieces \(pieces)"); return }
        #expect(head.count == 4)
        if case .paragraph(let intro) = head[0] { #expect(String(intro.characters) == "Intro.") } else { Issue.record("the H1 stayed") }
        #expect(rows == listed)
        #expect(tail.count == 1)
    }

    @Test func `pieces keeps a mismatched list as blocks and the H1 when it is not the title`() {
        let body = "# Another title\n\n## Sources\n\n- [A](https://a.dev)\n- [B](https://b.dev)\n- just words\n"
        let listed = ReportCitations.sourcesList(body)
        #expect(listed.count == 2)
        let pieces = ReportLayout.pieces(MarkdownDocument.parse(body).blocks, title: "SQLite", listed: listed)
        #expect(pieces.count == 1)
        guard case .blocks(let blocks) = pieces[0] else { Issue.record("swapped a mismatched list"); return }
        #expect(blocks.count == 3)
        #expect(blocks[0] == .heading(1, MarkdownBlocks.inline("Another title")))
    }
}
