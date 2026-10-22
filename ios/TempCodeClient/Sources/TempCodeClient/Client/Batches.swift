import Foundation
import TempCodeContract

/// A master's batch on this host (CLAUDE.md "Master threads"): the state
/// `batch.get` answers and the `batch` push carries, kept per master. The
/// host coalesces its pushes to four a second while a step's log streams;
/// the phone lands at most two a second, so a streaming console redraws the
/// board twice a second and the last state of a burst always lands.
extension EnvironmentClient {
    /// How far apart two landings of one master's batch are, at least.
    static let batchWindow: Duration = .milliseconds(500)

    /// The master's batch as last heard; nil until `batch.get` or the push.
    public func batchState(_ masterId: String) -> BatchState? { batches[masterId] }

    /// `batch.get` once. The board calls it on appear, on every socket open
    /// and every 5 s while it shows (the desktop's floor under the push).
    public func loadBatch(_ masterId: String) async {
        guard await socket.isOpen, let state = try? await request(Methods.BatchGet.self, .init(masterId: masterId)) else { return }
        publishBatch(state)
    }

    /// The push, coalesced: the first state in a window lands at once, the
    /// rest wait until the window after the last landing ends, and only the
    /// newest of them lands.
    func applyBatch(_ state: BatchState) {
        let id = state.masterId
        let now = ContinuousClock.now
        guard let last = batchLanded[id], now - last < Self.batchWindow else {
            publishBatch(state)
            return
        }
        batchPending[id] = state
        guard batchTimers[id] == nil else { return }
        let delay = Self.batchWindow - (now - last)
        batchTimers[id] = Task { [weak self] in
            try? await Task.sleep(for: delay)
            guard let self else { return }
            self.batchTimers[id] = nil
            if let pending = self.batchPending.removeValue(forKey: id) { self.publishBatch(pending) }
        }
    }

    /// Lands a state now; a state that waited behind it is superseded.
    func publishBatch(_ state: BatchState) {
        batchLanded[state.masterId] = ContinuousClock.now
        batchPending[state.masterId] = nil
        if batches[state.masterId] != state { batches[state.masterId] = state }
    }
}
