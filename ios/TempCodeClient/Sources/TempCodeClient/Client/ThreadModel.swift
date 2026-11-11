import Foundation
import Observation

/// One held thread, observed on its own. The client keeps these in a
/// dictionary nothing observes, so a write to one thread wakes that
/// thread's readers and no other's. `ThreadState` stays the value it was,
/// with its mutating methods, inside: every write goes through `mutate`,
/// in place, so neither the rows nor the fold's items are copied.
///
/// A view takes the model, never the state: a view that kept a
/// `ThreadState` would share its arrays, and the next push would copy
/// every row to write one. What a view reads decides when it runs again:
///
/// - `content`: what the transcript's rows are built from moved;
/// - `dock`: what the bottom dock draws of the thread;
/// - `flags`: loading, older rows, live, gone;
/// - `overlays`: this device's undecided approvals and answers;
/// - `state`: the whole state, at every write (a board, the frame).
///
/// Each of the four is assigned only when its value changed. `value` is
/// the state with nothing tracked, for code that acts and draws nothing.
@MainActor @Observable
public final class ThreadModel {
    /// What the transcript's rows are built from, by the marks that move
    /// when it does (`TranscriptModel`): the fold and its writes, the
    /// pending turns, the open turn, and the newest seq.
    public struct Content: Sendable, Equatable {
        public var epoch: Int
        public var generation: Int
        public var turnOpen: Bool
        public var pending: [PendingTurn]
        public var lastSeq: Int

        init(_ state: ThreadState) {
            epoch = state.fold.changes.epoch
            generation = state.fold.changes.generation
            turnOpen = state.fold.board.turnOpen
            pending = state.pending
            lastSeq = state.fold.lastSeq
        }
    }

    public struct Flags: Sendable, Equatable {
        public var isLoading: Bool
        public var isLoadingOlder: Bool
        public var isLoadingHistory: Bool
        public var historyError: String?
        public var moreBefore: Bool
        public var isLive: Bool
        public var goneReason: String?
        /// Rows are held: a painted tail, or a thread that has landed.
        public var hasRows: Bool

        init(_ state: ThreadState) {
            isLoading = state.isLoading
            isLoadingOlder = state.isLoadingOlder
            isLoadingHistory = state.isLoadingHistory
            historyError = state.historyError
            moreBefore = state.moreBefore
            isLive = state.isLive
            goneReason = state.goneReason
            hasRows = !state.rows.isEmpty
        }
    }

    public struct Overlays: Sendable, Equatable {
        public var decisions: [String: Bool]
        public var deciding: Set<String>
        public var refusals: [String: String]
        public var answers: [String: [[String]]]

        init(_ state: ThreadState) {
            decisions = state.decisions
            deciding = state.deciding
            refusals = state.refusals
            answers = state.answers
        }
    }

    /// The state, read with nothing tracked.
    @ObservationIgnored public private(set) var value: ThreadState
    /// Moves at every write: what a reader of `state` waits on.
    private var writes = 0
    public private(set) var content: Content
    public private(set) var dock: DockState
    public private(set) var flags: Flags
    public private(set) var overlays: Overlays

    init(_ state: ThreadState) {
        value = state
        content = Content(state)
        dock = DockState(state)
        flags = Flags(state)
        overlays = Overlays(state)
    }

    /// The whole state; its reader runs again at every write to this thread.
    public var state: ThreadState {
        _ = writes
        return value
    }

    /// One write to the thread, in place. Nothing in `body` may read the model.
    @discardableResult
    func mutate<T>(_ body: (inout ThreadState) -> T) -> T {
        let result = body(&value)
        writes &+= 1
        let content = Content(value)
        if content != self.content { self.content = content }
        let dock = DockState(value)
        if dock != self.dock { self.dock = dock }
        let flags = Flags(value)
        if flags != self.flags { self.flags = flags }
        let overlays = Overlays(value)
        if overlays != self.overlays { self.overlays = overlays }
        return result
    }
}
