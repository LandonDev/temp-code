import SwiftUI
import TempCodeClient
import TempCodeContract

/// Home: what needs you, what runs, then every host's workspaces, as native
/// sections under a large title. Paints from the cache before any socket;
/// the socket's catch-up lands as a diff, and nothing animates on that
/// first paint.
struct HomeView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Binding var path: NavigationPath
    /// Folded workspace keys, one per line, remembered across launches.
    @AppStorage("home.folded") private var foldedRaw = ""
    /// The needs-you cue per thread (its line and the row to land on), from its newest rows.
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
        let sections = HomeRows.build(clients: clients, folded: folded)
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
                                    HomeRowView(row: row, cue: cue(for: row), path: $path, pairAgain: { pairingAgain = $0 }, newThread: compose)
                                        .transition(row.isEvent && painted ? HomeStyles.eventRow(reduced: reduceMotion) : .identity)
                                }
                            } header: {
                                HomeHeaderView(header: section.header, fold: toggleFold, newThread: compose)
                            }
                            .id(section.id)
                        }
                    }
                    .listStyle(.plain)
                    .animation(painted ? Motion.rowAppear : nil, value: eventKey(sections))
                    .task(id: needsKey(sections)) { await loadLines(sections) }
                    .task(id: clients.first?.hasShell) { await performLaunch(clients, proxy: proxy) }
                    .task {
                        // One turn of the run loop after the cached paint: the diff that follows is an event.
                        await Task.yield()
                        painted = true
                    }
                }
            }
        }
        .navigationTitle("Home")
        .navigationBarTitleDisplayMode(.large)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
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
    }

    private func compose(_ client: EnvironmentClient, _ workspace: WorkspaceMeta, _ project: ProjectMeta?) {
        composing = NewThreadTarget(client: client, workspace: workspace, project: project)
    }

    /// DEBUG only: the proof opens the new-thread sheet, creates a chat in the
    /// first workspace and opens it, folds a workspace, or scrolls one to the top.
    private func performLaunch(_ clients: [EnvironmentClient], proxy: ScrollViewProxy) async {
        guard let client = clients.first, client.hasShell, let workspace = client.workspaces.first else { return }
        if let part = HomeTestHooks.fold, let target = client.workspaces.first(where: { $0.name.localizedCaseInsensitiveContains(part) }), !folded.contains(HomeRows.foldKey(client, target)) {
            foldedRaw = (folded.union([HomeRows.foldKey(client, target)])).sorted().joined(separator: "\n")
        }
        if let part = HomeTestHooks.scroll, let target = client.workspaces.first(where: { $0.name.localizedCaseInsensitiveContains(part) }) {
            try? await Task.sleep(for: .milliseconds(600))
            proxy.scrollTo("workspace:\(client.environment.id):\(target.id)", anchor: .top)
        }
        if TestHooks.sheet == "new", composing == nil {
            composing = NewThreadTarget(client: client, workspace: workspace, project: nil)
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
    /// come back with the expand spring; reduced motion cross-fades.
    private func toggleFold(_ client: EnvironmentClient, _ workspace: WorkspaceMeta) {
        var keys = folded
        let key = HomeRows.foldKey(client, workspace)
        let opening = keys.contains(key)
        if !keys.insert(key).inserted { keys.remove(key) }
        let animation: Animation = reduceMotion ? Motion.crossFade : (opening ? Motion.expand : Motion.collapse)
        withAnimation(animation) {
            foldedRaw = keys.sorted().joined(separator: "\n")
        }
    }

    private func cue(for row: HomeRow) -> HomeModel.Cue? {
        if case .needsYou(_, let item) = row { return cues[item.id] }
        return nil
    }

    /// Changes when a needs-you thread arrives, leaves or moves.
    private func needsKey(_ sections: [HomeSection]) -> String {
        sections.flatMap(\.rows).compactMap { row -> String? in
            if case .needsYou(_, let item) = row { return "\(item.id):\(item.meta.updatedAt)" }
            return nil
        }.joined(separator: ",")
    }

    /// Changes when an event row (a host's status, a needs-you thread) or a
    /// running thread comes or goes: the one key Home animates on.
    private func eventKey(_ sections: [HomeSection]) -> String {
        sections.flatMap(\.rows).compactMap { row -> String? in
            switch row {
            case .status, .needsYou, .running: row.id
            default: nil
            }
        }.joined(separator: ",")
    }

    private func loadLines(_ sections: [HomeSection]) async {
        for row in sections.flatMap(\.rows) {
            guard case .needsYou(let client, let item) = row else { continue }
            let tail = item.kind == .paused ? [] : await client.peekTail(item.id)
            let cue = HomeModel.cue(for: item.kind, rows: tail)
            if cues[item.id] != cue { cues[item.id] = cue }
        }
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

/// A section's header: nothing, a title, a host, or a workspace's fold row.
private struct HomeHeaderView: View {
    let header: HomeSection.Header
    let fold: (EnvironmentClient, WorkspaceMeta) -> Void
    let newThread: (EnvironmentClient, WorkspaceMeta, ProjectMeta?) -> Void

    var body: some View {
        switch header {
        case .none:
            EmptyView()
        case .title(let title):
            HomeSectionTitle(title)
                .listRowInsets(EdgeInsets())
        case .host(let client):
            HostHeader(client: client)
                .listRowInsets(EdgeInsets())
        case .workspace(let client, let workspace, let collapsed, let threads):
            HStack(spacing: 0) {
                Button { fold(client, workspace) } label: {
                    WorkspaceHeaderRow(client: client, workspace: workspace, collapsed: collapsed, threads: threads)
                }
                .buttonStyle(.pressable)
                NewThreadButton { newThread(client, workspace, nil) }
            }
            .padding(.leading, 16)
            .padding(.trailing, 4)
            .textCase(nil)
            .listRowInsets(EdgeInsets())
        }
    }
}

/// One row of Home. Content rows share the 16 pt text edge.
private struct HomeRowView: View {
    let row: HomeRow
    let cue: HomeModel.Cue?
    @Binding var path: NavigationPath
    let pairAgain: (PairedEnvironment) -> Void
    let newThread: (EnvironmentClient, WorkspaceMeta, ProjectMeta?) -> Void

    var body: some View {
        switch row {
        case .status(let client):
            HostStatusRow(client: client) { pairAgain(client.environment) }
                .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 4, trailing: 16))
                .listRowSeparator(.hidden)
        case .needsYou(let client, let item):
            Button { open(client, item.meta.id, seq: cue?.seq) } label: {
                NeedsYouRow(item: item, line: cue?.text)
            }
            .buttonStyle(.pressable)
            .listRowInsets(rowInsets)
            .listRowBackground(Surface.needsYou)
            .threadRowActions(client: client, meta: item.meta)
        case .running(let client, let meta):
            threadButton(client, meta, ThreadRowModel(session: meta))
        case .calm(let client, let workspace):
            QuietNote(text: "Nothing needs you right now.", action: ("New thread", { newThread(client, workspace, nil) }))
                .listRowInsets(rowInsets)
                .listRowSeparator(.hidden)
        case .project(let client, let group):
            ProjectHeaderRow(project: group.project) {
                if let workspace = client.workspaces.first(where: { $0.id == group.project.workspaceId }) {
                    NewThreadButton { newThread(client, workspace, group.project) }
                }
            }
            .listRowInsets(EdgeInsets(top: 0, leading: 16, bottom: 0, trailing: 4))
            .listRowSeparator(.hidden)
        case .thread(let client, let item):
            threadButton(client, item.meta, ThreadRowModel(session: item.meta, unseen: item.unseen))
        case .moreAgents(let client, let root, let hidden):
            Button { open(client, root.id) } label: {
                DimRow(hidden == 1 ? "1 more subagent" : "\(hidden) more subagents")
                    .padding(.leading, HomeStyles.agentIndent)
            }
            .buttonStyle(.pressable)
            .listRowInsets(rowInsets)
        case .archivedThreads(let client, let group):
            Button { path.append(Route.archivedThreads(environmentId: client.environment.id, projectId: group.id)) } label: {
                DimRow(group.archivedCount == 1 ? "1 archived" : "\(group.archivedCount) archived")
            }
            .buttonStyle(.pressable)
            .listRowInsets(rowInsets)
        case .archivedProjects(let client, let workspace, let count):
            Button { path.append(Route.archivedProjects(environmentId: client.environment.id, workspaceId: workspace.id)) } label: {
                DimRow(count == 1 ? "1 archived project" : "\(count) archived projects")
            }
            .buttonStyle(.pressable)
            .listRowInsets(rowInsets)
        case .emptyWorkspace(let client, let workspace):
            QuietNote(text: "No threads here yet.", action: ("New thread", { newThread(client, workspace, nil) }))
                .listRowInsets(rowInsets)
                .listRowSeparator(.hidden)
        case .nothing(let client):
            NothingRow(client: client) { path.append(Route.hosts) }
                .listRowInsets(rowInsets)
                .listRowSeparator(.hidden)
        }
    }

    private func open(_ client: EnvironmentClient, _ sessionId: String, seq: Int? = nil) {
        path.append(Route.thread(environmentId: client.environment.id, sessionId: sessionId, seq: seq))
    }

    private func threadButton(_ client: EnvironmentClient, _ meta: SessionMeta, _ model: ThreadRowModel) -> some View {
        Button { open(client, meta.id) } label: {
            ThreadRow(row: model)
        }
        .buttonStyle(.pressable)
        .listRowInsets(rowInsets)
        .threadRowActions(client: client, meta: meta)
    }
}

/// Where a new thread goes: the workspace, and the project when one was chosen.
struct NewThreadTarget: Identifiable {
    let client: EnvironmentClient
    let workspace: WorkspaceMeta
    let project: ProjectMeta?

    var id: String { "\(client.environment.id):\(workspace.id):\(project?.id ?? "")" }
}

/// A thread that needs the user, on the warning tint: the dot, the type,
/// the title, what it needs in one line, and how long it has waited. At
/// accessibility sizes the wait moves under the cue so neither truncates.
private struct NeedsYouRow: View {
    let item: NeedsYouItem
    let line: String?
    @Environment(\.dynamicTypeSize) private var typeSize
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var cue: String { line ?? HomeModel.line(for: item.kind, rows: []) }

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            StatusDot(status: item.meta.status)
                .alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + 4 }
            TypeGlyph(type: item.meta.threadType)
            VStack(alignment: .leading, spacing: 2) {
                Text(item.meta.title.isEmpty ? "Untitled" : item.meta.title)
                    .font(.subheadline)
                    .lineLimit(typeSize.isAccessibilitySize ? 2 : 1)
                ZStack(alignment: .leading) {
                    Text(cue)
                        .id(cue)
                        .transition(Motion.swap(reduced: reduceMotion))
                }
                .font(.footnote)
                .foregroundStyle(.secondary)
                .lineLimit(typeSize.isAccessibilitySize ? 2 : 1)
                .animation(Motion.crossFade, value: cue)
                if typeSize.isAccessibilitySize { waited }
            }
            if !typeSize.isAccessibilitySize {
                Spacer(minLength: 8)
                waited
            }
        }
        .padding(.vertical, 8)
        .frame(minHeight: 44)
        .accessibilityElement(children: .combine)
    }

    private var waited: some View {
        TimelineView(.periodic(from: .now, by: 30)) { context in
            Text(TimeFormat.ago(item.since, now: context.date))
                .contentTransition(.numericText())
        }
        .font(.caption2)
        .monospacedDigit()
        .foregroundStyle(.tertiary)
    }
}

