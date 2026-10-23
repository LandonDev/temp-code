import SwiftUI
import TempCodeClient
import TempCodeContract

/// Home: the workspaces, the way the desktop's far-left column lists them.
/// One row per workspace across every paired host (linked copies are one
/// row), with the column's one status mark: paused, needs you, unread, or
/// the working line naming what runs. Chats outside every workspace lead as
/// their own row. A tap pushes the workspace (WorkspaceScreen.swift). With
/// two or more hosts, each host is one row at the foot with its menu.
/// Paints from the cache before any socket; nothing animates on that first
/// paint. `slots` is what sibling threads plug in (HomeSlots.swift).
struct HomeView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(NavigationRouter.self) private var router
    @Environment(NewThreadPresenter.self) private var presenter
    @Binding var path: NavigationPath
    var slots = HomeSlots()
    @State private var adding = false
    @State private var pairingAgain: PairedEnvironment?
    @State private var launched = false
    /// The first body has been on screen: from here on, event rows animate in.
    @State private var painted = false

    var body: some View {
        let clients = model.registry.ordered
        let home = HomeSections.home(hosts: HomeRows.inputs(clients, notes: slots.hostNotes))
        Group {
            if !model.ready {
                Color.clear
            } else if clients.isEmpty {
                NoHostsView { adding = true }
            } else {
                List {
                    hostLines(home.hosts)
                    Section {
                        ForEach(home.entries) { entry in
                            WorkspaceEntryRow(entry: entry, offline: offline(entry, hosts: clients.count), path: $path)
                        }
                        if home.entries.isEmpty {
                            ForEach(home.hosts.filter(\.nothing)) { host in
                                NothingRow(host: host, path: $path)
                            }
                        }
                    }
                    if clients.count > 1 {
                        Section {
                            ForEach(clients, id: \.environment.id) { client in
                                HostFootRow(client: client, slots: slots)
                            }
                        }
                    }
                }
                .listStyle(.plain)
                .listSectionSpacing(10)
                .animation(painted ? Motion.rowAppear : nil, value: eventKey(home.hosts))
                .task(id: clients.first?.hasShell) { await performLaunch(clients) }
                .task {
                    // The cached paint lands in the first frames; whatever lands after this is an event.
                    try? await Task.sleep(for: .milliseconds(300))
                    painted = true
                }
            }
        }
        .navigationTitle("Home")
        .navigationBarTitleDisplayMode(.large)
        .toolbar {
            ToolbarItemGroup(placement: .primaryAction) {
                // With one host there is no host row at the foot, so its menu sits here.
                if clients.count == 1, let client = clients.first, let hostMenu = slots.hostMenu {
                    Menu {
                        hostMenu(client)
                    } label: {
                        Image(systemName: GlassMetrics.moreSymbol)
                    }
                    .accessibilityLabel(client.environment.name)
                }
                Button("Settings", systemImage: "gearshape") { path.append(Route.settings) }
            }
        }
        .listOnScreen("home")
        .sheet(isPresented: $adding) { AddEnvironmentSheet() }
        .sheet(item: $pairingAgain) { AddEnvironmentSheet(replacing: $0) }
        .onChange(of: router.restoredSheet, initial: true) { restoreSheet() }
        .onChange(of: model.ready) { restoreSheet() }   // the cached shell is painted by then
    }

    /// A troubled host's status row and every host's one-off notes, at the top.
    @ViewBuilder
    private func hostLines(_ hosts: [HomeSections.HostLines]) -> some View {
        let shown = hosts.filter { $0.status || !$0.notes.isEmpty }
        if !shown.isEmpty {
            Section {
                ForEach(shown) { host in
                    if host.status, let client = model.registry.client(host.environmentId) {
                        HostStatusRow(client: client, trailing: slots.hostTrailing?(client)) { pairingAgain = client.environment }
                            .listRowInsets(EdgeInsets(top: 4, leading: Layout.textEdge, bottom: 4, trailing: Layout.textEdge))
                            .listRowSeparator(.hidden)
                            .transition(painted ? Motion.appear(reduced: reduceMotion) : .identity)
                    }
                    ForEach(host.notes) { note in
                        QuietNote(text: note.text)
                            .listRowInsets(Layout.rowInsets)
                            .listRowSeparator(.hidden)
                            .transition(painted ? Motion.appear(reduced: reduceMotion) : .identity)
                    }
                }
            }
        }
    }

    /// With two or more hosts, a row whose every host is down sits under the
    /// offline tint, as the desktop's rail rows do.
    private func offline(_ entry: HomeSections.Entry, hosts: Int) -> Bool {
        guard hosts > 1 else { return false }
        return entry.environmentIds.allSatisfy { model.registry.client($0)?.status.transport != .open }
    }

    /// Changes when a status row or a note comes or goes: the one key Home animates on.
    private func eventKey(_ hosts: [HomeSections.HostLines]) -> String {
        hosts.map { "\($0.environmentId):\($0.status):\($0.notes.map(\.id).joined(separator: "|"))" }.joined(separator: ",")
    }

    /// The new-thread sheet the last run had up (return flow, thread 14).
    private func restoreSheet() {
        guard case .newThread(let environmentId, let workspaceId, let projectId)? = router.restoredSheet,
              let client = model.registry.client(environmentId), let workspace = client.workspaces.first(where: { $0.id == workspaceId }) else { return }
        router.restoredSheet = nil
        presenter.compose(client, workspace, projectId.flatMap { id in client.projects.first { $0.id == id } })
    }

    /// DEBUG only: the proof opens the new-thread sheet, a fleet confirm, or
    /// creates a chat in the first workspace and opens it.
    private func performLaunch(_ clients: [EnvironmentClient]) async {
        guard let client = clients.first, client.hasShell, let workspace = client.workspaces.first else { return }
        if TestHooks.sheet == "new", presenter.target == nil {
            presenter.compose(client, workspace, nil)
        } else if let sheet = TestHooks.sheet, sheet.hasPrefix("fleet:"), let action = TestHooks.batchAction(String(sheet.dropFirst(6))), !launched {
            // The fleet confirm for the shot, host scope (thread iOS 20).
            launched = true
            FleetSwitches.shared.request(action, client: client, scope: .host(name: client.environment.name))
        } else if let hook = TestHooks.action, hook.hasPrefix("batch:"), let action = TestHooks.batchAction(String(hook.dropFirst(6))), !launched {
            launched = true
            await FleetSwitches.shared.run(action, client: client, scope: .host(name: client.environment.name))
        } else if TestHooks.action == "new-chat", !launched {
            launched = true
            guard let catalog = await client.loadCatalog(), let provider = CatalogChoice.providerOrder.compactMap({ catalog[$0.rawValue] }).first else { return }
            let draft = ThreadDraft.thread(type: .chat, workspaceId: workspace.id, projectId: nil, provider: provider.id, model: provider.defaultModel, reasoning: nil, permission: nil)
            if let created = try? await client.createThread(draft) {
                path.append(Route.thread(environmentId: client.environment.id, sessionId: created.id, seq: nil))
            }
        }
    }
}

