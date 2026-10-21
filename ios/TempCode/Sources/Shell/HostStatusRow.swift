import SwiftUI
import TempCodeClient

/// One notice at the top of Home for a host that is not plainly connected:
/// its name, what is happening, and the one action that helps (Retry, or
/// Pair again when the key was refused). A 12 pt field on the chrome step,
/// with the capsule inside it; never a blank screen.
struct HostStatusRow: View {
    let client: EnvironmentClient
    let pairAgain: () -> Void
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        let status = client.status
        Group {
            if typeSize.isAccessibilitySize {
                VStack(alignment: .leading, spacing: 10) {
                    words(status)
                    action(status)
                }
            } else {
                HStack(alignment: .center, spacing: 12) {
                    words(status)
                    Spacer(minLength: 8)
                    action(status)
                }
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
        .background(Surface.chrome, in: RoundedRectangle(cornerRadius: Radius.field, style: .continuous))
        .accessibilityElement(children: .contain)
    }

    private func words(_ status: EnvironmentStatus) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Circle()
                .fill(status.transport == .reconnecting || status.transport == .connecting ? Tint.warning : Tint.destructive)
                .frame(width: 7, height: 7)
                .frame(width: 14)
                .alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + 4 }
            VStack(alignment: .leading, spacing: 1) {
                Text(client.environment.name)
                    .font(.footnote.weight(.semibold))
                    .lineLimit(1)
                StatusText(status: status)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .lineLimit(3)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    @ViewBuilder
    private func action(_ status: EnvironmentStatus) -> some View {
        if status.transport == .unauthorized {
            PillButton("Pair again", action: pairAgain)
        } else {
            PillButton("Retry") { Task { await client.retry() } }
        }
    }
}

/// What the socket is doing, in the words L2's status line used; the
/// reconnect countdown ticks each second.
struct StatusText: View {
    let status: EnvironmentStatus

    var body: some View {
        if status.transport == .reconnecting || status.transport == .connecting, status.nextRetryAt != nil {
            TimelineView(.periodic(from: .now, by: 1)) { context in
                Text(Self.text(for: status, now: context.date))
                    .monospacedDigit()
                    .contentTransition(.numericText())
            }
        } else {
            Text(Self.text(for: status, now: .now))
        }
    }

    static func text(for status: EnvironmentStatus, now: Date) -> String {
        switch status.transport {
        case .open:
            return "Connected"
        case .connecting:
            guard let at = status.nextRetryAt, status.attempts > 0 else { return "Connecting…" }
            let seconds = max(0, Int((at / 1000 - now.timeIntervalSince1970).rounded()))
            return seconds > 0 ? "Could not reach the host. Retrying in \(seconds) s" : "Could not reach the host. Retrying…"
        case .reconnecting:
            guard let at = status.nextRetryAt else { return "Reconnecting…" }
            let seconds = max(0, Int((at / 1000 - now.timeIntervalSince1970).rounded()))
            return seconds > 0 ? "Reconnecting in \(seconds) s" : "Reconnecting…"
        case .offline:
            switch status.halt {
            case .identityChanged?:
                return "This host is not the one that was paired."
            case .contractMismatch(let app, let host)?:
                return host > app ? "The host is newer than this app. Update the app." : "The host is older than this app. Update the host."
            case nil:
                return status.lastError ?? "Offline"
            }
        case .unauthorized:
            return "The key was refused."
        case .suspended:
            return "Paused"
        }
    }
}
