import Foundation
import Testing

/// The other-Space proof moves its own window with SkyLight's private calls; nothing that ships
/// may reach them. Every target but `capture-proof` is scanned for the private prefixes and for
/// run-time symbol lookup, but the AX reader's one lookup (native/tc-computer/README.md, "Private symbols").
@Suite struct PrivateCallScanTests {
    private static let sources = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .appendingPathComponent("Sources")

    @Test func noShippedTargetNamesAPrivateCall() throws {
        // `CGSSessionScreenIsLocked` is a key of the public CGSessionCopyCurrentDictionary() (Input's
        // locked-screen check), not a call; every other CGS or SLS name still fails the scan
        let pattern = try NSRegularExpression(pattern: #"\b(SLS|CGS)(?!SessionScreenIsLocked\b)[A-Z]|\bdl(open|sym)\b|SkyLight"#)
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
                var found = hits.compactMap { Range($0.range, in: text).map { String(text[$0]) } }
                // the AX reader's window id: `_AXUIElementGetWindow`, read-only and resolved by name (the person's
                // ruling, 2026-11-08; native/tc-computer/README.md), is the one run-time lookup that ships, and only that name
                if target == "AXReader", file == "Windows.swift" {
                    found.removeAll { $0 == "dlopen" || $0 == "dlsym" }
                    #expect(text.components(separatedBy: "Symbol(name: ").count == 2 && text.contains("Symbol(name: \"_AXUIElementGetWindow\")"))
                }
                #expect(found.isEmpty, "\(target)/\(file) names \(found)")
                scanned[target, default: 0] += 1
            }
        }
        #expect(scanned["Capture", default: 0] >= 5)
        #expect(scanned["ComputerCore", default: 0] >= 2)
    }
}
