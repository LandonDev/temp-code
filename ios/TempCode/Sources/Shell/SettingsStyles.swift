import SwiftUI
import TempCodeClient
import TempCodeContract

/// The small shared pieces of Settings, Hosts and the pairing sheet. They
/// sit here rather than in Design/ so the Settings work stays mergeable;
/// integration may lift them.

/// A host's state in one word or short phrase, as the Hosts list and the
/// detail's status row say it. The reconnect countdown comes from
/// `StatusText`; this is the static word for a row's second line.
enum ConnectionWord {
    static func text(for status: EnvironmentStatus) -> String {
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
func abbreviatedEnvironmentId(_ id: String) -> String {
    let prefix = "env_"
    let body = id.hasPrefix(prefix) ? String(id.dropFirst(prefix.count)) : id
    guard body.count > 10 else { return id }
    return "\(id.hasPrefix(prefix) ? prefix : "")\(body.prefix(4))…\(body.suffix(4))"
}

/// A refusal under a field: glyph and one sentence in destructive, footnote
/// size, inside the field's own section so it reads as part of the field.
/// It arrives with the needs-you row motion (200 ms, 8 pt of travel) and
/// leaves with a 150 ms fade; reduced motion fades both ways.
struct InlineFieldError: View {
    let message: String

    var body: some View {
        Label {
            Text(message)
                .font(.footnote)
        } icon: {
            Image(systemName: "exclamationmark.circle")
                .font(.footnote)
        }
        .foregroundStyle(Tint.destructive)
        .accessibilityIdentifier("field-error")
    }
}

/// A sentence from the client package's lowercase fragments ("that is not a
/// pairing link"): capitalised, with a full stop.
func sentence(_ fragment: String) -> String {
    let trimmed = fragment.trimmingCharacters(in: .whitespacesAndNewlines)
    guard let first = trimmed.first else { return trimmed }
    let capitalised = first.uppercased() + trimmed.dropFirst()
    return capitalised.last.map { ".!?".contains($0) } == true ? capitalised : capitalised + "."
}

/// A capability of a key, in the words the host's Remote access pane uses.
extension Capability {
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
