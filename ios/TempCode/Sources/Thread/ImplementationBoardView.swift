import SwiftUI
import TempCodeClient
import TempCodeContract

/// The desktop's implementation board in one column, Reminders meets a build
/// log: the goal with a thin progress line under it, one header per pass in
/// its colour once there are two, the todos with the running row bright and
/// open, the changes grouped by todo, what needs the user inline, the closing
/// report, and the fleet when the thread spawned agents.
struct ImplementationBoardView: View {
    let client: EnvironmentClient
    let sessionId: String
    let session: SessionMeta?
    let thread: ThreadState
    let document: String?
    @State private var choice: TodoChoice = .auto

    var body: some View {
        let running = session?.status == .running || session?.status == .starting
        let board = ImplementationBoard.build(thread.fold, running: running)
        let agents = Fleet.children(of: sessionId, in: client.sessions)
        let empty = board.rounds.allSatisfy { !$0.hasRow } && board.closing == nil && agents.isEmpty
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                GoalHeader(goal: goal(board), progress: board.progress)
                ForEach(board.rounds.indices, id: \.self) { index in
                    let round = board.rounds[index]
                    if round.hasRow || (round.isCurrent && !board.hasTodos) {
                        RoundSection(round: round, roundIndex: index, showsPass: board.showsPasses, running: running && round.isCurrent, choice: $choice, client: client, sessionId: sessionId)
                    }
                }
                if let closing = board.closing {
                    SectionHeader("Report")
                    MarkdownView(seq: closing.seq, text: closing.text)
                        .textSelection(.enabled)
                        .padding(.horizontal, 16)
                        .padding(.vertical, 12)
                }
                if !agents.isEmpty {
                    SectionHeader("Agents") {
                        Text("\(agents.count)")
                            .font(.footnote)
                            .foregroundStyle(.tertiary)
                            .monospacedDigit()
                    }
                    FleetRows(agents: agents, client: client)
                }
                if empty {
                    EmptyBoard(loading: thread.isLoading)
                }
            }
            .padding(.bottom, 16)
        }
        // The running task is the hero: when the harness moves on, the open row follows it.
        .onChange(of: board.current.active) { choice = .auto }
    }

    /// The plan's heading when the thread was seeded from one, else the first request.
    private func goal(_ board: ImplementationBoard) -> String? {
        if let document, let heading = PlanDoc.heading(document) { return heading }
        return board.goal
    }
}

/// Which todo row is open: the running one until the user says otherwise.
enum TodoChoice: Equatable {
    case auto
    case closed
    case open(round: Int, todo: Int)
}

/// The goal line, dim, with the progress line and its count under it once a
/// pass has tasks: how far the build is, visible before a single row is read.
private struct GoalHeader: View {
    let goal: String?
    let progress: BoardProgress?

    var body: some View {
        if goal != nil || progress != nil {
            VStack(alignment: .leading, spacing: 10) {
                if let goal {
                    Text(goal)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .lineLimit(3)
                }
                if let progress, progress.total > 0 {
                    HStack(spacing: 10) {
                        ProgressLine(progress: progress)
                        Text(progress.label)
                            .font(.caption)
                            .foregroundStyle(progress.complete ? Tint.success : Color(.tertiaryLabel))
                            .monospacedDigit()
                            .contentTransition(.numericText())
                            .animation(Motion.crossFade, value: progress.done)
                            .layoutPriority(1)
                    }
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 12)
            .padding(.bottom, 14)
        }
    }
}

private struct EmptyBoard: View {
    let loading: Bool

    var body: some View {
        HStack {
            Spacer()
            if loading {
                ProgressView()
            } else {
                Text("No tasks yet")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            Spacer()
        }
        .padding(.top, 40)
    }
}

private struct RoundSection: View {
    let round: RoundData
    let roundIndex: Int
    let showsPass: Bool
    let running: Bool
    @Binding var choice: TodoChoice
    let client: EnvironmentClient
    let sessionId: String

