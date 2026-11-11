import ApplicationServices
import ComputerCore
import ComputerProtocol
@testable import ComputerService
import ComputerServiceKit
import Foundation
import Testing

/// A scratch folder with one document and a folder of files, removed by `cleanup`.
private struct Scratch {
    let root: URL
    var doc: URL { root.appendingPathComponent("doc.txt") }
    var files: URL { root.appendingPathComponent("files", isDirectory: true) }

    init() throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent("tc-commit-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: files, withIntermediateDirectories: true)
        try "one\n".write(to: doc, atomically: false, encoding: .utf8)
        try "a\n".write(to: files.appendingPathComponent("alpha.txt"), atomically: false, encoding: .utf8)
    }

    func cleanup() { try? FileManager.default.removeItem(at: root) }

    /// Writes in place with a later mtime, as a save does.
    func save(_ text: String) throws {
        try text.write(to: doc, atomically: false, encoding: .utf8)
        try FileManager.default.setAttributes([.modificationDate: Date().addingTimeInterval(5)], ofItemAtPath: doc.path)
    }
}

private func key(_ text: String) -> ComputerAction { ComputerAction(action: .key, text: text) }

/// The commit check's rule over a real file and folder (docs/computer-protocol.md §26.8).
@Suite struct CommitCheckTests {
    @Test func aWindowWithNoFileIsNotChecked() {
        #expect(CommitCheck.begin(CommitContext(action: key("super+s")), state: nil) == nil)
        #expect(CommitCheck.begin(CommitContext(action: key("super+s")), state: DocumentState(url: nil, edited: true)) == nil)
        #expect(CommitCheck.begin(CommitContext(action: key("super+s")), state: DocumentState(url: "https://example.com/a", edited: nil)) == nil)
    }

    @Test func aSaveThatWritesTheFileReadsChangedAndNamesIt() throws {
        let s = try Scratch()
        defer { s.cleanup() }
        let check = try #require(CommitCheck.begin(CommitContext(action: key("super+s")), state: DocumentState(url: s.doc.absoluteString, edited: true)))
        #expect(check.expected == .save && check.expectsBefore)
        #expect(check.waiting(check.diff(DocumentState(url: s.doc.absoluteString, edited: true))))
        try s.save("two\n")
        let disk = check.diff(DocumentState(url: s.doc.absoluteString, edited: false), home: "/nowhere")
        #expect(!check.waiting(disk))
        let (effect, part) = check.judge(window: .none, disk: disk)
        #expect(effect == .changed)
        #expect(part?.saved == s.doc.path)
        #expect(part?.edited == DiskChange.Edited(before: true, after: false))
    }

    @Test func aSaveThatOnlyClearsTheEditedFlagIsChanged() throws {
        let s = try Scratch()
        defer { s.cleanup() }
        let check = try #require(CommitCheck.begin(CommitContext(action: key("super+s")), state: DocumentState(url: s.doc.absoluteString, edited: true)))
        let disk = check.diff(DocumentState(url: s.doc.absoluteString, edited: false))
        #expect(!check.waiting(disk))
        #expect(check.judge(window: .none, disk: disk).0 == .changed)
    }

    @Test func anInlineRenameThatChangedOnlyTheWindowIsOnScreenOnly() throws {
        let s = try Scratch()
        defer { s.cleanup() }
        let context = CommitContext(action: key("Return"), element: CommitElement(role: "input", inRow: true))
        let check = try #require(CommitCheck.begin(context, state: DocumentState(url: s.files.absoluteString, edited: nil)))
        #expect(check.document == .folder(s.files.path))
        #expect(check.expected == .rename && check.expectsBefore)
        let disk = check.diff(DocumentState(url: s.files.absoluteString, edited: nil))
        #expect(disk == nil && check.waiting(disk))
        let (effect, part) = check.judge(window: .changed, disk: disk)
        #expect(effect == .uncommitted)
        #expect(part?.hint == "commit it with key Return in the field")
    }

    @Test func aRenameOnDiskKeepsTheInodeAndReadsRenamed() throws {
        let s = try Scratch()
        defer { s.cleanup() }
        let context = CommitContext(action: key("Return"), element: CommitElement(role: "input", inRow: true))
        let check = try #require(CommitCheck.begin(context, state: DocumentState(url: s.files.absoluteString, edited: nil)))
        try FileManager.default.moveItem(at: s.files.appendingPathComponent("alpha.txt"), to: s.files.appendingPathComponent("gamma.txt"))
        let disk = check.diff(DocumentState(url: s.files.absoluteString, edited: nil), home: "/nowhere")
        #expect(disk?.renamed == [DiskChange.Renamed(from: s.files.appendingPathComponent("alpha.txt").path, to: s.files.appendingPathComponent("gamma.txt").path)])
        #expect(check.judge(window: .changed, disk: disk).0 == .changed)
    }

    @Test func aStepNotExpectedToCommitNamesAnAutosave() throws {
        let s = try Scratch()
        defer { s.cleanup() }
        let check = try #require(CommitCheck.begin(CommitContext(action: ComputerAction(action: .type, text: "x")), state: DocumentState(url: s.doc.absoluteString, edited: false)))
        #expect(check.expected == nil && !check.expectsBefore)
        #expect(!check.waiting(nil))
        try s.save("autosaved\n")
        let disk = check.diff(DocumentState(url: s.doc.absoluteString, edited: true))
        #expect(disk?.unexpected == true)
        #expect(check.judge(window: .changed, disk: disk).0 == .changed)
    }
}

