import ActivityKit
import Foundation
import TempCodeContract

/// The Live Activity for a host's running threads: for one thread, what the desktop's running row
/// shows (the type glyph, the title, the task in progress, the tally and the
/// elapsed time) on the lock screen and in the Dynamic Island; for two or
/// more, a row per thread (`ContentState.threads`). The attributes name the
/// thread that started it; a group's rows name their own. The app
/// starts it; the host updates it by push (`liveactivity`, through its own
/// APNs sender or the hub) and ends it when the thread settles; while the
/// socket is up the app updates it from the session metas itself. Compiled
/// into the app and the extension. The content state and the words derived
/// from it live in ThreadActivityText.swift, which has no ActivityKit so the
/// client package's tests can compile it.
nonisolated struct ThreadActivityAttributes: ActivityAttributes {
    /// What the host pushes as `content-state`; keys match `HubActivityState`
    /// (src/main/server/hub.ts) and the hub's `ActivityState`.
    typealias ContentState = ThreadActivityContent
    typealias Phase = ThreadActivityPhase
    typealias Unit = ThreadActivityUnit

    var environmentId: String
    var sessionId: String
    var title: String
    var threadType: ThreadType

    /// `tempcode://thread/<environment>/<session>?seq=<n>`: the app routes a tap
    /// the way a notification tap routes, to the thread and its card.
    func url(seq: Int?) -> URL? { url(sessionId: sessionId, seq: seq) }

    /// Another thread on the same host: a group card's row.
    func url(sessionId: String, seq: Int? = nil) -> URL? {
        var parts = URLComponents()
        parts.scheme = "tempcode"
        parts.host = "thread"
        parts.path = "/\(environmentId)/\(sessionId)"
        if let seq { parts.queryItems = [URLQueryItem(name: "seq", value: String(seq))] }
        return parts.url
    }

    /// A group card's own tap: Home, where every thread it lists is.
    static let homeURL = URL(string: "tempcode://home")

    /// What a single-thread presentation draws: the attributes' own thread, or the one row a group has left
    /// (another thread than the one that started the activity, with its own type, title and link).
    func single(_ state: ContentState) -> (attributes: ThreadActivityAttributes, state: ContentState) {
        guard let row = state.soloRow else { return (self, state) }
        let attributes = ThreadActivityAttributes(environmentId: environmentId, sessionId: row.id, title: row.title ?? title, threadType: row.type.map(ThreadType.init(rawValue:)) ?? threadType)
        return (attributes, state.state(of: row))
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
