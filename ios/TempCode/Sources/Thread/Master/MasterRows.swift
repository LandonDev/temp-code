import SwiftUI
import TempCodeClient
import TempCodeContract

/// One child of the batch on the board: the status mark in the mark column,
/// the type glyph, the title with its type word and the task tally, then the
/// activity line with the model mark at its right, then the thread's
/// subagents when it has any ("4 agents · 2 working · 1 needs approval", the
/// whole tree, `MasterBoard.agentSummaries`), then the body its type
/// carries (an implementation's tasks, a research or orchestration thread's
/// one summary line). A plan and the build it started are one row under the
/// plan's title. A child on another host names its host in the model mark
/// and reads "Out of reach on <host>" while that host is away. The row drills
/// into the child's own thread screen; its context menu (the kit's, local
/// rows only) adds Start now and Remove from queue for a queued child, Pause
/// and Stop for a working one, Resume for a paused or stopped one.
struct MasterRowView: View {
    let row: MasterBoard.Row
    /// The row's own host's client; nil for a remote row whose host is not paired.
    let client: EnvironmentClient?
    let landed: Bool
    let hostName: String?
    /// The thread's subagents; nil with none.
    let agents: MasterBoard.AgentSummary?
    @Binding var tasksOpen: [String: Bool]
    let fleetSize: Int
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let meta = row.meta
        let child = client?.threads[row.sessionId]
        let items = child?.fold.items ?? []
        let live = Fleet.isLive(row.status)
        let line = Fleet.line(status: row.status, items: items, compacting: child?.fold.board.compacting ?? false, activity: meta?.activity)
        let what = MasterBoard.remoteLine(row, hostName: hostName)
            ?? MasterBoard.whatLine(status: row.status, activity: meta?.activity, updatedAt: meta?.updatedAt ?? 0, line: line, landed: landed)
        let todos = child?.fold.board.todos ?? []
        let extra = MasterBoard.body(row.threadType, todos: todos, items: items, what: what?.text)
        let foldable: Bool = { if case .tasks? = extra { return true } else { return false } }()
        let tally = MasterBoard.tally(todos: todos, tasks: meta?.tasks)
        let dim = row.status == .queued || row.status == .idle || row.status == .stopped || row.status == .done
        let open = tasksOpen[row.key] ?? MasterBoard.tasksOpenByDefault(row.status)
        let label = MasterRowLabel(row: row, what: what, agents: agents, extra: extra, tally: tally, foldable: foldable, open: open, dim: dim, live: live, hostName: hostName, reasoning: meta?.reasoning.rawValue ?? "", context1m: meta?.context1m ?? false) { toggle(open) }

        linked(label)
            .opacity(row.linkDown ? 0.6 : 1)
            .modifier(RowActions(row: row, client: client))
            .onAppear {
                guard let client, Fleet.loadsTranscript(status: row.status, fleetSize: fleetSize) else { return }
                Task { await client.openThread(row.sessionId) }
            }
            .onDisappear {
                guard let client, Fleet.loadsTranscript(status: row.status, fleetSize: fleetSize) else { return }
                client.closeThread(row.sessionId)
            }
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("master-row-\(row.key)")
    }

    /// A local row pushes the thread screen; a remote row with a paired host
    /// pushes the thread on that host; a remote row with no paired host is
    /// read only. The link sits hidden behind the label so the List draws no
    /// chevron and the tally keeps its own tap.
    @ViewBuilder
    private func linked(_ label: some View) -> some View {
        if row.environmentId == nil {
            label.background(NavigationLink(value: ThreadScreenRoute(sessionId: row.sessionId)) { EmptyView() }.opacity(0))
        } else if client != nil, let env = row.environmentId {
            label.background(NavigationLink(value: Route.thread(environmentId: env, sessionId: row.sessionId, seq: nil)) { EmptyView() }.opacity(0))
        } else {
            label
        }
    }

    private func toggle(_ open: Bool) {
        withAnimation(reduceMotion ? nil : (open ? Motion.collapse : Motion.expand)) {
            tasksOpen[row.key] = !open
        }
    }
}

