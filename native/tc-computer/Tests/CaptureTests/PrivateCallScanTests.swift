import Foundation
import Testing

/// The other-Space proof moves its own window with SkyLight's private calls; nothing that ships
/// may reach them. Every target but `capture-proof` is scanned for the private prefixes and for
/// run-time symbol lookup.
@Suite struct PrivateCallScanTests {
    private static let sources = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .appendingPathComponent("Sources")

    @Test func noShippedTargetNamesAPrivateCall() throws {
        let pattern = try NSRegularExpression(pattern: #"\b(SLS|CGS)[A-Z]|\bdl(open|sym)\b|SkyLight"#)
        let targets = try FileManager.default.contentsOfDirectory(atPath: Self.sources.path).filter { $0 != "capture-proof" }
        #expect(targets.contains("Capture"))
        #expect(targets.contains("ComputerCore"))
        var scanned: [String: Int] = [:]
        for target in targets {
            let root = Self.sources.appendingPathComponent(target).resolvingSymlinksInPath()
            guard let files = FileManager.default.enumerator(atPath: root.path) else { continue }
            for case let file as String in files where file.hasSuffix(".swift") {
                let text = try String(contentsOf: root.appendingPathComponent(file), encoding: .utf8)
                let hits = pattern.matches(in: text, range: NSRange(text.startIndex..., in: text))
                let found = hits.compactMap { Range($0.range, in: text).map { String(text[$0]) } }
                #expect(found.isEmpty, "\(target)/\(file) names \(found)")
                scanned[target, default: 0] += 1
            }
        }
        #expect(scanned["Capture", default: 0] >= 5)
        #expect(scanned["ComputerCore", default: 0] >= 2)
    }
}
