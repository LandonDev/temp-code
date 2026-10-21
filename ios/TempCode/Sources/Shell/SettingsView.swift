import SwiftUI
import TempCodeClient
import TempCodeContract
import UIKit

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

/// Settings, from the Home navigation bar: the hosts, notifications and the
/// appearance, as Apple's own Settings lays them out. Inset grouped, one
/// sentence of footer where a row needs explaining, the app's version last.
struct SettingsView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.openURL) private var openURL
    @AppStorage("appearance") private var appearance = Appearance.system
    /// Where the switch sits while the permission prompt and the hosts are
    /// asked; nil once they have answered and the registrar's word is true.
    @State private var pushPending: Bool?

    var body: some View {
        let clients = model.registry.ordered
        let push = model.registry.push
        List {
            Section {
                NavigationLink(value: Route.hosts) {
                    HStack(spacing: 12) {
                        Text("Hosts")
                        Spacer(minLength: 12)
                        HostsSummary(clients: clients)
                    }
                }
                .accessibilityIdentifier("hosts-row")
            } footer: {
                Text(clients.isEmpty ? "Pair a desktop or the agent host to see its threads here." : "Threads from every paired host appear on Home.")
            }

            Section {
                // One row: the switch, with the registration's state beside it.
                Toggle(isOn: pushBinding) {
                    HStack(spacing: 12) {
                        Text("Notifications")
                        Spacer(minLength: 12)
                        Text(pushWord(push))
                            .foregroundStyle(.secondary)
                            .contentTransition(.opacity)
                    }
                    .animation(Motion.crossFade, value: pushWord(push))
                }
                .accessibilityIdentifier("push-row")
                if push.enabled, push.permission == .denied {
                    Button("Allow in Settings") { openSystemSettings() }
                }
            } footer: {
                Text(pushFooter(push))
            }

            Section {
                Picker("Appearance", selection: $appearance) {
                    ForEach(Appearance.allCases, id: \.self) { choice in
                        Text(choice.label).tag(choice)
                    }
                }
                .pickerStyle(.inline)
                .labelsHidden()
            } header: {
                Text("Appearance")
            } footer: {
                Text("System follows the phone's setting.")
            }

            Section {
                VersionFooter()
                    .listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets())
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle("Settings")
        .navigationBarTitleDisplayMode(.inline)
    }

    private var pushBinding: Binding<Bool> {
        Binding(
            get: { pushPending ?? model.registry.push.enabled },
            set: { on in
                guard pushPending == nil else { return }
                pushPending = on
                Task {
                    await model.setPushEnabled(on)
                    pushPending = nil
                }
            }
        )
    }

    private func pushWord(_ push: PushRegistrar) -> String {
        if let pending = pushPending { return pending ? "Turning On…" : "Turning Off…" }
        return push.summary
    }

    /// One sentence under the row: what the switch does, or what stands in its way.
    private func pushFooter(_ push: PushRegistrar) -> String {
        guard push.enabled else { return "Approvals, questions, errors and finished work from every paired host." }
        if push.permission == .denied { return "Notifications for TempCode are turned off in the phone's Settings." }
        if let error = push.tokenError { return "The phone could not register for push: \(sentence(error))" }
        if push.device == nil { return "Waiting for the phone's push token." }
        if let failure = push.failures.values.first { return "A host refused the registration: \(sentence(failure))" }
        let registered = push.statuses.values.filter(\.registered)
        if registered.contains(where: { $0.relay == .ok }) { return "Every paired host sends approvals, questions, errors and finished work here." }
        if let failed = registered.first(where: { $0.relay == .failed }) {
            return failed.error.map { "A host could not reach the relay: \(sentence($0))" } ?? "A host could not reach the relay."
        }
        if !registered.isEmpty { return "A paired host has no relay to Apple; its notifications stay on the desktop." }
        return "Registering with the paired hosts."
    }

    private func openSystemSettings() {
        guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
        openURL(url)
    }
}

/// The trailing half of the Hosts row: one connection dot per host and the
/// single host's name, or the count.
private struct HostsSummary: View {
    let clients: [EnvironmentClient]

    var body: some View {
        HStack(spacing: 8) {
            if !clients.isEmpty {
                HStack(spacing: 4) {
                    ForEach(clients, id: \.environment.id) { client in
                        ConnectionDot(status: client.status)
                    }
                }
            }
            Text(clients.isEmpty ? "None" : clients.count == 1 ? clients[0].environment.name : "\(clients.count)")
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .monospacedDigit()
        }
    }
}

/// The app's version and the contract it speaks, centred and dim at the
/// bottom, as Apple's Settings ends: the first thing to read off a
/// screenshot when a host says the app is too old.
private struct VersionFooter: View {
    var body: some View {
        let info = Bundle.main.infoDictionary
        let version = info?["CFBundleShortVersionString"] as? String ?? "0"
        let build = info?["CFBundleVersion"] as? String ?? "0"
        VStack(spacing: 2) {
            Text("TempCode \(version) (\(build))")
            Text("Contract \(contractVersion)")
        }
        .font(.footnote)
        .foregroundStyle(.tertiary)
        .monospacedDigit()
        .frame(maxWidth: .infinity)
        .padding(.top, 8)
        .accessibilityElement(children: .combine)
    }
}
