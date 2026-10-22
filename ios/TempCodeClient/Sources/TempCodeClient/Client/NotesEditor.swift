import Foundation
import Observation
import TempCodeContract

public enum NotesSaveState: Sendable, Hashable {
    case idle
    case saving
    case saved
    case failed
}

/// One edit of a thread's notes on the phone: the draft the text editor is
/// bound to, a save after a quiet period, a save on Done and on dismiss, a
/// failed save that keeps the text for the next try, and a remote change
/// measured against the text the edit began from. The view owns none of the
/// timing; the save is injected so the rules are tested without a host.
@MainActor @Observable
public final class NotesEditor {
    public private(set) var editing = false
    /// What the text editor shows; `change` is the binding's setter.
    public var draft = ""
    public private(set) var state: NotesSaveState = .idle
    /// The text the edit began from, moved up by every save; a doc past it means the thread wrote meanwhile.
    public private(set) var base = ""
    public private(set) var dirty = false
    /// How long after the last keystroke the draft is saved (800 ms in the app).
    public let quiet: Duration
    private let save: @MainActor (String) async throws -> ThreadNotesDoc
    private var timer: Task<Void, Never>?
    /// The text of the save in flight: the host pushes it back before it answers, and that is not a remote change.
    private var sent: String?
    /// Bumped by `begin` and `loadTheirs`, so a save that answers after either changes nothing.
    private var generation = 0

    public init(quiet: Duration = .milliseconds(800), save: @escaping @MainActor (String) async throws -> ThreadNotesDoc) {
        self.quiet = quiet
        self.save = save
    }

    /// Starts editing from the doc: an empty or all-empty one starts from the five headings.
    public func begin(from doc: ThreadNotesDoc?) {
        timer?.cancel()
        timer = nil
        generation += 1
        base = doc?.text ?? ""
        draft = Notes.isEmpty(base) ? Notes.empty() : base
        dirty = false
        state = .idle
        editing = true
    }

    /// A keystroke: the draft moves and the quiet period starts over.
    public func change(_ text: String) {
        guard text != draft else { return }
        draft = text
        dirty = true
        timer?.cancel()
        timer = Task { [weak self, quiet] in
            try? await Task.sleep(for: quiet)
            guard !Task.isCancelled, let self else { return }
            // Past the quiet period: the next keystroke must not cancel this save.
            self.timer = nil
            await self.persist()
        }
    }

    /// Done: whatever is unsaved is saved now, and the edit ends.
    public func finish() async {
        await flush()
        editing = false
    }

    /// The dismiss path: whatever is unsaved is saved now; the edit stays as it was.
    public func flush() async {
        timer?.cancel()
        timer = nil
        if dirty { await persist() }
    }

    /// The thread wrote the notes since this edit began (or last saved).
    public func remoteChanged(_ doc: ThreadNotesDoc?) -> Bool {
        guard editing, let doc else { return false }
        return doc.text != base && doc.text != sent && doc.text != draft
    }

    /// Take the thread's text as the new starting point, dropping the draft.
    public func loadTheirs(_ doc: ThreadNotesDoc?) {
        timer?.cancel()
        timer = nil
        generation += 1
        base = doc?.text ?? ""
        draft = Notes.isEmpty(base) ? Notes.empty() : base
        dirty = false
        state = .idle
    }

    /// Saves the draft as it is now; a keystroke during the save keeps `dirty`
    /// so the next quiet period saves it. The draft is never touched.
    private func persist() async {
        let text = draft
        let started = generation
        sent = text
        state = .saving
        defer { if sent == text { sent = nil } }
        do {
            let saved = try await save(text)
            guard generation == started else { return }
            base = saved.text
            if draft == text { dirty = false }
            state = .saved
        } catch {
            guard generation == started else { return }
            state = .failed
        }
    }
}
