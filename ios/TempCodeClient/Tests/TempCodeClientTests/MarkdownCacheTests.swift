import Foundation
import Testing
@testable import TempCodeClient

@Suite struct MarkdownCacheTests {
    @Test func `parse splits blocks and resolves inline markdown`() {
        let document = MarkdownDocument.parse("# Title\n\npara **bold** here\n\n```swift\nlet x = 1\n```\n\n- one\n- two\n")
        #expect(document.blocks.count == 4)
        guard case .heading(let level, let heading) = document.blocks[0], case .paragraph(let paragraph) = document.blocks[1], case .code(let code, let language) = document.blocks[2], case .list(let items, let ordered) = document.blocks[3] else {
            Issue.record("shape \(document.blocks)")
            return
        }
        #expect(level == 1)
        #expect(String(heading.characters) == "Title")
        #expect(String(paragraph.characters) == "para bold here")
        #expect(paragraph.runs.contains { $0.inlinePresentationIntent?.contains(.stronglyEmphasized) == true })
        #expect(code == "let x = 1" && language == "swift")
        #expect(items.map { String($0.characters) } == ["one", "two"] && !ordered)
        #expect(document.textHash == "# Title\n\npara **bold** here\n\n```swift\nlet x = 1\n```\n\n- one\n- two\n".hashValue)
    }

    @MainActor @Test func `a short row parses on the spot once and a hit is free`() {
        let cache = MarkdownCache()
        let first = cache.document(seq: 1, text: "**a**")
        #expect(first?.textHash == "**a**".hashValue)
        #expect(cache.parses == 1)
        #expect(cache.document(seq: 1, text: "**a**") == first)
        #expect(cache.parses == 1)
        #expect(cache.document(seq: 1, text: "**a** b")?.textHash == "**a** b".hashValue)
        #expect(cache.parses == 2)
    }

    @MainActor @Test func `a long row misses once, then hits, and a changed row serves its last parse until the next lands`() async {
        let cache = MarkdownCache(syncLimit: 0)
        #expect(cache.document(seq: 1, text: "**a**") == nil)
        let first = await cache.render(seq: 1, text: "**a**")
        #expect(first.textHash == "**a**".hashValue)
        let parsesAfterFirst = cache.parses
        #expect(parsesAfterFirst >= 1)
        #expect(cache.document(seq: 1, text: "**a**") == first)
        #expect(cache.parses == parsesAfterFirst)
        // A streaming row: the stale document shows while the new text parses.
        #expect(cache.document(seq: 1, text: "**a** b") == first)
        let second = await cache.render(seq: 1, text: "**a** b")
        #expect(second.textHash == "**a** b".hashValue)
        #expect(cache.document(seq: 1, text: "**a** b") == second)
        #expect(cache.document(seq: 2, text: "other") == nil)
        cache.clear()
        #expect(cache.document(seq: 1, text: "**a** b") == nil)
    }

    @MainActor @Test func `the cache stays bounded`() async {
        let cache = MarkdownCache(limit: 8, syncLimit: 0)
        for seq in 0..<12 { await cache.render(seq: seq, text: "row \(seq)") }
        #expect(cache.document(seq: 11, text: "row 11") != nil)
        #expect(cache.document(seq: 0, text: "row 0") == nil)
        let sync = MarkdownCache(limit: 8)
        for seq in 0..<12 { _ = sync.document(seq: seq, text: "row \(seq)") }
        #expect(sync.document(seq: 11, text: "row 11") != nil)
    }
}
