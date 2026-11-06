import Foundation
import Testing
@testable import TempCodeClient

/// The desktop's remend on the phone: an open span mid-stream is closed at
/// the end, so no raw mark shows and the plain text only grows.
@Suite struct MarkdownCloseTests {
    private func plain(_ text: String) -> String {
        String(MarkdownBlocks.inline(MarkdownClose.inline(text)).characters)
    }

    @Test func `each open span is closed at the end`() {
        #expect(MarkdownClose.inline("Run **very") == "Run **very**")
        #expect(MarkdownClose.inline("Run *very") == "Run *very*")
        #expect(MarkdownClose.inline("Run _very") == "Run _very_")
        #expect(MarkdownClose.inline("Run ~~very") == "Run ~~very~~")
        #expect(MarkdownClose.inline("Run `bun te") == "Run `bun te`")
        #expect(MarkdownClose.inline("See [the do") == "See [the do]()")
        #expect(MarkdownClose.inline("See [the docs](https://ex") == "See [the docs](https://ex)")
        #expect(MarkdownClose.inline("***both") == "***both***")
    }

    @Test func `the closer goes before trailing whitespace, where it can close`() {
        #expect(MarkdownClose.inline("Run **very ") == "Run **very** ")
        #expect(plain("Run **very ") == "Run very ")
    }

    @Test func `nested spans close innermost first`() {
        #expect(MarkdownClose.inline("a **b _c") == "a **b _c_**")
        #expect(MarkdownClose.inline("[**bold") == "[**bold**]()")
        #expect(MarkdownClose.inline("[a `b") == "[a `b`]()")
    }

    @Test func `closed spans, literals and code are left as they are`() {
        for text in ["Run **very** fast", "snake_case_name", "2 * 3 = 6", "a ~ b", "`a ** b`", "plain words", "\\*not\\*", "array[0] here"] {
            #expect(MarkdownClose.inline(text) == text, "\(text)")
        }
        // Inside a code span nothing opens.
        #expect(MarkdownClose.inline("`a **b") == "`a **b`")
    }

    @Test func `a mark with nothing after it yet is left out`() {
        #expect(MarkdownClose.inline("Run **") == "Run")
        #expect(MarkdownClose.inline("Run ** ") == "Run")
        #expect(MarkdownClose.inline("Run `") == "Run")
        #expect(MarkdownClose.inline("See [") == "See")
        #expect(MarkdownClose.inline("a **b _") == "a **b**")
    }

    @Test func `the plain text of every step only grows as a span streams`() {
        let final = "Run **very important** checks, then `bun test --watch` and [the docs](https://example.com/a) ~~twice~~ _now_."
        var shown = ""
        var steps: [String] = []
        for word in final.split(separator: " ", omittingEmptySubsequences: false) {
            shown += (shown.isEmpty ? "" : " ") + word
            steps.append(shown + " ")
        }
        var last = ""
        for step in steps.dropLast() {
            let text = plain(step)
            #expect(text.hasPrefix(last.trimmingCharacters(in: .whitespaces)), "\(last) → \(text)")
            for mark in ["**", "`", "~~", "]("] { #expect(!text.contains(mark), "raw \(mark) in \(text)") }
            last = text
        }
    }

    @MainActor @Test func `only a streaming row's last block is closed`() {
        let cache = MarkdownCache()
        let live = cache.streamingDocument(seq: 1, text: "One **open\n\nTwo **also")
        guard case .paragraph(let first) = live.blocks[0], case .paragraph(let second) = live.blocks[1] else {
            Issue.record("two paragraphs")
            return
        }
        #expect(String(first.characters) == "One **open")
        #expect(String(second.characters) == "Two also")
        // Settled, nothing is closed: the same document as the whole parse.
        let settled = cache.streamingDocument(seq: 1, text: "One **open\n\nTwo **also", settled: true)
        #expect(settled == MarkdownDocument.parse("One **open\n\nTwo **also"))
    }

    @Test func `a list's last item and a table's last row are closed`() {
        guard case .list(let items, _) = MarkdownClose.block(.list(["a **b", "c **d"], ordered: false)) else { return }
        #expect(items == ["a **b", "c **d**"])
        guard case .table(let rows) = MarkdownClose.block(.table([["h"], ["x **y"]])) else { return }
        #expect(rows == [["h"], ["x **y**"]])
    }
}
