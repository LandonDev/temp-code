import SwiftUI
import TempCodeClient
import TempCodeContract

/// Every paired host: name, connection dot and the abbreviated environment
/// id, each row pushing its detail. Adding one is a sheet; pairing again and
/// forgetting are on the detail, and also a swipe and a long press here.
struct HostsView: View {
    @Environment(AppModel.self) private var model
    @State private var adding = false
    @State private var pairingAgain: PairedEnvironment?
    @State private var forgetting: PairedEnvironment?
    /// DEBUG: the proof opens the first host's detail with `TC_TEST_OPEN=host`.
    @State private var openedByHook: HostDetailRoute?

    var body: some View {
        let clients = model.registry.ordered
        List {
            Section {
                ForEach(clients, id: \.environment.id) { client in
                    NavigationLink(value: HostDetailRoute(environmentId: client.environment.id)) {
                        HostRow(client: client)
                    }
                    .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                        Button("Forget", systemImage: "trash", role: .destructive) { forgetting = client.environment }
                        Button("Pair Again", systemImage: "key") { pairingAgain = client.environment }
                            .tint(Tint.warning)
                    }
                    .contextMenu {
                        Button("Pair Again", systemImage: "key") { pairingAgain = client.environment }
                        Button("Forget", systemImage: "trash", role: .destructive) { forgetting = client.environment }
                    }
                    .accessibilityIdentifier("environment-row")
                }
            } footer: {
                if !clients.isEmpty {
                    Text("Pair another host with the link its Remote access pane makes.")
                }
            }
        }
        .listStyle(.insetGrouped)
        .overlay {
            if clients.isEmpty {
                ContentUnavailableView {
                    Label("No Hosts", systemImage: "desktopcomputer")
                } description: {
                    Text("Pair a desktop or the agent host to see its threads here.")
                } actions: {
                    Button("Add a Host") { adding = true }
                        .buttonStyle(.borderedProminent)
                }
            }
        }
        .navigationTitle("Hosts")
        .navigationBarTitleDisplayMode(.inline)
        .navigationDestination(for: HostDetailRoute.self) { HostDetailView(environmentId: $0.environmentId) }
        .navigationDestination(item: $openedByHook) { HostDetailView(environmentId: $0.environmentId) }
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button("Add a Host", systemImage: "plus") { adding = true }
            }
        }
        .sheet(isPresented: $adding) { AddEnvironmentSheet() }
        .sheet(item: $pairingAgain) { AddEnvironmentSheet(replacing: $0) }
        .forgetHostDialog(host: $forgetting) { id in
            await model.registry.remove(id)
        }
        .onAppear {
            #if DEBUG
            if TestHooks.sheet == "pair" || TestHooks.sheet == "pair-error" { adding = true }
            if TestHooks.open == "host", let first = clients.first {
                openedByHook = HostDetailRoute(environmentId: first.environment.id)
            }
            #endif
        }
    }
}

/// A host's detail, pushed from its row.
struct HostDetailRoute: Hashable {
    let environmentId: String
}

/// A host: the dot, its name, the address while connected (else what is
/// wrong, in two words), and the abbreviated environment id trailing dim.
struct HostRow: View {
    let client: EnvironmentClient
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let status = client.status
        HStack(spacing: 12) {
            ConnectionDot(status: status)
                .frame(width: 14)
            VStack(alignment: .leading, spacing: 2) {
                Text(client.environment.name)
                    .lineLimit(1)
                Text(second(status))
                    .font(.footnote)
                    .foregroundStyle(wrong(status) ? AnyShapeStyle(Tint.destructive) : AnyShapeStyle(HierarchicalShapeStyle.secondary))
                    .lineLimit(1)
                    .id(second(status))
                    .transition(Motion.swap(reduced: reduceMotion))
            }
            .layoutPriority(1)
            Spacer(minLength: 12)
            Text(abbreviatedEnvironmentId(client.environment.id))
                .font(.caption.monospaced())
                .foregroundStyle(.tertiary)
                .lineLimit(1)
        }
        .padding(.vertical, 2)
        .animation(Motion.crossFade, value: second(status))
        .accessibilityElement(children: .combine)
    }

    private func second(_ status: EnvironmentStatus) -> String {
        status.transport == .open ? client.environment.host : ConnectionWord.text(for: status)
    }

    /// Destructive only when something is wrong that waits on the user; a
    /// socket on its way is quiet.
    private func wrong(_ status: EnvironmentStatus) -> Bool {
        switch status.transport {
        case .unauthorized, .offline: true
        case .connecting: status.attempts > 0
        case .open, .reconnecting, .suspended: false
        }
    }
}