/// The row's label: the marks, the title line with the tally, the activity
/// line with the model mark, and the body. Its own view, so the row's
/// builder stays small.
private struct MasterRowLabel: View {
    let row: MasterBoard.Row
    let what: MasterBoard.WhatLine?
    let agents: MasterBoard.AgentSummary?
    let extra: MasterBoard.Body?
    let tally: MasterBoard.Tally?
    let foldable: Bool
    let open: Bool
    let dim: Bool
    let live: Bool
    let hostName: String?
    let reasoning: String
    let context1m: Bool
    let onToggle: () -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dynamicTypeSize) private var typeSize

    private var weight: Font.Weight { dim ? .regular : .medium }

    var body: some View {
        HStack(alignment: .top, spacing: Layout.rowGap) {
            AgentStatusMark(status: row.status, weight: weight)
                .padding(.top, 2)
            TypeGlyph(type: row.threadType, weight: weight)
                .opacity(dim ? 0.5 : 1)
                .padding(.top, 1)
            VStack(alignment: .leading, spacing: 3) {
                titleLine
                if typeSize.isAccessibilitySize {
                    // Stacked at accessibility sizes: side by side, the mark squeezed the activity to a word.
                    ActivityLine(line: Fleet.Line(what?.text ?? "", tone: what?.tone ?? .muted), live: live)
                    ModelMark(provider: row.provider, model: row.model, reasoning: reasoning, context1m: context1m, hostName: hostName)
                } else {
                    HStack(spacing: 8) {
                        ActivityLine(line: Fleet.Line(what?.text ?? "", tone: what?.tone ?? .muted), live: live)
                        Spacer(minLength: 8)
                        ModelMark(provider: row.provider, model: row.model, reasoning: reasoning, context1m: context1m, hostName: hostName)
                    }
                }
                if let agents {
                    AgentsLine(summary: agents, dim: dim)
                }
                bodyView
            }
        }
        .padding(.horizontal, Layout.textEdge)
        .padding(.vertical, Layout.rowVertical)
        .frame(minHeight: Layout.rowHeight)
        .contentShape(Rectangle())
        .animation(reduceMotion ? nil : (open ? Motion.expand : Motion.collapse), value: open)
    }

    @ViewBuilder
    private var titleLine: some View {
        if typeSize.isAccessibilitySize {
            // Stacked at accessibility sizes: the type word and the tally beside it left the title two letters.
            VStack(alignment: .leading, spacing: 3) {
                title.lineLimit(3)
                HStack(alignment: .firstTextBaseline, spacing: Layout.tagGap) {
                    typeWord
                    Spacer(minLength: 8)
                    if let tally {
                        TallyButton(tally: tally, foldable: foldable, open: open, action: onToggle)
                    }
                }
            }
        } else {
            HStack(alignment: .firstTextBaseline, spacing: Layout.tagGap) {
                title.lineLimit(1)
                typeWord
                Spacer(minLength: 8)
                if let tally {
                    TallyButton(tally: tally, foldable: foldable, open: open, action: onToggle)
                }
            }
        }
    }

    private var title: some View {
        Text(row.title.isEmpty ? "Untitled" : row.title)
            .textStep(.title, weight: weight)
            .foregroundStyle(dim ? AnyShapeStyle(.secondary) : AnyShapeStyle(.primary))
    }

    private var typeWord: some View {
        Text(MasterBoard.typeWord(row.threadType))
            .textStep(.meta)
            .lineLimit(1)
            .fixedSize()
    }

    @ViewBuilder
    private var bodyView: some View {
        switch extra {
        case .tasks(let list)? where open:
            TaskList(todos: list, dim: dim)
                .transition(.expandBody(reduced: reduceMotion))
        case .summary(let text)?:
            Text(text)
                .textStep(.meta)
                .lineLimit(2)
                .padding(.top, 2)
        default:
            EmptyView()
        }
    }
}

/// The thread's subagents in one meta line: the count, then each live state
/// it has, needs approval in warning and failed in destructive (the fleet's
/// tones); a dimmed row keeps them all secondary.
private struct AgentsLine: View {
    let summary: MasterBoard.AgentSummary
    let dim: Bool

    var body: some View {
        summary.parts.enumerated().reduce(Text("")) { text, item in
            let part = Text(item.element.text).foregroundStyle(tone(item.element.tone))
            return item.offset == 0 ? text + part : text + Text(" · ").foregroundStyle(.tertiary) + part
        }
        .textStep(.meta)
        .monospacedDigit()
        .lineLimit(1)
        .accessibilityLabel(summary.text)
    }

