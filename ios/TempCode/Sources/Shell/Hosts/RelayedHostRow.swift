import SwiftUI
import TempCodeClient
import TempCodeContract

/// A host reached through another, under its carrier's row in Settings →
/// Hosts: the lane's dot in the mark column, the name, "through <carrier>,
/// <presence>" in the meta step, the abbreviated environment id trailing.
/// Nothing here waits on the person: no swipe, no menu (there is nothing to
/// pair again or forget; the carrier's Forget takes it along).
struct RelayedHostRow: View {
    let client: EnvironmentClient
    let carrierName: String

    var body: some View {
        let status = client.status
        // Read here, in the body, so a presence change re-renders the line at once.
        let presence = client.presence
        let lockedSince = client.stateSince
        HStack(spacing: Layout.rowGap) {
            ConnectionDot(status: status)
                .frame(width: Layout.markWidth)
                // The second line says the state; the dot's label would say it again.
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(client.environment.name)
                    .lineLimit(1)
                PresenceLine { now in
                    guard let presence else { return "through \(carrierName)" }
                    return RelayWords.subline(presence, carrierName: carrierName, lockedSince: lockedSince, now: now)
                }
            }
            .layoutPriority(1)
            Spacer(minLength: Layout.rowGap)
            Text(abbreviatedEnvironmentId(client.environment.id))
                .font(.caption.monospaced())
                .foregroundStyle(.tertiary)
                .lineLimit(1)
                .truncationMode(.middle)
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("relayed-row")
    }
}

/// A relayed host in full: the lane's state with the presence under it, the
/// host's facts, and what it borrows from its carrier. No Retry (the box
/// retries the link, the lane retries itself), no Key section (the carrier's
/// key is named in a footer), no Pair Again and no Forget.
struct RelayedHostDetailView: View {
    let client: EnvironmentClient
    let carrier: PairedEnvironment

    var body: some View {
        let environment = client.environment
        let status = client.status
        let presence = client.presence
        let lockedSince = client.stateSince
        // A held lane's status text already says "unreachable since …"; the line under it says nothing twice.
        let held = client.relayState == .unreachable
        List {
            // 1. Status: the lane, and the host's presence under it.
            Section {
                HStack(alignment: .firstTextBaseline, spacing: Layout.rowGap) {
                    ConnectionDot(status: status)
                        .frame(width: Layout.markWidth)
                        .alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + 4 }
                        .accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 2) {
                        StatusText(status: status)
                            .lineLimit(2)
                        PresenceLine { now in
                            guard !held, let presence else { return nil }
                            return RelayWords.rowLine(presence, lockedSince: lockedSince, now: now)
                        }
                    }
                    Spacer(minLength: Layout.rowGap)
                    if status.transport == .connecting {
                        ProgressView()
                            .controlSize(.small)
                            .transition(.opacity)
                    }
                }
                .animation(Motion.crossFade, value: status.transport)
                .accessibilityIdentifier("host-status")
            } footer: {
                Text("Reached through \(carrier.name). It relays this host's threads while the host is awake and its link is up.")
            }

            // 2. Host: its facts. The name is the host's own hostname, so it is not edited here.
            Section {
                LabeledContent("Name", value: environment.name)
                LabeledContent("Through", value: carrier.name)
                LabeledContent("Environment") {
                    Text(environment.id)
                        .font(.footnote.monospaced())
                        .textSelection(.enabled)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                if let version {
                    LabeledContent("Version") {
                        Text(version)
                            .monospacedDigit()
                    }
                }
                if let hello = status.lastHello {
                    LabeledContent("Contract", value: "\(hello.contract)")
                }
            } header: {
                Text("Host")
            } footer: {
                Text("Uses \(carrier.name)\u{2019}s key, \u{201C}\(carrier.keyName)\u{201D}. Forgetting \(carrier.name) forgets this host with it.")
            }
        }
        .listStyle(.insetGrouped)
    }

    /// The presence row's build first (the carrier's view of the host), else the lane's own hello.
    private var version: String? {
        if let build = client.presence?.build { return HostBuildLine.text(version: build.version, sha: build.sha) }
        return client.status.lastHello?.build.map(HostBuildLine.text)
    }
}
