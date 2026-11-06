import Testing
@testable import TempCodeClient

@Suite struct FlowRowsTests {
    private func sizes(_ widths: [Double], height: Double = 28) -> [FlowRows.Size] {
        widths.map { FlowRows.Size(width: $0, height: height) }
    }

    @Test func `as many on a line as fit, 8 pt apart, the next under it`() {
        // The capped card on a phone: Route automatically, then Continue on another model and Retry.
        let placed = FlowRows.place(sizes([160, 210, 60]), width: 300, spacing: 8, lineSpacing: 8)
        #expect(placed.lines == [0, 1, 1])
        #expect(placed.xs == [0, 0, 218])
        #expect(placed.ys == [0, 36, 36])
        #expect(placed.size == FlowRows.Size(width: 278, height: 64))
    }

    @Test func `all on one line when they fit, exactly at the edge included`() {
        let placed = FlowRows.place(sizes([100, 100, 84]), width: 300, spacing: 8, lineSpacing: 8)
        #expect(placed.lines == [0, 0, 0])
        #expect(placed.xs == [0, 108, 216])
        #expect(placed.size.width == 300)
        #expect(FlowRows.place(sizes([100, 100, 84]), width: nil, spacing: 8, lineSpacing: 8).lines == [0, 0, 0], "an unbounded width is one line")
    }

    @Test func `an item wider than the width sits alone; large text is one per line`() {
        let placed = FlowRows.place(sizes([320, 40, 340], height: 44), width: 300, spacing: 8, lineSpacing: 8)
        #expect(placed.lines == [0, 1, 2])
        #expect(placed.xs == [0, 0, 0])
        #expect(placed.size.height == 3 * 44 + 2 * 8)
    }

    @Test func `a line is as tall as its tallest item`() {
        let placed = FlowRows.place([.init(width: 50, height: 20), .init(width: 50, height: 30), .init(width: 250, height: 10)], width: 200, spacing: 8, lineSpacing: 4)
        #expect(placed.ys == [0, 0, 34])
        #expect(placed.size.height == 44)
        #expect(FlowRows.place([], width: 200, spacing: 8, lineSpacing: 4).size == .init(width: 0, height: 0))
    }
}