    var body: some View {
        let todos = round.todos
        let itemsByTodo = Board.groupByTodo(round.items, todoCount: todos.count)
        let workByTodo = Board.groupByTodo(round.work, todoCount: todos.count)
        let changes = round.changeGroups()
        VStack(alignment: .leading, spacing: 0) {
            if showsPass && round.hasRow {
                // The first request is the goal line above; later passes name theirs.
                PassHeader(round: round, showsRequest: roundIndex > 0)
            }
            if todos.isEmpty {
                WorkCards(items: round.work, client: client, sessionId: sessionId)
            } else {
                if let setup = workByTodo[-1], setup.contains(where: { $0.item.needsUser || $0.item.isError }) {
                    WorkCards(items: setup, client: client, sessionId: sessionId)
                }
                ForEach(todos.indices, id: \.self) { index in
                    let todo = todos[index]
                    let live = running && todo.status == .inProgress
                    let open = isOpen(index, live: live, todos: todos)
                    let taskItems = itemsByTodo[index] ?? []
                    let trace = Board.traceItems(taskItems)
                    TodoRowView(
                        todo: todo,
                        live: live,
                        open: open,
                        hasTrace: !trace.isEmpty,
                        ms: todo.status == .pending ? nil : Board.activeMs(taskItems, liveNow: live ? Int(Date.now.timeIntervalSince1970 * 1_000) : nil)
                    ) {
                        withAnimation(open ? Motion.collapse : Motion.expand) {
                            choice = open ? .closed : .open(round: roundIndex, todo: index)
                        }
                    }
                    if open && !trace.isEmpty {
                        TodoTrace(items: trace, client: client, sessionId: sessionId)
                            .transition(.asymmetric(insertion: .opacity.animation(Motion.expandContent), removal: .opacity.animation(Motion.collapse)))
                    }
                    if let cards = workByTodo[index], cards.contains(where: { $0.item.needsUser || $0.item.isError }) {
                        WorkCards(items: cards, client: client, sessionId: sessionId)
                    }
                }
            }
            if !changes.isEmpty {
                ChangesSection(groups: changes, labelled: todos.count > 1, sessionId: sessionId)
            }
        }
        .padding(.top, showsPass ? 8 : 0)
        .padding(.bottom, 8)
    }

    private func isOpen(_ index: Int, live: Bool, todos: [TodoItem]) -> Bool {
        switch choice {
        case .open(let r, let t): return r == roundIndex && t == index
        case .closed: return false
        case .auto:
            if round.isCurrent, let active = todos.firstIndex(where: { $0.status == .inProgress }) { return active == index }
            return false
        }
    }
}

/// A pass's row on the chrome step: its colour as the dot, its number, the
/// request that opened it dim, and a settled pass's count. The current pass
/// leaves its count to the progress line.
private struct PassHeader: View {
    let round: RoundData
    let showsRequest: Bool

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Circle()
                .fill(Color(hex: ImplementationBoard.passColor(round.passNumber)))
                .frame(width: 7, height: 7)
                .alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + 2 }
            Text("Pass \(round.passNumber)")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(.secondary)
            if showsRequest {
                Text(round.headerText)
                    .font(.footnote)
                    .foregroundStyle(.tertiary)
                    .lineLimit(1)
            }
            Spacer(minLength: 8)
            if !round.isCurrent, !round.todos.isEmpty {
                Text("\(round.done)/\(round.todos.count)")
                    .font(.footnote)
                    .foregroundStyle(.tertiary)
                    .monospacedDigit()
            }
        }
        .padding(.horizontal, 16)
        .frame(maxWidth: .infinity, minHeight: 30)
        .background(Surface.chrome)
        .accessibilityElement(children: .combine)
    }
}

/// A todo: status glyph, the content, the duration once done, a chevron when
/// there is a trace to open. The running row is the bright one, on a faint
/// field in the success tint; done rows step down to secondary, pending to
/// tertiary, so the eye lands on the work under way.
private struct TodoRowView: View {
    let todo: TodoItem
    let live: Bool
    let open: Bool
    let hasTrace: Bool
    let ms: Int?
    let toggle: () -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @ScaledMetric(relativeTo: .subheadline) private var baselineDrop: CGFloat = 5

