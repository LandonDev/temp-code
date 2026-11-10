import Foundation

/// The numbers of the change judge (docs/computer-protocol.md §7). The Task benchmark tunes these.
public struct ChangeRule: Equatable, Sendable {
    /// Cell size in frame pixels; a 256 px frame is about 32 cells across.
    public var cell: Int
    /// Dirty area under this share of the frame never counts (a caret is about 0.008%).
    public var minArea: Double
    /// This many dirty cells or more always count.
    public var largeCells: Int
    /// A small frame counts with at least this many cells that are not ambient.
    public var minCells: Int
    /// A cell dirty in this many small frames within `windowMs` is ambient.
    public var ambientHits: Int
    public var windowMs: Double
    /// With no dirty rects, a cell whose mean luma moved more than this is dirty.
    public var lumaDelta: Int

    public init(cell: Int, minArea: Double, largeCells: Int, minCells: Int, ambientHits: Int, windowMs: Double, lumaDelta: Int) {
        self.cell = cell
        self.minArea = minArea
        self.largeCells = largeCells
        self.minCells = minCells
        self.ambientHits = ambientHits
        self.windowMs = windowMs
        self.lumaDelta = lumaDelta
    }

    public static let standard = ChangeRule(
        cell: 8, minArea: 0.0005, largeCells: 8, minCells: 2, ambientHits: 3, windowMs: 2_000, lumaDelta: 6
    )
}

/// One watch-stream sample, as the judge reads it.
public struct WatchFrame: Sendable {
    public enum Status: Sendable { case complete, idle, other }

    public var status: Status
    public var width: Int
    public var height: Int
    /// `SCStreamFrameInfo.dirtyRects` in frame pixels; nil when the attachment is missing.
    public var dirty: [CGRect]?
    /// The frame's luma averaged over cells. Without dirty rects it says which cells changed;
    /// with them it confirms them: a dirty cell whose luma did not move is not a change (a covered
    /// window's frames are all dirty, whole, whether anything changed or not).
    public var luma: LumaGrid?
    public var atMs: Double

    public init(status: Status, width: Int, height: Int, dirty: [CGRect]?, luma: LumaGrid?, atMs: Double) {
        self.status = status
        self.width = width
        self.height = height
        self.dirty = dirty
        self.luma = luma
        self.atMs = atMs
    }
}

/// Does this watch frame count as a change (docs/computer-protocol.md §7)? Pure.
///
/// The frame is a grid of cells. Idle frames and the baseline never count. A dirty area under
/// `minArea` never counts; `largeCells` dirty cells or more always count, however often the same
/// area repaints. In between, a frame counts when at least `minCells` of its cells are not
/// ambient, a cell being ambient once it was dirty in `ambientHits` small frames within
/// `windowMs`: a spinner counts for its first two frames, then goes quiet. A frame with both dirty
/// rects and luma keeps only the dirty cells whose luma moved more than `lumaDelta`, each with
/// the dirty area inside it: ScreenCaptureKit reports a covered window's every frame as dirty,
/// whole, so the rects alone would count a still window as changing.
///
/// `ignore` (frame pixels) is the title-bar corner, where macOS draws its sharing badge while any
/// capture runs, this watch's own included: a cell meeting it never counts (§22.8).
public struct ChangeJudge: Sendable {
    private let rule: ChangeRule
    private let ignore: CGRect?
    private var sawBaseline = false
    private var lastLuma: LumaGrid?
    /// Small frames' hit times per cell (row-major index), each within `windowMs`.
    private var hits: [Int: [Double]] = [:]

    public init(rule: ChangeRule = CaptureTuning.changeRule, ignore: CGRect? = nil) {
        self.rule = rule
        self.ignore = ignore.flatMap { $0.isEmpty ? nil : $0.standardized }
    }

    /// The cells of a `columns`-wide grid that meet `ignore`.
    private func ignored(columns: Int, rows: Int) -> Set<Int> {
        guard let ignore else { return [] }
        let size = Double(rule.cell)
        let lastColumn = min(columns - 1, Int((Double(ignore.maxX) / size).rounded(.up)) - 1)
        let lastRow = min(rows - 1, Int((Double(ignore.maxY) / size).rounded(.up)) - 1)
        let firstColumn = max(0, Int(Double(ignore.minX) / size)), firstRow = max(0, Int(Double(ignore.minY) / size))
        guard firstColumn <= lastColumn, firstRow <= lastRow else { return [] }
        var out = Set<Int>()
        for row in firstRow...lastRow {
            for column in firstColumn...lastColumn { out.insert(row * columns + column) }
        }
        return out
    }

    public mutating func observe(_ frame: WatchFrame) -> Bool {
        guard frame.status == .complete, frame.width > 0, frame.height > 0 else { return false }
        let previousLuma = lastLuma
        if let luma = frame.luma { lastLuma = luma }
        guard sawBaseline else {
            sawBaseline = true
            return false
        }
        guard let (cells, area) = dirtyCells(frame, previousLuma: previousLuma) else { return false }
        guard area / Double(frame.width * frame.height) >= rule.minArea, !cells.isEmpty else { return false }
        if cells.count >= rule.largeCells { return true }
        return judgeSmall(cells, atMs: frame.atMs)
    }

