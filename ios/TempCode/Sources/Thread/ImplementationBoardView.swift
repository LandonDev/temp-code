import SwiftUI
import TempCodeClient
import TempCodeContract

/// The desktop's implementation board in one column, Reminders meets a build
/// log: the goal with a thin progress line under it (and the plan it came
/// from), one header per pass in its colour once there are two, the todos
/// with the running row bright and open, the changes grouped by todo, what
/// needs the user inline, the host's landing lines, the closing report, and
/// the fleet when the thread spawned agents. A queued build draws the goal
/// and the host's one line, nothing else.
struct ImplementationBoardView: View {
    let client: EnvironmentClient
    let sessionId: String
    let session: SessionMeta?
    let thread: ThreadState
    let document: String?
    @State private var choice: TodoChoice

    init(client: EnvironmentClient, sessionId: String, session: SessionMeta?, thread: ThreadState, document: String?) {
        self.client = client
        self.sessionId = sessionId
        self.session = session
        self.thread = thread
        self.document = document
        // The proof's `TC_TEST_OPEN=todo` shoots a row with its trace open.
        _choice = State(initialValue: TestHooks.open == "todo" ? .firstTrace : .auto)
    }

    var body: some View {
        let running = session?.status == .running || session?.status == .starting
        let board = ImplementationBoard.build(thread.fold, running: running)
        let agents = Fleet.children(of: sessionId, in: client.sessions)
        let empty = board.rounds.allSatisfy { !$0.hasRow && $0.outcomes.isEmpty } && board.closing == nil && agents.isEmpty
        let plan = session?.planThreadId.flatMap { client.session($0) }
        // The launch hook names a row by what the board holds now.
        let pick = Binding<TodoChoice>(get: { choice == .firstTrace ? Self.firstTrace(in: board) : choice }, set: { choice = $0 })
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                if session?.status == .queued {
                    GoalHeader(goal: goal(board), progress: nil, plan: plan)
                    QueuedRow(line: session?.activity ?? "Queued")
                } else {
                    GoalHeader(goal: goal(board), progress: board.progress, plan: plan)
                    ForEach(board.rounds.indices, id: \.self) { index in
                        let round = board.rounds[index]
                        // A landing that arrived in a round of its own (a "land it" follow-up,
                        // a Merge anyway from the desktop) still earns its rows.
                        if round.hasRow || !round.outcomes.isEmpty || (round.isCurrent && !board.hasTodos) {
                            RoundSection(round: round, roundIndex: index, showsPass: board.showsPasses, running: running && round.isCurrent, choice: pick, client: client, sessionId: sessionId)
                        }
                    }
                    if let closing = board.closing {
                        SectionHeader("Report")
                        MarkdownView(seq: closing.seq, text: closing.text)
                            .textSelection(.enabled)
                            .padding(.horizontal, Layout.textEdge)
                            .padding(.vertical, 12)
                    }
                    if !agents.isEmpty {
                        SectionHeader("Agents") {
                            CountText(agents.count)
                        }
                        FleetRows(agents: agents, client: client)
                    }
                    if empty {
                        EmptyBoard(loading: thread.isLoading)
                    }
                }
            }
            .padding(.bottom, 16)
        }
        // The running task is the hero: when the harness moves on, the open row
        // follows it. The launch hook's pick stays until the person taps.
        .onChange(of: [board.currentRound, board.current.active ?? -1]) {
            if choice != .firstTrace { choice = .auto }
        }
    }

    /// The plan's heading when the thread was seeded from one, else the first request.
    private func goal(_ board: ImplementationBoard) -> String? {
        if let document, let heading = PlanDoc.heading(document) { return heading }
        return board.goal
    }

    /// The proof's pick: the first row with a trace in the newest pass that
    /// has one, else the running row as usual.
    private static func firstTrace(in board: ImplementationBoard) -> TodoChoice {
        for r in board.rounds.indices.reversed() {
            let round = board.rounds[r]
            let byTodo = Board.groupByTodo(round.items, todoCount: round.todos.count)
            if let t = round.todos.indices.first(where: { !Board.traceItems(byTodo[$0] ?? []).isEmpty }) {
                return .open(round: r, todo: t)
            }
        }
        return .auto
    }
}

/// Which todo row is open: the running one until the user says otherwise.
/// `firstTrace` is the proof's launch pick, resolved to a row by the screen
/// from what the board holds (the first row with a trace, newest pass first).
enum TodoChoice: Equatable {
    case auto
    case closed
    case open(round: Int, todo: Int)
    case firstTrace
}

/// The goal line, dim, the plan it was built from under it when the host
/// linked one, then the progress line and its count once a pass has tasks:
/// how far the build is, visible before a single row is read.
private struct GoalHeader: View {
    let goal: String?
    let progress: BoardProgress?
    let plan: SessionMeta?

