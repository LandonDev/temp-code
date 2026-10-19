import SwiftUI
import TempCodeClient

/// Every paired host and how it is doing. Adding one is a sheet; pairing
/// again (a new key for the same host) and removing are swipe actions.
struct HostsView: View {
    @Environment(AppModel.self) private var model
    @State private var adding = false
    @State private var pairingAgain: PairedEnvironment?

    var body: some View {
        let clients = model.registry.ordered
        List {
            ForEach(clients, id: \.environment.id) { client in
                HostRow(client: client)
                    .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                        Button("Remove", systemImage: "trash", role: .destructive) {
                            Task { await model.registry.remove(client.environment.id) }
                        }
                        Button("Pair again", systemImage: "key") { pairingAgain = client.environment }
                            .tint(Tint.warning)
                    }
                    .contextMenu {
                        Button("Pair again", systemImage: "key") { pairingAgain = client.environment }
                        Button("Remove", systemImage: "trash", role: .destructive) {
                            Task { await model.registry.remove(client.environment.id) }
                        }
                    }
                    .accessibilityIdentifier("environment-row")
            }
        }
        .listStyle(.insetGrouped)
        .overlay {
            if clients.isEmpty {
                ContentUnavailableView {
                    Label("No hosts", systemImage: "desktopcomputer")
                } description: {
                    Text("Pair a desktop or the agent host to see its threads here.")
                } actions: {
                    Button("Add a host") { adding = true }
                        .buttonStyle(.borderedProminent)
                }
            }
        }
        .navigationTitle("Hosts")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button("Add a host", systemImage: "plus") { adding = true }
            }
        }
        .sheet(isPresented: $adding) { AddEnvironmentSheet() }
        .sheet(item: $pairingAgain) { AddEnvironmentSheet(replacing: $0) }
    }
}

/// A host: its name, its address, and the transport in one word.
struct HostRow: View {
    let client: EnvironmentClient

    var body: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(client.environment.name)
                    .font(.body)
                    .lineLimit(1)
                Text(client.environment.host)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 8)
            HStack(spacing: 6) {
                ConnectionDot(status: client.status)
                Text(word)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 2)
        .animation(Motion.crossFade, value: client.status.transport)
    }

    private var word: String {
        switch client.status.transport {
        case .open: "Connected"
        case .connecting: "Connecting"
        case .reconnecting: "Reconnecting"
        case .offline: client.status.halt == nil ? "Offline" : "Needs attention"
        case .unauthorized: "Key refused"
        case .suspended: "Paused"
        }
    }
}
