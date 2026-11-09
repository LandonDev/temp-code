@testable import Capture
import Foundation

/// A seeded generator, so a random case that fails fails again.
struct SplitMix64: RandomNumberGenerator {
    private var state: UInt64

    init(seed: UInt64) {
        state = seed
    }

    mutating func next() -> UInt64 {
        state &+= 0x9E37_79B9_7F4A_7C15
        var z = state
        z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
        z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
        return z ^ (z >> 31)
    }
}

extension Bitmap {
    /// Every pixel the same BGRA value.
    static func filled(width: Int, height: Int, _ bgra: (UInt8, UInt8, UInt8, UInt8)) -> Bitmap {
        var bytes = [UInt8](repeating: 0, count: width * height * 4)
        for pixel in stride(from: 0, to: bytes.count, by: 4) {
            bytes[pixel] = bgra.0
            bytes[pixel + 1] = bgra.1
            bytes[pixel + 2] = bgra.2
            bytes[pixel + 3] = bgra.3
        }
        return Bitmap(width: width, height: height, bytesPerRow: width * 4, bytes: bytes)
    }

    /// Colour channels drawn from `levels`, alpha opaque.
    static func noise(width: Int, height: Int, levels: ClosedRange<UInt8>, seed: UInt64) -> Bitmap {
        var random = SplitMix64(seed: seed)
        var bytes = [UInt8](repeating: 255, count: width * height * 4)
        for pixel in stride(from: 0, to: bytes.count, by: 4) {
            for channel in 0..<3 { bytes[pixel + channel] = UInt8.random(in: levels, using: &random) }
        }
        return Bitmap(width: width, height: height, bytesPerRow: width * 4, bytes: bytes)
    }

    /// A settings pane: a white field, grey rows, a dark rule, a few short "text" runs.
    static func flatUI(width: Int, height: Int) -> Bitmap {
        var bitmap = filled(width: width, height: height, (255, 255, 255, 255))
        bitmap.fill(x: 0, y: 0, width: width, height: 28, (236, 236, 236, 255))
        bitmap.fill(x: 0, y: 28, width: width, height: 1, (200, 200, 200, 255))
        for row in 0..<8 {
            let top = 48 + row * 40
            guard top + 12 < height else { break }
            bitmap.fill(x: 20, y: top, width: width / 3, height: 12, (60, 60, 60, 255))
            bitmap.fill(x: width / 2, y: top - 6, width: width / 3, height: 24, (245, 245, 245, 255))
        }
        return bitmap
    }

    mutating func fill(x: Int, y: Int, width: Int, height: Int, _ bgra: (UInt8, UInt8, UInt8, UInt8)) {
        for row in max(0, y)..<min(self.height, y + height) {
            for column in max(0, x)..<min(self.width, x + width) {
                let pixel = row * bytesPerRow + column * 4
                bytes[pixel] = bgra.0
                bytes[pixel + 1] = bgra.1
                bytes[pixel + 2] = bgra.2
                bytes[pixel + 3] = bgra.3
            }
        }
    }
}
