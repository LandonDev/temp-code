import ActivityKit
import Foundation
import TempCodeContract

/// The Live Activity for a running thread: what the fixed working strip
/// shows (the type glyph, the title, the flavour word and the elapsed time)
/// on the lock screen and in the Dynamic Island. The app starts it; the host
/// updates it by push through the hub (`liveactivity`) and ends it when the
/// thread settles. Compiled into the app and the extension.
struct ThreadActivityAttributes: ActivityAttributes {
    /// What the host pushes as `content-state`; keys match the hub's payload.
    struct ContentState: Codable, Hashable {
        var phase: Phase
        /// Clock milliseconds when the current stretch of work began (`busySince`).
        var since: Int
        /// Clock milliseconds of this state; seeds the flavour word.
        var ts: Int
        /// The row a tap lands on: the prompt, the error, the last row.
        var seq: Int?

        init(phase: Phase, since: Int, ts: Int, seq: Int? = nil) {
            self.phase = phase
            self.since = since
            self.ts = ts
            self.seq = seq
        }
    }

    enum Phase: String, Codable, Hashable {
        case working, paused, waiting, finished, failed

        /// The strip's word for a settled phase; a working one shows the flavour word.
        var label: String {
            switch self {
            case .working: "Working"
            case .paused: "Paused"
            case .waiting: "Waiting for you"
            case .finished: "Finished"
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
/// the word turns every seven seconds. Shared by the working strip and the
/// Live Activity (which shows the word of its last update).
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
