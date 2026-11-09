@testable import Capture
import Foundation
import Testing

/// An 800×600 pt window watched at 256 px: 256×192 frame pixels, 0.32 px a point, 32×24 cells.
private let frameWidth = 256, frameHeight = 192
private let pixelsPerPoint = 0.32
// A 24 pt spinner at (390, 290) pt sits on a cell corner: four cells, a small change.

private func rect(points x: Double, _ y: Double, _ width: Double, _ height: Double) -> CGRect {
    CGRect(x: x * pixelsPerPoint, y: y * pixelsPerPoint, width: width * pixelsPerPoint, height: height * pixelsPerPoint)
}

private func frame(_ dirty: [CGRect], at ms: Double, status: WatchFrame.Status = .complete) -> WatchFrame {
    WatchFrame(status: status, width: frameWidth, height: frameHeight, dirty: dirty, luma: nil, atMs: ms)
}

/// A judge past its baseline.
private func judge(rule: ChangeRule = .standard) -> ChangeJudge {
    var judge = ChangeJudge(rule: rule)
    _ = judge.observe(frame([], at: 0))
    return judge
}

@Suite struct ChangeJudgeTests {
    @Test func idleFramesAndTheBaselineNeverCount() {
        var judge = ChangeJudge()
        let whole = [CGRect(x: 0, y: 0, width: frameWidth, height: frameHeight)]
        #expect(judge.observe(frame(whole, at: 0)) == false, "the baseline")
        #expect(judge.observe(frame(whole, at: 100, status: .idle)) == false)
        #expect(judge.observe(frame(whole, at: 200, status: .other)) == false)
        #expect(judge.observe(frame(whole, at: 300)) == true)
    }

    @Test func aCaretNeverCountsWhereverItFalls() {
        // A 2×18 pt caret blinking every 500 ms, at offsets that cross column and row boundaries.
        for dx in stride(from: 0.0, through: 30, by: 1.5) {
            for dy in stride(from: 0.0, through: 30, by: 2.5) {
                var judge = judge()
                for blink in 1...20 {
                    #expect(judge.observe(frame([rect(points: 100 + dx, 100 + dy, 2, 18)], at: Double(blink) * 500)) == false)
                }
            }
        }
    }

    @Test func aCaretReportedAsACellTileCountsAtMostTwice() {
        for offset in [0.0, 4, 7.5] {
            var judge = judge()
            var counted = 0
            for blink in 1...20 {
                let tile = CGRect(x: 96 + offset, y: 64 + offset, width: 8, height: 8)
                if judge.observe(frame([tile], at: Double(blink) * 500)) { counted += 1 }
            }
            #expect(counted <= 2, "offset \(offset)")
        }
    }

    @Test func aSpinnerCountsTwiceThenGoesAmbient() {
        var judge = judge()
        var counted: [Int] = []
        for turn in 1...30 where judge.observe(frame([rect(points: 390, 290, 24, 24)], at: Double(turn) * 100)) {
            counted.append(turn)
        }
        #expect(counted == [1, 2])
    }

    @Test func aLargeRepaintCountsEveryFrame() {
        var judge = judge()
        for step in 1...30 {
            #expect(judge.observe(frame([rect(points: 200, 150, 400, 300)], at: Double(step) * 100)) == true)
        }
    }

    @Test func twoNewCellsBesideAnAmbientSpinnerCount() {
        var judge = judge()
        let spinner = rect(points: 390, 290, 24, 24)
        for turn in 1...10 { _ = judge.observe(frame([spinner], at: Double(turn) * 100)) }
        #expect(judge.observe(frame([spinner], at: 1_100)) == false)
        // A progress bar moving into two cells it never touched.
        #expect(judge.observe(frame([spinner, CGRect(x: 40, y: 160, width: 16, height: 4)], at: 1_200)) == true)
    }

    @Test func anAmbientCellStillForTwoSecondsCountsAgain() {
        var judge = judge()
        let spinner = rect(points: 390, 290, 24, 24)
        for turn in 1...10 { _ = judge.observe(frame([spinner], at: Double(turn) * 100)) }
        #expect(judge.observe(frame([spinner], at: 1_100)) == false)
        #expect(judge.observe(frame([spinner], at: 3_200)) == true)
    }

