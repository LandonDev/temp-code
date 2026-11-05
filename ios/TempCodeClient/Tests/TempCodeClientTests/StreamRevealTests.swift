import Testing
@testable import TempCodeClient

@Suite struct StreamRevealTests {
    private func armed() -> StreamRevealLedger {
        var ledger = StreamRevealLedger()
        ledger.arm()
        return ledger
    }

    @Test func `text held before arming is shown, never faded`() {
        var ledger = StreamRevealLedger()
        #expect(ledger.segments(for: "Held when the row mounted.", at: 10) == [RevealSegment(from: 0, to: 26, bornAt: nil)])
        ledger.arm()
        let runs = ledger.segments(for: "Held when the row mounted. New", at: 10.05)
        #expect(runs == [RevealSegment(from: 0, to: 26, bornAt: nil), RevealSegment(from: 26, to: 30, bornAt: 10.05)])
    }

    @Test func `each step is a run of its own while it is young, then joins the prefix`() {
        var ledger = armed()
        _ = ledger.segments(for: "One ", at: 0)
        _ = ledger.segments(for: "One two ", at: 0.1)
        let runs = ledger.segments(for: "One two three", at: 0.2)
        #expect(runs.map(\.bornAt) == [0, 0.1, 0.2])
        #expect(runs.map(\.from) == [0, 4, 8])
        // At 0.55 s the first two are past the fade: one settled prefix, the third still young.
        #expect(ledger.segments(for: "One two three", at: 0.55) == [RevealSegment(from: 0, to: 8, bornAt: nil), RevealSegment(from: 8, to: 13, bornAt: 0.2)])
        #expect(ledger.fading(at: 0.55))
        #expect(!ledger.fading(at: 0.61))
    }

    @Test func `at most four young runs: older young steps join the prefix`() {
        var ledger = armed()
        var text = ""
        for (i, word) in ["a ", "b ", "c ", "d ", "e ", "f "].enumerated() {
            text += word
            _ = ledger.segments(for: text, at: Double(i) * 0.05)
        }
        let runs = ledger.segments(for: text, at: 0.26)
        #expect(runs.filter(\.young).count == StreamRevealLedger.maxYoung)
        #expect(runs.first == RevealSegment(from: 0, to: 4, bornAt: nil))
        #expect(runs.last?.to == text.count)
    }

    @Test func `a block reparsed into another text fades in whole`() {
        var ledger = armed()
        _ = ledger.segments(for: "A paragraph that grows past the ledger key", at: 0)
        _ = ledger.segments(for: "A paragraph that grows past the ledger key", at: 1)
        // The same block now reads differently from its first character on: a new ledger.
        let runs = ledger.segments(for: "Heading: A paragraph that grew", at: 1.1)
        #expect(runs == [RevealSegment(from: 0, to: 30, bornAt: 1.1)])
    }

    @Test func `a short block grows into the longer key and keeps its steps`() {
        var ledger = armed()
        _ = ledger.segments(for: "Short", at: 0)
        let runs = ledger.segments(for: "Short, and then a good deal longer than the key", at: 1)
        #expect(runs == [RevealSegment(from: 0, to: 5, bornAt: nil), RevealSegment(from: 5, to: 47, bornAt: 1)])
    }

    @Test func `runs never pass the text they are drawn on`() {
        var ledger = armed()
        let long = "Two blocks that share their first 32 characters, the longer one"
        _ = ledger.segments(for: String(long.prefix(40)), at: 0)
        _ = ledger.segments(for: long, at: 0.1)
        // A shorter text under the same key: every run inside its 40 characters.
        let runs = ledger.segments(for: String(long.prefix(40)), at: 0.15)
        #expect(runs.allSatisfy { $0.from >= 0 && $0.to <= 40 && $0.from < $0.to })
    }

    @Test func `reduced motion builds no young runs, the steps are still noted`() {
        var ledger = armed()
        #expect(ledger.segments(for: "One ", at: 0, reduced: true) == [RevealSegment(from: 0, to: 4, bornAt: nil)])
        #expect(ledger.segments(for: "One two", at: 0.1, reduced: true) == [RevealSegment(from: 0, to: 7, bornAt: nil)])
        #expect(ledger.lastStepAt == 0.1)
    }

    @Test func `the opacity is linear over the fade`() {
        let run = RevealSegment(from: 0, to: 3, bornAt: 1)
        #expect(run.opacity(at: 1) == 0)
        #expect(abs(run.opacity(at: 1.2) - 0.5) < 1e-9)
        #expect(run.opacity(at: 2) == 1)
        #expect(RevealSegment(from: 0, to: 3, bornAt: nil).opacity(at: 0) == 1)
    }

    @Test func `a list item takes the runs inside its own range`() {
        let runs = [RevealSegment(from: 0, to: 6, bornAt: nil), RevealSegment(from: 6, to: 11, bornAt: 2)]
        // Items "first" (0..<5) and "second" (6..<12) joined by a newline.
        #expect(RevealSegment.slice(runs, from: 0, to: 5) == [RevealSegment(from: 0, to: 5, bornAt: nil)])
        #expect(RevealSegment.slice(runs, from: 6, to: 12) == [RevealSegment(from: 0, to: 5, bornAt: 2)])
    }
}

@MainActor
@Suite struct RevealDrainTests {
    @Test func `a turn reveals while any of its rows does`() {
        let drain = RevealDrain()
        #expect(!drain.revealing(turn: 1))
        drain.report(turn: 1, row: 10, on: true)
        drain.report(turn: 1, row: 11, on: true)
        drain.report(turn: 1, row: 10, on: false)
        #expect(drain.revealing(turn: 1))
        drain.report(turn: 1, row: 11, on: false)
        #expect(!drain.revealing(turn: 1))
    }

    @Test func `turns are apart, and a repeated report changes nothing`() {
        let drain = RevealDrain()
        drain.report(turn: 1, row: 10, on: true)
        drain.report(turn: 1, row: 10, on: true)
        drain.report(turn: 2, row: 20, on: false)
        #expect(drain.revealing(turn: 1))
        #expect(!drain.revealing(turn: 2))
        drain.report(turn: 1, row: 10, on: false)
        #expect(!drain.revealing(turn: 1))
    }
}

@MainActor
@Suite struct MarkdownSettleTests {
    nonisolated static let texts = [
        "Plain prose with **bold**, `code` and a [link](https://example.com).",
        "# A heading\n\nA paragraph.\n\n- one\n- two\n\n> a quote\n\n```swift\nlet a = 1\n```\n\n| a | b |\n| - | - |\n| 1 | 2 |",
        "1. first\n2. second with *emphasis*\n\n---\n\nThe end.",
        String(repeating: "A long paragraph with **styling** in it. ", count: 260),
    ]

    @Test(arguments: texts)
    func `the drained streaming document equals the settled parse`(text: String) {
        let cache = MarkdownCache()
        // Streamed in pieces first, as a row does, then drawn settled.
        var shown = ""
        for piece in text.split(separator: " ", omittingEmptySubsequences: false) {
            shown += shown.isEmpty ? String(piece) : " " + piece
            _ = cache.streamingDocument(seq: 7, text: shown)
        }
        #expect(cache.streamingDocument(seq: 7, text: text, settled: true) == MarkdownDocument.parse(text))
    }
}
