@testable import Capture
import Foundation
import Testing

@Suite struct ShotGeometryTests {
    @Test func aWindowAtTwiceFitsTheLongEdge() {
        let size = ShotGeometry.output(points: CGSize(width: 800, height: 600), pointPixelScale: 2, maxEdge: 1_280)
        #expect(size.width == 1_280)
        #expect(size.height == 960)
        #expect(abs(size.scale - 1.6) < 1e-12)
    }

    @Test func aWindowAtOnceIsNeverUpscaled() {
        let size = ShotGeometry.output(points: CGSize(width: 800, height: 600), pointPixelScale: 1, maxEdge: 1_280)
        #expect(size == ShotSize(width: 800, height: 600, scale: 1))
        let small = ShotGeometry.output(points: CGSize(width: 100, height: 80), pointPixelScale: 2, maxEdge: 2_576)
        #expect(small == ShotSize(width: 200, height: 160, scale: 2))
    }

    @Test func theLargeWindowHitsThePixelCapFirst() {
        let size = ShotGeometry.output(points: CGSize(width: 1_800, height: 1_200), pointPixelScale: 2, maxEdge: 2_576)
        #expect(size.width == 2_371)
        #expect(size.height == 1_581)
        #expect(abs(size.scale - 1.31762) < 1e-5)
        #expect(size.width * size.height <= CaptureTuning.pixelCap)
    }

    @Test func clampEdgeHoldsTheScreenshotRange() {
        #expect(ShotGeometry.clampEdge(100) == 512)
        #expect(ShotGeometry.clampEdge(9_000) == 2_576)
        #expect(ShotGeometry.clampEdge(1_000) == 1_000)
    }

    @Test func outputTakesAPreviewOrWatchEdgeAsGiven() {
        let size = ShotGeometry.output(points: CGSize(width: 800, height: 600), pointPixelScale: 2, maxEdge: 256)
        #expect(size.width == 256)
        #expect(size.height == 192)
    }

    @Test func aZoomCapturesTheWholeWindowAndCropsTheRegion() {
        let zoom = ShotGeometry.zoom(
            window: CGSize(width: 800, height: 600),
            region: CGRect(x: 300, y: 225, width: 200, height: 150),
            pointPixelScale: 2,
            maxEdge: 1_280
        )
        #expect(zoom.capture == ShotSize(width: 1_600, height: 1_200, scale: 2))
        #expect(zoom.crop == CGRect(x: 600, y: 450, width: 400, height: 300))
    }

    @Test func aZoomRegionPastTheEdgeIsClampedAndItsCropStaysInside() {
        let zoom = ShotGeometry.zoom(
            window: CGSize(width: 800, height: 600),
            region: CGRect(x: 700, y: 500, width: 300, height: 300),
            pointPixelScale: 2,
            maxEdge: 1_280
        )
        #expect(zoom.crop.width == 200)
        #expect(zoom.crop.height == 200)
        #expect(zoom.crop.maxX <= CGFloat(zoom.capture.width))
        #expect(zoom.crop.maxY <= CGFloat(zoom.capture.height))
        let outside = ShotGeometry.zoom(
            window: CGSize(width: 800, height: 600),
            region: CGRect(x: 2_000, y: -400, width: 50, height: 50),
            pointPixelScale: 2,
            maxEdge: 1_280
        )
        #expect(outside.crop.width >= 1)
        #expect(outside.crop.maxX <= CGFloat(outside.capture.width))
        #expect(outside.crop.minY >= 0)
    }

    @Test func aLargeZoomRegionIsFittedToTheEdge() {
        let zoom = ShotGeometry.zoom(
            window: CGSize(width: 1_600, height: 1_000),
            region: CGRect(x: 0, y: 0, width: 1_600, height: 1_000),
            pointPixelScale: 2,
            maxEdge: 1_280
        )
        let whole = ShotGeometry.output(points: CGSize(width: 1_600, height: 1_000), pointPixelScale: 2, maxEdge: 1_280)
        #expect(zoom.crop.width == CGFloat(whole.width))
        #expect(zoom.crop.height == CGFloat(whole.height))
    }

    @Test func randomSizesKeepEveryBound() {
        var random = SplitMix64(seed: 0xCA97)
        for _ in 0..<1_000 {
            let points = CGSize(width: Double.random(in: 40...4_000, using: &random), height: Double.random(in: 30...3_000, using: &random))
            let pps = [1, 1.5, 2, 3][Int.random(in: 0..<4, using: &random)]
            let edge = Int.random(in: 256...2_576, using: &random)
            let size = ShotGeometry.output(points: points, pointPixelScale: pps, maxEdge: edge)
            #expect(size.width * size.height <= CaptureTuning.pixelCap)
            #expect(max(size.width, size.height) <= edge)
            #expect(size.width >= 1 && size.height >= 1)
            #expect(size.scale <= pps)
            #expect(size.width <= Int(Double(points.width) * pps) + 1)
        }
    }

    @Test func aHeldSampleCropsByItsOwnContentRect() {
        // A sample held before a resize keeps the rect it came with; the stream's new size is not read.
        let held = ShotGeometry.contentCrop(
            contentRect: CGRect(x: 0, y: 0, width: 480, height: 360),
            pixelsPerPoint: 2,
            bufferWidth: 960,
            bufferHeight: 960
        )
        #expect(held == CGRect(x: 0, y: 0, width: 960, height: 720))
        let past = ShotGeometry.contentCrop(
            contentRect: CGRect(x: 10, y: 0, width: 600, height: 400),
            pixelsPerPoint: 2,
            bufferWidth: 960,
            bufferHeight: 720
        )
        #expect(past == CGRect(x: 20, y: 0, width: 940, height: 720))
        let empty = ShotGeometry.contentCrop(contentRect: .zero, pixelsPerPoint: 2, bufferWidth: 640, bufferHeight: 480)
        #expect(empty == CGRect(x: 0, y: 0, width: 640, height: 480))
    }
}
