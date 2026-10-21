import SwiftUI
import TempCodeClient
import TempCodeContract

/// Home: what needs you, what runs, then every host's workspaces, as grouped
/// sections under a large title. Paints from the cache before any socket;
/// the socket's catch-up lands as a diff.
struct HomeView: View {
    @Environment(AppModel.self) private var model
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
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

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
                            HomeSectionView(section: section, cues: cues, path: $path, fold: toggleFold, pairAgain: { pairingAgain = $0 }, addHost: { adding = true }, newThread: { composing = NewThreadTarget(client: $0, workspace: $1, project: $2) })
                                .id(section.id)
                        }
                    }
                    .listStyle(.insetGrouped)
                    .animation(Motion.rowAppear, value: needsKey(sections))
                    .task(id: needsKey(sections)) { await loadLines(sections) }
                    .task(id: clients.first?.hasShell) { await performLaunch(clients, sections: sections, proxy: proxy) }
                }
            }
        }
        .navigationTitle("Home")
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

    /// DEBUG only: the proof opens the new-thread sheet, creates a chat in the
    /// first workspace and opens it, folds every workspace, or scrolls to the
    /// first workspace so the shot shows that part of the list.
    private func performLaunch(_ clients: [EnvironmentClient], sections: [HomeSection], proxy: ScrollViewProxy) async {
        guard let client = clients.first, client.hasShell, let workspace = client.workspaces.first else { return }
        if TestHooks.sheet == "new", composing == nil {
            composing = NewThreadTarget(client: client, workspace: workspace, project: nil)
        } else if TestHooks.action == "new-chat", !launched {
            launched = true
            guard let catalog = await client.loadCatalog(), let provider = CatalogChoice.providerOrder.compactMap({ catalog[$0.rawValue] }).first else { return }
            let draft = ThreadDraft.thread(type: .chat, workspaceId: workspace.id, projectId: nil, provider: provider.id, model: provider.defaultModel, reasoning: nil, permission: nil)
            if let created = try? await client.createThread(draft) {
                path.append(Route.thread(environmentId: client.environment.id, sessionId: created.id, seq: nil))
            }
        } else if TestHooks.open == "folded", !launched {
            launched = true
            foldedRaw = client.workspaces.map { HomeRows.foldKey(client, $0) }.sorted().joined(separator: "\n")
        } else if TestHooks.open == "workspaces", !launched {
            launched = true
            try? await Task.sleep(for: .milliseconds(300))
            if let first = sections.first(where: { if case .workspace = $0.kind { return true } else { return false } }) {
                proxy.scrollTo(first.id, anchor: .top)
            }
        }
    }

    private func toggleFold(_ client: EnvironmentClient, _ workspace: WorkspaceMeta) {
        var keys = folded
        let key = HomeRows.foldKey(client, workspace)
        if !keys.insert(key).inserted { keys.remove(key) }
        let next = keys.sorted().joined(separator: "\n")
        if reduceMotion {
            withAnimation(Motion.collapse) { foldedRaw = next }
        } else {
            withAnimation(Motion.expand) { foldedRaw = next }
        }
    }

    /// Changes when a needs-you thread arrives, leaves or moves.
    private func needsKey(_ sections: [HomeSection]) -> String {
        sections.flatMap(\.rows).compactMap { row -> String? in
            if case .needsYou(_, let item) = row { return "\(item.id):\(item.meta.updatedAt)" }
            return nil
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

/// One grouped section of Home: its native header (or the workspace's own
/// header row), then its rows on the card.
private struct HomeSectionView: View {
    let section: HomeSection
    let cues: [String: HomeModel.Cue]
    @Binding var path: NavigationPath
    let fold: (EnvironmentClient, WorkspaceMeta) -> Void
    let pairAgain: (PairedEnvironment) -> Void
    let addHost: () -> Void
    let newThread: (EnvironmentClient, WorkspaceMeta, ProjectMeta?) -> Void

    var body: some View {
        switch section.kind {
        case .status(let client):
            Section {
                HostStatusRow(client: client) { pairAgain(client.environment) }
                    .listRowBackground(HomeSurface.status(destructive: client.status.transport == .unauthorized || client.status.transport == .offline))
            }
        case .needsYou:
            Section {
                rows
            } header: {
                HomeHeader("Needs you")
            }
        case .running:
            Section {
                rows
            } header: {
                HomeHeader("Running")
            }
        case .host(let client):
            Section {
            } header: {
                HostHeader(client: client)
            }
        case .chats(let client):
            Section {
                rows
            } header: {
                HomeHeader(client.environment.name)
            }
        case .workspace(let client, let workspace, let branch, let collapsed):
            Section {
                rows
            } header: {
                WorkspaceHeader(client: client, workspace: workspace, branch: branch, collapsed: collapsed, fold: { fold(client, workspace) }, newThread: { newThread(client, workspace, nil) })
            }
        case .empty(let client):
            Section {
                if client.hasShell {
                    EmptyRow(sentence: "No workspaces on \(client.environment.name) yet. Open one in temp-code there and it appears here.", action: ("Add a host", addHost))
                } else {
                    HStack {
                        Spacer()
                        ProgressView()
                        Spacer()
                    }
                    .padding(.vertical, 12)
                    .listRowBackground(Color.clear)
                }
            }
        }
    }

    private var rows: some View {
        ForEach(section.rows) { row in
            HomeRowView(row: row, cue: cue(for: row), path: $path, newThread: newThread)
        }
    }

    private func cue(for row: HomeRow) -> HomeModel.Cue? {
        if case .needsYou(_, let item) = row { return cues[item.id] }
        return nil
    }
}

/// One row of Home on the card.
private struct HomeRowView: View {
    let row: HomeRow
    let cue: HomeModel.Cue?
    @Binding var path: NavigationPath
    let newThread: (EnvironmentClient, WorkspaceMeta, ProjectMeta?) -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        switch row {
        case .needsYou(let client, let item):
            Button { open(client, item.meta.id, seq: cue?.seq) } label: {
                NeedsYouRow(item: item, line: cue?.text)
            }
            .buttonStyle(.pressable)
            .listRowBackground(HomeSurface.needsYou)
            .transition(HomeMotion.needsYou(reduced: reduceMotion))
        case .running(let client, let meta):
            threadButton(client, meta, ThreadRowModel(session: meta))
        case .project(let client, let group):
            ProjectHeaderRow(group: group) {
                if let workspace = client.workspaces.first(where: { $0.id == group.project.workspaceId }) {
                    newThread(client, workspace, group.project)
                }
            }
            .listRowSeparator(.hidden, edges: .bottom)
        case .thread(let client, let item):
            threadButton(client, item.meta, ThreadRowModel(session: item.meta, unseen: item.unseen))
        case .moreAgents(let client, let root, let hidden):
            Button { open(client, root.id) } label: {
                DimRow(hidden == 1 ? "1 more subagent" : "\(hidden) more subagents")
                    .padding(.leading, 16 + 24)
            }
            .buttonStyle(.pressable)
        case .archivedThreads(let client, let group):
            Button { path.append(Route.archivedThreads(environmentId: client.environment.id, projectId: group.id)) } label: {
                DimRow(group.archivedCount == 1 ? "1 archived" : "\(group.archivedCount) archived")
            }
            .buttonStyle(.pressable)
        case .archivedProjects(let client, let workspace, let count):
            Button { path.append(Route.archivedProjects(environmentId: client.environment.id, workspaceId: workspace.id)) } label: {
                DimRow(count == 1 ? "1 archived project" : "\(count) archived projects")
            }
            .buttonStyle(.pressable)
        case .noThreads(let client, let workspace):
            EmptyRow(sentence: "No threads in \(workspace.name) yet.", action: ("New thread", { newThread(client, workspace, nil) }))
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

/// A grouped section's title in the system's place, sentence case like the
/// desktop's chrome.
private struct HomeHeader: View {
    let title: String

    init(_ title: String) { self.title = title }

    var body: some View {
        Text(title)
            .font(.footnote.weight(.semibold))
            .foregroundStyle(.secondary)
            .textCase(nil)
    }
}

/// A thread that needs the user, on the warning tint: the dot, the type,
/// the title, what it needs in one line, and how long it has waited.
private struct NeedsYouRow: View {
    let item: NeedsYouItem
    let line: String?
    @Environment(\.dynamicTypeSize) private var typeSize
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let text = line ?? HomeModel.line(for: item.kind, rows: [])
        HStack(spacing: 10) {
            StatusDot(status: item.meta.status)
            TypeGlyph(type: item.meta.threadType)
            VStack(alignment: .leading, spacing: 2) {
                Text(item.meta.title.isEmpty ? "Untitled" : item.meta.title)
                    .font(.subheadline)
                    .lineLimit(typeSize.isAccessibilitySize ? 2 : 1)
                ZStack(alignment: .leading) {
                    Text(text)
                        .id(text)
                        .transition(Motion.swap(reduced: reduceMotion))
                }
                .animation(Motion.crossFade, value: text)
                .font(.footnote)
                .foregroundStyle(.secondary)
                .lineLimit(typeSize.isAccessibilitySize ? 2 : 1)
            }
            Spacer(minLength: 8)
            TimelineView(.periodic(from: .now, by: 30)) { context in
                Text(TimeFormat.ago(item.since, now: context.date))
                    .font(.caption2)
                    .monospacedDigit()
                    .foregroundStyle(.tertiary)
            }
        }
        .frame(minHeight: 44)
        .accessibilityElement(children: .combine)
    }
}

/// With several hosts, each one's workspaces sit under its name and connection dot.
private struct HostHeader: View {
    let client: EnvironmentClient

    var body: some View {
        HStack(spacing: 8) {
            ConnectionDot(status: client.status)
            Text(client.environment.name)
                .font(.headline)
                .foregroundStyle(.primary)
                .lineLimit(1)
            Spacer(minLength: 8)
        }
        .textCase(nil)
        .padding(.top, 8)
    }
}

/// A workspace's header: its logo, its name, the branch its checkout is on,
/// the fold mark, and the plus. Tapping the name folds the section.
private struct WorkspaceHeader: View {
    let client: EnvironmentClient
    let workspace: WorkspaceMeta
    let branch: String?
    let collapsed: Bool
    let fold: () -> Void
    let newThread: () -> Void

    var body: some View {
        HStack(spacing: 0) {
            Button(action: fold) {
                HStack(spacing: 8) {
                    WorkspaceIconView(client: client, workspace: workspace, size: 22)
                    Text(workspace.name)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.primary)
                        .lineLimit(1)
                    if let branch {
                        Text(branch)
                            .font(.footnote)
                            .foregroundStyle(.tertiary)
                            .lineLimit(1)
                            .layoutPriority(-1)
                    }
                    FoldMark(collapsed: collapsed)
                    Spacer(minLength: 0)
                }
                .frame(minHeight: 44)
                .contentShape(Rectangle())
            }
            .buttonStyle(.pressable)
            .accessibilityLabel(workspace.name)
            .accessibilityValue(collapsed ? "Collapsed" : "Expanded")
            .accessibilityHint("Double tap to \(collapsed ? "expand" : "collapse")")
            NewThreadButton(action: newThread)
                .padding(.trailing, -12)
        }
        .textCase(nil)
        .listRowInsets(EdgeInsets())
    }
}

/// A project inside its workspace's card: name, the worktree mark, the
/// branch dim, and the plus; the rows below it are its threads.
private struct ProjectHeaderRow: View {
    let group: ProjectGroup
    let newThread: () -> Void

    var body: some View {
        HStack(spacing: 6) {
            Text(group.project.name)
                .font(.footnote.weight(.semibold))
                .foregroundStyle(.secondary)
                .lineLimit(1)
            if group.project.mode == .worktree {
                Image(systemName: "arrow.triangle.branch")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.tertiary)
                    .accessibilityLabel("Worktree")
            }
            if let branch = group.project.branch {
                Text(branch)
                    .font(.footnote)
                    .foregroundStyle(.tertiary)
                    .lineLimit(1)
                    .layoutPriority(-1)
            }
            Spacer(minLength: 8)
            NewThreadButton(weight: .semibold, action: newThread)
                .padding(.trailing, -12)
        }
        .frame(minHeight: 36)
        .padding(.top, 4)
    }
}

/// A host with nothing paired yet: the first run, one tap to pair.
private struct NoHostsView: View {
    let add: () -> Void

    var body: some View {
        ContentUnavailableView {
            Label("No hosts yet", systemImage: "iphone.and.arrow.right.inward")
        } description: {
            Text("Pair your Mac or the agent host to see its threads here.")
        } actions: {
            Button("Add a host", action: add)
                .buttonStyle(.borderedProminent)
        }
    }
}
