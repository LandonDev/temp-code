@testable import ComputerService
import Foundation
import Testing

/// The commit check's disk reads (docs/computer-protocol.md §26.8) on a scratch folder of their own.
@Suite struct DiskFactsTests {
    private let root: URL

    init() throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent("tc-filefacts-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }

    private func write(_ name: String, _ text: String) throws -> URL {
        let url = root.appendingPathComponent(name)
        try text.write(to: url, atomically: false, encoding: .utf8)
        return url
    }

    private func cleanup() { try? FileManager.default.removeItem(at: root) }

    @Test func aFileReadsItsSizeInodeAndTime() throws {
        defer { cleanup() }
        let url = try write("doc.txt", "hello")
        guard case .present(let st) = DiskFacts.stat(url.path) else { Issue.record("not present"); return }
        let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
        #expect(st.size == 5)
        #expect(!st.isDirectory)
        #expect(st.inode == (attributes[.systemFileNumber] as? NSNumber)?.uint64Value)
        let modified = try #require(attributes[.modificationDate] as? Date)
        #expect(abs(st.mtime - modified.timeIntervalSince1970) < 0.001)
    }

    @Test func aWriteMovesTheTimeAndKeepsTheInode() throws {
        defer { cleanup() }
        let url = try write("doc.txt", "one")
        guard case .present(let before) = DiskFacts.stat(url.path) else { Issue.record("not present"); return }
        try FileManager.default.setAttributes([.modificationDate: Date(timeIntervalSince1970: before.mtime + 10)], ofItemAtPath: url.path)
        let handle = try FileHandle(forWritingTo: url)
        try handle.seekToEnd()
        try handle.write(contentsOf: Data(" two".utf8))
        try handle.close()
        guard case .present(let after) = DiskFacts.stat(url.path) else { Issue.record("not present"); return }
        #expect(after.inode == before.inode)
        #expect(after.size == 7)
        #expect(after.mtime != before.mtime)
    }

    @Test func aMissingFileAndAMissingParentAreMissing() {
        defer { cleanup() }
        #expect(DiskFacts.stat(root.appendingPathComponent("none.txt").path) == .missing)
        #expect(DiskFacts.stat(root.appendingPathComponent("none/deeper.txt").path) == .missing)
    }

    @Test func aFolderReadsAsADirectory() {
        defer { cleanup() }
        guard case .present(let st) = DiskFacts.stat(root.path) else { Issue.record("not present"); return }
        #expect(st.isDirectory)
    }

    @Test func aRefusedStatIsUnknownNeverMissing() throws {
        defer {
            try? FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: root.appendingPathComponent("shut").path)
            cleanup()
        }
        let shut = root.appendingPathComponent("shut", isDirectory: true)
        try FileManager.default.createDirectory(at: shut, withIntermediateDirectories: false)
        try "x".write(to: shut.appendingPathComponent("inside.txt"), atomically: false, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o000], ofItemAtPath: shut.path)
        #expect(DiskFacts.stat(shut.appendingPathComponent("inside.txt").path) == .unknown)
        #expect(DiskFacts.list(shut.path) == .unknown(.unreadable))
    }

    @Test func aListingNamesEachEntryWithItsInodeAndSkipsDotNames() throws {
        defer { cleanup() }
        let a = try write("a.txt", "a")
        _ = try write(".DS_Store", "noise")
        try FileManager.default.createDirectory(at: root.appendingPathComponent("folder"), withIntermediateDirectories: false)
        guard case .listed(let entries) = DiskFacts.list(root.path) else { Issue.record("not listed"); return }
        #expect(Set(entries.keys) == ["a.txt", "folder"])
        #expect(entries["folder"]?.isDirectory == true)
        #expect(entries["a.txt"]?.isDirectory == false)
        guard case .present(let st) = DiskFacts.stat(a.path) else { Issue.record("not present"); return }
        #expect(entries["a.txt"]?.inode == st.inode)
        #expect(entries["a.txt"]?.mtime == st.mtime)
    }

    @Test func aRenameKeepsTheInodeUnderTheNewName() throws {
        defer { cleanup() }
        let a = try write("a.txt", "a")
        guard case .listed(let before) = DiskFacts.list(root.path) else { Issue.record("not listed"); return }
        try FileManager.default.moveItem(at: a, to: root.appendingPathComponent("b.txt"))
        guard case .listed(let after) = DiskFacts.list(root.path) else { Issue.record("not listed"); return }
        #expect(after["a.txt"] == nil)
        #expect(after["b.txt"]?.inode == before["a.txt"]?.inode)
    }

    @Test func aListingPastTheCapIsUnknown() throws {
        defer { cleanup() }
        for n in 0 ..< 5 { _ = try write("f\(n).txt", "\(n)") }
        #expect(DiskFacts.list(root.path, max: 3) == .unknown(.tooMany))
        guard case .listed(let all) = DiskFacts.list(root.path, max: 5) else { Issue.record("not listed"); return }
        #expect(all.count == 5)
    }

    @Test func aListingPastItsBudgetIsUnknown() throws {
        defer { cleanup() }
        for n in 0 ..< 4 { _ = try write("f\(n).txt", "\(n)") }
        // a clock that moves 8 ms at every look: the budget of 20 ms runs out on the third entry
        var ticks: UInt64 = 0
        let clock = { () -> UInt64 in
            ticks += 8_000_000
            return ticks
        }
        #expect(DiskFacts.list(root.path, budgetMs: 20, now: clock) == .unknown(.tooSlow))
        #expect(DiskFacts.list(root.appendingPathComponent("none").path) == .unknown(.unreadable))
    }

    @Test func theDefaultsAreTheWire() {
        #expect(ComputerDefaultsCheck.listMax == 2_000)
        #expect(ComputerDefaultsCheck.listMs == 20)
    }

    @Test func aDocumentURLGivesItsPath() {
        #expect(DiskFacts.path(fromDocument: "file:///tmp/tc-active/scratch/doc.txt") == "/tmp/tc-active/scratch/doc.txt")
        #expect(DiskFacts.path(fromDocument: "file:///Users/me/My%20Run/files/") == "/Users/me/My Run/files")
        #expect(DiskFacts.path(fromDocument: "https://example.com/a.txt") == nil)
        #expect(DiskFacts.path(fromDocument: "not a url") == nil)
    }

    @Test func pathsReadFromTheHomeFolder() {
        #expect(DiskFacts.display("/Users/me/run/Total.txt", home: "/Users/me") == "~/run/Total.txt")
        #expect(DiskFacts.display("/Users/me", home: "/Users/me/") == "~")
        #expect(DiskFacts.display("/Users/meadow/x", home: "/Users/me") == "/Users/meadow/x")
        #expect(DiskFacts.display("/tmp/a", home: "/Users/me") == "/tmp/a")
        #expect(DiskFacts.absolute("~/run/note.rtf", home: "/Users/me") == "/Users/me/run/note.rtf")
        #expect(DiskFacts.absolute("~", home: "/Users/me") == "/Users/me")
        #expect(DiskFacts.absolute("/tmp/a", home: "/Users/me") == "/tmp/a")
        #expect(DiskFacts.absolute("run/a", home: "/Users/me") == nil)
    }
}

import ComputerProtocol

private enum ComputerDefaultsCheck {
    static let listMax = ComputerDefaults.Front.commitListMax
    static let listMs = ComputerDefaults.Front.commitListMs
}
