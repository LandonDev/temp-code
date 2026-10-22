import Foundation
import TempCodeContract

/// What the Settings, Hosts and host-detail screens say about a host, as
/// pure functions of the client's models, so the app target holds only the
/// SwiftUI and every word here has a test. Value code throughout; only
/// `forgetHost` touches the registry and runs on the main actor.

/// A host's state in one word or short phrase: the Hosts row's second line
/// and the detail's status row. The reconnect countdown is the app's
/// `StatusText`; this is the static word.
public enum ConnectionWord {
    public static func text(for status: EnvironmentStatus) -> String {
        switch status.transport {
        case .open: "Connected"
        case .connecting: status.attempts > 0 ? "Unreachable" : "Connecting…"
        case .reconnecting: "Reconnecting…"
        case .offline:
            switch status.halt {
            case .identityChanged?: "Different host"
            case .contractMismatch?: "Needs an update"
            case nil: "Offline"
            }
        case .unauthorized: "Key refused"
        case .suspended: "Paused"
        }
    }
}

/// `env_Ab3k…9xQz`: the id's prefix, its first four and last four characters.
/// Long enough to tell two hosts apart, short enough for a row's trailing edge.
/// An id whose body is ten characters or fewer is left whole.
public func abbreviatedEnvironmentId(_ id: String) -> String {
    let prefix = "env_"
    let body = id.hasPrefix(prefix) ? String(id.dropFirst(prefix.count)) : id
    guard body.count > 10 else { return id }
    return "\(id.hasPrefix(prefix) ? prefix : "")\(body.prefix(4))…\(body.suffix(4))"
}

/// A sentence from the package's lowercase fragments ("that is not a pairing
/// link"): trimmed, capitalised, with a full stop unless it already ends one
/// way or another. Empty stays empty.
public func sentence(_ fragment: String) -> String {
    let trimmed = fragment.trimmingCharacters(in: .whitespacesAndNewlines)
    guard let first = trimmed.first else { return trimmed }
    let capitalised = first.uppercased() + trimmed.dropFirst()
    return capitalised.last.map { ".!?".contains($0) } == true ? capitalised : capitalised + "."
}

/// The one action that helps a host in a given state, and the sentence that
/// says why. A new key when the key or the host's identity is wrong, a retry
/// when the host is out of reach, nothing while it is connected, on its
/// first attempt, suspended, or needs an update this app cannot do.
public enum HostFix: Sendable, Hashable {
    case retry
    case pairAgain

    public var title: String {
        switch self {
        case .retry: "Retry Now"
        case .pairAgain: "Pair Again"
        }
    }

    /// - Parameter environment: a relayed host has no fix of its own: the box
    ///   retries the link and the lane retries itself.
    public static func fix(for status: EnvironmentStatus, environment: PairedEnvironment? = nil) -> HostFix? {
        if environment?.isRelayed == true { return nil }
        return switch status.transport {
        case .unauthorized: .pairAgain
        case .reconnecting: .retry
        case .offline:
            switch status.halt {
            case .identityChanged?: .pairAgain
            case .contractMismatch?: nil
            case nil: .retry
            }
        case .connecting: status.attempts > 0 ? .retry : nil
        case .open, .suspended: nil
        }
    }

    /// The footer under the status row: why the host is where it is, and
    /// what the phone does about it on its own. Nothing when connected.
    public static func explanation(for status: EnvironmentStatus) -> String? {
        switch status.transport {
        case .open: nil
        case .connecting, .reconnecting: status.attempts > 0 ? "The phone keeps trying on its own; Retry tries now." : nil
        case .offline:
            switch status.halt {
            case .identityChanged?: "The address now answers as another host. Pair again to trust it."
            case .contractMismatch(let app, let host)?: host > app ? "Update this app to talk to the host." : "Update the host to talk to this app."
            case nil: "The phone will try again when the network returns."
            }
        case .unauthorized: "The host refused this key. A new pairing link from its Remote access pane replaces it."
        case .suspended: "Reconnects when the app comes forward."
        }
    }

    /// Destructive only when the state waits on the person: the key was
    /// refused, the address answers as another host, or the contract needs
    /// an update. Offline and unreachable are the phone's to fix, so they
    /// stay secondary.
    public static func waitsOnUser(_ status: EnvironmentStatus) -> Bool {
        switch status.transport {
        case .unauthorized: true
        case .offline: status.halt != nil
        case .connecting, .reconnecting, .open, .suspended: false
        }
    }
}

/// The host's version row in the detail: `1.0.273 · 5edeb5d`, or the
/// version alone when the hello carried no commit. `release` repeats the
/// version and `platform` is the deploy line's, so neither is shown.
public enum HostBuildLine {
    public static func text(_ build: BuildFacts) -> String {
        text(version: build.version, sha: build.sha)
    }

    /// The same line from the fields alone (a relayed host's presence carries its build under another type).
    public static func text(version: String, sha: String?) -> String {
        guard let sha, !sha.isEmpty else { return version }
        return "\(version) · \(sha.prefix(7))"
    }
}

/// The detail's Notifications row: what this one host holds of the phone's
/// push registration, from the registrar's switch, its last failure for the
/// host and the host's own status.
public enum HostPushWord {
    public static func text(enabled: Bool, failure: String?, status: PushStatus?) -> String {
        guard enabled else { return "Off" }
        if failure != nil { return "Failed" }
        guard let status, status.registered else { return "Not registered" }
        switch status.relay {
        case .ok: return "On"
        case .none: return "No relay"
        case .failed: return "Failed"
        case .unknown: return "Registered"
        }
    }
}

/// A capability of a key, in the words the host's Remote access pane uses.
public extension Capability {
    static let ordered: [Capability] = [.read, .operate, .approve, .admin]

    var title: String {
        switch self {
        case .read: "Read"
        case .operate: "Operate"
        case .approve: "Approve"
        case .admin: "Admin"
        case .unknown(let raw): raw.capitalized
        }
    }

    /// One line on what the capability lets the phone do.
    var detail: String {
        switch self {
        case .read: "See threads, files and the inbox"
        case .operate: "Send turns, stop and start threads"
        case .approve: "Decide approvals and run full-access threads"
        case .admin: "Pair devices, manage keys and move threads"
        case .unknown: "Not known to this app"
        }
    }
}

/// The Forget dialog's message for a carrier: the sentence every host gets,
/// then the relayed hosts that go with it, by name ("Studio Mac goes with
/// it.", "Studio Mac and Office Mac go with it.").
public func forgetCopy(carrier: String, relayed: [String]) -> String {
    let base = "Its threads stay on the host, and it stops sending notifications here when it can be reached. The key stays valid there until revoked. Pair again to come back."
    guard !relayed.isEmpty else { return base }
    let names: String
    if relayed.count == 1 {
        names = relayed[0]
    } else {
        names = relayed.dropLast().joined(separator: ", ") + " and " + relayed[relayed.count - 1]
    }
    return "\(base) \(names) \(relayed.count == 1 ? "goes" : "go") with it."
}

/// Forgetting a host: drop its push registration there while the socket is
/// open (best effort, no retry: the key stays valid on the host, so a
/// registration left behind would keep sending notices for an environment
/// the phone no longer knows), then remove the key here. The removal stops
/// the socket, forgets the registrar's state and clears the cache. A host
/// relayed through this one goes with it (`ClientRegistry.remove`).
@MainActor
public func forgetHost(_ id: String, registry: ClientRegistry) async {
    if registry.push.enabled, let client = registry.client(id), await client.socket.isOpen {
        _ = try? await client.request(Methods.RemotePushUnregister.self, .init())
    }
    await registry.remove(id)
}
