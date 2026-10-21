import SwiftUI
import TempCodeClient

/// One row at the top of Home for a host that is not plainly connected: its
/// name, what is happening, and the one action that helps (Retry, or Pair
/// again when the key was refused). On the card, tinted like a needs-you
/// row: warning while it retries, destructive when refused or offline.
/// Never a blank screen.
struct HostStatusRow: View {
    let client: EnvironmentClient
    let pairAgain: () -> Void

    var body: some View {
        let status = client.status
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Circle()
                .fill(status.transport == .reconnecting || status.transport == .connecting ? Tint.warning : Tint.destructive)
                .frame(width: 7, height: 7)
                .frame(width: 14)
                .alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + 3 }
            VStack(alignment: .leading, spacing: 2) {
                Text(client.environment.name)
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(1)
                StatusText(status: status)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            Spacer(minLength: 8)
            if status.transport == .unauthorized {
                PillButton("Pair again", action: pairAgain)
            } else {
                PillButton("Retry") { Task { await client.retry() } }
            }
        }
        .padding(.vertical, 6)
        .frame(minHeight: 44)
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
