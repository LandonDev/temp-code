import Testing
@testable import TempCodeClient

@Suite struct MarkdownBlocksTests {
    @Test func `code, headings, lists, quotes and rules each get their own block`() {
        let text = """
        # Title
        A paragraph with **bold**
        that continues.

        - one
        - two
          more of two
        1. first
        2. second

        > quoted

        ---
        ```swift
        let x = 1

        print(x)
        ```
        tail
        """
        let blocks = MarkdownBlocks.split(text)
        #expect(blocks == [
            .heading(1, "Title"),
            .paragraph("A paragraph with **bold**\nthat continues."),
            .list(["one", "two\nmore of two"], ordered: false),
            .list(["first", "second"], ordered: true),
            .quote("quoted"),
            .rule,
            .code("let x = 1\n\nprint(x)", language: "swift"),
            .paragraph("tail")
        ])
    }

    @Test func `an unclosed fence still becomes code and inline markdown parses`() {
        #expect(MarkdownBlocks.split("```\nraw") == [.code("raw", language: nil)])
        #expect(String(MarkdownBlocks.inline("a **b** c").characters) == "a b c")
        #expect(String(MarkdownBlocks.inline("not *closed").characters).contains("closed"))
    }

    @Test func `a pipe table is one block with every row padded to the header`() {
        let text = """
        Before

        | Name | Count |
        | --- | ---: |
        | a | 1 |
        | b \\| c |
        after
        """
        #expect(MarkdownBlocks.split(text) == [
            .paragraph("Before"),
            .table([["Name", "Count"], ["a", "1"], ["b | c", ""]]),
            .paragraph("after")
        ])
        // A lone pipe row with no separator under it stays a paragraph.
        #expect(MarkdownBlocks.split("| just | text |") == [.paragraph("| just | text |")])
    }
}
