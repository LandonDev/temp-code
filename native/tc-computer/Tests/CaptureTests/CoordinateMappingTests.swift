import ComputerCore
import Foundation
import Testing

@Suite struct CoordinateMappingTests {
    @Test func everyPixelRoundTrips() {
        var random = SplitMix64(seed: 0x51A7)
        for _ in 0..<200 {
            let origin = CGPoint(x: Double.random(in: -3_000...6_000, using: &random), y: Double.random(in: -1_500...3_000, using: &random))
            let scale = [0.32, 1, 1.31762, 1.5, 1.6, 2, Double.random(in: 0.2...3, using: &random)][Int.random(in: 0..<7, using: &random)]
            let width = Int.random(in: 1...120, using: &random), height = Int.random(in: 1...90, using: &random)
            for y in 0..<height {
                for x in 0..<width {
                    let point = CoordinateMapping.screenPoint(pixel: [x, y], windowOrigin: origin, scale: scale)
                    #expect(CoordinateMapping.pixel(screenPoint: point, windowOrigin: origin, scale: scale) == [x, y])
                }
            }
        }
    }

    @Test func aPointInsideAPixelMapsToIt() {
        var random = SplitMix64(seed: 0x9E1)
        for _ in 0..<2_000 {
            let origin = CGPoint(x: Double.random(in: -2_000...4_000, using: &random), y: Double.random(in: -1_000...2_000, using: &random))
            let scale = Double.random(in: 0.25...3, using: &random)
            let pixel = [Int.random(in: 0..<2_576, using: &random), Int.random(in: 0..<1_600, using: &random)]
            let inside = CGPoint(
                x: Double(origin.x) + (Double(pixel[0]) + Double.random(in: 0.05...0.95, using: &random)) / scale,
                y: Double(origin.y) + (Double(pixel[1]) + Double.random(in: 0.05...0.95, using: &random)) / scale
            )
            #expect(CoordinateMapping.pixel(screenPoint: inside, windowOrigin: origin, scale: scale) == pixel)
        }
    }

    @Test func aClickLandsAtThePixelCentre() {
        let point = CoordinateMapping.screenPoint(pixel: [0, 0], windowOrigin: CGPoint(x: 100, y: 50), scale: 2)
        #expect(point == CGPoint(x: 100.25, y: 50.25))
    }
}
