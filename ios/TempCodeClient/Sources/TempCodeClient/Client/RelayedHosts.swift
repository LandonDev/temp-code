import Foundation
import Observation
import TempCodeContract

// MARK: - the state

/// The one word the phone acts on, the wire's `relayState` (src/shared/contract-relay.ts).
public enum RelayState: Sendable, Hashable, Codable {
    case available, locked, asleep, unreachable

    /// The only place `link`, `screen` and `power` are read. Order: a down link
    /// is unreachable whatever the screen says; asleep beats locked. An unknown
    /// screen counts as not locked, an unknown power as not asleep (the wire's
    /// `relayState` reads them the same way).
    public init(_ presence: HostPresence) {
        if presence.link.rawValue == "down" { self = .unreachable }
        else if presence.power.rawValue == "asleep" { self = .asleep }
        else if presence.screen.rawValue == "locked" { self = .locked }
        else { self = .available }
    }

    /// The relay forwards operate calls (`session.send`, approvals, rows) in this
    /// state: a locked Mac still answers every method the phone uses.
    public var admitsSends: Bool { self == .available || self == .locked }
}

/// A host reached through another: what the carrier's hello and `presence`
/// pushes said, kept on disk so a cold launch has the row before any socket
/// is up.
public struct RelayedHost: Sendable, Hashable, Codable, Identifiable {
    /// The relayed host's own environment id (the Mac's).
    public let id: String
    /// The carrier's environment id (the box's).
    public var via: String
    public var presence: HostPresence
    /// Wall-clock ms the phone first learned of it, for a stable order.
    public var learnedAt: Double
    /// Wall-clock ms (the phone's clock) when `state` last moved, for the
    /// locked line; nil until the phone has seen a move. The wire's `since`
    /// is the link's, never the lock's.
    public var stateSince: Int?

    public init(id: String, via: String, presence: HostPresence, learnedAt: Double, stateSince: Int? = nil) {
        self.id = id
        self.via = via
        self.presence = presence
        self.learnedAt = learnedAt
        self.stateSince = stateSince
    }

    public var name: String { presence.name }
    public var state: RelayState { RelayState(presence) }
}

/// One host whose `RelayState` moved in an apply.
public struct RelayedMove: Sendable, Hashable {
    public let id: String
    public let state: RelayState

    public init(id: String, state: RelayState) {
        self.id = id
        self.state = state
    }
}

/// What one apply changed, for the registry: ids added, ids removed, the ids
/// whose state moved (with the new state) and the ids whose name changed, so
/// the registry touches only those clients.
public struct RelayedChange: Sendable, Hashable {
    public var added: [String] = []
    public var removed: [String] = []
    public var moved: [RelayedMove] = []
    public var renamed: [String] = []

    public init(added: [String] = [], removed: [String] = [], moved: [RelayedMove] = [], renamed: [String] = []) {
        self.added = added
        self.removed = removed
        self.moved = moved
        self.renamed = renamed
    }

    public var isEmpty: Bool { added.isEmpty && removed.isEmpty && moved.isEmpty && renamed.isEmpty }
    /// The set of clients changed: a rebuild through `sync()` is due.
    public var needsSync: Bool { !added.isEmpty || !removed.isEmpty || !renamed.isEmpty }
}

// MARK: - the store

/// The relayed hosts of every carrier: fed by the carrier's hello (`hosts`)
/// and its `presence` push, and by a relayed lane's own hello (`presence`).
/// Persisted as `relayed.json` beside `environments.json`, in `learnedAt`
/// order. Pure except the file; the registry reacts to `onChange`.
@MainActor @Observable
public final class RelayedHosts {
    public private(set) var hosts: [RelayedHost]
    /// The registry's reaction: a host arrived, left, changed state or name.
    public var onChange: (@MainActor (RelayedChange) -> Void)?
    private let file: URL
    private let now: @MainActor () -> Double

    /// - Parameter directory: where `relayed.json` lives; `[]` when missing or unreadable.
    /// - Parameter now: wall-clock ms, for `learnedAt` and `stateSince`; tests fix it.
    public init(directory: URL, now: @escaping @MainActor () -> Double = { Date().timeIntervalSince1970 * 1000 }) {
        self.file = directory.appending(path: "relayed.json")
        self.now = now
        self.hosts = RelayedHosts.load(file)
    }

    public func host(_ id: String) -> RelayedHost? {
        hosts.first { $0.id == id }
    }

    /// This carrier's hosts, in the order they were learned.
    public func hosts(via carrier: String) -> [RelayedHost] {
        hosts.filter { $0.via == carrier }
    }

    /// nil for a host that is not relayed.
    public func state(of id: String) -> RelayState? {
        host(id)?.state
    }

