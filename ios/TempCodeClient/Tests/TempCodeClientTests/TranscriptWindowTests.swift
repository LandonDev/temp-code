import Testing
@testable import TempCodeClient

@Suite struct TranscriptWindowGrowthTests {
    @Test func `the window grows while the reader is still rows from its top, by a page of held rows`() {
        // The window starts at row 400 of the list.
        #expect(TranscriptWindow.reaches(index: 400, start: 400))
        #expect(TranscriptWindow.reaches(index: 424, start: 400))
        #expect(!TranscriptWindow.reaches(index: 425, start: 400))
        #expect(!TranscriptWindow.reaches(index: 399, start: 400), "a row above the window is not the window's")
        #expect(TranscriptWindow.grown(shown: 75, above: 400) == 225)
        #expect(TranscriptWindow.grown(shown: 225, above: 40) == 265, "every row held, when fewer than a page are")
        #expect(TranscriptWindow.grown(shown: 265, above: 0) == 265)
        #expect(TranscriptWindow.lookAhead < TranscriptWindow.cold)
    }

    @Test func `older rows are asked for while a page of held rows still lies above the window`() {
        #expect(!TranscriptWindow.asksOlder(above: 150, moreBefore: true, loading: false))
        #expect(TranscriptWindow.asksOlder(above: 149, moreBefore: true, loading: false))
        #expect(TranscriptWindow.asksOlder(above: 0, moreBefore: true, loading: false))
        #expect(!TranscriptWindow.asksOlder(above: 0, moreBefore: false, loading: false))
        #expect(!TranscriptWindow.asksOlder(above: 0, moreBefore: true, loading: true))
    }

    @Test func `rows that joined above move the list's bounds by what the anchor moved, or not at all`() {
        #expect(TranscriptWindow.correction(anchorTopBefore: 1_200, after: 9_640) == 8_440)
        #expect(TranscriptWindow.correction(anchorTopBefore: 1_200, after: 1_200.3) == nil)
        #expect(TranscriptWindow.correction(anchorTopBefore: 1_200, after: 1_100) == -100)
    }
}
