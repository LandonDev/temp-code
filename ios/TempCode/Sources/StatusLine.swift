import SwiftUI
import TempCodeClient

/// One thin line of text over the top of the content while a host's socket
/// is away for longer than a blink: what is happening and, for the states
/// that need a hand, Retry. It takes no room (a zero-height host with the
/// line drawn over whatever follows it), waits 1.5 s before it exists so a
/// reconnect that finishes within that changes nothing on screen, fades in
/// and out over 150 ms (opacity only), and goes away by itself the frame the
/// socket is open. The background's own `suspended` state never shows: the
/// app is off screen then, and on return the line's clock starts over.
struct StatusLine: View {
    let client: EnvironmentClient
    @State private var shown = false
    @State private var now = Date()

    /// How long the transport may be away before the line appears.
    static let hold: Duration = .milliseconds(1_500)
    /// The one motion: opacity, 150 ms ease-out, both ways.
    static let fade: Animation = .easeOut(duration: 0.15)

    var body: some View {
        let status = client.status
        let text = Self.text(for: status, host: client.environment.name, now: now)
        Color.clear
            .frame(height: 0)
            .overlay(alignment: .top) {
                if shown, let text {
                    HStack(spacing: 12) {
                        Text(text)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                            .truncationMode(.middle)
                        Spacer(minLength: 0)
                        if Self.showsRetry(status) {
                            Button("Retry") { Task { await client.retry() } }
                                .font(.footnote.weight(.medium))
                                .buttonStyle(.plain)
                                .foregroundStyle(Color.accentColor)
                        }
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 6)
                    .frame(maxWidth: .infinity)
                    .background(Surface.chrome)
                    .transition(.opacity)
                    .accessibilityIdentifier("status-line")
                }
            }
            .zIndex(1)
            .animation(Self.fade, value: shown)
            .task(id: status.transport) {
                // The hold restarts with every state: suspended → reconnecting
                // on return starts the 1.5 s from the return, not from when
                // the app left the screen.
                guard Self.text(for: status, host: "", now: now) != nil else {
                    shown = false
                    return
                }
                try? await Task.sleep(for: Self.hold)
                guard !Task.isCancelled else { return }
                shown = true
            }
            .task(id: status.nextRetryAt) {
                // The countdown only ticks while a retry is pending.
                guard status.nextRetryAt != nil else { return }
                while !Task.isCancelled {
                    now = Date()
                    try? await Task.sleep(for: .seconds(1))
                }
            }
    }

    /// What the line says; nil when there is nothing to say (open, or away in the background).
    static func text(for status: EnvironmentStatus, host: String, now: Date) -> String? {
        switch status.transport {
        case .open, .suspended:
            return nil
        case .connecting:
            return "Connecting…"
        case .reconnecting:
            guard let at = status.nextRetryAt else { return "Reconnecting…" }
            let seconds = max(0, Int((at / 1000 - now.timeIntervalSince1970).rounded()))
            if status.attempts >= 2, !host.isEmpty {
                return seconds > 0 ? "Can’t reach \(host). Retrying in \(seconds) s" : "Can’t reach \(host). Retrying…"
            }
            return seconds > 0 ? "Reconnecting in \(seconds) s" : "Reconnecting…"
        case .offline:
            switch status.halt {
            case .identityChanged?:
                return "This host is not the one that was paired."
            case .contractMismatch(let app, let host)?:
                return host > app ? "The host is newer than this app. Update the app." : "The host is older than this app. Update the host."
            case nil:
                return "No connection"
            }
        case .unauthorized:
            return "The key was refused. Remove the host and pair again."
        }
    }

    static func showsRetry(_ status: EnvironmentStatus) -> Bool {
        switch status.transport {
        case .reconnecting, .offline, .unauthorized: true
        default: false
        }
    }
}
