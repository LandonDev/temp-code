import SwiftUI
import TempCodeClient

/// One tone rule for every dot that means "a host's link", the desktop's
/// `hostTone` (src/renderer/src/lib/threadMove.ts): five tones, the kit's
/// colors, nothing new.
enum HostTone: Equatable {
    /// Open and fresh.
    case fresh
    /// Open, not yet re-listed.
    case stale
    /// Connecting, reconnecting, suspended.
    case busy
    /// Offline.
    case away
    /// The key was refused.
    case refused

    init(_ status: EnvironmentStatus) {
        switch status.transport {
        case .open: self = status.fresh ? .fresh : .stale
        case .connecting, .reconnecting, .suspended: self = .busy
        case .offline: self = .away
        case .unauthorized: self = .refused
        }
    }

    var color: Color {
        switch self {
        case .fresh: Tint.success
        case .stale: Tint.success.opacity(0.5)
        case .busy: Tint.warning
        case .away: Color(.tertiaryLabel)
        case .refused: Tint.destructive
        }
    }

    /// The static cue: the words `StatusText` would say, for accessibility values.
    func label(_ status: EnvironmentStatus, now: Date) -> String {
        StatusText.text(for: status, now: now)
    }
}

/// A host's link as a dot. Cross-fades 150 ms between tones after the first
/// paint; never on it. VoiceOver reads the state in words.
struct HostDot: View {
    let status: EnvironmentStatus
    var size: CGFloat = Layout.dotSize
    @State private var painted = false

    private var tone: HostTone { HostTone(status) }

    var body: some View {
        Circle()
            .fill(tone.color)
            .frame(width: size, height: size)
            .animation(painted ? Motion.crossFade : nil, value: tone)
            .task { painted = true }
            .accessibilityLabel(tone.label(status, now: .now))
    }
}

/// A paired project's two (or more) hosts: one dot per member, 2 pt apart,
/// in registry order. One accessibility element: "On Mac and box".
struct PairedHostMarks: View {
    let statuses: [(name: String, status: EnvironmentStatus)]

    var body: some View {
        HStack(spacing: 2) {
            ForEach(statuses.indices, id: \.self) { index in
                HostDot(status: statuses[index].status)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("On " + statuses.map(\.name).formatted(.list(type: .and)))
        .accessibilityValue(statuses.map { "\($0.name) \(HostTone($0.status).label($0.status, now: .now).lowercased())" }.joined(separator: ", "))
    }
}

/// The host a row names when more than one is paired: a stamp-step word, nothing else.
struct HostWord: View {
    let name: String

    var body: some View {
        Text(name)
            .textStep(.stamp)
            .lineLimit(1)
            .fixedSize()
    }
}
