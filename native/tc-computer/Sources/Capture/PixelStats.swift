import Foundation

/// An image's pixels, 8 bits a channel, four channels a pixel (BGRA as Capture renders them).
public struct Bitmap: Sendable {
    public let width: Int
    public let height: Int
    public let bytesPerRow: Int
    public var bytes: [UInt8]

    public init(width: Int, height: Int, bytesPerRow: Int, bytes: [UInt8]) {
        precondition(bytesPerRow >= width * 4 && bytes.count >= bytesPerRow * height, "a bitmap holds its rows")
        self.width = width
        self.height = height
        self.bytesPerRow = bytesPerRow
        self.bytes = bytes
    }
}

/// A frame's luma averaged over square cells, row-major: the watch's change signal when the
/// compositor sends no dirty rects.
public struct LumaGrid: Equatable, Sendable {
    public let columns: Int
    public let rows: Int
    public var values: [UInt8]

    public init(columns: Int, rows: Int, values: [UInt8]) {
        precondition(values.count == columns * rows, "a value per cell")
        self.columns = columns
        self.rows = rows
        self.values = values
    }
}

/// What a shot's pixels say (docs/computer-protocol.md §6). Pure: buffers in, numbers out; the
/// CGImage entry points render into a `Bitmap` first (PixelStats+CGImage.swift).
public enum PixelStats {
    /// Every channel, alpha included, spans at most `levels`: a window the compositor has not
    /// drawn. Stops at the first pixel outside the range, so a drawn window costs almost nothing.
    public static func isBlank(_ bitmap: Bitmap, levels: Int = 3) -> Bool {
        bitmap.bytes.withUnsafeBytes { buffer in
            isBlank(rgba: buffer, width: bitmap.width, height: bitmap.height, bytesPerRow: bitmap.bytesPerRow, levels: levels)
        }
    }

    public static func isBlank(rgba: UnsafeRawBufferPointer, width: Int, height: Int, bytesPerRow: Int, levels: Int = 3) -> Bool {
        guard width > 0, height > 0 else { return true }
        var low = [Int](repeating: 255, count: 4), high = [Int](repeating: 0, count: 4)
        for y in 0..<height {
            let row = y * bytesPerRow
            for x in 0..<width {
                let pixel = row + x * 4
                for channel in 0..<4 {
                    let value = Int(rgba[pixel + channel])
                    if value < low[channel] { low[channel] = value }
                    if value > high[channel] { high[channel] = value }
                    if high[channel] - low[channel] > levels { return false }
                }
            }
        }
        return true
    }

    /// 0...1: on every 4th row, the share of pixels within 2 levels per colour channel of their
    /// right neighbour. A photograph or a busy page sits well under 0.5, a settings pane, a
    /// terminal or a document over 0.9.
    public static func flatness(_ bitmap: Bitmap) -> Double {
        bitmap.bytes.withUnsafeBytes { buffer in
            flatness(rgba: buffer, width: bitmap.width, height: bitmap.height, bytesPerRow: bitmap.bytesPerRow)
        }
    }

    public static func flatness(rgba: UnsafeRawBufferPointer, width: Int, height: Int, bytesPerRow: Int) -> Double {
        guard width > 1, height > 0 else { return 1 }
        var same = 0, total = 0
        for y in stride(from: 0, to: height, by: 4) {
            let row = y * bytesPerRow
            for x in 0..<(width - 1) {
                let left = row + x * 4, right = left + 4
                total += 1
                if abs(Int(rgba[left]) - Int(rgba[right])) <= 2,
                   abs(Int(rgba[left + 1]) - Int(rgba[right + 1])) <= 2,
                   abs(Int(rgba[left + 2]) - Int(rgba[right + 2])) <= 2 {
                    same += 1
                }
            }
        }
        return Double(same) / Double(total)
    }

    /// A hash of a buffer's pixel rows, row padding ignored: equal buffers give equal hashes, and
    /// a change of any byte gives a different one but by a 2^-64 chance. About 0.3 ms for a
    /// 960 px BGRA frame (one pass of 8-byte words).
    public static func fingerprint(plane: UnsafeRawBufferPointer, rowBytes: Int, height: Int, bytesPerRow: Int) -> UInt64 {
        var hash: UInt64 = 0xCBF2_9CE4_8422_2325 ^ UInt64(truncatingIfNeeded: rowBytes &* 31 &+ height)
        guard rowBytes > 0, height > 0, plane.count >= (height - 1) * bytesPerRow + rowBytes else { return hash }
        let words = rowBytes / 8
        for y in 0..<height {
            let row = y * bytesPerRow
            for word in 0..<words {
                hash = (hash ^ plane.loadUnaligned(fromByteOffset: row + word * 8, as: UInt64.self)) &* 0x0000_0100_0000_01B3
                hash ^= hash >> 29
            }
            for byte in (words * 8)..<rowBytes {
                hash = (hash ^ UInt64(plane[row + byte])) &* 0x0000_0100_0000_01B3
            }
        }
        return hash
    }

    /// One 8-bit plane (a 420 frame's luma) averaged over `cell`-pixel squares; edge cells
    /// average what they cover.
    public static func lumaGrid(plane: UnsafeRawBufferPointer, width: Int, height: Int, bytesPerRow: Int, cell: Int) -> LumaGrid {
        let columns = max(1, (width + cell - 1) / cell), rows = max(1, (height + cell - 1) / cell)
        var sums = [Int](repeating: 0, count: columns * rows), counts = [Int](repeating: 0, count: columns * rows)
        for y in 0..<height {
            let row = y * bytesPerRow, cellRow = (y / cell) * columns
            for x in 0..<width {
                sums[cellRow + x / cell] += Int(plane[row + x])
                counts[cellRow + x / cell] += 1
            }
        }
        let values = zip(sums, counts).map { sum, count in UInt8(count == 0 ? 0 : sum / count) }
        return LumaGrid(columns: columns, rows: rows, values: values)
    }
}

/// Whether a stream sample holds new pixels. ScreenCaptureKit marks a sample `complete` with a
/// dirty rect over the whole frame on every frame of a covered window (measured on macOS 27.2: a
/// static window below the person's windows gave 24 complete samples in 2.4 s, 2 distinct
/// buffers), so `complete` alone does not mean new pixels: a sample whose fingerprint and size
/// equal the last one's is nothing new. Pure.
public struct PixelNovelty: Equatable, Sendable {
    private var last: Seen?

    private struct Seen: Equatable, Sendable {
        let fingerprint: UInt64
        let width: Int
        let height: Int
    }

    public init() {}

    /// True for the first sample and for every one whose pixels or size differ from the last.
    public mutating func isNew(fingerprint: UInt64, width: Int, height: Int) -> Bool {
        let seen = Seen(fingerprint: fingerprint, width: width, height: height)
        defer { last = seen }
        return seen != last
    }
}
