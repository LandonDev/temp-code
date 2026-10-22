import Foundation
import TempCodeContract

/// A thread's notes as this client holds them: fetched once per launch on
/// first use, replaced by every `notes` push. Nothing is cached to disk: the
/// notes are one round trip, and the glyph's read mark lives on the device.
public struct NotesState: Sendable, Hashable {
    public var doc: ThreadNotesDoc?
    public var isLoading = false
    /// What the last fetch hit, for the sheet's retry line; cleared once a doc is held.
    public var error: ActionError?

    public init(doc: ThreadNotesDoc? = nil, isLoading: Bool = false, error: ActionError? = nil) {
        self.doc = doc
        self.isLoading = isLoading
        self.error = error
    }
}

extension EnvironmentClient {
    /// The notes, from memory when held (unless `refresh`), else one
    /// `session.notes.get`. Returns what is held after the call; a fetch
    /// already out is not doubled, the observable delivers its answer.
    public func loadNotes(_ sessionId: String, refresh: Bool = false) async -> ThreadNotesDoc? {
        if let held = notes[sessionId], held.doc != nil, !refresh { return held.doc }
        if notes[sessionId]?.isLoading == true { return notes[sessionId]?.doc }
        notes[sessionId, default: NotesState()].isLoading = true
        // The fetch outlives the caller: a Home row leaving mid-fetch must not
        // leave the thread with no doc and no error for the sheet to find.
        let fetch = Task { [weak self] () -> ThreadNotesDoc? in
            guard let self else { return nil }
            defer { self.notes[sessionId]?.isLoading = false }
            do {
                let doc = try await self.request(Methods.SessionNotesGet.self, .init(sessionId: sessionId))
                // A thread removed during the fetch stays gone.
                guard self.notes[sessionId] != nil else { return doc }
                self.notes[sessionId] = NotesState(doc: doc)
                return doc
            } catch {
                if self.notes[sessionId] != nil { self.notes[sessionId]?.error = ActionError.wrap(error) }
                return self.notes[sessionId]?.doc
            }
        }
        return await fetch.value
    }

    /// The person's whole-text edit: the host writes the file, mirrors it and
    /// pushes; the answer is held at once. A read key is refused before the wire.
    public func saveNotes(_ sessionId: String, text: String) async throws -> ThreadNotesDoc {
        if let block = operateBlock { throw ActionError.blocked(block) }
        do {
            let doc = try await request(Methods.SessionNotesSet.self, .init(sessionId: sessionId, text: text))
            if session(sessionId) != nil { notes[sessionId] = NotesState(doc: doc) }
            return doc
        } catch {
            throw ActionError.wrap(error)
        }
    }

    /// The `notes` push: the host's text wins over whatever is held.
    func applyNotes(_ push: NotesPush) {
        guard notes[push.sessionId]?.doc != push.doc else { return }
        notes[push.sessionId] = NotesState(doc: push.doc)
    }
}