    /// The whole list a carrier knows. A host of this carrier not in the list
    /// is gone from the box (it forgot it): dropped here too. Rows of other
    /// carriers are untouched, and a host another carrier already relays is
    /// left to that carrier. Saves on any change; `onChange` fires only when
    /// an id came, went, moved state or changed name (`lastSeenAt` alone
    /// never counts).
    public func apply(_ list: [HostPresence], via carrier: String) {
        let stamp = now()
        var change = RelayedChange()
        var next = hosts.filter { $0.via != carrier }
        let elsewhere = Set(next.map(\.id))
        let known = Dictionary(hosts.filter { $0.via == carrier }.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        var listed: Set<String> = []
        for presence in list where presence.environmentId != carrier && !elsewhere.contains(presence.environmentId) && !listed.contains(presence.environmentId) {
            listed.insert(presence.environmentId)
            if var row = known[presence.environmentId] {
                Self.take(presence, into: &row, change: &change, now: stamp)
                next.append(row)
            } else {
                next.append(RelayedHost(id: presence.environmentId, via: carrier, presence: presence, learnedAt: stamp))
                change.added.append(presence.environmentId)
            }
        }
        change.removed = known.keys.filter { !listed.contains($0) }.sorted()
        commit(next, change)
    }

    /// A single row (a relayed lane's hello `presence`). Never adds: a lane
    /// exists only for a host the carrier listed.
    public func update(_ presence: HostPresence, via carrier: String) {
        guard let at = hosts.firstIndex(where: { $0.id == presence.environmentId && $0.via == carrier }) else { return }
        var change = RelayedChange()
        var next = hosts
        Self.take(presence, into: &next[at], change: &change, now: now())
        commit(next, change)
    }

    /// The carrier was forgotten: every host through it goes.
    public func forget(via carrier: String) {
        let gone = hosts.filter { $0.via == carrier }.map(\.id)
        guard !gone.isEmpty else { return }
        commit(hosts.filter { $0.via != carrier }, RelayedChange(removed: gone))
    }

    private static func take(_ presence: HostPresence, into row: inout RelayedHost, change: inout RelayedChange, now: Double) {
        let was = row.state
        let name = row.name
        row.presence = presence
        if row.state != was {
            row.stateSince = Int(now)
            change.moved.append(RelayedMove(id: row.id, state: row.state))
        }
        if row.name != name { change.renamed.append(row.id) }
    }

    private func commit(_ next: [RelayedHost], _ change: RelayedChange) {
        let ordered = next.sorted { ($0.learnedAt, $0.id) < ($1.learnedAt, $1.id) }
        guard ordered != hosts else { return }
        hosts = ordered
        save()
        if !change.isEmpty { onChange?(change) }
    }

    private static func load(_ file: URL) -> [RelayedHost] {
        guard let data = try? Data(contentsOf: file) else { return [] }
        return (try? JSONDecoder().decode([RelayedHost].self, from: data)) ?? []
    }

    private func save() {
        do {
            try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
            try JSONEncoder().encode(hosts).write(to: file, options: .atomic)
        } catch {
            // The carrier's next hello rebuilds the list; losing it never loses a key.
        }
    }
}

// MARK: - the relayed environment

public extension PairedEnvironment {
    /// A host reached through `carrier`: the carrier's origin, key and caps
    /// under the relayed host's own id. Rebuilt from the carrier on every
    /// launch, never persisted itself.
    static func relayed(_ host: RelayedHost, through carrier: PairedEnvironment) -> PairedEnvironment {
        PairedEnvironment(id: host.id, name: host.name, origin: carrier.origin, caps: carrier.caps, keyId: carrier.keyId, keyName: carrier.keyName, addedAt: host.learnedAt, via: carrier.id)
    }
}

// MARK: - the words

/// Every sentence the phone says about a relayed host's presence, as pure
/// functions of the wire's row, so the app target holds only the SwiftUI
/// and every word has a test.
public enum RelayWords {
    /// "the Mac" for a darwin host, else the host's name; what every sentence is about.
    public static func subject(_ presence: HostPresence) -> String {
        presence.platform == "darwin" ? "the Mac" : presence.name
    }

    /// `9:14` today, `21 Oct 9:14` on another day: the box's clock (ms) in the
    /// calendar's zone, 24-hour, the month in the locale's short word. Pure:
    /// the calendar and locale are passed in, never the system's implicit ones.
    public static func since(_ ms: Int, now: Date, calendar: Calendar = .current, locale: Locale = .current) -> String {
        let date = Date(timeIntervalSince1970: Double(ms) / 1000)
        let parts = calendar.dateComponents([.day, .hour, .minute], from: date)
        let time = "\(parts.hour ?? 0):\(String(format: "%02d", parts.minute ?? 0))"
        if calendar.isDate(date, inSameDayAs: now) { return time }
        var style = Date.FormatStyle(locale: locale, calendar: calendar, timeZone: calendar.timeZone)
        style = style.month(.abbreviated)
        return "\(parts.day ?? 0) \(date.formatted(style)) \(time)"
    }

