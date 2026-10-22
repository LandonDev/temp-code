import SwiftUI
import TempCodeClient
import TempCodeContract

/// Home: what needs you, what runs, then every host's workspaces, as native
/// sections under a large title. Paints from the cache before any socket;
/// the socket's catch-up lands as a diff, and nothing animates on that
/// first paint. `slots` is what sibling threads plug in (HomeSlots.swift).
struct HomeView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(NavigationRouter.self) private var router
    @Binding var path: NavigationPath
    var slots = HomeSlots()
    /// Folded workspace keys, one per line, remembered across launches.
    @AppStorage("home.folded") private var foldedRaw = ""
    /// The needs-you cue per thread (its line and the row to land on), from its
    /// newest rows, keyed by host and thread (a moved thread can be cached on two).
    @State private var cues: [String: HomeModel.Cue] = [:]
    @State private var adding = false
    @State private var pairingAgain: PairedEnvironment?
    /// The workspace (and project) a new thread is being composed for.
    @State private var composing: NewThreadTarget?
    @State private var launched = false
    /// The first body has been on screen: from here on, event rows animate in.
    @State private var painted = false

    private var folded: Set<String> {
        Set(foldedRaw.split(separator: "\n").map(String.init))
    }

    var body: some View {
        let clients = model.registry.ordered
        let sections = HomeRows.build(clients: clients, folded: folded, slots: slots)
        Group {
            if !model.ready {
                Color.clear
            } else if clients.isEmpty {
                NoHostsView { adding = true }
            } else {
                ScrollViewReader { proxy in
                    List {
                        ForEach(sections) { section in
                            Section {
                                ForEach(section.rows) { row in
                                    if let client = model.registry.client(row.environmentId) {
                                        HomeRowView(row: row, client: client, cue: cue(for: row), path: $path, slots: slots, pairAgain: { pairingAgain = $0 }, newThread: compose)
                                            // The same transition either way, so flipping `painted` never re-creates the row.
                                            .transition(row.isEvent && painted ? Motion.appear(reduced: reduceMotion) : .identity)
                                    }
                                }
                            } header: {
                                HomeHeaderView(header: section.header, slots: slots, fold: toggleFold, newThread: compose)
                            }
                            .headerProminence(section.header.isTitle ? .increased : .standard)
                            .id(section.id)
                        }
                    }
                    .listStyle(.plain)
                    .listSectionSpacing(10)
                    .animation(painted ? Motion.rowAppear : nil, value: eventKey(sections))
                    .task(id: needsKey(sections)) { await loadLines(sections) }
                    .task(id: clients.first?.hasShell) { await performLaunch(clients, sections: sections, proxy: proxy) }
                    .task {
                        // The cached paint lands in the first frames; whatever lands after this is an event.
                        try? await Task.sleep(for: .milliseconds(300))
                        painted = true
                    }
                }
            }
        }
        .navigationTitle("Home")
        .navigationBarTitleDisplayMode(.large)
        .toolbar {
            ToolbarItemGroup(placement: .primaryAction) {
                // With one host its menu has no header to sit on, so it sits here.
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
        .sheet(isPresented: $adding) { AddEnvironmentSheet() }
        .sheet(item: $pairingAgain) { AddEnvironmentSheet(replacing: $0) }
        .sheet(item: $composing) { target in
            NewThreadSheet(client: target.client, workspace: target.workspace, project: target.project) { created in
                path.append(Route.thread(environmentId: target.client.environment.id, sessionId: created.id, seq: nil))
            }
        }
        // Return flow (thread 14): the sheet survives a kill.
        .onChange(of: composing?.id) { NavigationMemory.rememberSheet(composing.map { .newThread(environmentId: $0.client.environment.id, workspaceId: $0.workspace.id, projectId: $0.project?.id) }) }
        .onChange(of: router.restoredSheet, initial: true) { restoreSheet() }
        .onChange(of: model.ready) { restoreSheet() }   // the cached shell is painted by then
    }

    /// The new-thread sheet the last run had up (return flow, thread 14).
    private func restoreSheet() {
        guard case .newThread(let environmentId, let workspaceId, let projectId)? = router.restoredSheet,
              let client = model.registry.client(environmentId), let workspace = client.workspaces.first(where: { $0.id == workspaceId }) else { return }
        router.restoredSheet = nil
        composing = NewThreadTarget(client: client, workspace: workspace, project: projectId.flatMap { id in client.projects.first { $0.id == id } })
    }

    private func compose(_ client: EnvironmentClient, _ workspace: WorkspaceMeta, _ project: ProjectMeta?) {
        composing = NewThreadTarget(client: client, workspace: workspace, project: project)
    }

    /// DEBUG only: the proof opens the new-thread sheet, creates a chat in the
    /// first workspace and opens it, folds a workspace, or scrolls one to the top.
    private func performLaunch(_ clients: [EnvironmentClient], sections: [HomeSection], proxy: ScrollViewProxy) async {
        guard let client = clients.first, client.hasShell, let workspace = client.workspaces.first else { return }
        let listed = sections.compactMap { section -> HomeWorkspace? in
            if case .workspace(let workspace, _, _) = section.header { return workspace }
            return nil
        }
        if let part = HomeTestHooks.fold, let target = listed.first(where: { $0.name.localizedCaseInsensitiveContains(part) }), !folded.contains(HomeSections.foldKey(target)) {
            foldedRaw = folded.union([HomeSections.foldKey(target)]).sorted().joined(separator: "\n")
        }
        if let part = HomeTestHooks.scroll, let target = listed.first(where: { $0.name.localizedCaseInsensitiveContains(part) }),
           let section = sections.first(where: { $0.id == "workspace:\(target.id)" }), let first = section.rows.first {
            // A List scrolls to a row, not to a Section: the workspace's first row, with its header pinned above it.
            try? await Task.sleep(for: .milliseconds(600))
            proxy.scrollTo(first.id, anchor: .top)
        }
        if TestHooks.sheet == "new", composing == nil {
            composing = NewThreadTarget(client: client, workspace: workspace, project: nil)
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

    /// Fold or unfold a workspace: its rows leave with the collapse curve and
    /// come back with the expand spring; reduced motion cross-fades. A linked
    /// workspace folds by its link, so every copy folds at once.
    private func toggleFold(_ workspace: HomeWorkspace) {
        var keys = folded
        let key = HomeSections.foldKey(workspace)
        let opening = keys.contains(key)
        if !keys.insert(key).inserted { keys.remove(key) }
        let animation: Animation = reduceMotion ? Motion.crossFade : (opening ? Motion.expand : Motion.collapse)
        withAnimation(animation) {
            foldedRaw = keys.sorted().joined(separator: "\n")
        }
    }

    private func cue(for row: HomeRow) -> HomeModel.Cue? {
        if case .needsYou(let environmentId, let item) = row { return cues[Self.cueKey(environmentId, item.id)] }
        return nil
    }

    private static func cueKey(_ environmentId: String, _ sessionId: String) -> String {
        "\(environmentId):\(sessionId)"
    }

    /// Changes when a needs-you thread arrives, leaves or moves.
    private func needsKey(_ sections: [HomeSection]) -> String {
        sections.flatMap(\.rows).compactMap { row -> String? in
            if case .needsYou(let environmentId, let item) = row { return "\(environmentId):\(item.id):\(item.meta.updatedAt)" }
            return nil
        }.joined(separator: ",")
    }

    /// Changes when an event row comes or goes (a host's status, a thread
    /// needing you, a host's note): the one key Home animates on. A thread
    /// starting is routine and changes nothing here.
    private func eventKey(_ sections: [HomeSection]) -> String {
        sections.flatMap(\.rows).filter(\.isEvent).map(\.id).joined(separator: ",")
    }

    private func loadLines(_ sections: [HomeSection]) async {
        for row in sections.flatMap(\.rows) {
            guard case .needsYou(let environmentId, let item) = row, let client = model.registry.client(environmentId) else { continue }
            let tail = item.kind == .paused ? [] : await client.peekTail(item.id)
            // iOS 18: a waiting thread's row reads its notes' State line (NeedsYouNotes.swift).
            let cue = await NeedsYouNotes.cue(HomeModel.cue(for: item, rows: tail), for: item, client: client)
            // The key changed under this task: a newer run owns the cues now.
            guard !Task.isCancelled else { return }
            let key = Self.cueKey(environmentId, item.id)
            if cues[key] != cue { cues[key] = cue }
        }
    }
}

extension HomeSection.Header {
    /// "Needs you" and "Running": the system's prominent header. Every other
    /// header draws its own row.
    var isTitle: Bool {
        if case .title = self { return true }
        return false
    }
}

/// Home's own launch hooks, for the proof only; a release build reads none.
private enum HomeTestHooks {
    #if DEBUG
    /// Part of a workspace name: that workspace scrolls to the top once the shell is listed.
    static let scroll = ProcessInfo.processInfo.environment["TC_TEST_HOME_SCROLL"].flatMap { $0.isEmpty ? nil : $0 }
    /// Part of a workspace name: that workspace starts folded.
    static let fold = ProcessInfo.processInfo.environment["TC_TEST_HOME_FOLD"].flatMap { $0.isEmpty ? nil : $0 }
    #else
    static let scroll: String? = nil
    static let fold: String? = nil
    #endif
}

/// A section's header: nothing, a prominent title, a host, the chats group,
/// or a workspace's fold row.
private struct HomeHeaderView: View {
    @Environment(AppModel.self) private var model
    let header: HomeSection.Header
    let slots: HomeSlots
    let fold: (HomeWorkspace) -> Void
    let newThread: (EnvironmentClient, WorkspaceMeta, ProjectMeta?) -> Void

    var body: some View {
        switch header {
        case .none:
            EmptyView()
        case .title(let title):
            Text(title)
                .textCase(nil)
        case .host(let environmentId, _):
            if let client = model.registry.client(environmentId) {
                HostHeader(client: client, slots: slots)
                    .listRowInsets(EdgeInsets())
            }
        case .chats:
            // The host's loose chats: a workspace-level group, drawn as one, with no fold and no plus (a new thread needs a workspace).
            GroupHeaderRow(name: "Chats", repo: nil, collapsed: false, threads: 0, members: []) {
                Image(systemName: "bubble.left")
                    .font(TextStep.title.font.weight(.medium))
                    .foregroundStyle(.secondary)
                    .frame(width: 22, height: 22)
            }
            .padding(.horizontal, Layout.textEdge)
            .textCase(nil)
            .listRowInsets(EdgeInsets())
        case .workspace(let workspace, let collapsed, let threads):
            if let first = workspace.members.first, let client = model.registry.client(first.environmentId) {
                HStack(spacing: 0) {
                    Button { fold(workspace) } label: {
                        GroupHeaderRow(name: workspace.name, repo: workspace.repo, collapsed: collapsed, threads: threads, members: workspace.isPaired ? workspace.members : []) {
                            WorkspaceIconView(client: client, workspace: first.workspace, size: 22)
                        }
                    }
                    .buttonStyle(.pressable)
                    NewThreadButton { newThread(client, first.workspace, nil) }
                }
                .padding(.leading, Layout.textEdge)
                .padding(.trailing, 4)
                .textCase(nil)
                .listRowInsets(EdgeInsets())
            }
        }
    }
}

/// One row of Home. Content rows share the text edge.
private struct HomeRowView: View {
    @Environment(AppModel.self) private var model
    let row: HomeRow
    let client: EnvironmentClient
    let cue: HomeModel.Cue?
    @Binding var path: NavigationPath
    let slots: HomeSlots
    let pairAgain: (PairedEnvironment) -> Void
    let newThread: (EnvironmentClient, WorkspaceMeta, ProjectMeta?) -> Void

    var body: some View {
        switch row {
        case .status:
            HostStatusRow(client: client, trailing: slots.hostTrailing?(client)) { pairAgain(client.environment) }
                .listRowInsets(EdgeInsets(top: 4, leading: Layout.textEdge, bottom: 4, trailing: Layout.textEdge))
                .listRowSeparator(.hidden)
        case .hostNote(_, let note):
            QuietNote(text: note.text)
                .listRowInsets(Layout.rowInsets)
                .listRowSeparator(.hidden)
        case .needsYou(_, let item):
            Button { open(item.meta.id, seq: cue?.seq) } label: {
                ThreadRow(row: .needsYou(item: item, cue: cue)) { HostGlyph(environmentId: client.environment.id) }
            }
            .buttonStyle(.pressable)
            .listRowInsets(Layout.rowInsets)
            .listRowBackground(Surface.needsYou)
            .threadRowActions(client: client, meta: item.meta) { MasterPinButton(client: client, session: item.meta) }
        case .running(_, let meta):
            threadButton(meta, ThreadRowModel(session: meta))
        case .calm(_, let workspace):
            QuietNote(text: "Nothing needs you right now.", action: ("New thread", { newThread(client, workspace, nil) }))
                .listRowInsets(Layout.rowInsets)
                .listRowSeparator(.hidden)
        case .project(_, let linked):
            // The lead copy (the first host in registry order) takes the plus and the menu;
            // the settings entry finds the copy the settings live on itself.
            let project = linked.project
            let workspace = client.workspaces.first { $0.id == project.workspaceId }
            ProjectHeaderRow(project: project) {
                slots.projectTrailing?(client, project)
                if let workspace {
                    NewThreadButton { newThread(client, workspace, project) }
                }
                if slots.hasProjectMenu {
                    HeaderMenu(systemImage: "ellipsis", label: "\(project.name) menu") {
                        if let workspace {
                            Button("New Thread", systemImage: "square.and.pencil") { newThread(client, workspace, project) }
                        }
                        if let settings = slots.projectSettings {
                            Divider()
                            settings(client, project)
                        }
                        if let batch = slots.projectBatch {
                            Divider()
                            if linked.isLinked {
                                // One set per host: each acts on that host's copy alone.
                                ForEach(linked.members, id: \.environmentId) { member in
                                    if let memberClient = model.registry.client(member.environmentId) {
                                        Section(memberClient.environment.name) { batch(memberClient, member.group.project) }
                                    }
                                }
                            } else {
                                batch(client, project)
                            }
                        }
                    }
                }
            }
            .listRowInsets(EdgeInsets(top: 0, leading: Layout.textEdge, bottom: 0, trailing: 4))
            .listRowSeparator(.hidden)
        case .thread(_, let item):
            threadButton(item.meta, ThreadRowModel(session: item.meta, unseen: item.unseen))
        case .moreAgents(_, let root, let hidden):
            Button { open(root.id) } label: {
                DimRow(hidden == 1 ? "1 more subagent" : "\(hidden) more subagents")
                    .padding(.leading, Layout.rowTextEdge + Layout.indent)
            }
            .buttonStyle(.pressable)
            .listRowInsets(Layout.rowInsets)
        case .archivedThreads(_, let group):
            Button { path.append(Route.archivedThreads(environmentId: client.environment.id, projectId: group.id)) } label: {
                HStack(spacing: 6) {
                    DimRow(group.archivedCount == 1 ? "1 archived" : "\(group.archivedCount) archived")
                    HostGlyph(environmentId: client.environment.id)
                }
            }
            .buttonStyle(.pressable)
            .listRowInsets(Layout.rowInsets)
        case .archivedProjects(_, let workspace, let count):
            Button { path.append(Route.archivedProjects(environmentId: client.environment.id, workspaceId: workspace.id)) } label: {
                DimRow(count == 1 ? "1 archived project" : "\(count) archived projects")
            }
            .buttonStyle(.pressable)
            .listRowInsets(Layout.rowInsets)
        case .emptyWorkspace(_, let workspace):
            QuietNote(text: "No threads here yet.", action: ("New thread", { newThread(client, workspace, nil) }))
                .listRowInsets(Layout.rowInsets)
                .listRowSeparator(.hidden)
        case .nothing(_, let name, let listed):
            Group {
                if listed {
                    QuietNote(text: "No workspaces on \(name) yet. Open a folder there and it appears here.", action: ("Hosts", { path.append(Route.hosts) }))
                } else {
                    // Not listed yet: the system's spinner in an ordinary row, nothing bespoke.
                    ProgressView()
                        .frame(maxWidth: .infinity, minHeight: Layout.rowHeight)
                }
            }
            .listRowInsets(Layout.rowInsets)
            .listRowSeparator(.hidden)
        }
    }

    private func open(_ sessionId: String, seq: Int? = nil) {
        path.append(Route.thread(environmentId: client.environment.id, sessionId: sessionId, seq: seq))
    }

    private func threadButton(_ meta: SessionMeta, _ row: ThreadRowModel) -> some View {
        Button { open(meta.id) } label: {
            ThreadRow(row: row) { HostGlyph(environmentId: client.environment.id) }
        }
        .buttonStyle(.pressable)
        .listRowInsets(Layout.rowInsets)
        // Start now on a queued root, Resume on a stopped one (thread iOS 20).
        .threadRowActions(client: client, meta: meta) {
            RowStateActions(client: client, meta: meta)
            MasterPinButton(client: client, session: meta)
        }
    }
}

/// Where a new thread goes: the workspace, and the project when one was chosen.
struct NewThreadTarget: Identifiable {
    let client: EnvironmentClient
    let workspace: WorkspaceMeta
    let project: ProjectMeta?

    var id: String { "\(client.environment.id):\(workspace.id):\(project?.id ?? "")" }
}

/// With several hosts, each one's workspaces sit under its name and
/// connection dot, with a sibling's trailing mark and its menu when set.
private struct HostHeader: View {
    let client: EnvironmentClient
    let slots: HomeSlots

    var body: some View {
        HStack(spacing: 8) {
            ConnectionDot(status: client.status, relay: client.relayState)
            VStack(alignment: .leading, spacing: 1) {
                Text(client.environment.name)
                    .textStep(.title, weight: .semibold)
                    .lineLimit(1)
                slots.hostSubline?(client)
            }
            Spacer(minLength: 8)
            slots.hostTrailing?(client)
            if let hostMenu = slots.hostMenu {
                HeaderMenu(systemImage: "ellipsis.circle", label: "\(client.environment.name) menu") {
                    hostMenu(client)
                }
            }
        }
        .textCase(nil)
        .padding(.leading, Layout.textEdge)
        .padding(.trailing, slots.hostMenu == nil ? Layout.textEdge : 4)
        .padding(.top, 18)
        .padding(.bottom, 2)
        .accessibilityElement(children: .contain)
        .accessibilityAddTraits(.isHeader)
    }
}

/// A workspace-level group's header row: its mark, its name, the repo dim
/// under it, one connection dot per member host when linked, and while
/// folded the number of threads inside. The whole row is the fold; no
/// chevron. The chats group draws the same row with a glyph and no fold.
private struct GroupHeaderRow<Icon: View>: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dynamicTypeSize) private var typeSize
    let name: String
    let repo: String?
    let collapsed: Bool
    let threads: Int
    /// The member hosts when the workspace is linked across hosts; empty otherwise.
    let members: [HomeWorkspace.Member]
    @ViewBuilder let icon: () -> Icon

    var body: some View {
        HStack(spacing: Layout.rowGap) {
            HStack(spacing: 4) {
                icon()
                ForEach(members, id: \.environmentId) { member in
                    if let client = model.registry.client(member.environmentId) {
                        ConnectionDot(status: client.status, relay: client.relayState)
                    }
                }
            }
            VStack(alignment: .leading, spacing: 1) {
                Text(name)
                    .textStep(.title, weight: .semibold)
                    .lineLimit(1)
                if let repo, !repo.isEmpty, !typeSize.isAccessibilitySize {
                    Text(repo)
                        .textStep(.stamp)
                        .lineLimit(1)
                }
            }
            Spacer(minLength: 8)
            if collapsed, threads > 0 {
                CountText(threads)
                    .transition(.opacity)
            }
        }
        .padding(.top, 10)
        .padding(.bottom, 4)
        .frame(minHeight: Layout.rowHeight)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityLabel(name)
        .accessibilityValue(collapsed ? (threads == 1 ? "Collapsed, 1 thread" : "Collapsed, \(threads) threads") : "Expanded")
        .accessibilityAddTraits(.isHeader)
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