    @Test func dirtyRectsOutsideTheFrameAreClipped() {
        var judge = judge()
        #expect(judge.observe(frame([CGRect(x: 300, y: 300, width: 100, height: 100)], at: 100)) == false)
        #expect(judge.observe(frame([], at: 200)) == false)
    }

    @Test func overlappingRectsCountTheirUnionOnce() {
        let a = CGRect(x: 0, y: 0, width: 10, height: 10), b = CGRect(x: 5, y: 5, width: 10, height: 10)
        #expect(ChangeJudge.unionArea([a, b]) == 175)
        #expect(ChangeJudge.unionArea([a, a]) == 100)
        #expect(ChangeJudge.unionArea([]) == 0)
    }
}

/// The same scenes with no dirty rects: the luma grid alone.
@Suite struct ChangeJudgeLumaTests {
    private static let columns = frameWidth / 8, rows = frameHeight / 8

    private func grid(_ changed: Set<Int> = [], flip: Bool = false) -> LumaGrid {
        var values = [UInt8](repeating: 200, count: Self.columns * Self.rows)
        for cell in changed { values[cell] = flip ? 90 : 200 }
        return LumaGrid(columns: Self.columns, rows: Self.rows, values: values)
    }

    private func frame(_ luma: LumaGrid, at ms: Double, status: WatchFrame.Status = .complete) -> WatchFrame {
        WatchFrame(status: status, width: frameWidth, height: frameHeight, dirty: nil, luma: luma, atMs: ms)
    }

    /// The cells a rect in frame pixels touches, as the rect path counts them.
    private func cells(_ rect: CGRect) -> Set<Int> {
        var cells = Set<Int>()
        for row in Int(rect.minY / 8)...Int((rect.maxY / 8).rounded(.up)) - 1 {
            for column in Int(rect.minX / 8)...Int((rect.maxX / 8).rounded(.up)) - 1 { cells.insert(row * Self.columns + column) }
        }
        return cells
    }

    @Test func idleAndStillFramesNeverCount() {
        var judge = ChangeJudge()
        #expect(judge.observe(frame(grid(), at: 0)) == false)
        #expect(judge.observe(frame(grid(), at: 100)) == false)
        #expect(judge.observe(frame(grid([1, 2, 3], flip: true), at: 200, status: .idle)) == false)
    }

    @Test func aSpinnerCountsTwiceThenGoesAmbient() {
        var judge = ChangeJudge()
        _ = judge.observe(frame(grid(), at: 0))
        let spinner = cells(rect(points: 390, 290, 24, 24))
        var counted: [Int] = []
        for turn in 1...30 where judge.observe(frame(grid(spinner, flip: turn % 2 == 1), at: Double(turn) * 100)) {
            counted.append(turn)
        }
        #expect(counted == [1, 2])
    }

    @Test func aLargeRepaintCountsEveryFrame() {
        var judge = ChangeJudge()
        _ = judge.observe(frame(grid(), at: 0))
        let block = cells(rect(points: 200, 150, 400, 300))
        for step in 1...30 {
            #expect(judge.observe(frame(grid(block, flip: step % 2 == 1), at: Double(step) * 100)) == true)
        }
    }

    @Test func aSmallLumaChangeIsNotAChange() {
        var judge = ChangeJudge()
        _ = judge.observe(frame(grid(), at: 0))
        var values = grid().values
        for cell in 0..<50 { values[cell] = 205 }
        #expect(judge.observe(frame(LumaGrid(columns: Self.columns, rows: Self.rows, values: values), at: 100)) == false)
    }

    @Test func aNewSizeIsAChange() {
        var judge = ChangeJudge()
        _ = judge.observe(frame(grid(), at: 0))
        let wider = LumaGrid(columns: 40, rows: 24, values: [UInt8](repeating: 200, count: 960))
        #expect(judge.observe(WatchFrame(status: .complete, width: 320, height: 192, dirty: nil, luma: wider, atMs: 100)) == true)
    }
}