    var body: some View {
        if goal != nil || progress != nil || plan != nil {
            VStack(alignment: .leading, spacing: 10) {
                if let goal {
                    Text(goal)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .lineLimit(3)
                }
                if let plan {
                    PlanLine(plan: plan)
                }
                if let progress, progress.total > 0 {
                    HStack(spacing: 10) {
                        ProgressLine(progress: progress)
                        Text(progress.label)
                            .textStep(.stamp, tint: progress.complete ? Tint.success : nil)
                            .numeric(progress.label)
                            .layoutPriority(1)
                    }
                }
            }
            .padding(.horizontal, Layout.textEdge)
            .padding(.top, 12)
            .padding(.bottom, 14)
        }
    }
}

/// "Planned in <title>": where the build came from; tap pushes the planning
/// thread. Drawn only for a thread this host knows, never a bare "a thread".
/// The line takes 30 pt of the header; its hit area is the full 44.
private struct PlanLine: View {
    let plan: SessionMeta

    var body: some View {
        let title = plan.title.isEmpty ? "a plan" : plan.title
        NavigationLink(value: ThreadScreenRoute(sessionId: plan.id)) {
            HStack(spacing: 6) {
                Image(systemName: "map")
                    .font(.footnote.weight(.regular))
                    .foregroundStyle(Tint.violet)
                Text("Planned in \(title)")
                    .textStep(.meta)
                    .lineLimit(1)
                if plan.archived {
                    Text("Archived")
                        .textStep(.meta, tint: Color(.tertiaryLabel))
                }
            }
            .frame(maxWidth: .infinity, minHeight: Layout.rowHeight, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.pressable)
        .padding(.vertical, (30 - Layout.rowHeight) / 2)
        .accessibilityLabel("Planned in \(title)")
        .accessibilityHint("Opens the planning thread")
    }
}

/// A queued build: the host's one line ("Queued  waiting for <sibling>")
/// behind the quiet dot. The thread has not booted, so there is nothing else
/// to draw and no "No tasks yet" to say.
private struct QueuedRow: View {
    let line: String

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: Layout.rowGap) {
            StatusDot(status: .queued)
                .alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + 4 }
            Text(line)
                .textStep(.meta)
                .lineLimit(2)
        }
        .padding(.horizontal, Layout.textEdge)
        .frame(maxWidth: .infinity, minHeight: Layout.rowHeight, alignment: .leading)
        .accessibilityElement(children: .combine)
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
                ContentUnavailableView("No Tasks Yet", systemImage: "checklist")
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
        let now = Date.now
        VStack(alignment: .leading, spacing: 0) {
            if showsPass && round.hasRow {
                // The first request is the goal line above; later passes name theirs.
                PassHeader(round: round, showsRequest: roundIndex > 0)
            }
            if todos.isEmpty {
                WorkCards(items: round.work, client: client, sessionId: sessionId)
            } else {
                // Always mounted, so the first card arrives through the container's animation.
                WorkCards(items: workByTodo[-1] ?? [], client: client, sessionId: sessionId)
                ForEach(todos.indices, id: \.self) { index in
                    let todo = todos[index]
                    let live = running && todo.status == .inProgress
                    let taskItems = itemsByTodo[index] ?? []
                    let trace = Board.traceItems(taskItems)
                    let open = isOpen(index, todos: todos)
                    TodoRowView(
                        todo: todo,
                        live: live,
                        open: open,
                        hasTrace: !trace.isEmpty,
                        ms: todo.status == .pending ? nil : Board.activeMs(taskItems, liveNow: live ? Int(now.timeIntervalSince1970 * 1_000) : nil),
                        renderedAt: now
                    ) {
                        withAnimation(open ? Motion.collapse : Motion.expand) {
                            choice = open ? .closed : .open(round: roundIndex, todo: index)
                        }
                    }
                    if open && !trace.isEmpty {
                        TodoTrace(items: trace, client: client, sessionId: sessionId)
                            .transition(.asymmetric(insertion: .opacity.animation(Motion.expandContent), removal: .opacity.animation(Motion.collapse)))
                    }
                    WorkCards(items: workByTodo[index] ?? [], client: client, sessionId: sessionId)
                }
            }
            if !changes.isEmpty {
                ChangesSection(groups: changes, labelled: todos.count > 1, sessionId: sessionId)
            }
            if !round.outcomes.isEmpty {
                OutcomeRows(items: round.outcomes, client: client)
            }
        }
        .padding(.top, showsPass ? 8 : 0)
        .padding(.bottom, 8)
    }

    private func isOpen(_ index: Int, todos: [TodoItem]) -> Bool {
        switch choice {
        case .open(let r, let t): return r == roundIndex && t == index
        case .closed, .firstTrace: return false // firstTrace is resolved to a row by the screen
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
    @ScaledMetric(relativeTo: .footnote) private var dot = Layout.dotSize

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Circle()
                .fill(PassTint.color(round.passNumber))
                .frame(width: dot, height: dot)
                .alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + 2 }
            Text("Pass \(round.passNumber)")
                .textStep(.meta, weight: .semibold)
            if showsRequest {
                // The kit's three steps have no tertiary footnote; this pair stays written out.
                Text(round.headerText)
                    .font(.footnote)
                    .foregroundStyle(.tertiary)
                    .lineLimit(1)
            }
            Spacer(minLength: 8)
            if !round.isCurrent, !round.todos.isEmpty {
                Text("\(round.done)/\(round.todos.count)")
                    .font(.footnote)
                    .monospacedDigit()
                    .foregroundStyle(.tertiary)
            }
        }
        .padding(.horizontal, Layout.textEdge)
        .frame(maxWidth: .infinity, minHeight: 30)
        .background(Surface.chrome)
        .accessibilityElement(children: .combine)
    }
}

