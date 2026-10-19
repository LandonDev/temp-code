import SwiftUI
import TempCodeClient

/// Every paired host and how it is doing. Adding one is a sheet.
struct EnvironmentsView: View {
    @Environment(AppModel.self) private var model
    @State private var adding = false

    var body: some View {
        let clients = model.registry.ordered
        Group {
            if clients.isEmpty && model.started {
                ContentUnavailableView {
                    Label("No hosts", systemImage: "desktopcomputer")
                } description: {
                    Text("Pair a desktop or the agent host to see its threads here.")
                } actions: {
                    Button("Add a host") { adding = true }
                        .buttonStyle(.borderedProminent)
                }
            } else {
                List {
                    ForEach(clients, id: \.environment.id) { client in
                        NavigationLink(value: client.environment.id) {
                            EnvironmentRow(client: client)
                        }
                        .accessibilityIdentifier("environment-row")
                    }
                    .onDelete { offsets in
                        let ids = offsets.map { clients[$0].environment.id }
                        Task { for id in ids { await model.registry.remove(id) } }
                    }
                }
                .listStyle(.insetGrouped)
            }
        }
        .navigationTitle("Hosts")
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button("Add a host", systemImage: "plus") { adding = true }
            }
        }
        .sheet(isPresented: $adding) {
            AddEnvironmentSheet()
        }
    }
}

struct EnvironmentRow: View {
    let client: EnvironmentClient

    var body: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(client.environment.name)
                    .font(.body)
                Text(client.environment.host)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 8)
            ConnectionMark(status: client.status)
        }
        .padding(.vertical, 2)
    }
}

/// One word for the transport, and a dot only when it is not plainly open.
struct ConnectionMark: View {
    let status: EnvironmentStatus

    var body: some View {
        HStack(spacing: 6) {
            if status.transport != .open {
                Circle()
                    .fill(color)
                    .frame(width: 7, height: 7)
            }
            Text(label)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .contentTransition(.numericText())
        }
        .animation(.default, value: status.transport)
    }

    private var label: String {
        switch status.transport {
        case .open: "Connected"
        case .connecting: "Connecting"
        case .reconnecting: "Reconnecting"
        case .offline: status.halt == nil ? "Offline" : "Needs attention"
        case .unauthorized: "Key refused"
        case .suspended: "Paused"
        }
    }

    private var color: Color {
        switch status.transport {
        case .open: .green
        case .connecting, .reconnecting, .suspended: .orange
        case .offline, .unauthorized: .red
        }
    }
}
