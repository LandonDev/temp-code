import SwiftUI
import TempCodeClient
import TempCodeContract

/// Every paired host: name, connection dot and the abbreviated environment
/// id, each row pushing its detail. Adding one is a sheet; pairing again and
/// forgetting are on the detail, and also a swipe and a long press here.
struct HostsView: View {
    /// The stack's path: rows push `HostDetailRoute` through it, and so does
    /// the proof's hook, so the detail is one screen however it is reached.
    @Binding var path: NavigationPath
    @Environment(AppModel.self) private var model
    @State private var adding = false
    @State private var pairingAgain: PairedEnvironment?
    @State private var forgetting: PairedEnvironment?
    /// DEBUG: the proof's hooks fire once, not again when Hosts reappears after Back.
    @State private var hooksFired = false

    var body: some View {
        // The paired hosts; each host relayed through one sits under it (the hook below), never listed twice.
        let clients = model.registry.ordered.filter { !$0.environment.isRelayed }
        List {
            Section {
                ForEach(clients, id: \.environment.id) { client in
                    NavigationLink(value: HostDetailRoute(environmentId: client.environment.id)) {
                        HostRow(client: client)
                    }
                    .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                        // No destructive role here: a destructive swipe action slides the row
                        // out at once, and this one only asks.
                        Button("Forget", systemImage: "trash") { forgetting = client.environment }
                            .tint(Tint.destructive)
                        Button("Pair Again", systemImage: "key") { pairingAgain = client.environment }
                            .tint(Tint.warning)
                    }
                    .contextMenu {
                        Button("Pair Again", systemImage: "key") { pairingAgain = client.environment }
                        Button("Forget", systemImage: "trash", role: .destructive) { forgetting = client.environment }
                    }
                    .accessibilityIdentifier("environment-row")
                    // Thread 29: the hosts reached through this one (the Mac through the box).
                    ForEach(model.registry.relayed(via: client.environment.id), id: \.environment.id) { relayed in
                        NavigationLink(value: HostDetailRoute(environmentId: relayed.environment.id)) {
                            RelayedHostRow(client: relayed, carrierName: client.environment.name)
                        }
                    }
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
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button("Add a Host", systemImage: "plus") { adding = true }
            }
        }
        .sheet(isPresented: $adding) { AddEnvironmentSheet() }
        .sheet(item: $pairingAgain) { AddEnvironmentSheet(replacing: $0) }
        .forgetHostDialog(host: $forgetting) { id in
            await forgetHost(id, registry: model.registry)
        }
        .onAppear {
            #if DEBUG
            guard !hooksFired else { return }
            hooksFired = true
            if TestHooks.sheet == "pair" || TestHooks.sheet == "pair-error" { adding = true }
            if TestHooks.open == "host", let first = clients.first {
                // The same push a row's tap makes.
                path.append(HostDetailRoute(environmentId: first.environment.id))
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

    var body: some View {
        let status = client.status
        let line = second(status)
        HStack(spacing: Layout.rowGap) {
            ConnectionDot(status: status)
                .frame(width: Layout.markWidth)
                // The second line says the state; the dot's label would say it again.
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(client.environment.name)
                    .lineLimit(1)
                // The meta step's footnote; destructive only when the state
                // waits on the person, else the step's own secondary.
                ZStack(alignment: .leading) {
                    Text(line)
                        .font(TextStep.meta.font)
                        .foregroundStyle(HostFix.waitsOnUser(status) ? AnyShapeStyle(Tint.destructive) : AnyShapeStyle(HierarchicalShapeStyle.secondary))
                        .lineLimit(1)
                        .id(line)
                        .swapTransition()
                }
            }
            .layoutPriority(1)
            Spacer(minLength: Layout.rowGap)
            // An id must stay legible: `caption` mono, not the stamp step's
            // caption2, which falls under the floor for eight glyphs of mono.
            Text(abbreviatedEnvironmentId(client.environment.id))
                .font(.caption.monospaced())
                .foregroundStyle(.tertiary)
                .lineLimit(1)
                .truncationMode(.middle)
        }
        .padding(.vertical, 2)
        .animation(Motion.crossFade, value: line)
        .accessibilityElement(children: .combine)
    }

    private func second(_ status: EnvironmentStatus) -> String {
        status.transport == .open ? client.environment.host : ConnectionWord.text(for: status)
    }
}

/// One host in full: its state and the action that fixes it, what the host
/// is doing (thread 21's sections), the key and what it may do, the host's
/// facts, then Pair Again and Forget.
struct HostDetailView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let environmentId: String
    @State private var pairingAgain: PairedEnvironment?
    @State private var forgetting: PairedEnvironment?
    @State private var name = ""

    var body: some View {
        let client = model.registry.client(environmentId)
        Group {
            if let client, client.environment.isRelayed, let carrier = model.registry.carrier(of: client.environment.id) {
                // Thread 29: a relayed host's detail borrows its carrier's key and has no fix of its own.
                RelayedHostDetailView(client: client, carrier: carrier.environment)
            } else if let client {
                detail(client)
            } else {
                // Forgotten while on screen: the list behind is already without it.
                Color.clear.onAppear { dismiss() }
            }
        }
        .navigationTitle(client?.environment.name ?? "")
        .navigationBarTitleDisplayMode(.inline)
    }

    @ViewBuilder
    private func detail(_ client: EnvironmentClient) -> some View {
        let environment = client.environment
        let status = client.status
        let push = model.registry.push
        List {
            // 1. Status: the state, the one action that fixes it, and why.
            Section {
                HStack(spacing: Layout.rowGap) {
                    ConnectionDot(status: status)
                        .frame(width: Layout.markWidth)
                        .accessibilityHidden(true)
                    StatusText(status: status)
                        .lineLimit(2)
                    Spacer(minLength: Layout.rowGap)
                    if status.transport == .connecting {
                        ProgressView()
                            .controlSize(.small)
                            .transition(.opacity)
                    }
                }
                .animation(Motion.crossFade, value: status.transport)
                .accessibilityIdentifier("host-status")
                if let fix = HostFix.fix(for: status) {
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
                if let explanation = HostFix.explanation(for: status) {
                    Text(explanation)
                }
            }

            // 2. Activity: what the host is doing. Thread 21 ("Hosts: deploy
            // drift, the Mac bridge, devices, sync") adds exactly one line here,
            // `HostActivitySections(client: client)`, a view of its own under
            // Shell/Hosts/ whose body is one or more Sections, so they take the
            // inset grouped style and the list's animations like the rest.

            // 3. Key: the four capabilities and whether this key has them.
            Section {
                ForEach(Capability.ordered, id: \.rawValue) { capability in
                    let allowed = environment.allows(capability)
                    HStack(spacing: Layout.rowGap) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(capability.title)
                                .foregroundStyle(allowed ? Color.primary : Color.secondary)
                            Text(capability.detail)
                                .font(TextStep.meta.font)
                                .foregroundStyle(allowed ? AnyShapeStyle(HierarchicalShapeStyle.secondary) : AnyShapeStyle(HierarchicalShapeStyle.tertiary))
                        }
                        Spacer(minLength: Layout.rowGap)
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

            // 4. Host: its facts.
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
                // Older hosts send no build; the row shows only when the hello carried one.
                if let build = status.lastHello?.build {
                    LabeledContent("Version") {
                        Text(HostBuildLine.text(build))
                            .monospacedDigit()
                    }
                }
                if let hello = status.lastHello {
                    LabeledContent("Contract", value: "\(hello.contract)")
                }
                LabeledContent("Notifications", value: HostPushWord.text(enabled: push.enabled, failure: push.failures[environment.id], status: push.statuses[environment.id]))
                LabeledContent("Paired", value: Date(timeIntervalSince1970: environment.addedAt / 1000), format: .dateTime.day().month().year())
            } header: {
                Text("Host")
            }

            // 5. Pair Again and Forget.
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
        .scrollDismissesKeyboard(.interactively)
        .sheet(item: $pairingAgain) { AddEnvironmentSheet(replacing: $0) }
        .forgetHostDialog(host: $forgetting) { id in
            await forgetHost(id, registry: model.registry)
        }
        .onAppear { name = environment.name }
        .onDisappear { rename(environment) }
    }

    private func rename(_ environment: PairedEnvironment) {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed != environment.name else { return }
        model.registry.store.rename(environment.id, to: trimmed)
    }
}

/// Forgetting is confirmed: a confirmation dialog naming the host, with the
/// destructive action and what it means. Shared by the list and the detail;
/// `forget` is the package's `forgetHost`, which unregisters push on the
/// host first.
private struct ForgetHostDialog: ViewModifier {
    @Environment(AppModel.self) private var model
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
        } message: { environment in
            // Thread 29: the hosts relayed through this one go with it, by name.
            Text(forgetCopy(carrier: environment.name, relayed: model.registry.relayed(via: environment.id).map(\.environment.name)))
        }
    }
}

extension View {
    func forgetHostDialog(host: Binding<PairedEnvironment?>, forget: @escaping (String) async -> Void) -> some View {
        modifier(ForgetHostDialog(host: host, forget: forget))
    }
}