    /// The row's dim line, with no subject (the row's title is the host):
    /// nil when available; "locked since 9:14" (or "locked" before the phone
    /// saw the move) · "asleep" · "unreachable since 9:14".
    public static func rowLine(_ presence: HostPresence, lockedSince: Int?, now: Date, calendar: Calendar = .current, locale: Locale = .current) -> String? {
        switch RelayState(presence) {
        case .available:
            return nil
        case .locked:
            guard let lockedSince else { return "locked" }
            return "locked since \(since(lockedSince, now: now, calendar: calendar, locale: locale))"
        case .asleep:
            return "asleep"
        case .unreachable:
            return "unreachable since \(since(presence.since, now: now, calendar: calendar, locale: locale))"
        }
    }

    /// Home's host header and the Hosts row's relation: "through box",
    /// "through box · locked since 9:14".
    public static func subline(_ presence: HostPresence, carrierName: String, lockedSince: Int?, now: Date, calendar: Calendar = .current, locale: Locale = .current) -> String {
        let through = "through \(carrierName)"
        guard let line = rowLine(presence, lockedSince: lockedSince, now: now, calendar: calendar, locale: locale) else { return through }
        return "\(through) · \(line)"
    }

    /// The working strip's idle slot: only the state with no block has a line
    /// here. Locked → "The Mac is locked since 9:14"; every other state → nil
    /// (asleep and unreachable speak through the composer's block line, and
    /// nothing is said twice).
    public static func stripLine(_ presence: HostPresence, lockedSince: Int?, now: Date, calendar: Calendar = .current, locale: Locale = .current) -> String? {
        guard RelayState(presence) == .locked else { return nil }
        let head = "\(subject(presence).capitalisedFirst) is locked"
        guard let lockedSince else { return head }
        return "\(head) since \(since(lockedSince, now: now, calendar: calendar, locale: locale))"
    }

    /// The status line while the lane is held: "The Mac is unreachable since 9:14".
    public static func heldLine(_ presence: HostPresence, now: Date, calendar: Calendar = .current, locale: Locale = .current) -> String {
        "\(subject(presence).capitalisedFirst) is unreachable since \(since(presence.since, now: now, calendar: calendar, locale: locale))"
    }

    /// "Reconnecting to the Mac…"
    public static func reconnecting(_ presence: HostPresence) -> String {
        "Reconnecting to \(subject(presence))…"
    }

    /// The status line's words for a relayed host, or nil to let the line say
    /// what it says for any host: the reconnect names the host, and a lane
    /// the carrier holds (the link is down) says so. One place, so the Retry
    /// rule (`showsRetry`) and the words agree.
    @MainActor
    public static func statusLine(for client: EnvironmentClient, status: EnvironmentStatus, now: Date = .now) -> String? {
        guard client.environment.isRelayed, let presence = client.presence else { return nil }
        switch status.transport {
        case .connecting, .reconnecting:
            return reconnecting(presence)
        case .offline where status.halt == nil && RelayState(presence) == .unreachable:
            return heldLine(presence, now: now)
        default:
            return nil
        }
    }

    /// A held relayed lane has no Retry: the box retries the link, the lane retries itself.
    @MainActor
    public static func showsRetry(for client: EnvironmentClient) -> Bool {
        !(client.environment.isRelayed && client.relayState == .unreachable)
    }
}

// MARK: - the refusal

/// The typed line a relayed call came back with, parsed from the wire's
/// words (contract-relay.ts `relayRefusal`, `linkDownText`):
/// `unavailable: the Mac is locked` · `unavailable: the Mac is asleep` ·
/// `unavailable: the Mac is unreachable since 09:14` ·
/// `linkDown: the Mac is unreachable since 09:14`.
public struct RelayRefusal: Sendable, Hashable {
    public enum Kind: Sendable, Hashable {
        case locked, asleep, unreachable, linkDown
    }

    public let kind: Kind
    /// The host's own words after the prefix, capitalised: "The Mac is
    /// asleep". No full stop: it is a field line, not prose.
    public let line: String

    /// nil when the message is not a relay refusal.
    public init?(message: String) {
        let rest: Substring
        let cut: Bool
        if message.hasPrefix("unavailable: ") {
            rest = message.dropFirst("unavailable: ".count)
            cut = false
        } else if message.hasPrefix("linkDown: ") {
            rest = message.dropFirst("linkDown: ".count)
            cut = true
        } else {
            return nil
        }
        let words = rest.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !words.isEmpty else { return nil }
        if cut {
            kind = .linkDown
        } else if words.contains("asleep") {
            kind = .asleep
        } else if words.contains("locked") {
            kind = .locked
        } else if words.contains("unreachable") {
            kind = .unreachable
        } else {
            return nil
        }
        line = words.capitalisedFirst
    }
}

extension String {
    /// "the Mac" → "The Mac"; the rest untouched.
    var capitalisedFirst: String {
        guard let first else { return self }
        return first.uppercased() + dropFirst()
    }
}