/// One workspace row: the mark at 28 pt, the name, and its state. A busy
/// workspace says what runs on the line under its name; any other state is
/// the one mark at the trailing edge. The whole row pushes; a long press
/// offers New Thread.
private struct WorkspaceEntryRow: View {
    @Environment(AppModel.self) private var model
    @Environment(NewThreadPresenter.self) private var presenter
    let entry: HomeSections.Entry
    let offline: Bool
    @Binding var path: NavigationPath
    @ScaledMetric(relativeTo: .subheadline) private var icon: CGFloat = 28

    var body: some View {
        Button { path.append(Route.workspace(key: entry.id)) } label: {
            HStack(spacing: Layout.rowGap + 2) {
                mark
                    .frame(width: icon, height: icon)
                VStack(alignment: .leading, spacing: 2) {
                    Text(name)
                        .textStep(.title, weight: .medium)
                        .lineLimit(1)
                    if case .busy(let running)? = entry.status {
                        WorkingLine(running: running)
                    }
                }
                Spacer(minLength: 8)
                if let status = entry.status, !status.isBusy {
                    RailMark(status: status)
                }
            }
            .padding(.vertical, 8)
            .frame(minHeight: Layout.rowHeight + 8)
            .contentShape(Rectangle())
            .separatorAtTextEdge(icon + Layout.rowGap + 2)
        }
        .buttonStyle(.pressable)
        .listRowInsets(Layout.rowInsets)
        .opacity(offline ? 0.5 : 1)
        .contextMenu {
            if let lead {
                Button("New Thread", systemImage: "square.and.pencil") { presenter.compose(lead.client, lead.workspace, nil) }
            }
        }
        .accessibilityElement(children: .combine)
    }

