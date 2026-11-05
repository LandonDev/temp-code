import Foundation
import TempCodeContract

/// The words of a held state in the slot above the composer (paused,
/// stopped, queued) and of a turn's phase in the header: a title in the
/// label color and, when there is more to say, a quieter detail drawn as
/// its own text beside it (never joined with a dot).
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