/// One host in full: its state and the action that fixes it, the key and
/// what it may do, the host's facts, then Pair Again and Forget.
struct HostDetailView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let environmentId: String
    @State private var pairingAgain: PairedEnvironment?
    @State private var forgetting: PairedEnvironment?
    @State private var name = ""

    var body: some View {
        if let client = model.registry.client(environmentId) {
            detail(client)
        } else {
            // Forgotten while on screen: the list behind is already without it.
            Color.clear.onAppear { dismiss() }
        }
    }

    @ViewBuilder
    private func detail(_ client: EnvironmentClient) -> some View {
        let environment = client.environment
        let status = client.status
        let push = model.registry.push
        List {
            Section {
                HStack(spacing: 12) {
                    ConnectionDot(status: status)
                        .frame(width: 14)
                    StatusText(status: status)
                        .lineLimit(2)
                    Spacer(minLength: 12)
                    if status.transport == .connecting {
                        ProgressView()
                            .controlSize(.small)
                            .transition(.opacity)
                    }
                }
                .animation(Motion.crossFade, value: status.transport)
                .accessibilityIdentifier("host-status")
                if let fix = fix(for: status) {
                    Button(fix.title) {
                        switch fix {
                        case .retry:
                            Task { await client.retry() }
                        case .pairAgain:
                            pairingAgain = environment
                        }
                    }
                }
            } footer: {
                if let explanation = explanation(for: status) {
                    Text(explanation)
                }
            }

            Section {
                ForEach(Capability.ordered, id: \.rawValue) { capability in
                    let allowed = environment.allows(capability)
                    HStack(spacing: 12) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(capability.title)
                                .foregroundStyle(allowed ? Color.primary : Color.secondary)
                            Text(capability.detail)
                                .font(.footnote)
                                .foregroundStyle(allowed ? AnyShapeStyle(HierarchicalShapeStyle.secondary) : AnyShapeStyle(HierarchicalShapeStyle.tertiary))
                        }
                        Spacer(minLength: 12)
                        Image(systemName: "checkmark")
                            .font(.body.weight(.semibold))
                            .foregroundStyle(.tint)
                            .opacity(allowed ? 1 : 0)
                            .accessibilityHidden(true)
                    }
                    .accessibilityElement(children: .combine)
                    .accessibilityValue(allowed ? "Allowed" : "Not allowed")
                }
            } header: {
                Text("Key")
            } footer: {
                Text("What \u{201C}\(environment.keyName)\u{201D} may do on the host. Make a new key on the host to change it.")
            }

            Section {
                LabeledContent("Name") {
                    TextField("Name", text: $name)
                        .multilineTextAlignment(.trailing)
                        .submitLabel(.done)
                        .onSubmit { rename(environment) }
                }
                LabeledContent("Address", value: environment.host)
                LabeledContent("Environment") {
                    Text(environment.id)
                        .font(.footnote.monospaced())
                        .textSelection(.enabled)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                if let hello = status.lastHello {
                    LabeledContent("Contract", value: "\(hello.contract)")
                }
                LabeledContent("Notifications", value: pushWord(push, for: environment.id))
                LabeledContent("Paired", value: Date(timeIntervalSince1970: environment.addedAt / 1000), format: .dateTime.day().month().year())
            } header: {
                Text("Host")
            }

            Section {
                Button("Pair Again") { pairingAgain = environment }
                    .accessibilityIdentifier("pair-again")
                Button("Forget This Host", role: .destructive) { forgetting = environment }
                    .accessibilityIdentifier("forget-host")
            } footer: {
                Text("Pairing again takes a new link from the host and replaces this key. Forgetting removes the key from this phone; the host keeps its threads.")
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle(environment.name)
        .navigationBarTitleDisplayMode(.inline)
        .scrollDismissesKeyboard(.interactively)
        .sheet(item: $pairingAgain) { AddEnvironmentSheet(replacing: $0) }
        .forgetHostDialog(host: $forgetting) { id in
            await model.registry.remove(id)
        }
        .onAppear { name = environment.name }
        .onDisappear { rename(environment) }
    }

    private enum Fix {
        case retry
        case pairAgain

        var title: String {
            switch self {
            case .retry: "Retry Now"
            case .pairAgain: "Pair Again"
            }
        }
    }

    /// The one action that helps: a new key when the key or the host's
    /// identity is wrong, a retry when the host is out of reach, nothing
    /// while it is connected, connecting, or needs an update this app cannot do.
    private func fix(for status: EnvironmentStatus) -> Fix? {
        switch status.transport {
        case .unauthorized: .pairAgain
        case .reconnecting: .retry
        case .offline:
            switch status.halt {
            case .identityChanged?: .pairAgain
            case .contractMismatch?: nil
            case nil: .retry
            }
        case .connecting: status.attempts > 0 ? .retry : nil
        case .open, .suspended: nil
        }
    }

    private func explanation(for status: EnvironmentStatus) -> String? {
        switch status.transport {
        case .open: nil
        case .connecting, .reconnecting: status.attempts > 0 ? "The phone keeps trying on its own; Retry tries now." : nil
        case .offline:
            switch status.halt {
            case .identityChanged?: "The address now answers as another host. Pair again to trust it."
            case .contractMismatch(let app, let host)?: host > app ? "Update this app to talk to the host." : "Update the host to talk to this app."
            case nil: "The phone will try again when the network returns."
            }
        case .unauthorized: "The host refused this key. A new pairing link from its Remote access pane replaces it."
        case .suspended: "Reconnects when the app comes forward."
        }
    }

    private func pushWord(_ push: PushRegistrar, for id: String) -> String {
        guard push.enabled else { return "Off" }
        if push.failures[id] != nil { return "Failed" }
        guard let status = push.statuses[id], status.registered else { return "Not registered" }
        switch status.relay {
        case .ok: return "On"
        case .none: return "No relay"
        case .failed: return "Failed"
        case .unknown: return "Registered"
        }
    }

    private func rename(_ environment: PairedEnvironment) {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed != environment.name else { return }
        model.registry.store.rename(environment.id, to: trimmed)
    }
}

/// Forgetting is confirmed: a confirmation dialog naming the host, with the
/// destructive action and what it means. Shared by the list and the detail.
private struct ForgetHostDialog: ViewModifier {
    @Binding var host: PairedEnvironment?
    let forget: (String) async -> Void

    func body(content: Content) -> some View {
        content.confirmationDialog(
            host.map { "Forget \u{201C}\($0.name)\u{201D}?" } ?? "Forget this host?",
            isPresented: Binding(get: { host != nil }, set: { if !$0 { host = nil } }),
            titleVisibility: .visible,
            presenting: host
        ) { environment in
            Button("Forget Host", role: .destructive) {
                Task { await forget(environment.id) }
            }
        } message: { _ in
            Text("Its threads stay on the host, and its key stays valid there until revoked. Pair again to come back.")
        }
    }
}

extension View {
    func forgetHostDialog(host: Binding<PairedEnvironment?>, forget: @escaping (String) async -> Void) -> some View {
        modifier(ForgetHostDialog(host: host, forget: forget))
    }
}
