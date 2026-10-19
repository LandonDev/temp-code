import SwiftUI
import TempCodeClient
import TempCodeContract

/// The desktop's implementation board in one column: the goal, one section
/// per pass in its colour, the todos with the running row open, the changes
/// grouped by todo, what needs the user inline, the closing report, and the
/// fleet when the thread spawned agents.
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
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                if let goal = goal(board) {
                    Text(goal)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .lineLimit(3)
                        .padding(.horizontal, 16)
                        .padding(.vertical, 12)
                }
                ForEach(board.rounds.indices, id: \.self) { index in
                    let round = board.rounds[index]
                    if round.hasRow || (round.isCurrent && !board.hasTodos) {
                        RoundSection(round: round, roundIndex: index, multi: board.rounds.count { $0.hasRow } > 1, running: running && round.isCurrent, choice: $choice, client: client, sessionId: sessionId)
                    }
                }
                if let closing = board.closing {
                    VStack(alignment: .leading, spacing: 10) {
                        Hairline()
                            .padding(.horizontal, 16)
                        MarkdownView(seq: closing.seq, text: closing.text)
                            .textSelection(.enabled)
                            .padding(.horizontal, 16)
                            .padding(.vertical, 12)
                    }
                    .padding(.top, 8)
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
                if board.rounds.allSatisfy({ !$0.hasRow }) && board.closing == nil && agents.isEmpty {
                    HStack {
                        Spacer()
                        if thread.isLoading {
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
            .padding(.bottom, 16)
        }
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

private struct RoundSection: View {
    let round: RoundData
    let roundIndex: Int
    let multi: Bool
    let running: Bool
    @Binding var choice: TodoChoice
    let client: EnvironmentClient
    let sessionId: String

    var body: some View {
        let todos = round.todos
        let itemsByTodo = Board.groupByTodo(round.items, todoCount: todos.count)
        let workByTodo = Board.groupByTodo(round.work, todoCount: todos.count)
        let changes = Board.changes(in: round.work)
        VStack(alignment: .leading, spacing: 0) {
            if round.hasRow {
                // The first request is the goal line above; later passes name theirs.
                PassBanner(round: round, showsRequest: roundIndex > 0)
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
                    TodoRowView(todo: todo, live: live, open: open, ms: todo.status == .pending ? nil : Board.activeMs(taskItems, liveNow: live ? Int(Date.now.timeIntervalSince1970 * 1_000) : nil)) {
                        withAnimation(open ? Motion.collapse : Motion.expand) {
                            choice = open ? .closed : .open(round: roundIndex, todo: index)
                        }
                    }
                    if open {
                        TodoTrace(items: taskItems, client: client, sessionId: sessionId)
                            .transition(.asymmetric(insertion: .opacity.animation(Motion.expandContent), removal: .opacity.animation(Motion.collapse)))
                    }
                    if let cards = workByTodo[index], cards.contains(where: { $0.item.needsUser || $0.item.isError }) {
                        WorkCards(items: cards, client: client, sessionId: sessionId)
                    }
                }
            }
            if !changes.isEmpty {
                ChangesSection(round: round, workByTodo: workByTodo, total: changes.count, sessionId: sessionId)
            }
        }
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

/// The pass's row: its colour, number, the request that opened it, its time.
private struct PassBanner: View {
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
            if !round.todos.isEmpty {
                Text("\(round.done)/\(round.todos.count)")
                    .font(.footnote)
                    .foregroundStyle(.tertiary)
                    .monospacedDigit()
                    .contentTransition(.numericText())
            }
        }
        .padding(.horizontal, 16)
        .frame(minHeight: 30)
        .background(Surface.chrome)
    }
}

/// A todo: status glyph, the content, the duration once done. The running
/// row is the bright one; settled rows dim.
private struct TodoRowView: View {
    let todo: TodoItem
    let live: Bool
    let open: Bool
    let ms: Int?
    let toggle: () -> Void

    var body: some View {
        Button(action: toggle) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Group {
                    switch todo.status {
                    case .pending:
                        Image(systemName: "circle")
                            .foregroundStyle(.tertiary)
                    case .inProgress:
                        if live {
                            ProgressView()
                                .controlSize(.mini)
                        } else {
                            Image(systemName: "circle.dotted")
                                .foregroundStyle(.secondary)
                        }
                    case .completed:
                        Image(systemName: "checkmark.circle.fill")
                            .foregroundStyle(Tint.success)
                    }
                }
                .font(.footnote)
                .frame(width: 16)
                Text(todo.content)
                    .font(.subheadline.weight(live ? .medium : .regular))
                    .foregroundStyle(live ? .primary : .secondary)
                    .lineLimit(open ? 4 : 2)
                Spacer(minLength: 8)
                if live {
                    TimelineView(.periodic(from: .now, by: 1)) { _ in
                        Text(ToolTime.duration(ms: ms ?? 0))
                            .contentTransition(.numericText())
                    }
                    .font(.footnote)
                    .monospacedDigit()
                    .foregroundStyle(.tertiary)
                } else if let ms, ms > 1_500 {
                    Text(ToolTime.duration(ms: ms))
                        .font(.footnote)
                        .monospacedDigit()
                        .foregroundStyle(.tertiary)
                }
            }
            .padding(.horizontal, 16)
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.pressable)
        .accessibilityLabel("\(todo.content), \(todo.status == .completed ? "done" : todo.status == .inProgress ? "in progress" : "pending")")
    }
}

/// What landed while the todo was in progress: tool chips and quiet notes.
/// Edits sit in Changes and plan-tool calls are mechanics, so neither shows here.
private struct TodoTrace: View {
    let items: [ThreadEntry]
    let client: EnvironmentClient
    let sessionId: String

    var body: some View {
        let visible = items.filter { entry in
            switch entry.item {
            case .tool(let tool): Board.editPath(tool) == nil && !tool.isPlanTool
            case .assistant(let block): !block.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            case .system(let line): line.kind == .error
            default: false
            }
        }
        if !visible.isEmpty {
            VStack(alignment: .leading, spacing: 4) {
                ForEach(visible) { entry in
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
            .padding(.leading, 34)
            .padding(.trailing, 8)
            .padding(.bottom, 8)
        }
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

/// File rows as edits land, grouped by the todo that made them.
private struct ChangesSection: View {
    let round: RoundData
    let workByTodo: [Int: [ThreadEntry]]
    let total: Int
    let sessionId: String

    var body: some View {
        SectionHeader("Changes") {
            Text("\(total)")
                .font(.footnote)
                .foregroundStyle(.tertiary)
                .monospacedDigit()
                .contentTransition(.numericText())
                .animation(Motion.crossFade, value: total)
        }
        let keys = workByTodo.keys.sorted()
        ForEach(keys, id: \.self) { key in
            let cards = Board.changes(in: workByTodo[key] ?? [])
            if !cards.isEmpty {
                if round.todos.count > 1 || key < 0 {
                    Text(key < 0 ? "Setup" : round.todos[safe: key]?.content ?? "")
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                        .lineLimit(1)
                        .padding(.horizontal, 16)
                        .padding(.top, 8)
                }
                ForEach(cards) { card in
                    EditRow(sessionId: sessionId, card: card)
                        .padding(.horizontal, 8)
                }
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
