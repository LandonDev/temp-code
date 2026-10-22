import Foundation

/// A thread this host sent to another (the `session-moved` push; docs/box.md
/// "Moving a thread between hosts"): where it went and when. Kept in memory
/// for this process only; the thread lists under its new host from that
/// host's next `sessions` push, with its id and seqs intact, so the same
/// `sessionId` there is the same thread. A screen open on the thread shows
/// one line that opens it there when that host is paired.
public struct MovedThread: Sendable, Hashable {
    public var sessionId: String
    /// The destination's environment id.
    public var to: String
    public var subagents: [String]
    /// Milliseconds, the phone's clock.
    public var at: Int

    public init(sessionId: String, to: String, subagents: [String], at: Int) {
        self.sessionId = sessionId
        self.to = to
        self.subagents = subagents
        self.at = at
    }
}
