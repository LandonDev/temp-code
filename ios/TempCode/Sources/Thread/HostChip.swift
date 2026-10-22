import SwiftUI
import TempCodeClient

/// The host a thread runs on, in the header's subtitle: a dot in the host's
/// tone and its name, on the fill step with row corners. Shown only with more
/// than one host paired (the header's rule). Tap shows the host's state line.
/// The phone offers no move: `session.move` is the Mac's own local RPC, which
/// no remote key can call.
struct HostChip: View {
    let environmentId: String
    @Environment(AppModel.self) private var app
    @State private var showing = false

    var body: some View {
        if let client = app.registry.client(environmentId) {
            Button {
                showing = true
            } label: {
                HStack(alignment: .center, spacing: 5) {
                    HostDot(status: client.status, size: 6)
                    Text(client.environment.name)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .alignmentGuide(VerticalAlignment.center) { $0[.firstTextBaseline] - 4 }
                }
                .padding(.horizontal, 7)
                .padding(.vertical, 2)
                .background(Surface.fill, in: .rowCorner)
                .frame(minWidth: 44, minHeight: 28)
                .contentShape(Rectangle())
            }
            .buttonStyle(.pressable)
            .accessibilityLabel("Host: \(client.environment.name)")
            .accessibilityValue(HostTone(client.status).label(client.status, now: .now))
            .accessibilityHint("Shows the host's connection")
            .popover(isPresented: $showing, arrowEdge: .top) {
                HostStatePopover(client: client)
                    .presentationCompactAdaptation(.popover)
            }
        }
    }
}

/// The host's state line: its name, what the socket is doing (ticking while a
/// retry is pending), and Retry when it helps (reconnecting, offline, refused:
/// the status line's rule).
struct HostStatePopover: View {
    let client: EnvironmentClient

    var body: some View {
        let status = client.status
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                HostDot(status: status)
                Text(client.environment.name)
                    .textStep(.title, weight: .semibold)
                    .lineLimit(1)
            }
            StatusText(status: status)
                .textStep(.meta)
            if retryHelps(status) {
                PillButton("Retry") { Task { await client.retry() } }
                    .padding(.top, 4)
            }
        }
        .padding(16)
        .frame(minWidth: 220, alignment: .leading)
    }

    private func retryHelps(_ status: EnvironmentStatus) -> Bool {
        switch status.transport {
        case .reconnecting, .offline, .unauthorized: true
        case .open, .connecting, .suspended: false
        }
    }
}

/// One quiet line where the thread was: "Moved to box". Tapping opens the
/// thread there when that host is paired; when it is not, the line says so
/// and is plain text.
struct MovedLine: View {
    let moved: MovedThread
    @Environment(AppModel.self) private var app
    @Environment(NavigationRouter.self) private var router
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var destination: PairedEnvironment? { app.registry.store.environment(moved.to) }

    var body: some View {
        Group {
            if let destination {
                Button {
                    router.pending = .thread(environmentId: moved.to, sessionId: moved.sessionId, seq: nil)
                } label: {
                    HStack(spacing: 6) {
                        Text("Moved to \(destination.name)")
                            .textStep(.meta)
                        Spacer(minLength: 8)
                        Image(systemName: "chevron.right")
                            .font(.caption2.weight(.regular))
                            .foregroundStyle(.tertiary)
                    }
                    .padding(.horizontal, Layout.textEdge)
                    .frame(maxWidth: .infinity, minHeight: Layout.rowHeight)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.pressable)
                .accessibilityLabel("Moved to \(destination.name). Opens the thread there.")
            } else {
                Text("Moved to a host this phone is not paired with")
                    .textStep(.meta)
                    .padding(.horizontal, Layout.textEdge)
                    .frame(maxWidth: .infinity, minHeight: Layout.rowHeight, alignment: .leading)
                    .accessibilityLabel("Moved to a host this phone is not paired with")
            }
        }
        .transition(Motion.appear(reduced: reduceMotion))
    }
}
