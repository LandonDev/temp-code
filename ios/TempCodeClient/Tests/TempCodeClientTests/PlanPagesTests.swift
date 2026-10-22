import Foundation
import Testing
@testable import TempCodeClient

/// A store on its own temp directory and defaults suite, both removed at the end.
@MainActor
private struct Scratch {
    let directory: URL
    let suite: String

    init() {
        directory = FileManager.default.temporaryDirectory.appending(path: "plan-pages-\(UUID().uuidString)", directoryHint: .isDirectory)
        suite = "plan-pages-tests-\(UUID().uuidString)"
    }

    func pages() -> PlanPages {
        PlanPages(directory: directory, defaults: UserDefaults(suiteName: suite)!)
    }

    func remove() {
        try? FileManager.default.removeItem(at: directory)
        UserDefaults(suiteName: suite)?.removePersistentDomain(forName: suite)
    }
}

/// A text past the sync limit, so `document` parses it off the actor.
private func long(_ marker: String) -> String {
    String(repeating: "A line of \(marker) prose that is long enough to matter.\n", count: 200)
}

/// Polls `document` until the parse of `text` lands; nil after two seconds.
@MainActor
private func settled(_ pages: PlanPages, _ key: String, _ text: String) async -> PlanDocument? {
    for _ in 0..<400 {
        if let document = pages.document(key, text: text), document.textHash == text.hashValue { return document }
        try? await Task.sleep(for: .milliseconds(5))
    }
    return nil
}

@Suite struct PlanPagesTests {
    @MainActor @Test func `a remembered text reads back from disk in a fresh instance`() async {
        let scratch = Scratch()
        defer { scratch.remove() }
        let pages = scratch.pages()
        #expect(pages.cached("env/one") == nil)
        pages.remember("env/one", text: "# One\n\nbody\n")
        #expect(pages.cached("env/one") == "# One\n\nbody\n")
        await pages.awaitDisk()
        let fresh = scratch.pages()
        #expect(fresh.cached("env/one") == "# One\n\nbody\n")
        #expect(fresh.cached("env/other") == nil)
    }

    @MainActor @Test func `the same text again writes nothing`() async throws {
        let scratch = Scratch()
        defer { scratch.remove() }
        let pages = scratch.pages()
        pages.remember("k", text: "same")
        await pages.awaitDisk()
        let file = pages.url("k")
        let first = try FileManager.default.attributesOfItem(atPath: file.path)[.modificationDate] as? Date
        #expect(first != nil)
        try await Task.sleep(for: .milliseconds(20))
        pages.remember("k", text: "same")
        await pages.awaitDisk()
        let second = try FileManager.default.attributesOfItem(atPath: file.path)[.modificationDate] as? Date
        #expect(second == first)
        pages.remember("k", text: "changed")
        await pages.awaitDisk()
        let third = try FileManager.default.attributesOfItem(atPath: file.path)[.modificationDate] as? Date
        #expect(third != first)
        #expect(try String(contentsOf: file, encoding: .utf8) == "changed")
    }

    @MainActor @Test func `a key with a slash and spaces round-trips through a safe file name`() async {
        let scratch = Scratch()
        defer { scratch.remove() }
        let pages = scratch.pages()
        let key = "env_abc/thread id/report"
        #expect(PlanPages.fileName(key) == "env_abc_thread_id_report")
        #expect(pages.url(key).lastPathComponent == "env_abc_thread_id_report.md")
        pages.remember(key, text: "text")
        await pages.awaitDisk()
        #expect(scratch.pages().cached(key) == "text")
    }

    @MainActor @Test func `the reading position is 0 until saved`() {
        let scratch = Scratch()
        defer { scratch.remove() }
        let pages = scratch.pages()
        #expect(pages.position("env/a") == 0)
        pages.savePosition("env/a", 7)
        #expect(pages.position("env/a") == 7)
        #expect(pages.position("env/b") == 0)
        #expect(scratch.pages().position("env/a") == 7)
    }

    @MainActor @Test func `a short text parses on the first paint and the same text is the same document`() {
        let scratch = Scratch()
        defer { scratch.remove() }
        let pages = scratch.pages()
        let first = pages.document("k", text: "# A\n\n- [ ] b\n")
        #expect(first?.textHash == "# A\n\n- [ ] b\n".hashValue)
        #expect(first?.blocks.count == 2)
        #expect(pages.parses == 1)
        #expect(pages.document("k", text: "# A\n\n- [ ] b\n") == first)
        #expect(pages.parses == 1)
    }

    @MainActor @Test func `a long text is nil on a cold page, then the parsed document`() async {
        let scratch = Scratch()
        defer { scratch.remove() }
        let pages = scratch.pages()
        let text = long("alpha")
        #expect(text.utf8.count > PlanPages.syncLimit)
        #expect(pages.document("k", text: text) == nil)
        #expect(pages.parses == 1)
        let document = await settled(pages, "k", text)
        #expect(document?.textHash == text.hashValue)
        #expect(document?.blocks.count == 1)
        #expect(pages.parses == 1)
    }

    @MainActor @Test func `a second text while one is in flight supersedes it`() async throws {
        let scratch = Scratch()
        defer { scratch.remove() }
        let pages = scratch.pages()
        let stale = long("stale")
        let fresh = long("fresh")
        #expect(pages.document("k", text: stale) == nil)
        #expect(pages.document("k", text: fresh) == nil)
        #expect(pages.parses == 2)
        let document = await settled(pages, "k", fresh)
        #expect(document?.textHash == fresh.hashValue)
        // The stale parse finishing later never replaces the fresh one, and
        // nothing was parsed twice.
        try await Task.sleep(for: .milliseconds(50))
        #expect(pages.document("k", text: fresh)?.textHash == fresh.hashValue)
        #expect(pages.parses == 2)
    }

    @MainActor @Test func `the last document is kept while a new version parses`() async {
        let scratch = Scratch()
        defer { scratch.remove() }
        let pages = scratch.pages()
        let first = pages.document("k", text: "# A\n")
        #expect(first?.blocks.count == 1)
        let next = long("next")
        // The page asks for the new text and gets the document it had.
        #expect(pages.document("k", text: next) == first)
        let document = await settled(pages, "k", next)
        #expect(document?.textHash == next.hashValue)
        // A short follow-up after the first paint also keeps the last one.
        #expect(pages.document("k", text: "# B\n") == document)
        let last = await settled(pages, "k", "# B\n")
        #expect(last?.blocks.count == 1)
        #expect(last?.textHash == "# B\n".hashValue)
    }
}
