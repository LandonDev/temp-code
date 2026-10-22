import Foundation
import TempCodeContract

/// The actions the host's own rows offer: the failure card's Retry and
/// Route automatically, the review card's Merge anyway. Each runs the gate
/// `Actions.block` the way `approve` does and throws an `ActionError`.
extension EnvironmentClient {
    /// The failure card's Retry: `session.continue`, the desktop's continueSession.
    public func continueThread(_ sessionId: String) async throws {
        if let block = operateBlock { throw ActionError.blocked(block) }
        do {
            _ = try await request(Methods.SessionContinue.self, .init(sessionId: sessionId))
        } catch {
            throw ActionError.wrap(error)
        }
    }

    /// Route automatically: the host re-picks the account; `moved` false means nothing had room.
    public func reroute(_ sessionId: String) async throws -> RerouteAnswer {
        if let block = operateBlock { throw ActionError.blocked(block) }
        do {
            return try await request(Methods.SessionReroute.self, .init(sessionId: sessionId))
        } catch {
            throw ActionError.wrap(error)
        }
    }

    /// Merge past a held review: `review.override`, an approve-key action.
    public func mergeAnyway(_ sessionId: String, runId: String) async throws {
        if let block = approveBlock { throw ActionError.blocked(block) }
        do {
            _ = try await request(Methods.ReviewOverride.self, .init(sessionId: sessionId, runId: runId))
        } catch {
            throw ActionError.wrap(error)
        }
    }
}
