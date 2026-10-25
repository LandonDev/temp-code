import SwiftUI
import TempCodeClient
import TempCodeContract

/// The rows the three Home levels share: the rail's status mark, the
/// working line, a thread row at its depth, the project row, and the
/// project menu. The rules behind them are the client package's
/// `HomeSections`; nothing here decides what shows.

/// The desktop rail's one mark per workspace: the pause glyph, a warning
/// dot for needs you, an info dot for unread. Working has no mark of its
/// own: the working line under the name leads with the spinner.
struct RailMark: View {
    let status: RailStatus
    @ScaledMetric(relativeTo: .subheadline) private var column = Layout.markWidth
    @ScaledMetric(relativeTo: .subheadline) private var dot = Layout.dotSize

    var body: some View {
        ZStack {
            switch status {
            case .paused:
                Image(systemName: "pause.fill")
                    .font(.caption2)
                    .foregroundStyle(Tint.warning)
            case .needsYou:
                Circle().fill(Tint.warning).frame(width: dot, height: dot)
            case .unread:
                Circle().fill(Tint.info).frame(width: dot, height: dot)
            case .busy:
                ProgressView().controlSize(.mini)
            }
        }
        .frame(width: column, height: column)
        .accessibilityLabel(label)
    }

    private var label: String {
        let threads = status.count == 1 ? "1 thread" : "\(status.count) threads"
        switch status {
        case .paused: return "Paused, \(threads)"
        case .needsYou: return "Needs you, \(threads)"
        case .busy: return "Working, \(threads)"
        case .unread: return "Unread, \(threads)"
        }
    }
}

/// What a busy workspace is doing, under its name: the spinner, the newest
/// working thread's title, and how many more work beside it.
struct WorkingLine: View {
    let running: [HostedSession]

    var body: some View {
        if let first = running.first {
            HStack(spacing: 6) {
                ProgressView().controlSize(.mini)
                Text(first.meta.title.isEmpty ? "Untitled" : first.meta.title)
                    .textStep(.meta)
                    .lineLimit(1)
                if running.count > 1 {
                    CountText("+\(running.count - 1)", step: .meta)
                        .foregroundStyle(.tertiary)
                        .fixedSize()
                }
            }
            .accessibilityElement(children: .combine)
        }
    }
}

/// One thread row of a level, or the dim row for the settled children left
/// out. A thread that needs the user reads its cue as the second line
/// ("Approve: run bun test") and a waiting one sits on the warning tint.
struct ShellRowView: View {
    @Environment(AppModel.self) private var model
    @Environment(ShellNavigator.self) private var navigator
    @Environment(\.shellPose) private var pose
    let row: ShellRow
    let cue: HomeModel.Cue?

    var body: some View {
        if let client = model.registry.client(row.environmentId) {
            switch row {
            case .thread(let env, let item, let depth):
                Button { navigator.open(.thread(environmentId: env, sessionId: item.id, seq: cue?.seq)) } label: {
                    ThreadRow(row: rowModel(item, depth: depth)) { HostGlyph(environmentId: env) }
                }
                .buttonStyle(.pressable)
                .listRowInsets(Layout.rowInsets)
                .listRowBackground(background(env, item))
                // Start now on a queued root, Resume on a stopped one (thread iOS 20).
                .threadRowActions(client: client, meta: item.meta) {
                    RowStateActions(client: client, meta: item.meta)
                    MasterPinButton(client: client, session: item.meta)
                }
            case .more(let env, let root, let hidden):
                Button { navigator.open(.thread(environmentId: env, sessionId: root.id, seq: nil)) } label: {
                    DimRow(hidden == 1 ? "1 more" : "\(hidden) more")
                        .padding(.leading, Layout.rowTextEdge + Layout.indent)
                }
                .buttonStyle(.pressable)
                .listRowInsets(Layout.rowInsets)
            }
        }
    }

    /// In the split, the row whose thread is the detail root sits on the fill,
    /// so the sidebar says what the detail shows; a waiting thread keeps the
    /// needs-you tint. Nothing in compact: there is no beside.
    private func background(_ environmentId: String, _ item: ThreadItem) -> Color? {
        if pose.isSplit, navigator.isOpen(environmentId: environmentId, sessionId: item.id) { return Surface.fill }
        return item.meta.status == .waiting ? Surface.needsYou : nil
    }

    private func rowModel(_ item: ThreadItem, depth: Int) -> ThreadRowModel {
        var out: ThreadRowModel
        if let cue, let needs = HomeModel.needsYou([item.meta]).first {
            out = .needsYou(item: needs, cue: cue)
        } else {
            out = ThreadRowModel(session: item.meta, unseen: item.unseen)
        }
        out.depth = depth
        return out
    }
}

extension View {
    /// Loads the needs-you cue of every thread in `rows` that waits, failed
    /// or paused, from its newest rows (and a waiting thread's notes), into
    /// `cues` keyed by `ShellCues.key`.
    func needsYouCues(_ rows: [ShellRow], into cues: Binding<[String: HomeModel.Cue]>) -> some View {
        modifier(NeedsYouCues(rows: rows, cues: cues))
    }

    /// Marks this list screen as on screen while it is, so the clients
    /// publish list changes with motion.
    func listOnScreen(_ id: String) -> some View {
        modifier(ListOnScreen(id: id))
    }
}

enum ShellCues {
    static func key(_ environmentId: String, _ sessionId: String) -> String {
        "\(environmentId):\(sessionId)"
    }

