import ActivityKit
import Foundation
import TempCodeContract

/// The Live Activity for a running thread: what the desktop's running row
/// shows (the type glyph, the title, the task in progress, the tally and the
/// elapsed time) on the lock screen and in the Dynamic Island. The app
/// starts it; the host updates it by push (`liveactivity`, through its own
/// APNs sender or the hub) and ends it when the thread settles; while the
/// socket is up the app updates it from the session metas itself. Compiled
/// into the app and the extension.
nonisolated struct ThreadActivityAttributes: ActivityAttributes {
    /// What the host pushes as `content-state`; keys match `HubActivityState`
    /// (src/main/server/hub.ts) and the hub's `ActivityState`. Everything but
    /// the phase and the clock is optional, so an older host's state decodes.
    nonisolated struct ContentState: Codable, Hashable {
        var phase: Phase
        /// Clock milliseconds when the current stretch of work began (`busySince`); the elapsed time ticks from here on the device.
        var since: Int
        /// Clock milliseconds of this state: where a paused or settled clock freezes.
        var ts: Int
        /// The row a tap lands on: the prompt, the error, the last row.
        var seq: Int?
        /// The thread's title at this state, so a rename shows without a restart.
        var title: String?
        /// The in-progress task of the thread's list, else what it is doing right now.
        var task: String?
        /// The list's tally, when the thread has one.
        var done: Int?
        var total: Int?
        /// Why the thread waits: the needs-you line ("Needs approval: Bash — bun test").
        var reason: String?

        init(phase: Phase, since: Int, ts: Int, seq: Int? = nil, title: String? = nil, task: String? = nil, done: Int? = nil, total: Int? = nil, reason: String? = nil) {
            self.phase = phase
            self.since = since
            self.ts = ts
            self.seq = seq
            self.title = title
            self.task = task
            self.done = done
            self.total = total
            self.reason = reason
        }

        var hasTasks: Bool { (total ?? 0) > 0 }

        /// "3/7", when the thread has a list.
        var tally: String? {
            guard let total, total > 0 else { return nil }
            return "\(min(done ?? 0, total))/\(total)"
        }

        var fraction: Double {
            guard let total, total > 0 else { return 0 }
            return min(1, max(0, Double(done ?? 0) / Double(total)))
        }

        /// The line beside the status word: the task while it works or pauses, the reason while it waits, nothing once settled.
        var line: String? {
            switch phase {
            case .working, .paused: task
            case .waiting: reason
            case .finished, .failed: nil
            }
        }

        /// Everything but the clock: what decides whether an update is worth sending.
        var shape: Shape { Shape(phase: phase, since: since, seq: seq, title: title, task: task, done: done, total: total, reason: reason) }

        nonisolated struct Shape: Hashable {
            var phase: Phase
            var since: Int
            var seq: Int?
            var title: String?
            var task: String?
            var done: Int?
            var total: Int?
            var reason: String?
        }
    }

    nonisolated enum Phase: String, Codable, Hashable, CaseIterable {
        case working, paused, waiting, finished, failed

        /// The status word: colored only where it carries meaning (paused and waiting warning, failed destructive, done success).
        var word: String {
            switch self {
            case .working: "Working"
            case .paused: "Paused"
            case .waiting: "Waiting"
            case .finished: "Done"
            case .failed: "Failed"
            }
        }

        var isLive: Bool { self == .working || self == .paused }
    }

    var environmentId: String
    var sessionId: String
    var title: String
    var threadType: ThreadType

    /// `tempcode://thread/<environment>/<session>?seq=<n>`: the app routes a tap
    /// the way a notification tap routes, to the thread and its card.
    func url(seq: Int?) -> URL? {
        var parts = URLComponents()
        parts.scheme = "tempcode"
        parts.host = "thread"
        parts.path = "/\(environmentId)/\(sessionId)"
        if let seq { parts.queryItems = [URLQueryItem(name: "seq", value: String(seq))] }
        return parts.url
    }
}

/// The desktop's flavour words, in its order; the seed is the thread's id and
/// the word turns every seven seconds. The working strip inside the app shows
/// them; the Live Activity shows the task instead.
enum Flavour {
    nonisolated static let words = ["Thinking", "Pondering", "Scheming", "Brewing", "Weaving", "Tinkering", "Musing", "Composing", "Sifting", "Untangling", "Distilling", "Sketching", "Plotting", "Riffing", "Combobulating", "Percolating", "Marinating", "Noodling", "Puzzling", "Conjuring"]

    nonisolated static func word(seed id: String, now: TimeInterval) -> String {
        var hash: Int32 = 0
        for scalar in id.unicodeScalars { hash = hash &* 31 &+ Int32(truncatingIfNeeded: scalar.value) }
        let seed = Int(abs(hash))
        let turn = Int(now * 1000 / 7000)
        return words[(seed + turn) % words.count]
    }
}
