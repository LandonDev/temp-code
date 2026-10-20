import SwiftUI
import TempCodeClient
import TempCodeContract

/// Home: what needs you, what runs, then every host's workspaces. Paints
/// from the cache before any socket; the socket's catch-up lands as a diff.
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

    private var folded: Set<String> {
        Set(foldedRaw.split(separator: "\n").map(String.init))
    }

    var body: some View {
        let clients = model.registry.ordered
        let rows = HomeRows.build(clients: clients, folded: folded)
        Group {
            if !model.ready {
                Color.clear
            } else if clients.isEmpty {
                NoHostsView { adding = true }
            } else {
                List {
                    ForEach(rows) { row in
                        HomeRowView(row: row, cue: cue(for: row), path: $path, fold: toggleFold, pairAgain: { pairingAgain = $0 }, newThread: { composing = NewThreadTarget(client: $0, workspace: $1, project: $2) })
                    }
                }
                .listStyle(.plain)
                .animation(Motion.rowAppear, value: rows.map(\.id))
                .task(id: needsKey(rows)) { await loadLines(rows) }
                .task(id: clients.first?.hasShell) { await performLaunch(clients) }
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

    /// DEBUG only: the proof opens the new-thread sheet, or creates a chat in the first workspace and opens it.
    private func performLaunch(_ clients: [EnvironmentClient]) async {
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
        }
    }

    private func toggleFold(_ client: EnvironmentClient, _ workspace: WorkspaceMeta) {
        var keys = folded
        let key = HomeRows.foldKey(client, workspace)
        if !keys.insert(key).inserted { keys.remove(key) }
        foldedRaw = keys.sorted().joined(separator: "\n")
    }

    private func cue(for row: HomeRow) -> HomeModel.Cue? {
        if case .needsYou(_, let item) = row { return cues[item.id] }
        return nil
    }

    /// Changes when a needs-you thread arrives, leaves or moves.
    private func needsKey(_ rows: [HomeRow]) -> String {
        rows.compactMap { row -> String? in
            if case .needsYou(_, let item) = row { return "\(item.id):\(item.meta.updatedAt)" }
            return nil
        }.joined(separator: ",")
    }

    private func loadLines(_ rows: [HomeRow]) async {
        for row in rows {
            guard case .needsYou(let client, let item) = row else { continue }
            let tail = item.kind == .paused ? [] : await client.peekTail(item.id)
            let cue = HomeModel.cue(for: item.kind, rows: tail)
            if cues[item.id] != cue { cues[item.id] = cue }
        }
    }
}

/// One row of Home. Headers sit flush; content rows share the text edge.
private struct HomeRowView: View {
    let row: HomeRow
    let cue: HomeModel.Cue?
    @Binding var path: NavigationPath
    let fold: (EnvironmentClient, WorkspaceMeta) -> Void
    let pairAgain: (PairedEnvironment) -> Void
    let newThread: (EnvironmentClient, WorkspaceMeta, ProjectMeta?) -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        switch row {
        case .status(let client):
            HostStatusRow(client: client) { pairAgain(client.environment) }
                .listRowInsets(rowInsets)
                .listRowBackground(Surface.chrome)
        case .title(let title):
            SectionHeader(title)
                .listRowInsets(EdgeInsets())
                .listRowSeparator(.hidden)
        case .needsYou(let client, let item):
            Button { open(client, item.meta.id, seq: cue?.seq) } label: {
                NeedsYouRow(item: item, line: cue?.text)
            }
            .buttonStyle(.pressable)
            .listRowInsets(rowInsets)
            .listRowBackground(Surface.needsYou)
            .transition(Motion.appear(reduced: reduceMotion))
        case .running(let client, let meta):
            threadButton(client, meta, ThreadRowModel(session: meta))
        case .host(let client):
            HostHeader(client: client)
                .listRowInsets(EdgeInsets())
                .listRowSeparator(.hidden)
        case .workspace(let client, let workspace, let collapsed):
            HStack(spacing: 0) {
                Button { fold(client, workspace) } label: {
                    WorkspaceHeaderRow(client: client, workspace: workspace, collapsed: collapsed)
                }
                .buttonStyle(.pressable)
                NewThreadButton { newThread(client, workspace, nil) }
            }
            .listRowInsets(rowInsets)
            .listRowSeparator(.hidden)
        case .project(let client, let group):
            SectionHeader(group.project.name, branch: group.project.branch, worktree: group.project.mode == .worktree) {
                if let workspace = client.workspaces.first(where: { $0.id == group.project.workspaceId }) {
                    NewThreadButton { newThread(client, workspace, group.project) }
                }
            }
            .listRowInsets(EdgeInsets())
            .listRowSeparator(.hidden)
        case .thread(let client, let item):
            threadButton(client, item.meta, ThreadRowModel(session: item.meta, unseen: item.unseen))
        case .moreAgents(let client, let root, let hidden):
            Button { open(client, root.id) } label: {
                DimRow(hidden == 1 ? "1 more subagent" : "\(hidden) more subagents")
                    .padding(.leading, 16 + 24)
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
        case .nothing(let client):
            NothingRow(client: client)
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

/// The plus at the end of a workspace or project header: a new thread there.
struct NewThreadButton: View {
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: "plus")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(.secondary)
                .frame(minWidth: 44, minHeight: 30)
                .contentShape(Rectangle())
        }
        .buttonStyle(.pressable)
        .accessibilityLabel("New thread")
    }
}

/// A thread that needs the user, on the warning tint: the dot, the type,
/// the title, what it needs in one line, and how long it has waited.
private struct NeedsYouRow: View {
    let item: NeedsYouItem
    let line: String?
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        HStack(spacing: 10) {
            StatusDot(status: item.meta.status)
            TypeGlyph(type: item.meta.threadType)
            VStack(alignment: .leading, spacing: 2) {
                Text(item.meta.title.isEmpty ? "Untitled" : item.meta.title)
                    .font(.subheadline)
                    .lineLimit(typeSize.isAccessibilitySize ? 2 : 1)
                Text(line ?? HomeModel.line(for: item.kind, rows: []))
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
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
                .font(.footnote.weight(.semibold))
                .foregroundStyle(.secondary)
                .lineLimit(1)
            Spacer(minLength: 8)
        }
        .padding(.horizontal, 16)
        .padding(.top, 12)
        .frame(minHeight: 36)
    }
}

/// A workspace: its icon, its name, and the fold mark. Tap to fold or open.
private struct WorkspaceHeaderRow: View {
    let client: EnvironmentClient
    let workspace: WorkspaceMeta
    let collapsed: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        HStack(spacing: 10) {
            WorkspaceIconView(client: client, workspace: workspace, size: 20)
            Text(workspace.name)
                .font(.subheadline.weight(.semibold))
                .lineLimit(1)
            Spacer(minLength: 8)
            Image(systemName: "chevron.down")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.tertiary)
                .rotationEffect(collapsed ? .degrees(-90) : .zero)
                .animation(reduceMotion ? nil : Motion.collapse, value: collapsed)
        }
        .frame(minHeight: 44)
        .accessibilityLabel(workspace.name)
        .accessibilityValue(collapsed ? "Collapsed" : "Expanded")
    }
}

