import SwiftUI
import TempCodeClient

/// System, light or dark, remembered.
enum Appearance: String, CaseIterable {
    case system
    case light
    case dark

    var scheme: ColorScheme? {
        switch self {
        case .system: nil
        case .light: .light
        case .dark: .dark
        }
    }

    var label: String {
        switch self {
        case .system: "System"
        case .light: "Light"
        case .dark: "Dark"
        }
    }
}

/// Settings, from the Home navigation bar: the hosts and the appearance.
/// Notifications arrive with L6.
struct SettingsView: View {
    @Environment(AppModel.self) private var model
    @AppStorage("appearance") private var appearance = Appearance.system

    var body: some View {
        let clients = model.registry.ordered
        List {
            Section {
                NavigationLink(value: Route.hosts) {
                    LabeledContent("Hosts") {
                        HStack(spacing: 6) {
                            ForEach(clients, id: \.environment.id) { client in
                                ConnectionDot(status: client.status)
                            }
                            Text(clients.count == 1 ? clients[0].environment.name : "\(clients.count)")
                                .lineLimit(1)
                        }
                    }
                }
            }
            Section("Appearance") {
                Picker("Appearance", selection: $appearance) {
                    ForEach(Appearance.allCases, id: \.self) { choice in
                        Text(choice.label).tag(choice)
                    }
                }
                .pickerStyle(.inline)
                .labelsHidden()
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle("Settings")
        .navigationBarTitleDisplayMode(.inline)
    }
}
