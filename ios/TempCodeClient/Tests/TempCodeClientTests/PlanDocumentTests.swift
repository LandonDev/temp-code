import Foundation
import Testing
@testable import TempCodeClient

private func plain(_ text: AttributedString) -> String { String(text.characters) }

@Suite struct PlanDocumentTests {
    @Test func `headings, paragraphs with soft breaks, code, quotes and rules`() {
        let document = PlanDocument.parse("""
        # Move the history ##
        The Mac keeps the Apple-only work.
        Everything else moves to the box.
        A hard break\\
        keeps its line.

        > quoted
        > and more

        ---
        ```sh
        restic backup
        ```
        tail
        """)
        guard document.blocks.count == 6 else {
            Issue.record("expected 6 blocks, got \(document.blocks)")
            return
        }
        guard case .heading(let level, let title) = document.blocks[0] else {
            Issue.record("no heading")
            return
        }
        #expect(level == 1 && plain(title) == "Move the history")
        guard case .paragraph(let paragraph) = document.blocks[1] else {
            Issue.record("no paragraph")
            return
        }
        #expect(plain(paragraph) == "The Mac keeps the Apple-only work. Everything else moves to the box. A hard break\nkeeps its line.")
        guard case .quote(let quote) = document.blocks[2] else {
            Issue.record("no quote")
            return
        }
        #expect(plain(quote) == "quoted and more")
        #expect(document.blocks[3] == .rule)
        #expect(document.blocks[4] == .code("restic backup", language: "sh"))
        guard case .paragraph(let tail) = document.blocks[5] else {
            Issue.record("no tail")
            return
        }
        #expect(plain(tail) == "tail")
    }

    @Test func `lists keep their nesting, ordinals and task checkboxes`() {
        let document = PlanDocument.parse("""
        ## Tasks

        - [x] Snapshot the database
        - [ ] Copy the snapshot
          - [ ] over the tunnel
            with resume
          - plain child
        1. Rehearse
        1. Cut over
           1. retire the Mac
        2. Celebrate
        """)
        guard document.blocks.count == 2, case .list(let items) = document.blocks[1] else {
            Issue.record("expected a heading and one list, got \(document.blocks)")
            return
        }
        #expect(items.map(\.depth) == [0, 0, 1, 1, 0, 0, 1, 0])
        #expect(items.map(\.checked) == [true, false, false, nil, nil, nil, nil, nil])
        #expect(items.map(\.ordered) == [false, false, false, false, true, true, true, true])
        #expect(items.map(\.number) == [nil, nil, nil, nil, 1, 2, 1, 3])
        #expect(items.map { plain($0.text) } == [
            "Snapshot the database", "Copy the snapshot", "over the tunnel with resume", "plain child",
            "Rehearse", "Cut over", "retire the Mac", "Celebrate"
        ])
    }

    @Test func `a loose ordered list keeps its count, a C# heading its hash, an unindented line its item`() {
        let document = PlanDocument.parse("1. one\n\n2. two\nstill two\n\n## Port to C# ##\n")
        guard document.blocks.count == 3, case .list(let first) = document.blocks[0], case .list(let second) = document.blocks[1], case .heading(_, let heading) = document.blocks[2] else {
            Issue.record("expected two lists and a heading, got \(document.blocks)")
            return
        }
        #expect(first.map(\.number) == [1])
        #expect(second.map(\.number) == [2])
        #expect(second.map { plain($0.text) } == ["two still two"])
        #expect(plain(heading) == "Port to C#")
    }

    @Test func `a pipe table becomes rows padded to the header with alignments`() {
        let document = PlanDocument.parse("""
        Before:

        | Host | Size | Keeps \\| drops |
        | :--- | ---: | :---: |
        | Mac | 4 GB | signing |
        | Box | 17 GB |
        not a row
        """)
        guard document.blocks.count == 3, case .table(let table) = document.blocks[1] else {
            Issue.record("expected paragraph, table, paragraph; got \(document.blocks)")
            return
        }
        #expect(table.header.map(plain) == ["Host", "Size", "Keeps | drops"])
        #expect(table.alignments == [.leading, .trailing, .center])
        #expect(table.rows.map { $0.map(plain) } == [["Mac", "4 GB", "signing"], ["Box", "17 GB", ""]])
        guard case .paragraph(let after) = document.blocks[2] else {
            Issue.record("no trailing paragraph")
            return
        }
        #expect(plain(after) == "not a row")
    }

    @Test func `a lone pipe line without a separator stays a paragraph and empty text is empty`() {
        let document = PlanDocument.parse("| just | text |\nmore\n")
        guard document.blocks.count == 1, case .paragraph(let text) = document.blocks[0] else {
            Issue.record("expected one paragraph, got \(document.blocks)")
            return
        }
        #expect(plain(text) == "| just | text | more")
        #expect(PlanDocument.parse("").isEmpty)
        #expect(PlanDocument.parse("\n\n  \n").isEmpty)
    }

    @Test func `an unclosed fence is code to the end and the hash tracks the text`() {
        let document = PlanDocument.parse("```\nlet x = 1\n")
        #expect(document.blocks == [.code("let x = 1", language: nil)])
        #expect(document.textHash == "```\nlet x = 1\n".hashValue)
        #expect(PlanDocument.parse("a").textHash != PlanDocument.parse("b").textHash)
    }

    @Test func `render parses the same document off the caller`() async {
        let text = "# A\n\n- [ ] b\n"
        let rendered = await PlanDocument.render(text)
        #expect(rendered == PlanDocument.parse(text))
    }
}