/// A quiet row that pushes a list: "3 archived", "2 more subagents".
struct DimRow: View {
    let text: String

    init(_ text: String) { self.text = text }

    var body: some View {
        Text(text)
            .font(.footnote)
            .foregroundStyle(.tertiary)
            .frame(maxWidth: .infinity, minHeight: 36, alignment: .leading)
    }
}

/// A host with nothing to list yet: a spinner until its shell is listed, then the fact.
private struct NothingRow: View {
    let client: EnvironmentClient

    var body: some View {
        HStack {
            Spacer()
            if client.hasShell {
                Text("No threads yet")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            } else {
                ProgressView()
            }
            Spacer()
        }
        .padding(.vertical, 40)
    }
}

/// The first run: one tap to pair.
private struct NoHostsView: View {
    let add: () -> Void

    var body: some View {
        ContentUnavailableView {
            Label("No hosts", systemImage: "desktopcomputer")
        } description: {
            Text("Pair a desktop or the agent host to see its threads here.")
        } actions: {
            Button("Add a host", action: add)
                .buttonStyle(.borderedProminent)
        }
    }
}

/// The transport in one color: open green, trying orange, refused or offline red.
struct ConnectionDot: View {
    let status: EnvironmentStatus

    var body: some View {
        Circle()
            .fill(color)
            .frame(width: 7, height: 7)
            .accessibilityLabel(StatusText.text(for: status, now: .now))
    }

    private var color: Color {
        switch status.transport {
        case .open: Tint.success
        case .connecting, .reconnecting, .suspended: Tint.warning
        case .offline, .unauthorized: Tint.destructive
        }
    }
}
