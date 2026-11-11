import ComputerProtocol
@testable import ComputerServiceKit
import Testing

// The commit check's two reads compared (§25.8).

private let home = "/Users/me"
private let path = "/Users/me/run/Total.txt"

@Suite struct DiskDiffTests {
    @Test func aFileWrittenInPlaceOrReplaced() {
        let a = FileStamp(size: 10, mtime: 100, inode: 7)
        // mtime moved
        #expect(DiskDiff.diff(before: .file(path: path, a), after: .file(path: path, FileStamp(size: 10, mtime: 101, inode: 7)), expected: true, home: home) == DiskChange(saved: "~/run/Total.txt"))
        // an atomic save: a new inode
        #expect(DiskDiff.diff(before: .file(path: path, a), after: .file(path: path, FileStamp(size: 10, mtime: 100, inode: 8)), expected: true, home: home)?.saved == "~/run/Total.txt")
        // made, and removed
        #expect(DiskDiff.diff(before: .file(path: path, nil), after: .file(path: path, a), expected: true, home: home)?.saved == "~/run/Total.txt")
        #expect(DiskDiff.diff(before: .file(path: path, a), after: .file(path: path, nil), expected: true, home: home)?.removed == ["~/run/Total.txt"])
        // nothing moved: no disk part
        #expect(DiskDiff.diff(before: .file(path: path, a), after: .file(path: path, a), expected: true, home: home) == nil)
    }

    @Test func aFolderListingMatchesRenamesByInode() {
        let before: [String: FolderEntry] = ["a.txt": FolderEntry(inode: 1, mtime: 10), "b.txt": FolderEntry(inode: 2, mtime: 10), "gone.txt": FolderEntry(inode: 3, mtime: 10)]
        let after: [String: FolderEntry] = ["renamed.txt": FolderEntry(inode: 1, mtime: 10), "b.txt": FolderEntry(inode: 2, mtime: 12), "untitled folder": FolderEntry(inode: 9, mtime: 12)]
        let d = DiskDiff.diff(before: .folder(path: "/Users/me/run", before), after: .folder(path: "/Users/me/run", after), expected: true, home: home)
        #expect(d == DiskChange(
            saved: "~/run/b.txt",
            renamed: [DiskChange.Renamed(from: "~/run/a.txt", to: "~/run/renamed.txt")],
            added: ["~/run/untitled folder"],
            removed: ["~/run/gone.txt"]
        ))
    }

    @Test func anUnexpectedWriteIsMarked() {
        let a = FileStamp(size: 10, mtime: 100, inode: 7)
        let d = DiskDiff.diff(before: .file(path: path, a), after: .file(path: path, FileStamp(size: 12, mtime: 105, inode: 7)), expected: false, home: home)
        #expect(d == DiskChange(saved: "~/run/Total.txt", unexpected: true))
        // a flag that moved alone is no write
        let flag = DiskDiff.diff(before: .file(path: path, a), after: .file(path: path, a), edited: (true, false), expected: false, home: home)
        #expect(flag == DiskChange(edited: DiskChange.Edited(before: true, after: false)))
    }

    @Test func theEditedFlagAndTheDocumentOnlyWhenTheyMoved() {
        let a = FileStamp(size: 10, mtime: 100, inode: 7)
        #expect(DiskDiff.diff(before: .file(path: path, a), after: .file(path: path, a), edited: (true, true), document: (path, path), expected: true, home: home) == nil)
        let moved = DiskDiff.diff(before: .file(path: path, a), after: .file(path: "/Users/me/run/New.txt", a), document: (path, "/Users/me/run/New.txt"), expected: true, home: home)
        #expect(moved == DiskChange(document: DiskChange.Document(from: "~/run/Total.txt", to: "~/run/New.txt")))
        // an untitled window's first save names its document
        let first = DiskDiff.diff(before: .unknown, after: .file(path: path, a), document: (nil, path), expected: true, home: home)
        #expect(first?.document == DiskChange.Document(from: nil, to: "~/run/Total.txt"))
        #expect(first?.unknown == true)
    }

    @Test func aListingPastItsBoundsIsUnknown() {
        #expect(DiskSnapshot.listingFits(entries: 2_000, elapsedMs: 20))
        #expect(!DiskSnapshot.listingFits(entries: 2_001, elapsedMs: 5))
        #expect(!DiskSnapshot.listingFits(entries: 10, elapsedMs: 21))
        #expect(DiskDiff.diff(before: .unknown, after: .folder(path: "/x", [:]), expected: true, home: home) == DiskChange(unknown: true))
    }

    @Test func listsAreCappedAndPathsTildeRelative() {
        var after: [String: FolderEntry] = [:]
        for i in 0 ..< 40 { after["f\(i)"] = FolderEntry(inode: UInt64(100 + i), mtime: 1) }
        let d = DiskDiff.diff(before: .folder(path: "/tmp/x", [:]), after: .folder(path: "/tmp/x", after), expected: true, home: home)
        #expect(d?.added?.count == DiskDiff.listMax)
        #expect(d?.added?.first == "/tmp/x/f0")
        #expect(tildeRelative("/Users/me", home: home) == "~")
        #expect(tildeRelative("/Users/me/a", home: home + "/") == "~/a")
        #expect(tildeRelative("/Users/meg/a", home: home) == "/Users/meg/a")
        #expect(tildeRelative("/" + String(repeating: "é", count: 2_000), home: home).utf16.count == ComputerDefaults.Front.pathMaxUnits)
    }
}