/// The check inside `action.run`, over the fake Input and a document reader the test gives.
@Suite struct CommitCheckServiceTests {
    private func run(_ rig: ServiceRig, _ action: String) async throws -> JSONValue {
        let result = try #require(await rig.call("action.run", "{\(docTarget),\"action\":\(action),\"tiers\":[\"ax\",\"process\",\"front\"],\"wait\":\(quick),\"observe\":{\"mode\":\"none\"}}").result)
        return try #require(result["step"])
    }

    @Test func aSaveTheAppWroteCarriesItsDiskPart() async throws {
        let s = try Scratch()
        defer { s.cleanup() }
        let rig = ServiceRig()
        await rig.ready(features: ["front", "commit", "save_as"])
        let edited = Box<Bool>()
        edited.value = true
        let url = s.doc.absoluteString
        rig.service.documentReader = { _ in DocumentState(url: url, edited: edited.value ?? true) }
        rig.input.onPerform = { _, target in
            #expect(target.commitExpected?(ComputerAction(action: .key, text: "super+s")) == true)
            try? s.save("saved\n")
            edited.value = false
            return InputOutcome(tier: .front, via: .menu, clipboard: nil, cursor: nil, lastInputAt: 1, on: "File › Save")
        }
        let step = try await run(rig, #"{"action":"key","text":"super+s"}"#)
        #expect(step["effect"]?.stringValue == "changed")
        #expect(step["disk"]?["saved"]?.stringValue == FileFacts_tilde(s.doc.path))
        #expect(step["disk"]?["edited"]?["after"]?.boolValue == false)
    }

    @Test func anOlderHostGetsNoCheck() async throws {
        let s = try Scratch()
        defer { s.cleanup() }
        let rig = ServiceRig()
        await rig.ready()
        let url = s.doc.absoluteString
        let read = Box<Int>()
        rig.service.documentReader = { _ in
            read.value = (read.value ?? 0) + 1
            return DocumentState(url: url, edited: true)
        }
        rig.input.onPerform = { _, target in
            #expect(target.commitExpected == nil)
            return InputOutcome(tier: .process, via: nil, clipboard: nil, cursor: nil, lastInputAt: 1)
        }
        let step = try await run(rig, #"{"action":"key","text":"super+s"}"#)
        #expect(step["disk"] == nil)
        #expect(read.value == nil)
    }
}

/// `~`-relative as the service writes it.
private func FileFacts_tilde(_ path: String) -> String { tildeRelative(path, home: NSHomeDirectory()) }

/// The document line (§26.10) is asked for only from a host whose parser reads it.
@Suite struct DocumentLineGateTests {
    @Test func aHostThatListedCommitGetsTheLineAndAnOlderOneDoesNot() async throws {
        let newer = ServiceRig()
        await newer.ready(features: ["front", "commit", "save_as"])
        _ = try #require(await newer.call("state.get", "{\(docTarget),\"wait\":\(quick)}").result)
        #expect(newer.reader().observed.last?.document == true)
        let older = ServiceRig()
        await older.ready()
        _ = try #require(await older.call("state.get", "{\(docTarget),\"wait\":\(quick)}").result)
        #expect(older.reader().observed.last?.document == false)
    }
}

/// The menus a call left open (§26.11): its closing read notes them, then the call closes them.
@Suite struct MenuCloseServiceTests {
    @Test func anActionsClosingReadAsksForTheNoteAndTheCallClosesWhatItWalked() async throws {
        let rig = ServiceRig()
        await rig.ready(features: ["front", "commit", "save_as"])
        // a context menu read as a root, of a pid that is gone: the cancel leaves nothing to read
        rig.reader().menus = [OpenMenu(menu: AXUIElementCreateApplication(999_999), opener: nil, kind: .context, title: "context menu", items: ["Copy"])]
        rig.input.onPerform = { _, _ in InputOutcome(tier: .ax, via: nil, clipboard: nil, cursor: nil, lastInputAt: 1) }
        let result = try #require(await rig.call("action.run", "{\(docTarget),\"action\":{\"action\":\"left_click\",\"coordinate\":[10,10]},\"tiers\":[\"ax\",\"process\"],\"wait\":\(quick)}").result)
        #expect(rig.reader().observed.last?.closingMenus == true)
        #expect(rig.reader().menusAsked == 1)
        #expect(result["menusLeftOpen"] == nil)
    }

    @Test func aReadOfItsOwnClosesNothingAndAnOlderHostGetsNoNote() async throws {
        let rig = ServiceRig()
        await rig.ready()
        _ = try #require(await rig.call("state.get", "{\(docTarget),\"wait\":\(quick)}").result)
        #expect(rig.reader().observed.last?.closingMenus == false)
        #expect(rig.reader().menusAsked == 0)
        rig.input.onPerform = { _, _ in InputOutcome(tier: .ax, via: nil, clipboard: nil, cursor: nil, lastInputAt: 1) }
        _ = try #require(await rig.call("action.run", "{\(docTarget),\"action\":{\"action\":\"left_click\",\"coordinate\":[10,10]},\"tiers\":[\"ax\"],\"wait\":\(quick)}").result)
        #expect(rig.reader().observed.last?.closingMenus == false)
    }
}