    private var name: String {
        switch entry.kind {
        case .workspace(let workspace): workspace.name
        case .chats: "Chats"
        }
    }

    private var lead: (client: EnvironmentClient, workspace: WorkspaceMeta)? {
        guard case .workspace(let workspace) = entry.kind, let first = workspace.members.first,
              let client = model.registry.client(first.environmentId) else { return nil }
        return (client: client, workspace: first.workspace)
    }

    @ViewBuilder
    private var mark: some View {
        if let lead {
            WorkspaceIconView(client: lead.client, workspace: lead.workspace, size: icon)
        } else {
            Image(systemName: "bubble.left.and.bubble.right")
                .font(TextStep.title.font.weight(.medium))
                .foregroundStyle(.secondary)
        }
    }
}

extension RailStatus {
    var isBusy: Bool {
        if case .busy = self { return true }
        return false
    }
}

/// A host that lists nothing, while Home has no workspace at all: the
/// system's spinner until it has listed, then the fact and where to fix it.
private struct NothingRow: View {
    let host: HomeSections.HostLines
    @Binding var path: NavigationPath

    var body: some View {
        Group {
            if host.listed {
                QuietNote(text: "No workspaces on \(host.name) yet. Open a folder there and it appears here.", action: ("Hosts", { path.append(Route.hosts) }))
            } else {
                ProgressView()
                    .frame(maxWidth: .infinity, minHeight: Layout.rowHeight)
            }
        }
        .listRowInsets(Layout.rowInsets)
        .listRowSeparator(.hidden)
    }
}

/// With two or more hosts, one row per host at the foot, as the desktop's
/// host rows sit above Settings: the host's glyph, its name with the relay
/// line under it, its connection dot, the drift mark; a tap opens its menu.
private struct HostFootRow: View {
    @Environment(AppModel.self) private var model
    let client: EnvironmentClient
    let slots: HomeSlots

    var body: some View {
        Group {
            if let hostMenu = slots.hostMenu {
                Menu { hostMenu(client) } label: { label }
                    .buttonStyle(.pressable)
            } else {
                label
            }
        }
        .listRowInsets(Layout.rowInsets)
        .listRowSeparator(.hidden)
    }

    private var label: some View {
        HStack(spacing: Layout.rowGap) {
            MetaGlyph(HostKind(platform: model.registry.platform(client.environment.id)).symbol, tint: .secondary, label: "")
                .frame(width: Layout.markWidth)
            VStack(alignment: .leading, spacing: 1) {
                Text(client.environment.name)
                    .textStep(.meta, tint: Color(.secondaryLabel))
                    .lineLimit(1)
                slots.hostSubline?(client)
            }
            ConnectionDot(status: client.status, relay: client.relayState)
            Spacer(minLength: 8)
            slots.hostTrailing?(client)
        }
        .frame(minHeight: Layout.rowHeight)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityLabel(client.environment.name)
    }
}

/// The first run: one tap to pair.
private struct NoHostsView: View {
    let add: () -> Void

    var body: some View {
        ContentUnavailableView {
            Label("Nothing Paired Yet", systemImage: "desktopcomputer")
        } description: {
            Text("Pair your Mac or the agent host to see its threads here.")
        } actions: {
            Button("Pair a Host", action: add)
                .buttonStyle(.borderedProminent)
        }
    }
}
