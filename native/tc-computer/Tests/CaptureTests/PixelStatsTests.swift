@testable import Capture
import ComputerProtocol
import Foundation
import Testing

@Suite struct PixelStatsTests {
    @Test func oneColourAndTransparentImagesAreBlank() {
        #expect(PixelStats.isBlank(.filled(width: 320, height: 200, (40, 80, 120, 255))))
        #expect(PixelStats.isBlank(.filled(width: 320, height: 200, (0, 0, 0, 0))))
    }

    @Test func oneSmallPatchIsEnoughToBeDrawn() {
        var bitmap = Bitmap.filled(width: 2_560, height: 1_600, (250, 250, 250, 255))
        bitmap.fill(x: 2_000, y: 1_400, width: 2, height: 2, (10, 10, 10, 255))
        #expect(!PixelStats.isBlank(bitmap))
    }

    @Test func alphaCountsAsAChannel() {
        var bitmap = Bitmap.filled(width: 64, height: 64, (0, 0, 0, 0))
        bitmap.fill(x: 3, y: 3, width: 1, height: 1, (0, 0, 0, 255))
        #expect(!PixelStats.isBlank(bitmap))
    }

    @Test func noiseWithinThreeLevelsIsBlankAndFourIsNot() {
        #expect(PixelStats.isBlank(.noise(width: 256, height: 256, levels: 100...103, seed: 1)))
        #expect(!PixelStats.isBlank(.noise(width: 256, height: 256, levels: 100...104, seed: 1)))
    }

    @Test func flatUIIsFlatAndNoiseIsNot() {
        #expect(PixelStats.flatness(.flatUI(width: 1_280, height: 800)) > 0.9)
        #expect(PixelStats.flatness(.noise(width: 1_280, height: 800, levels: 0...255, seed: 7)) < 0.2)
        #expect(PixelStats.flatness(.filled(width: 1, height: 10, (1, 2, 3, 255))) == 1)
    }

    @Test func theLumaGridAveragesEachCell() {
        // 10×5 plane, cells of 4: 3×2 cells, the right and bottom ones partial.
        var plane = [UInt8](repeating: 0, count: 12 * 5)
        for y in 0..<5 {
            for x in 0..<10 { plane[y * 12 + x] = x < 4 ? 100 : (x < 8 ? 50 : 200) }
        }
        let grid = plane.withUnsafeBytes { PixelStats.lumaGrid(plane: $0, width: 10, height: 5, bytesPerRow: 12, cell: 4) }
        #expect(grid.columns == 3)
        #expect(grid.rows == 2)
        #expect(grid.values == [100, 50, 200, 100, 50, 200])
    }
}

@Suite struct ImageEncodingRuleTests {
    @Test func pngOnlyWhenMadeAndNoLarger() {
        #expect(ImageEncoding.choose(jpeg: 100, png: nil) == .jpeg)
        #expect(ImageEncoding.choose(jpeg: 100, png: 100) == .png)
        #expect(ImageEncoding.choose(jpeg: 100, png: 60) == .png)
        #expect(ImageEncoding.choose(jpeg: 100, png: 101) == .jpeg)
    }

    @Test func flatnessDecidesTheTry() {
        #expect(ImageEncoding.wantsPNG(flatness: 0.85))
        #expect(!ImageEncoding.wantsPNG(flatness: 0.84))
    }

    @Test func theFrameLadderStepsDownThenDrops() {
        var asked: [Double] = []
        let sizes: [Double: Int] = [0.85: 500_000, 0.7: 420_000, 0.55: 300_000]
        let fits = ImageEncoding.frameJPEG { quality in
            asked.append(quality)
            return Data(count: sizes[quality]!)
        }
        #expect(fits?.quality == 0.55)
        #expect(asked == [0.85, 0.7, 0.55])

        asked = []
        let dropped = ImageEncoding.frameJPEG { quality in
            asked.append(quality)
            return Data(count: 600_000)
        }
        #expect(dropped == nil)
        #expect(asked == [0.85, 0.7, 0.55])

        asked = []
        let first = ImageEncoding.frameJPEG { quality in
            asked.append(quality)
            return Data(count: 80_000)
        }
        #expect(first?.quality == 0.85)
        #expect(asked == [0.85])
    }

    @Test func theFrameCapLeavesTheWireRoomForBase64AndJSON() {
        let base64 = (CaptureTuning.frameJPEGCap + 2) / 3 * 4
        #expect(base64 + 4_096 <= ComputerDefaults.PreviewStream.frameMaxBytes)
    }
}
