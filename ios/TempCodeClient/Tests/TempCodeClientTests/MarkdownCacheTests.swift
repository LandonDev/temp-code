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

    @MainActor @Test func `a long row misses once, then hits, and a changed row waits for its own parse`() async {
        let cache = MarkdownCache(syncLimit: 0)
        #expect(cache.document(seq: 1, text: "**a**") == nil)
        let first = await cache.render(seq: 1, text: "**a**")
        #expect(first.textHash == "**a**".hashValue)
        let parsesAfterFirst = cache.parses
        #expect(parsesAfterFirst >= 1)
        #expect(cache.document(seq: 1, text: "**a**") == first)
        #expect(cache.parses == parsesAfterFirst)
        // Each text version waits for its own parse.
        #expect(cache.document(seq: 1, text: "**a** b") == nil)
        let second = await cache.render(seq: 1, text: "**a** b")
        #expect(second.textHash == "**a** b".hashValue)
        #expect(cache.document(seq: 1, text: "**a** b") == second)
        #expect(cache.document(seq: 2, text: "other") == nil)
        cache.clear()
        #expect(cache.document(seq: 1, text: "**a** b") == nil)
    }

    @MainActor @Test func `equal seqs on two threads and two hosts never share long markdown`() async {
        let cache = MarkdownCache(syncLimit: 0)
        let scopes = [MarkdownScope(environmentId: "mac", sessionId: "a"), MarkdownScope(environmentId: "box", sessionId: "a"), MarkdownScope(environmentId: "mac", sessionId: "b")]
        for (index, scope) in scopes.enumerated() {
            #expect(cache.document(scope: scope, seq: 9, text: "text \(index)") == nil)
            let document = await cache.render(scope: scope, seq: 9, text: "text \(index)")
            #expect(document.textHash == "text \(index)".hashValue)
        }
        for (index, scope) in scopes.enumerated() {
            #expect(cache.document(scope: scope, seq: 9, text: "text \(index)")?.textHash == "text \(index)".hashValue)
        }
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

    @MainActor @Test func `a streaming row re-parses only the blocks that changed`() {
        let cache = MarkdownCache()
        let first = cache.streamingDocument(seq: 1, text: "One **a**\n\nTwo")
        #expect(first.blocks.count == 2)
        #expect(cache.streamingParses == 2)
        // One more paragraph: the two before keep their render.
        let second = cache.streamingDocument(seq: 1, text: "One **a**\n\nTwo\n\nThr")
        #expect(second.blocks.count == 3)
        #expect(cache.streamingParses == 3)
        #expect(second.blocks[0] == first.blocks[0] && second.blocks[1] == first.blocks[1])
        // The last block grows: that one block again.
        let third = cache.streamingDocument(seq: 1, text: "One **a**\n\nTwo\n\nThree")
        #expect(cache.streamingParses == 4)
        guard case .paragraph(let tail) = third.blocks[2] else {
            Issue.record("shape \(third.blocks)")
            return
        }
        #expect(String(tail.characters) == "Three")
        // A change inside the first paragraph re-parses from there.
        let edited = cache.streamingDocument(seq: 1, text: "One **b**\n\nTwo\n\nThree")
        #expect(edited.blocks.count == 3)
        #expect(cache.streamingParses == 7)
        // The same text again parses nothing.
        _ = cache.streamingDocument(seq: 1, text: "One **b**\n\nTwo\n\nThree")
        #expect(cache.streamingParses == 7)
        #expect(edited.textHash == "One **b**\n\nTwo\n\nThree".hashValue)
    }

    @MainActor @Test func `the settled parse clears the streaming slot and rows never share one`() {
        let cache = MarkdownCache()
        _ = cache.streamingDocument(seq: 4, text: "a")
        _ = cache.streamingDocument(seq: 5, text: "b")
        #expect(cache.hasStreamingSlot(seq: 4) && cache.hasStreamingSlot(seq: 5))
        _ = cache.document(seq: 4, text: "a **done**")
        #expect(!cache.hasStreamingSlot(seq: 4))
        #expect(cache.hasStreamingSlot(seq: 5))
        let other = MarkdownScope(environmentId: "box", sessionId: "s")
        _ = cache.streamingDocument(scope: other, seq: 5, text: "c **d**")
        #expect(cache.streamingParses == 3)
        _ = cache.streamingDocument(seq: 5, text: "b")
        #expect(cache.streamingParses == 3)
        cache.clear()
        #expect(!cache.hasStreamingSlot(seq: 5))
    }

    @MainActor @Test func `a long row that was streaming keeps its render until the settled parse lands`() async {
        let cache = MarkdownCache(syncLimit: 0)
        _ = cache.streamingDocument(seq: 7, text: "**a**\n\nb")
        // The settled call for a long text parses in the background; meanwhile
        // the streaming render stands in, styled, instead of nil (plain text).
        let standIn = cache.document(seq: 7, text: "**a**\n\nb done")
        #expect(standIn?.blocks.count == 2)
        #expect(standIn?.textHash == "**a**\n\nb done".hashValue)
        #expect(cache.hasStreamingSlot(seq: 7))
        let settled = await cache.render(seq: 7, text: "**a**\n\nb done")
        #expect(settled.blocks.count == 2)
        #expect(!cache.hasStreamingSlot(seq: 7))
        // A row that never streamed still waits for its parse.
        #expect(cache.document(seq: 8, text: "**c**") == nil)
    }

    @MainActor @Test func `a huge streaming paragraph stays plain until the next block`() {
        let cache = MarkdownCache()
        let huge = String(repeating: "**x** ", count: 2_000)
        let document = cache.streamingDocument(seq: 1, text: huge)
        guard case .paragraph(let plain) = document.blocks[0] else {
            Issue.record("shape \(document.blocks)")
            return
        }
        #expect(!plain.runs.contains { $0.inlinePresentationIntent?.contains(.stronglyEmphasized) == true })
        #expect(String(plain.characters) == huge)
        let next = cache.streamingDocument(seq: 1, text: huge + "\n\n**y**")
        guard case .paragraph(let small) = next.blocks[1] else {
            Issue.record("shape \(next.blocks)")
            return
        }
        #expect(small.runs.contains { $0.inlinePresentationIntent?.contains(.stronglyEmphasized) == true })
    }
}