/// A todo: status glyph, the content, the duration once done, a chevron when
/// there is a trace to open. The running row is the bright one, on a faint
/// field in the success tint; done rows step down to secondary, pending to
/// tertiary, so the eye lands on the work under way. The colour change rides
/// the 150 ms cross-fade; the weight change stays a snap.
private struct TodoRowView: View {
    let todo: TodoItem
    let live: Bool
    let open: Bool
    let hasTrace: Bool
    let ms: Int?
    /// When `ms` was measured; the live row's clock ticks on from here.
    let renderedAt: Date
    let toggle: () -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @ScaledMetric(relativeTo: .subheadline) private var baselineDrop: CGFloat = 5

    var body: some View {
        Button(action: toggle) {
            HStack(alignment: .firstTextBaseline, spacing: Layout.rowGap) {
                TodoStatusGlyph(status: todo.status, live: live)
                    .alignmentGuide(.firstTextBaseline) { [baselineDrop] in $0[VerticalAlignment.center] + baselineDrop }
                Text(todo.content)
                    .font(.subheadline.weight(live ? .medium : .regular))
                    .foregroundStyle(live ? Color(.label) : todo.status == .completed ? Color(.secondaryLabel) : Color(.tertiaryLabel))
                    .animation(Motion.crossFade, value: todo.status)
                    .lineLimit(open ? nil : 2)
                    .multilineTextAlignment(.leading)
                Spacer(minLength: 8)
                if live {
                    TimelineView(.periodic(from: .now, by: 1)) { context in
                        let elapsed = (ms ?? 0) + Int(context.date.timeIntervalSince(renderedAt) * 1_000)
                        Text(ToolTime.duration(ms: elapsed))
                            .textStep(.stamp)
                            .numeric(elapsed / 1_000)
                    }
                } else if let ms, ms > 1_500 {
                    Text(ToolTime.duration(ms: ms))
                        .textStep(.stamp)
                }
                if hasTrace {
                    Image(systemName: "chevron.right")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(.tertiary)
                        .rotationEffect(.degrees(open ? 90 : 0))
                        .animation(reduceMotion ? nil : Motion.expand, value: open)
                }
            }
            .padding(.horizontal, BoardMetrics.fieldPadding)
            .padding(.vertical, 10)
            .frame(maxWidth: .infinity, minHeight: Layout.rowHeight, alignment: .leading)
            .background(live ? Tint.success.opacity(0.06) : .clear, in: RoundedRectangle.fieldCorner)
            .animation(Motion.crossFade, value: live)
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
                        .textStep(.meta)
                        .lineLimit(3)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 4)
                case .system(let line):
                    SystemRow(line: line, client: client, sessionId: sessionId)
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

/// Needs-you cards and errors, inline in order, each arriving with the
/// row-appear transition on a container that animates the list.
private struct WorkCards: View {
    let items: [ThreadEntry]
    let client: EnvironmentClient
    let sessionId: String

    var body: some View {
        let cards = items.filter { $0.item.needsUser || $0.item.isError }
        VStack(alignment: .leading, spacing: 0) {
            ForEach(cards) { entry in
                TranscriptRow(row: .item(entry), client: client, sessionId: sessionId)
                    .padding(.horizontal, Layout.textEdge)
                    .padding(.vertical, 6)
                    .rowAppearTransition()
            }
        }
        .animation(Motion.rowAppear, value: cards.map(\.id))
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
            CountText(total)
        }
        ForEach(groups) { group in
            if labelled || group.todo < 0 {
                Text(group.title)
                    .textStep(.meta)
                    .lineLimit(1)
                    .padding(.horizontal, Layout.textEdge)
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
