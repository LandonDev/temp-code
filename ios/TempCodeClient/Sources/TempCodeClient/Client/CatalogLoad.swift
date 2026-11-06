/// Which host's catalog a model picker holds (the app's `CatalogChoice`).
/// A picker that moves to another host (a draft's host switched) loads that
/// host's catalog anew and holds none meanwhile, so nothing is sent with a
/// model the new host cannot run; an answer for a host no longer asked for
/// is dropped.
public struct CatalogLoad: Sendable, Hashable {
    /// The host asked for last.
    public private(set) var host: String?

    public init() {}

    /// True when `host` needs a load: none asked yet, or another host's.
    public mutating func begin(_ host: String) -> Bool {
        guard self.host != host else { return false }
        self.host = host
        return true
    }

    /// True when the answer for `host` is still the one wanted.
    public func lands(_ host: String) -> Bool { self.host == host }

    /// The load for `host` brought nothing back: the next `begin` tries again.
    public mutating func failed(_ host: String) {
        if self.host == host { self.host = nil }
    }
}
