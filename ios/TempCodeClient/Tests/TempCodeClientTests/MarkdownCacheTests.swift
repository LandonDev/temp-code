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
        #expect(code.text == "let x = 1" && language == "swift")
        #expect(items.map { String($0.characters) } == ["one", "two"] && !ordered)
        #expect(document.textHash == "# Title\n\npara **bold** here\n\n```swift\nlet x = 1\n```\n\n- one\n- two\n".hashValue)
    }

    @Test func `a code block's lines are counted and numbered at the parse`() {
        let one = CodeText("let x = 1")
        #expect(one.lineCount == 1 && one.numbers == "1")
        let three = CodeText("a\n\nc")
        #expect(three.lineCount == 3 && three.numbers == "1\n2\n3")
        #expect(CodeText("").lineCount == 1)
        // Within its fold a block is its own strings; past it, its first lines and their numbers.
        #expect(three.head(3).text == "a\n\nc" && three.head(3).numbers == "1\n2\n3")
        #expect(three.head(2).text == "a\n" && three.head(2).numbers == "1\n2")
        #expect(three.head(1).text == "a" && three.head(1).numbers == "1")
        let long = CodeText((1...50).map { "line \($0)" }.joined(separator: "\n"))
        let head = long.head(40)
        #expect(head.text.split(separator: "\n").count == 40 && head.text.hasSuffix("line 40"))
        #expect(head.numbers.hasSuffix("39\n40") && long.numbers.hasSuffix("49\n50"))
        // The text is the block.
        #expect(CodeText("a") == "a" && CodeText("a") != CodeText("b"))
        guard case .code(let code, _) = MarkdownDocument.renderBlock(.code("x\ny", language: nil)) else { Issue.record("not code"); return }
        #expect(code.lineCount == 2)
    }

    @Test func `prose with no inline code says so, and prose with some does not`() {
        let document = MarkdownDocument.parse("# A title\n\nplain **bold** words\n\ncall `rows()` here\n\na lone ` tick\n\n- one\n- `two`\n\n> quoted\n\n| a | `b` |\n| - | - |\n| c | d |\n")
        guard case .heading(_, let heading) = document.blocks[0], case .paragraph(let plain) = document.blocks[1], case .paragraph(let coded) = document.blocks[2],
              case .paragraph(let tick) = document.blocks[3], case .list(let items, _) = document.blocks[4], case .quote(let quote) = document.blocks[5],
              case .table(let rows) = document.blocks[6] else {
            Issue.record("shape \(document.blocks)")
            return
        }
        #expect(heading.inlineCodeFree && plain.inlineCodeFree && quote.inlineCodeFree)
        #expect(!coded.inlineCodeFree && coded.hasInlineCode)
        // A backtick that opens no code span: walked once at the parse, and free.
        #expect(tick.inlineCodeFree && !tick.hasInlineCode)
        #expect(items[0].inlineCodeFree && !items[1].inlineCodeFree)
        #expect(rows[0][0].inlineCodeFree && !rows[0][1].inlineCodeFree && rows[1][0].inlineCodeFree)
        // The mark changes no character and no intent, and a string made elsewhere carries none.
        #expect(String(plain.characters) == "plain bold words")
        #expect(plain.runs.contains { $0.inlinePresentationIntent?.contains(.stronglyEmphasized) == true })
        #expect(!MarkdownBlocks.inline("plain").inlineCodeFree)
        #expect(!AttributedString("").inlineCodeFree)
        // The streaming parse marks as the settled one does: the two documents are equal.
        #expect(MarkdownDocument.renderBlock(.paragraph("plain **bold** words")) == document.blocks[1])
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

    @MainActor @Test func `a paragraph past the streaming limit is styled from the settle's first frame, not plain then styled`() async {
        let cache = MarkdownCache()
        let huge = String(repeating: "**x** ", count: 2_000)
        _ = cache.streamingDocument(seq: 3, text: huge)
        // The settled call while its parse runs: the stand-in is the whole parse, styled.
        let standIn = cache.document(seq: 3, text: huge)
        #expect(standIn == MarkdownDocument.parse(huge))
        guard case .paragraph(let styled)? = standIn?.blocks.first else {
            Issue.record("shape")
            return
        }
        #expect(styled.runs.contains { $0.inlinePresentationIntent?.contains(.stronglyEmphasized) == true })
        let settled = await cache.render(seq: 3, text: huge)
        #expect(settled == standIn)
    }

    @MainActor @Test func `a prefetched row is ready before it mounts`() async {
        let cache = MarkdownCache(syncLimit: 0)
        cache.prefetch(seq: 9, text: "**ready**")
        cache.prefetch(seq: 9, text: "**ready**")
        let document = await cache.render(seq: 9, text: "**ready**")
        #expect(cache.isReady(seq: 9, text: "**ready**"))
        #expect(cache.document(seq: 9, text: "**ready**") == document)
        #expect(cache.parses == 1, "one parse however many asks")
        // A short text is parsed at its mount; nothing to fetch ahead.
        let short = MarkdownCache()
        short.prefetch(seq: 1, text: "a")
        #expect(short.parses == 0)
    }
}

