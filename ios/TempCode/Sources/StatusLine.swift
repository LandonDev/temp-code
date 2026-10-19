import SwiftUI
import TempCodeClient

/// One line under the navigation bar while the socket is not open: what is
/// happening and, when it helps, a way to act. Gone the moment it is open.
struct StatusLine: View {
    let client: EnvironmentClient
    @State private var now = Date()

    var body: some View {
        let status = client.status
        if status.transport != .open {
            HStack(spacing: 10) {
                if status.transport == .connecting || status.transport == .reconnecting {
                    ProgressView()
                        .controlSize(.small)
                }
                Text(text(for: status))
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                Spacer(minLength: 0)
                if showsRetry(status) {
                    Button("Retry") { Task { await client.retry() } }
                        .font(.footnote.weight(.medium))
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 8)
            .background(.bar)
            .overlay(alignment: .bottom) { Divider() }
            .transition(.move(edge: .top).combined(with: .opacity))
            .task(id: status.nextRetryAt) {
                // The countdown only ticks while a retry is pending.
                guard status.nextRetryAt != nil else { return }
                while !Task.isCancelled {
                    now = Date()
                    try? await Task.sleep(for: .seconds(1))
                }
            }
        }
    }

    private func text(for status: EnvironmentStatus) -> String {
        switch status.transport {
        case .open:
            return ""
        case .connecting:
            return "Connecting…"
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
            return "The key was refused. Remove the host and pair again."
        case .suspended:
            return "Paused"
        }
    }

    private func showsRetry(_ status: EnvironmentStatus) -> Bool {
        switch status.transport {
        case .reconnecting, .offline, .unauthorized: true
        default: false
        }
    }
}
