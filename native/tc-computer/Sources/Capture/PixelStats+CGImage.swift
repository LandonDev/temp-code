import CoreGraphics
import Foundation

extension Bitmap {
    /// The image's own pixels at its own size, rendered once into BGRA sRGB.
    public init?(image: CGImage) {
        let width = image.width, height = image.height
        guard width > 0, height > 0, let space = CGColorSpace(name: CGColorSpace.sRGB) else { return nil }
        let bytesPerRow = width * 4
        var bytes = [UInt8](repeating: 0, count: bytesPerRow * height)
        let drawn = bytes.withUnsafeMutableBytes { buffer -> Bool in
            guard let context = CGContext(
                data: buffer.baseAddress,
                width: width,
                height: height,
                bitsPerComponent: 8,
                bytesPerRow: bytesPerRow,
                space: space,
                bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue
            ) else { return false }
            context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
            return true
        }
        guard drawn else { return nil }
        self.init(width: width, height: height, bytesPerRow: bytesPerRow, bytes: bytes)
    }
}

extension PixelStats {
    public static func isBlank(_ image: CGImage) -> Bool {
        Bitmap(image: image).map { isBlank($0) } ?? true
    }

    public static func flatness(_ image: CGImage) -> Double {
        Bitmap(image: image).map { flatness($0) } ?? 1
    }
}
