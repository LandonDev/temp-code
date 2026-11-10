import ComputerProtocol
@testable import ComputerServiceKit
import Testing

@Suite struct OpenItemsTests {
    /// A Mac with a few things on it.
    let disk: [String: FileFacts] = [
        "/tmp/report.pdf": FileFacts(exists: true),
        "/tmp/a b.txt": FileFacts(exists: true),
        "/tmp/scratch": FileFacts(exists: true, isDirectory: true),
        "/Applications/Calculator.app": FileFacts(exists: true, isDirectory: true, isBundle: true, hasExecutable: true, conformsToExecutable: true),
        "/tmp/notes.rtfd": FileFacts(exists: true, isDirectory: true, isBundle: true),
        "/tmp/run.sh": FileFacts(exists: true, executeBit: true, conformsToExecutable: true),
        "/tmp/go.command": FileFacts(exists: true, executeBit: true, conformsToExecutable: true),
        "/tmp/plain.command": FileFacts(exists: true, conformsToExecutable: true),
        "/tmp/tool": FileFacts(exists: true, executeBit: true)
    ]

    func classify(_ raw: String) -> Result<OpenItem, OpenRefusal> {
        OpenItem.classify(raw, facts: { disk[$0] })
    }

    func reason(_ raw: String) -> ErrorReason? {
        if case .failure(let refusal) = classify(raw) { return refusal.reason }
        return nil
    }

    @Test func webAddressesOpenAsGiven() throws {
        let item = try classify("https://example.com/a?b=1").get()
        #expect(item.kind == .web("https://example.com/a?b=1"))
        #expect(try classify("http://localhost:5173/").get().kind == .web("http://localhost:5173/"))
        #expect(try classify("HTTPS://example.com").get().kind == .web("HTTPS://example.com"))
    }

    @Test func everyOtherSchemeIsRefused() {
        for raw in ["ftp://example.com/x", "javascript:alert(1)", "mailto:a@b.c", "x-apple.systempreferences:com.apple.preference", "ssh://box", "https:///nohost", "report.pdf", "~/report.pdf", "tmp/report.pdf"] {
            #expect(reason(raw) == .scheme, "\(raw)")
        }
    }

    @Test func absolutePathsAndFileURLsOpen() throws {
        #expect(try classify("/tmp/report.pdf").get().kind == .file("/tmp/report.pdf"))
        #expect(try classify("file:///tmp/report.pdf").get().kind == .file("/tmp/report.pdf"))
        #expect(try classify("file://localhost/tmp/report.pdf").get().kind == .file("/tmp/report.pdf"))
        #expect(try classify("file:///tmp/a%20b.txt").get().kind == .file("/tmp/a b.txt"))
        #expect(try classify("/tmp/report.pdf").get().label == "report.pdf")
        #expect(reason("file://otherhost/tmp/report.pdf") == .scheme)
    }

    @Test func aFolderAndABundleWithoutAnExecutableOpen() throws {
        #expect(try classify("/tmp/scratch").get().kind == .file("/tmp/scratch"))
        #expect(try classify("/tmp/notes.rtfd").get().kind == .file("/tmp/notes.rtfd"))
    }

    @Test func programsAreRefused() {
        #expect(reason("/Applications/Calculator.app") == .executable)
        #expect(reason("file:///Applications/Calculator.app") == .executable)
        #expect(reason("/tmp/run.sh") == .executable, "a script with an execute bit")
        #expect(reason("/tmp/go.command") == .executable)
        #expect(reason("/tmp/plain.command") == .executable, "a .command without the bit still conforms to public.script")
        #expect(reason("/tmp/tool") == .executable, "a plain file with an execute bit")
    }

    @Test func aMissingPathIsRefused() {
        #expect(reason("/tmp/nothing.pdf") == .missing)
        #expect(reason("file:///tmp/nothing.pdf") == .missing)
        if case .failure(let refusal) = classify("/tmp/nothing.pdf") {
            #expect(refusal.error.kind == .openRefused)
            #expect(refusal.error.reason == .missing)
            #expect(refusal.message.contains("/tmp/nothing.pdf"))
        }
    }

    @Test func theMessagesSayWhy() {
        if case .failure(let refusal) = classify("/tmp/go.command") {
            #expect(refusal.message == "go.command is a program; open only opens documents, folders and web pages.")
        } else {
            Issue.record("go.command opened")
        }
    }

    @Test func atMostEightItemsAndTheFirstRefusalWins() throws {
        let eight = Array(repeating: "/tmp/report.pdf", count: ComputerDefaults.Service.openItemsMax)
        #expect(try OpenItem.classifyAll(eight, facts: { disk[$0] }).get().count == 8)
        guard case .failure(let tooMany) = OpenItem.classifyAll(eight + ["/tmp/scratch"], facts: { disk[$0] }) else {
            Issue.record("nine items passed")
            return
        }
        #expect(tooMany.error.kind == .openRefused)
        #expect(tooMany.reason == nil)
        guard case .failure(let first) = OpenItem.classifyAll(["/tmp/report.pdf", "/tmp/run.sh", "/tmp/nothing"], facts: { disk[$0] }) else {
            Issue.record("a program passed")
            return
        }
        #expect(first.reason == .executable)
        #expect(first.item == "/tmp/run.sh")
        #expect(try OpenItem.classifyAll([], facts: { disk[$0] }).get().isEmpty)
    }
}
