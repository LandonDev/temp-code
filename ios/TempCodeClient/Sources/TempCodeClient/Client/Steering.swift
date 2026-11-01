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

/// The words the bar's status line shows for a phase that has any: a title
/// in the label color and, when there is more to say, a quieter detail
/// drawn as its own text beside it (never joined with a dot).
public struct StripWords: Hashable, Sendable {
    public let title: String
    public let detail: String?

    public init(title: String, detail: String? = nil) {
        self.title = title
        self.detail = detail
    }

    /// A stopped thread: the harness is gone, Resume brings it back.
    public static let stopped = StripWords(title: "Stopped", detail: "The harness is gone")

    /// A paused thread; on a master, how many of its batch threads paused with it.
    public static func paused(batch: Int) -> StripWords {
        StripWords(title: "Paused", detail: batch > 0 ? "\(batch) batch \(batch == 1 ? "thread" : "threads") with it" : nil)
    }

    /// A queued thread from an older host's activity line alone ("Queued
    /// waiting for <sibling>", two spaces after the word; older rows carry
    /// " · "): the title is "Queued" and the reason, with its first letter
    /// raised, is the detail. A current host's row goes through
    /// `StatusWords.queuedLine`, which prefers its `statusDetail`.
    public static func queued(activity: String?) -> StripWords {
        StripWords(title: "Queued", detail: StatusDetail.of(status: .queued, statusDetail: nil, activity: activity))
    }

    /// A turn's phase before its first content, as the host words it onto
    /// the activity line (sessions.ts `phaseLine`): "Starting the CLI",
    /// "Initializing", "Waiting for the provider, 25 s", "Rate limited,
    /// retry 3 in 32 s", "Provider overloaded, retry 1 in 5 s", "Retrying",
    /// "Reconnecting, retry 2 of 5". The words before the first ", " (the
    /// " · " of an older row) are the title, the rest (its first letter
    /// raised) the detail; nil for any other activity ("Thinking", a tool's
    /// line).
    public static func phase(activity: String?) -> StripWords? {
        guard let activity else { return nil }
        let split = activity.range(of: ", ") ?? activity.range(of: " · ")
        let title = split.map { String(activity[..<$0.lowerBound]) } ?? activity
        guard phaseTitles.contains(title) else { return nil }
        guard let split else { return StripWords(title: title) }
        let rest = activity[split.upperBound...]
        guard let first = rest.first else { return StripWords(title: title) }
        return StripWords(title: title, detail: first.uppercased() + rest.dropFirst())
    }

    private static let phaseTitles: Set<String> = [
        "Starting the CLI", "Initializing", "Waiting for the provider",
        "Rate limited", "Provider overloaded", "Retrying", "Reconnecting"
    ]
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