    private func tone(_ tone: Fleet.Tone) -> Color {
        if dim { return Color(.secondaryLabel) }
        return switch tone {
        case .warning: Tint.warning
        case .danger: Tint.destructive
        case .muted: Color(.secondaryLabel)
        }
    }
}

/// "3/7" with a chevron that turns when the row has a task list to fold.
private struct TallyButton: View {
    let tally: MasterBoard.Tally
    let foldable: Bool
    let open: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 4) {
                CountText(tally.text, step: .stamp)
                if foldable {
                    Image(systemName: "chevron.right")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(.tertiary)
                        .rotationEffect(.degrees(open ? 90 : 0))
                        .animation(Motion.crossFade, value: open)
                }
            }
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.pressableStatic)
        .disabled(!foldable)
        .accessibilityLabel(open ? "Hide tasks" : "Show tasks")
        .accessibilityValue("\(tally.done) of \(tally.total) tasks done")
    }
}

/// An implementation's tasks under its row: done ones quiet with a check,
/// the one in progress with the spinner while the thread works, the rest
/// with an open ring.
private struct TaskList: View {
    let todos: [TodoItem]
    let dim: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            ForEach(Array(todos.enumerated()), id: \.offset) { _, todo in
                HStack(spacing: 6) {
                    mark(todo)
                        .frame(width: 12, height: 12)
                    Text(todo.content)
                        .textStep(.meta)
                        .foregroundStyle(style(todo))
                        .lineLimit(1)
                }
            }
        }
        .padding(.top, 4)
    }

    @ViewBuilder
    private func mark(_ todo: TodoItem) -> some View {
        switch todo.status {
        case .completed:
            Image(systemName: "checkmark")
                .font(.caption2.weight(.semibold))
                .foregroundStyle(.tertiary)
        case .inProgress where !dim:
            ProgressView()
                .controlSize(.mini)
        default:
            Circle()
                .strokeBorder(.tertiary, lineWidth: 1.5)
                .frame(width: 9, height: 9)
        }
    }

    private func style(_ todo: TodoItem) -> AnyShapeStyle {
        switch todo.status {
        case .completed: AnyShapeStyle(.tertiary)
        case .inProgress where !dim: AnyShapeStyle(.primary)
        default: AnyShapeStyle(.secondary)
        }
    }
}

/// The kit's swipes and context menu on a local row, with the batch's own
/// rows in its slot; a remote row carries none (its host acts on it).
private struct RowActions: ViewModifier {
    let row: MasterBoard.Row
    let client: EnvironmentClient?
    @State private var failure: String?

    func body(content: Content) -> some View {
        if row.environmentId == nil, let client, let meta = row.meta {
            let block = client.operateBlock
            content
                .threadRowActions(client: client, meta: meta) {
                    if meta.status == .queued {
                        Button { act { try await client.start(meta.id) } } label: { Label("Start now", systemImage: "play") }
                            .disabled(block != nil)
                        Button { act { try await client.setArchived(meta.id, true) } } label: { Label("Remove from queue", systemImage: "xmark") }
                            .disabled(block != nil)
                    } else {
                        if ThreadBatch.hasRunningTurn(meta) {
                            Button { act { _ = try await client.sessionBatch(.pause, ids: [meta.id]) } } label: { Label("Pause", systemImage: "pause") }
                                .disabled(block != nil)
                            Button { act { try await client.stop(meta.id) } } label: { Label("Stop", systemImage: "stop") }
                                .disabled(block != nil)
                        }
                        if meta.status == .paused || meta.status == .stopped {
                            Button { act { try await client.resume(meta.id) } } label: { Label("Resume", systemImage: "play") }
                                .disabled(block != nil)
                        }
                    }
                }
                .alert("Couldn't do that", isPresented: Binding(get: { failure != nil }, set: { if !$0 { failure = nil } })) {
                    Button("OK", role: .cancel) {}
                } message: {
                    Text(failure ?? "")
                }
        } else {
            content
        }
    }

    private func act(_ body: @escaping () async throws -> Void) {
        Task {
            do {
                try await body()
            } catch {
                failure = (error as? ActionError)?.message ?? String(describing: error)
            }
        }
    }
}
