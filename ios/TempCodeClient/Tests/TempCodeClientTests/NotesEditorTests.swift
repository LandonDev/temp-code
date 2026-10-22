import Foundation
import Testing
import TempCodeContract
@testable import TempCodeClient

/// Records every save; `failing` makes each one throw.
@MainActor
private final class SaveRecorder {
    var saved: [String] = []
    var failing = false

    func save(_ text: String) async throws -> ThreadNotesDoc {
        if failing { throw ActionError.refused(message: "no", forbidden: false) }
        saved.append(text)
        return ThreadNotesDoc(text: text, updatedAt: Double(saved.count), path: nil)
    }
}

@MainActor
private func wait(_ predicate: () -> Bool) async -> Bool {
    for _ in 0..<1000 {
        if predicate() { return true }
        try? await Task.sleep(for: .milliseconds(2))
    }
    return false
}

private let quiet: Duration = .milliseconds(20)
private let filled = ThreadNotesDoc(text: "## Goal\n\nShip.\n", updatedAt: 1, path: nil)

@MainActor
@Suite struct NotesEditorTests {
    @Test func `one keystroke saves once with that text after the quiet period`() async {
        let recorder = SaveRecorder()
        let editor = NotesEditor(quiet: quiet) { try await recorder.save($0) }
        editor.begin(from: filled)
        #expect(editor.editing)
        #expect(editor.draft == filled.text)
        editor.change("## Goal\n\nShip it.\n")
        #expect(editor.dirty)
        #expect(recorder.saved.isEmpty, "nothing before the quiet period")
        #expect(await wait { editor.state == .saved })
        #expect(recorder.saved == ["## Goal\n\nShip it.\n"])
        #expect(!editor.dirty)
        #expect(editor.base == "## Goal\n\nShip it.\n")
        #expect(editor.editing, "a save does not end the edit")
    }

    @Test func `two keystrokes inside the window save once with the last text`() async {
        let recorder = SaveRecorder()
        let editor = NotesEditor(quiet: quiet) { try await recorder.save($0) }
        editor.begin(from: filled)
        editor.change("## Goal\n\nShip i\n")
        try? await Task.sleep(for: .milliseconds(5))
        editor.change("## Goal\n\nShip it.\n")
        #expect(await wait { editor.state == .saved })
        try? await Task.sleep(for: .milliseconds(40))
        #expect(recorder.saved == ["## Goal\n\nShip it.\n"])
    }

    @Test func `finish saves at once when dirty, not when clean, and ends the edit`() async {
        let recorder = SaveRecorder()
        let editor = NotesEditor(quiet: .seconds(10)) { try await recorder.save($0) }
        editor.begin(from: filled)
        await editor.finish()
        #expect(recorder.saved.isEmpty)
        #expect(!editor.editing)
        editor.begin(from: filled)
        editor.change("## Goal\n\nDone.\n")
        await editor.finish()
        #expect(recorder.saved == ["## Goal\n\nDone.\n"])
        #expect(!editor.editing)
        #expect(!editor.dirty)
        #expect(editor.state == .saved)
    }

    @Test func `flush saves what is unsaved without ending the edit`() async {
        let recorder = SaveRecorder()
        let editor = NotesEditor(quiet: .seconds(10)) { try await recorder.save($0) }
        editor.begin(from: filled)
        editor.change("## Goal\n\nHalf\n")
        await editor.flush()
        #expect(recorder.saved == ["## Goal\n\nHalf\n"])
        #expect(editor.editing)
        #expect(!editor.dirty)
        await editor.flush()
        #expect(recorder.saved.count == 1, "a clean flush saves nothing")
    }

    @Test func `a failing save keeps the draft and dirty, so finish tries again`() async {
        let recorder = SaveRecorder()
        recorder.failing = true
        let editor = NotesEditor(quiet: quiet) { try await recorder.save($0) }
        editor.begin(from: filled)
        editor.change("## Goal\n\nTry.\n")
        #expect(await wait { editor.state == .failed })
        #expect(editor.draft == "## Goal\n\nTry.\n")
        #expect(editor.dirty)
        #expect(editor.base == filled.text)
        #expect(recorder.saved.isEmpty)
        recorder.failing = false
        await editor.finish()
        #expect(recorder.saved == ["## Goal\n\nTry.\n"])
        #expect(editor.state == .saved)
        #expect(!editor.dirty)
    }

    @Test func `remoteChanged is true only while editing and only for a text past base`() async {
        let recorder = SaveRecorder()
        let editor = NotesEditor(quiet: quiet) { try await recorder.save($0) }
        let theirs = ThreadNotesDoc(text: "## Goal\n\nTheirs.\n", updatedAt: 2, path: nil)
        #expect(!editor.remoteChanged(theirs), "not editing")
        editor.begin(from: filled)
        #expect(!editor.remoteChanged(nil))
        #expect(!editor.remoteChanged(filled))
        #expect(editor.remoteChanged(theirs))
        editor.change("## Goal\n\nMine.\n")
        #expect(await wait { editor.state == .saved })
        #expect(!editor.remoteChanged(ThreadNotesDoc(text: "## Goal\n\nMine.\n", updatedAt: 3, path: nil)), "the save moved base up")
        #expect(editor.remoteChanged(theirs))
        await editor.finish()
        #expect(!editor.remoteChanged(theirs), "the edit ended")
    }

    @Test func `loadTheirs resets the draft, the base and dirty`() async {
        let recorder = SaveRecorder()
        let editor = NotesEditor(quiet: .seconds(10)) { try await recorder.save($0) }
        editor.begin(from: filled)
        editor.change("## Goal\n\nMine.\n")
        let theirs = ThreadNotesDoc(text: "## Goal\n\nTheirs.\n", updatedAt: 2, path: nil)
        editor.loadTheirs(theirs)
        #expect(editor.draft == theirs.text)
        #expect(editor.base == theirs.text)
        #expect(!editor.dirty)
        #expect(!editor.remoteChanged(theirs))
        #expect(editor.editing)
        await editor.finish()
        #expect(recorder.saved.isEmpty, "the dropped draft is never saved")
    }

    @Test func `begin on no doc or an all-empty one starts from the five headings`() {
        let recorder = SaveRecorder()
        let editor = NotesEditor(quiet: quiet) { try await recorder.save($0) }
        editor.begin(from: nil)
        #expect(editor.draft == Notes.empty())
        #expect(editor.base == "")
        editor.begin(from: ThreadNotesDoc(text: Notes.empty(), updatedAt: nil, path: nil))
        #expect(editor.draft == Notes.empty())
        #expect(editor.base == Notes.empty())
        #expect(!editor.dirty)
        #expect(editor.state == .idle)
    }
}