    static func cue(for row: ShellRow, in cues: [String: HomeModel.Cue]) -> HomeModel.Cue? {
        guard case .thread(let env, let item, _) = row else { return nil }
        return cues[key(env, item.id)]
    }

    /// The needs-you threads among the rows, with their hosts.
    static func items(_ rows: [ShellRow]) -> [(String, NeedsYouItem)] {
        rows.compactMap { row in
            guard case .thread(let env, let item, _) = row, let needs = HomeModel.needsYou([item.meta]).first else { return nil }
            return (env, needs)
        }
    }
}

private struct NeedsYouCues: ViewModifier {
    @Environment(AppModel.self) private var model
    let rows: [ShellRow]
    @Binding var cues: [String: HomeModel.Cue]

    func body(content: Content) -> some View {
        let items = ShellCues.items(rows)
        content.task(id: items.map { "\($0.0):\($0.1.id):\($0.1.meta.updatedAt)" }.joined(separator: ",")) {
            for (env, item) in items {
                guard let client = model.registry.client(env) else { continue }
                let tail = item.kind == .paused ? [] : await client.peekTail(item.id)
                // iOS 18: a waiting thread's row reads its notes' State line (NeedsYouNotes.swift).
                let cue = await NeedsYouNotes.cue(HomeModel.cue(for: item, rows: tail), for: item, client: client)
                // The key changed under this task: a newer run owns the cues now.
                guard !Task.isCancelled else { return }
                let key = ShellCues.key(env, item.id)
                if cues[key] != cue { cues[key] = cue }
            }
        }
    }
}

private struct ListOnScreen: ViewModifier {
    @Environment(NavigationRouter.self) private var router
    let id: String

    func body(content: Content) -> some View {
        content
            .onAppear { router.lists.insert(id) }
            .onDisappear { router.lists.remove(id) }
    }
}

/// A project on its workspace's screen: the name with the worktree mark and
/// the branch under it, which pushes the project's every thread; then the
/// plan chip, the plus and the menu. One row for every host's copy.
struct ProjectEntryRow: View {
    @Environment(AppModel.self) private var model
    @Environment(ShellNavigator.self) private var navigator
    let project: HomeProject
    let slots: HomeSlots
    let newThread: (EnvironmentClient, WorkspaceMeta, ProjectMeta?) -> Void

    var body: some View {
        let meta = project.project
        if let client = model.registry.client(project.environmentId) {
            let workspace = client.workspaces.first { $0.id == meta.workspaceId }
            HStack(spacing: 0) {
                Button { navigator.open(.project(key: project.id)) } label: {
                    VStack(alignment: .leading, spacing: 1) {
                        HStack(spacing: 6) {
                            Text(meta.name)
                                .textStep(.title, weight: .semibold)
                                .lineLimit(1)
                            if meta.mode == .worktree {
                                MetaGlyph("arrow.triangle.pull", weight: .semibold, label: "Worktree")
                            }
                        }
                        if let branch = meta.branch, !branch.isEmpty {
                            Text(branch)
                                .textStep(.stamp)
                                .lineLimit(1)
                                .truncationMode(.middle)
                        }
                    }
                    .frame(maxWidth: .infinity, minHeight: Layout.rowHeight, alignment: .leading)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.pressable)
                .accessibilityAddTraits(.isHeader)
                slots.projectTrailing?(client, meta)
                if let workspace {
                    NewThreadButton { newThread(client, workspace, meta) }
                }
                if slots.hasProjectMenu {
                    HeaderMenu(systemImage: "ellipsis", label: "\(meta.name) menu") {
                        ProjectMenuContent(project: project, slots: slots, newThread: newThread)
                    }
                }
            }
            .padding(.top, 6)
            .listRowInsets(EdgeInsets(top: 0, leading: Layout.textEdge, bottom: 0, trailing: 4))
            .listRowSeparator(.hidden)
        }
    }
}

/// A project's menu: New Thread, its settings, and the fleet switches per
/// host copy. The lead copy (the first host in registry order) takes the
/// plus and the settings entry; the settings find their home themselves.
struct ProjectMenuContent: View {
    @Environment(AppModel.self) private var model
    let project: HomeProject
    let slots: HomeSlots
    let newThread: (EnvironmentClient, WorkspaceMeta, ProjectMeta?) -> Void

    var body: some View {
        let meta = project.project
        if let client = model.registry.client(project.environmentId) {
            if let workspace = client.workspaces.first(where: { $0.id == meta.workspaceId }) {
                Button("New Thread", systemImage: "square.and.pencil") { newThread(client, workspace, meta) }
            }
            if let settings = slots.projectSettings {
                Divider()
                settings(client, meta)
            }
            if let batch = slots.projectBatch {
                Divider()
                if project.isLinked {
                    // One set per host: each acts on that host's copy alone.
                    ForEach(project.members, id: \.environmentId) { member in
                        if let memberClient = model.registry.client(member.environmentId) {
                            Section(memberClient.environment.name) { batch(memberClient, member.group.project) }
                        }
                    }
                } else {
                    batch(client, meta)
                }
            }
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

/// The new-thread sheet's target, shared by the Home stack's screens and
/// presented from the root, as project settings are: a sheet on a pushed
/// screen's menu item never shows.
@MainActor @Observable
final class NewThreadPresenter {
    var target: NewThreadTarget?

    func compose(_ client: EnvironmentClient, _ workspace: WorkspaceMeta, _ project: ProjectMeta?) {
        target = NewThreadTarget(client: client, workspace: workspace, project: project)
    }
}
