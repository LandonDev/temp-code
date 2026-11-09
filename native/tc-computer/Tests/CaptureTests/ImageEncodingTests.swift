@testable import Capture
import ComputerProtocol
import CoreGraphics
import Foundation
import ImageIO
import Testing

extension Bitmap {
    /// The bitmap as the CGImage ScreenCaptureKit would hand back (BGRA, sRGB).
    var image: CGImage {
        let provider = CGDataProvider(data: Data(bytes) as CFData)!
        return CGImage(
            width: width,
            height: height,
            bitsPerComponent: 8,
            bitsPerPixel: 32,
            bytesPerRow: bytesPerRow,
            space: CGColorSpace(name: CGColorSpace.sRGB)!,
            bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue),
            provider: provider,
            decode: nil,
            shouldInterpolate: false,
            intent: .defaultIntent
        )!
    }
}

private func decodedSize(_ data: Data) -> (Int, Int)? {
    guard let source = CGImageSourceCreateWithData(data as CFData, nil), let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else { return nil }
    return (image.width, image.height)
}

private func magic(_ data: Data) -> ShotFormat? {
    if data.starts(with: [0x89, 0x50, 0x4E, 0x47]) { return .png }
    if data.starts(with: [0xFF, 0xD8, 0xFF]) { return .jpeg }
    return nil
}

@Suite struct ImageEncodingTests {
    @Test func flatUIComesOutAsPNG() throws {
        let image = Bitmap.flatUI(width: 1_280, height: 800).image
        let encoded = try ImageEncoding.encode(image, format: nil)
        #expect(encoded.format == .png)
        #expect(magic(encoded.data) == .png)
        let jpeg = try ImageEncoding.jpeg(image, quality: CaptureTuning.jpegQuality)
        #expect(encoded.data.count <= jpeg.count)
    }

    @Test func noisyContentStaysJPEG() throws {
        let encoded = try ImageEncoding.encode(Bitmap.noise(width: 1_280, height: 800, levels: 0...255, seed: 3).image, format: nil)
        #expect(encoded.format == .jpeg)
        #expect(magic(encoded.data) == .jpeg)
    }

    @Test func aNamedFormatIsUsedAsNamed() throws {
        let flat = Bitmap.flatUI(width: 640, height: 400).image
        let jpeg = try ImageEncoding.encode(flat, format: .jpeg)
        #expect(jpeg.format == .jpeg && magic(jpeg.data) == .jpeg)
        let noisy = Bitmap.noise(width: 640, height: 400, levels: 0...255, seed: 4).image
        let png = try ImageEncoding.encode(noisy, format: .png)
        #expect(png.format == .png && magic(png.data) == .png)
    }

    @Test func theOutputDecodesToTheSameSize() throws {
        for format: ShotFormat? in [nil, .jpeg, .png] {
            let encoded = try ImageEncoding.encode(Bitmap.flatUI(width: 333, height: 211).image, format: format)
            let size = try #require(decodedSize(encoded.data))
            #expect(size.0 == 333 && size.1 == 211)
        }
    }

    @Test func theCGImageEntryPointsReadTheImagesOwnPixels() {
        #expect(PixelStats.isBlank(Bitmap.filled(width: 200, height: 100, (9, 9, 9, 255)).image))
        var drawn = Bitmap.filled(width: 200, height: 100, (9, 9, 9, 255))
        drawn.fill(x: 150, y: 80, width: 2, height: 2, (200, 0, 0, 255))
        #expect(!PixelStats.isBlank(drawn.image))
        #expect(PixelStats.flatness(Bitmap.flatUI(width: 640, height: 400).image) > 0.9)
    }
}
