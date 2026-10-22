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

/// The host a thread or agent runs on, as one small monochrome glyph: a
/// laptop for a Mac, a rack for anything else (the box), from the platform
/// the host's hello named and the paired environment remembers. Drawn only
/// when two or more hosts are paired; colour stays for the status dots.
/// VoiceOver reads "On box".
struct HostGlyph: View {
    let environmentId: String
    @Environment(AppModel.self) private var app

    var body: some View {
        if ProjectPairs.showsHost(hostCount: app.registry.ordered.count), let client = app.registry.client(environmentId) {
            MetaGlyph(HostKind(platform: app.registry.platform(environmentId)).symbol, tint: .secondary, label: "On \(client.environment.name)")
        }
    }
}
