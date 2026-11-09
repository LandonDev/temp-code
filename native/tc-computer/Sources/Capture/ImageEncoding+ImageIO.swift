import ComputerCore
import ComputerProtocol
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

extension ImageEncoding {
    /// A shot's bytes. A named format is used as named; nil (or a format this build does not
    /// know) chooses by content. `flatness` saves a second render when the caller has it.
    public static func encode(_ image: CGImage, format: ShotFormat?, flatness: Double? = nil) throws -> (data: Data, format: ShotFormat) {
        switch format {
        case .png?:
            return (try png(image), .png)
        case .jpeg?:
            return (try jpeg(image, quality: CaptureTuning.jpegQuality), .jpeg)
        case nil, .unknown?:
            let jpegData = try jpeg(image, quality: CaptureTuning.jpegQuality)
            guard wantsPNG(flatness: flatness ?? PixelStats.flatness(image)) else { return (jpegData, .jpeg) }
            let pngData = try png(image)
            return choose(jpeg: jpegData.count, png: pngData.count) == .png ? (pngData, .png) : (jpegData, .jpeg)
        }
    }

    public static func jpeg(_ image: CGImage, quality: Double) throws -> Data {
        try write(image, type: .jpeg, options: [kCGImageDestinationLossyCompressionQuality: quality])
    }

    public static func png(_ image: CGImage) throws -> Data {
        try write(image, type: .png, options: [:])
    }

    private static func write(_ image: CGImage, type: UTType, options: [CFString: Any]) throws -> Data {
        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(data as CFMutableData, type.identifier as CFString, 1, nil) else {
            throw ComputerFailure.captureFailed("The image could not be encoded as \(type.preferredFilenameExtension ?? type.identifier).")
        }
        CGImageDestinationAddImage(destination, image, options as CFDictionary)
        guard CGImageDestinationFinalize(destination) else {
            throw ComputerFailure.captureFailed("The image could not be encoded as \(type.preferredFilenameExtension ?? type.identifier).")
        }
        return data as Data
    }
}