/// With several hosts, each one's workspaces sit under its name and connection dot.
private struct HostHeader: View {
    let client: EnvironmentClient

    var body: some View {
        HStack(spacing: 8) {
            ConnectionDot(status: client.status)
            Text(client.environment.name)
                .font(.title3.weight(.semibold))
                .foregroundStyle(.primary)
                .lineLimit(1)
            Spacer(minLength: 8)
        }
        .textCase(nil)
        .padding(.leading, 16)
        .padding(.top, 18)
        .padding(.bottom, 2)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
    }
}

/// A workspace: its mark, its name, the repo dim, and while folded the
/// number of threads inside. The whole row is the fold; no chevron.
private struct WorkspaceHeaderRow: View {
    let client: EnvironmentClient
    let workspace: WorkspaceMeta
    let collapsed: Bool
    let threads: Int
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        HStack(spacing: 10) {
            WorkspaceIconView(client: client, workspace: workspace, size: 22)
            VStack(alignment: .leading, spacing: 1) {
                Text(workspace.name)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.primary)
                    .lineLimit(1)
                if let repo = workspace.githubRepo, !repo.isEmpty, !typeSize.isAccessibilitySize {
                    Text(repo)
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                        .lineLimit(1)
                }
            }
            Spacer(minLength: 8)
            if collapsed, threads > 0 {
                Text("\(threads)")
                    .font(.footnote)
                    .monospacedDigit()
                    .foregroundStyle(.tertiary)
                    .contentTransition(.numericText())
                    .transition(.opacity)
            }
        }
        .padding(.top, 10)
        .padding(.bottom, 4)
        .frame(minHeight: 44)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityLabel(workspace.name)
        .accessibilityValue(collapsed ? (threads == 1 ? "Collapsed, 1 thread" : "Collapsed, \(threads) threads") : "Expanded")
        .accessibilityAddTraits(.isHeader)
    }
}

/// A host with nothing to list yet: a spinner until its shell is listed,
/// then the fact and where to look.
private struct NothingRow: View {
    let client: EnvironmentClient
    let hosts: () -> Void

    var body: some View {
        if client.hasShell {
            QuietNote(text: "No workspaces on \(client.environment.name) yet. Open a folder there and it appears here.", action: ("Hosts", hosts))
        } else {
            HStack {
                Spacer()
                ProgressView()
                Spacer()
            }
            .padding(.vertical, 40)
        }
    }
}

/// The first run: one tap to pair.
private struct NoHostsView: View {
    let add: () -> Void

    var body: some View {
        ContentUnavailableView {
            Label("Pair a host", systemImage: "desktopcomputer")
        } description: {
            Text("Pair your Mac or the agent host to see its threads here.")
        } actions: {
            Button("Pair a host", action: add)
                .buttonStyle(.borderedProminent)
        }
    }
}
