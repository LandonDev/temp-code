import Foundation
import TempCodeContract

/// The working strip's six states, from the session's status and whether a
/// turn this device sent is still in flight. The app has no unit test
/// target, so the rule lives here where SteeringTests reaches it.
public enum WorkingPhase: Hashable, Sendable {
    case idle
    case sending
    case working
    case paused
    case stopped
    case queued

    /// A waiting thread is `idle` here: its card, the segment dot and Home's
    /// needs-you row already say so, and the row says nothing twice. A
    /// watching master is idle too: its harness is up but nothing runs.
    public init(status: SessionStatus?, sending: Bool) {
        switch status {
        case .paused?: self = .paused
        case .stopped?: self = .stopped
        case .queued?: self = .queued
        case .running?: self = .working
        case .starting?: self = sending ? .sending : .working
        default: self = sending ? .sending : .idle
        }
    }

    /// The paused master's batch line: how many of its batch's roots are
    /// paused with it (the desktop's `pausedText` rule). Roots only, never
    /// archived, carrying the master's id, and paused themselves.
    public static func batchPaused(of id: String, in sessions: [SessionMeta]) -> Int {
        sessions.count { $0.masterId == id && $0.parentId == nil && !$0.archived && $0.status == .paused }
    }
}

/// What the composer decides from the session: whether its button stops a
/// turn or sends, and what the empty field says.
public enum ComposerRules {
    /// A turn is running: the host says so, or this device just sent one.
    /// `watching` is not running: a watching master's button is Send.
    public static func running(status: SessionStatus?, sending: Bool) -> Bool {
        status == .running || status == .starting || sending
    }

    /// Stop while a turn runs and the box is empty; Send otherwise. A master
    /// mid-turn with text sends: the host whispers it into the live turn.
    public static func stops(running: Bool, hasText: Bool) -> Bool {
        running && !hasText
    }

    /// The field's placeholder: "Steer" for a root that takes direction (an
    /// implementation or orchestration thread, or a master of any type),
    /// "Message the agent" for a subagent, "Message" otherwise.
    public static func placeholder(for session: SessionMeta?) -> String {
        guard let session else { return "Message" }
        if session.parentId != nil { return "Message the agent" }
        if session.isMaster == true || session.threadType == .implementation || session.threadType == .orchestration { return "Steer" }
        return "Message"
    }
}
