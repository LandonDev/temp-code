#if canImport(ScreenCaptureKit)

import CoreGraphics
import Foundation
import ImageIO
import Vision

/// Text in an image, read by Vision on this Mac.
enum Ocr {
    static func lines(_ image: CGImage) throws -> [String] {
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = false
        try VNImageRequestHandler(cgImage: image).perform([request])
        return (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }
    }

    /// Whether `phrase` is read in the image, ignoring case and spacing.
    static func finds(_ phrase: String, in image: CGImage) -> (found: Bool, lines: [String]) {
        let lines = (try? lines(image)) ?? []
        let squash = { (text: String) in text.lowercased().filter { !$0.isWhitespace } }
        let wanted = squash(phrase)
        return (lines.contains { squash($0).contains(wanted) } || squash(lines.joined()).contains(wanted), lines)
    }
}

/// Images on disk, read back for checking.
enum Images {
    static func load(_ path: String) -> CGImage? {
        guard let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil) else { return nil }
        return CGImageSourceCreateImageAtIndex(source, 0, nil)
    }

    static func load(_ data: Data) -> CGImage? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
        return CGImageSourceCreateImageAtIndex(source, 0, nil)
    }

    /// What the file's first bytes say it is.
    static func magic(_ path: String) -> String {
        guard let handle = FileHandle(forReadingAtPath: path) else { return "missing" }
        defer { try? handle.close() }
        let head = [UInt8](handle.readData(ofLength: 4))
        if head.starts(with: [0x89, 0x50, 0x4E, 0x47]) { return "png" }
        if head.starts(with: [0xFF, 0xD8, 0xFF]) { return "jpeg" }
        return "unknown"
    }
}

#endif