    private mutating func judgeSmall(_ cells: Set<Int>, atMs: Double) -> Bool {
        let since = atMs - rule.windowMs
        for key in Array(hits.keys) {
            let recent = hits[key]!.filter { $0 > since }
            hits[key] = recent.isEmpty ? nil : recent
        }
        var fresh = 0
        for cell in cells {
            hits[cell, default: []].append(atMs)
            if hits[cell]!.count < rule.ambientHits { fresh += 1 }
        }
        return fresh >= rule.minCells
    }

    /// The frame's dirty cells and dirty area in pixels, the ignored corner's left out; nil when the frame says nothing either way.
    private func dirtyCells(_ frame: WatchFrame, previousLuma: LumaGrid?) -> (Set<Int>, Double)? {
        let columns = (frame.width + rule.cell - 1) / rule.cell
        let rows = (frame.height + rule.cell - 1) / rule.cell
        guard let (cells, area) = allDirtyCells(frame, previousLuma: previousLuma, columns: columns, rows: rows) else { return nil }
        let corner = ignored(columns: columns, rows: rows)
        guard !corner.isEmpty, !cells.isDisjoint(with: corner) else { return (cells, area) }
        let kept = cells.subtracting(corner)
        // what the corner's cells held leaves the area too, at most a whole cell each
        let dropped = Double(cells.count - kept.count) * Double(rule.cell * rule.cell)
        return (kept, max(0, area - dropped))
    }

    private func allDirtyCells(_ frame: WatchFrame, previousLuma: LumaGrid?, columns: Int, rows: Int) -> (Set<Int>, Double)? {
        if let dirty = frame.dirty {
            let bounds = CGRect(x: 0, y: 0, width: frame.width, height: frame.height)
            // a rect wholly inside the ignored corner says nothing
            let clipped = dirty.map { $0.standardized.intersection(bounds) }.filter { !$0.isNull && $0.width > 0 && $0.height > 0 && !(ignore?.contains($0) ?? false) }
            var cells = Set<Int>()
            let size = Double(rule.cell)
            for rect in clipped {
                let firstColumn = Int(Double(rect.minX) / size), lastColumn = min(columns - 1, Int((Double(rect.maxX) / size).rounded(.up)) - 1)
                let firstRow = Int(Double(rect.minY) / size), lastRow = min(rows - 1, Int((Double(rect.maxY) / size).rounded(.up)) - 1)
                guard firstColumn <= lastColumn, firstRow <= lastRow else { continue }
                for row in firstRow...lastRow {
                    for column in firstColumn...lastColumn { cells.insert(row * columns + column) }
                }
            }
            guard let luma = frame.luma, let previous = previousLuma, previous.columns == luma.columns, previous.rows == luma.rows,
                  luma.columns == columns, luma.rows == rows
            else { return (cells, Self.unionArea(clipped)) }
            // Confirmed by luma: the dirty cells whose mean luma moved, each with its dirty area.
            var confirmed = Set<Int>(), area = 0.0
            for cell in cells where abs(Int(luma.values[cell]) - Int(previous.values[cell])) > rule.lumaDelta {
                confirmed.insert(cell)
                let box = CGRect(x: (cell % columns) * rule.cell, y: (cell / columns) * rule.cell, width: rule.cell, height: rule.cell)
                let inside = clipped.map { $0.intersection(box) }.filter { !$0.isNull && $0.width > 0 && $0.height > 0 }
                area += min(Double(box.width * box.height), Self.unionArea(inside))
            }
            return (confirmed, area)
        }
        guard let luma = frame.luma else { return nil }
        guard let previous = previousLuma, previous.columns == luma.columns, previous.rows == luma.rows else {
            // A new size: the whole frame changed.
            return (Set(0..<(luma.columns * luma.rows)), Double(frame.width * frame.height))
        }
        var cells = Set<Int>()
        for index in luma.values.indices where abs(Int(luma.values[index]) - Int(previous.values[index])) > rule.lumaDelta {
            cells.insert(index)
        }
        return (cells, Double(cells.count * rule.cell * rule.cell))
    }

    /// The area the rects cover together, by coordinate compression; past 32 rects the clipped
    /// areas are summed instead (a frame with that many is a large change either way).
    static func unionArea(_ rects: [CGRect]) -> Double {
        guard rects.count > 1 else { return rects.first.map { Double($0.width * $0.height) } ?? 0 }
        guard rects.count <= 32 else { return rects.reduce(0) { $0 + Double($1.width * $1.height) } }
        let xs = Array(Set(rects.flatMap { [Double($0.minX), Double($0.maxX)] })).sorted()
        let ys = Array(Set(rects.flatMap { [Double($0.minY), Double($0.maxY)] })).sorted()
        var area = 0.0
        for i in 0..<(xs.count - 1) {
            let midX = (xs[i] + xs[i + 1]) / 2
            for j in 0..<(ys.count - 1) {
                let midY = (ys[j] + ys[j + 1]) / 2
                if rects.contains(where: { Double($0.minX) <= midX && midX < Double($0.maxX) && Double($0.minY) <= midY && midY < Double($0.maxY) }) {
                    area += (xs[i + 1] - xs[i]) * (ys[j + 1] - ys[j])
                }
            }
        }
        return area
    }
}