    var body: some View {
        Button(action: toggle) {
            HStack(alignment: .firstTextBaseline, spacing: BoardMetrics.glyphGap) {
                TodoStatusGlyph(status: todo.status, live: live)
                    .alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + baselineDrop }
                Text(todo.content)
                    .font(.subheadline.weight(live ? .medium : .regular))
                    .foregroundStyle(live ? Color(.label) : todo.status == .completed ? Color(.secondaryLabel) : Color(.tertiaryLabel))
                    .lineLimit(open ? nil : 2)
                    .multilineTextAlignment(.leading)
                Spacer(minLength: 8)
                if live {
                    TimelineView(.periodic(from: .now, by: 1)) { _ in
                        Text(ToolTime.duration(ms: ms ?? 0))
                            .contentTransition(.numericText())
                    }
                    .font(.caption)
                    .monospacedDigit()
                    .foregroundStyle(.tertiary)
                } else if let ms, ms > 1_500 {
                    Text(ToolTime.duration(ms: ms))
                        .font(.caption)
                        .monospacedDigit()
                        .foregroundStyle(.tertiary)
                }
                if hasTrace {
                    Image(systemName: "chevron.right")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(.tertiary)
                        .rotationEffect(.degrees(open ? 90 : 0))
                        .animation(reduceMotion ? nil : BoardMotion.chevron, value: open)
                }
            }
            .padding(.horizontal, BoardMetrics.fieldPadding)
            .padding(.vertical, 10)
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .background(live ? Tint.success.opacity(0.06) : .clear, in: RoundedRectangle(cornerRadius: Radius.field, style: .continuous))
            .animation(BoardMotion.field, value: live)
            .padding(.horizontal, BoardMetrics.fieldInset)
            .contentShape(Rectangle())
        }
        .buttonStyle(.pressable)
        .accessibilityLabel("\(todo.content), \(todo.status == .completed ? "done" : todo.status == .inProgress ? "in progress" : "pending")")
        .accessibilityHint(hasTrace ? (open ? "Hides what it did" : "Shows what it did") : "")
    }
}

/// What landed while the todo was in progress: tool chips and quiet notes,
/// inset to the text column. Edits sit in Changes and plan-tool calls are
/// mechanics, so neither shows here.
private struct TodoTrace: View {
    let items: [ThreadEntry]
    let client: EnvironmentClient
    let sessionId: String

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(items) { entry in
                switch entry.item {
                case .tool(let tool):
                    ToolChip(tool: tool, client: client, sessionId: sessionId)
                case .assistant(let block):
                    Text(Board.firstLine(block.text))
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .lineLimit(3)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 4)
                case .system(let line):
                    SystemRow(line: line, client: client)
                default:
                    EmptyView()
                }
            }
        }
        .padding(.leading, BoardMetrics.traceInset)
        .padding(.trailing, 8)
        .padding(.top, 2)
        .padding(.bottom, 10)
    }
}

/// Needs-you cards and errors, inline in order.
private struct WorkCards: View {
    let items: [ThreadEntry]
    let client: EnvironmentClient
    let sessionId: String
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        ForEach(items.filter { $0.item.needsUser || $0.item.isError }) { entry in
            TranscriptRow(entry: entry, client: client, sessionId: sessionId)
                .padding(.horizontal, 16)
                .padding(.vertical, 6)
                .transition(Motion.appear(reduced: reduceMotion))
        }
    }
}

/// File rows as edits land, grouped by the todo that made them; the count
/// in the header ticks as files join.
private struct ChangesSection: View {
    let groups: [ChangeGroup]
    let labelled: Bool
    let sessionId: String

    var body: some View {
        let total = groups.reduce(0) { $0 + $1.cards.count }
        SectionHeader("Changes") {
            Text("\(total)")
                .font(.footnote)
                .foregroundStyle(.tertiary)
                .monospacedDigit()
                .contentTransition(.numericText())
                .animation(Motion.crossFade, value: total)
        }
        ForEach(groups) { group in
            if labelled || group.todo < 0 {
                Text(group.title)
                    .font(.caption)
                    .foregroundStyle(.tertiary)
                    .lineLimit(1)
                    .padding(.horizontal, 16)
                    .padding(.top, 10)
                    .padding(.bottom, 2)
            }
            ForEach(group.cards) { card in
                EditRow(sessionId: sessionId, card: card)
                    .padding(.horizontal, 8)
            }
        }
    }
}

extension Color {
    /// "#10b981" → a colour; the pass wheel's values.
    init(hex: String) {
        var value: UInt64 = 0
        Scanner(string: String(hex.dropFirst())).scanHexInt64(&value)
        self.init(red: Double((value >> 16) & 0xff) / 255, green: Double((value >> 8) & 0xff) / 255, blue: Double(value & 0xff) / 255)
    }
}
