import Foundation
import Observation
import Synchronization
import Testing
import TempCodeContract
@testable import TempCodeClient

/// True when a reader that ran `read` was told of a change `change` made.
@MainActor
private func hears(_ read: () -> Void, when change: () -> Void) -> Bool {
    let told = Mutex(false)
    withObservationTracking(read) { told.withLock { $0 = true } }
    change()
    return told.withLock { $0 }
}

@MainActor
@Suite struct ComposerDraftTests {
    @Test func `a key tells the field, and tells a reader of has-content only when it flips`() {
        let draft = ComposerDraft()
        #expect(!draft.hasContent)
        #expect(hears({ _ = draft.hasContent }, when: { draft.type("h") }), "empty to filled")
        #expect(draft.hasContent)
        #expect(!hears({ _ = draft.hasContent }, when: { draft.type("he") }))
        #expect(!hears({ _ = draft.hasContent }, when: { draft.type("hello there") }))
        #expect(hears({ _ = draft.text }, when: { draft.type("hello there!") }), "the field reads every key")
        #expect(hears({ _ = draft.hasContent }, when: { draft.type("") }), "filled to empty")
        #expect(!draft.hasContent)
    }

    @Test func `a box of white space alone has no content, as the send's own trim says`() {
        let draft = ComposerDraft()
        for blank in ["", " ", "\n", "\n\n \t", "\u{3000}", " \u{3000}\n"] {
            draft.type(blank)
            #expect(!draft.hasContent, "\(blank.unicodeScalars.map(\.value))")
            #expect(draft.trimmed.isEmpty)
            #expect(ComposerDraft.hasContent(blank) == !blank.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
        draft.type("\n a \u{3000}")
        #expect(draft.hasContent)
        #expect(draft.trimmed == "a")
        #expect(draft.text == "\n a \u{3000}", "stored as the field gave it")
    }

    @Test func `only the field's own write is a person's edit`() {
        let draft = ComposerDraft()
        var edits = 0
        draft.onEdit = { edits += 1 }
        draft.seed("typed by the proof")
        draft.clear()
        draft.restore("given back")
        #expect(edits == 0)
        #expect(draft.text == "given back" && draft.hasContent)
        draft.type("given back!")
        #expect(edits == 1)
    }

    @Test func `a refused send gives its words back before what was typed since`() {
        let draft = ComposerDraft()
        draft.type("the sent words")
        draft.clear()
        #expect(draft.text.isEmpty && !draft.hasContent)
        // Nothing typed meanwhile: the sent text as it was.
        draft.restore("the sent words")
        #expect(draft.text == "the sent words")
        // Something typed meanwhile is kept, after a blank line.
        draft.clear()
        draft.type("and a second thought")
        draft.restore("the sent words")
        #expect(draft.text == "the sent words\n\nand a second thought")
        #expect(ComposerDraft.restored(sent: "a", later: "  \n") == "a")
    }

    @Test func `the height eases for a paste of lines and snaps for a key, read by bytes`() {
        #expect(!ComposerHeight.eases(from: "abc", to: "abcd"))
        #expect(!ComposerHeight.eases(from: "abc", to: "abc\n"), "Return is a key")
        #expect(ComposerHeight.eases(from: "abc", to: "abc\nline two\nline three"))
        #expect(!ComposerHeight.eases(from: "abc", to: "abc and a long paste on one line"))
        #expect(!ComposerHeight.eases(from: "abc\nline two", to: ""), "the clear after a send snaps")
        // One key of more than one byte adds no line.
        #expect(!ComposerHeight.eases(from: "abc", to: "abcé"))
        #expect(!ComposerHeight.eases(from: "abc", to: "abc日"))
    }
}

@Suite struct ComposerChromeTests {
    @Test func `the dock's copy of the session moves only with what the dock draws`() {
        let running = meta("s1", status: .running, updatedAt: 5, busySince: 100)
        let chrome = ComposerChrome(running)
        #expect(chrome.exists && chrome.status == .running && chrome.busySince == 100)
        #expect(chrome.placeholder == ComposerRules.placeholder(for: running))
        // The activity line, the time and the title are no part of it.
        #expect(ComposerChrome(meta("s1", status: .running, updatedAt: 9, title: "Renamed", activity: "Reading files", busySince: 100)) == chrome)
        // What it draws is: the status, the model, the meter, the turn's start.
        #expect(ComposerChrome(meta("s1", status: .idle, updatedAt: 5, busySince: 100)) != chrome)
        #expect(ComposerChrome(meta("s1", status: .running, updatedAt: 5, model: "claude-opus-5-5", busySince: 100)) != chrome)
        #expect(ComposerChrome(meta("s1", status: .running, updatedAt: 5, context: SessionMeta.Context(tokens: 10, window: 100), busySince: 100)) != chrome)
        #expect(ComposerChrome(meta("s1", status: .running, updatedAt: 5, busySince: 200)) != chrome)
        #expect(ComposerChrome(nil) == ComposerChrome(nil))
        #expect(!ComposerChrome(nil).exists && ComposerChrome(nil).placeholder == "Message")
    }

    @Test func `the frozen time, the queued words and the batch count ride only in the state that shows them`() {
        #expect(ComposerChrome(meta("s1", status: .running, frozenActiveElapsed: 9_000)).frozen == nil)
        #expect(ComposerChrome(meta("s1", status: .paused, frozenActiveElapsed: 9_000)).frozen == 9_000)
        #expect(ComposerChrome(meta("s1", status: .stopped, frozenActiveElapsed: 4_000)).frozen == 4_000)
        let queued = meta("s1", status: .queued, statusDetail: "waiting for a sibling")
        #expect(ComposerChrome(queued).queued == StatusWords.queuedLine(queued))
        #expect(ComposerChrome(meta("s1", status: .running, statusDetail: "waiting for a sibling")).queued == nil)
        #expect(ComposerChrome(meta("m", status: .paused, isMaster: true), pausedBatch: 3).pausedBatch == 3)
        #expect(ComposerChrome(meta("m", status: .running, isMaster: true), pausedBatch: 3).pausedBatch == 0)
        #expect(ComposerChrome(meta("s", status: .paused), pausedBatch: 3).pausedBatch == 0)
        #expect(ComposerChrome(meta("m", status: .paused, isMaster: true)).placeholder == "Steer")
    }
}