@Suite struct MarkdownCacheEvictionTests {
    @MainActor @Test func `a document read last outlives the ones read before it, whatever their seq`() async {
        let cache = MarkdownCache(limit: 8, syncLimit: 0)
        for seq in 0..<8 { await cache.render(seq: seq, text: "row \(seq)") }
        // The reader scrolls back to the oldest row: it is the newest read.
        #expect(cache.document(seq: 0, text: "row 0") != nil)
        for seq in 8..<11 { await cache.render(seq: seq, text: "row \(seq)") }
        #expect(cache.isReady(seq: 0, text: "row 0"), "read last, kept")
        #expect(!cache.isReady(seq: 1, text: "row 1"), "read longest ago, gone")
        #expect(cache.isReady(seq: 10, text: "row 10"))
    }

    @MainActor @Test func `the documents kept stay under the cost bound`() {
        let text = String(repeating: "word ", count: 200)
        let each = MarkdownCache.cost(of: text)
        let cache = MarkdownCache(limit: 1_000, costLimit: each * 10)
        for seq in 0..<40 { _ = cache.document(seq: seq, text: text + "\(seq)") }
        #expect(cache.cost <= each * 10 + each)
        #expect(cache.isReady(seq: 39, text: text + "39"))
        #expect(!cache.isReady(seq: 0, text: text + "0"))
    }

    @MainActor @Test func `a settled text that is not held parses in place up to the limit, and waits past it`() async {
        let cache = MarkdownCache()
        let reply = String(repeating: "A **bold** claim. ", count: 300)
        #expect(reply.utf8.count > MarkdownCache.prefetchFloor && reply.utf8.count <= cache.syncLimit)
        let document = cache.document(seq: 1, text: reply)
        #expect(document != nil, "it mounts at its real height")
        #expect(document == MarkdownDocument.parse(reply))
        let long = String(repeating: "A **bold** claim. ", count: 700)
        #expect(long.utf8.count > cache.syncLimit)
        #expect(cache.document(seq: 2, text: long) == nil)
        #expect(await cache.render(seq: 2, text: long) == MarkdownDocument.parse(long))
        // A prefetch parses a middling text ahead of its mount, off the main actor.
        let ahead = MarkdownCache()
        ahead.prefetch(seq: 3, text: reply)
        let deadline = ContinuousClock.now.advanced(by: waitDeadline)
        while !ahead.isReady(seq: 3, text: reply), ContinuousClock.now < deadline { try? await Task.sleep(for: .milliseconds(2)) }
        #expect(ahead.document(seq: 3, text: reply) == MarkdownDocument.parse(reply))
        #expect(ahead.parses == 1, "the mount found it ready")
    }
}
