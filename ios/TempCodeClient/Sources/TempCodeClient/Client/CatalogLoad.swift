/// Which host's catalog a model picker holds (the app's `CatalogChoice`).
/// A picker that moves to another host (a draft's host switched) loads that
/// host's catalog anew and holds none meanwhile, so nothing is sent with a
/// model the new host cannot run; an answer for an ask no longer wanted is
/// dropped. An ask made while the host's link was down comes back empty
/// (`notConnected`); the link coming up is a new `Trigger`, which asks again,
/// so a draft opened before its host connected still gets its catalog.
public struct CatalogLoad: Sendable, Hashable {
    /// What a picker's load is keyed on: the host it reads and whether that
    /// host's link is open. The view runs its load task by this value, so the
    /// link coming up runs it again.
    public struct Trigger: Sendable, Hashable {
        public var host: String
        public var open: Bool

        public init(host: String, open: Bool) {
            self.host = host
            self.open = open
        }

        public init(host: String, transport: TransportState) {
            self.init(host: host, open: transport == .open)
        }
    }

    /// The ask in flight, or the last one made.
    public private(set) var asked: Trigger?
    /// The ask in flight has not answered yet.
    public private(set) var pending = false
    /// A catalog for `asked.host` landed.
    public private(set) var loaded = false

    public init() {}

    /// The host asked for last.
    public var host: String? { asked?.host }

    /// True when `trigger` needs a load: none asked yet, another host, or the
    /// same host with no catalog yet and not the very ask already in flight
    /// (an empty answer, or the link coming up under an ask that will fail).
    public mutating func begin(_ trigger: Trigger) -> Bool {
        if let asked, asked.host == trigger.host, loaded || (pending && asked == trigger) { return false }
        asked = trigger
        pending = true
        loaded = false
        return true
    }

    /// True when the answer for `trigger` is still the one wanted.
    public func lands(_ trigger: Trigger) -> Bool { asked == trigger }

    /// The answer for `trigger` came: a catalog, or nothing (the next `begin`
    /// for that host tries again).
    public mutating func finish(_ trigger: Trigger, loaded: Bool) {
        guard asked == trigger else { return }
        pending = false
        self.loaded = loaded
    }

    /// The row's one line while the catalog waits on its host's link, in the
    /// row's words: "Waiting for box"; nil once a catalog is held or while
    /// the link is open (the ask is out, or came back with nothing to say).
    public static func waitLine(hostName: String, transport: TransportState, hasCatalog: Bool) -> String? {
        guard !hasCatalog, transport != .open else { return nil }
        return "Waiting for \(hostName)"
    }
}
