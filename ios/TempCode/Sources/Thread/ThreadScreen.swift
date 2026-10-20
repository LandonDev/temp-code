import SwiftUI
import TempCodeClient
import TempCodeContract

/// Where every thread opens. One header for every type; below it the type
/// decides the body: a transcript for chats and subagents, two swipeable
/// segments for the four board types. At the bottom the 28 pt working strip
/// over the composer bar (Composer.swift, WorkingStrip.swift).
struct ThreadScreen: View {
    let client: EnvironmentClient
    let sessionId: String
    var targetSeq: Int?
    @State private var model: ThreadScreenModel
    @State private var page: Segment?
    @State private var launchPush: LaunchPush?
    /// A thread this screen created (a build from the plan), pushed over it.
    @State private var pushed: ThreadScreenRoute?
    @State private var starting = false
    @State private var acted = false

    init(client: EnvironmentClient, sessionId: String, targetSeq: Int? = nil) {
        self.client = client
        self.sessionId = sessionId
        self.targetSeq = targetSeq
        _model = State(initialValue: ThreadScreenModel(sessionId: sessionId))
    }

    var body: some View {
        let session = client.session(sessionId)
        let thread = client.threads[sessionId] ?? ThreadState()
        let segments = Segment.segments(for: session)
        let phase = ThreadPhase(session: session, thread: thread, document: model.document)
        let segment = model.segment(in: segments, phase: phase)
        VStack(spacing: 0) {
            StatusLine(client: client)
            if segments.count > 1 {
                SegmentControl(segments: segments, selected: segment, dot: model.dot(in: segments, phase: phase, thread: thread)) { model.choose($0) }
                pager(segments: segments, session: session, thread: thread, phase: phase)
            } else {
                transcript(session: session, thread: thread)
            }
        }
        .background(Surface.background)
        .safeAreaInset(edge: .bottom, spacing: 0) { BottomDock(client: client, sessionId: sessionId, session: session, thread: thread) }
        .toolbar {
            ToolbarItem(placement: .principal) { ThreadHeader(session: session) }
            if let session, session.threadType == .planning, session.parentId == nil, phase.planHasContent, !phase.running, session.status != .waiting {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Start") { starting = true }
                        .font(.subheadline.weight(.semibold))
                        .disabled(client.operateBlock != nil)
                        .accessibilityHint(client.operateBlock.map { $0.text(now: Date().timeIntervalSince1970 * 1000) } ?? "Start building this plan")
                }
            }
        }
        .sheet(isPresented: $starting) {
            if let session {
                StartBuildSheet(client: client, plan: session, document: model.document) { built in
                    pushed = ThreadScreenRoute(sessionId: built.id)
                }
            }
        }
        .navigationDestination(item: $pushed) { route in ThreadScreen(client: client, sessionId: route.sessionId) }
        // The composer docks where the tab bar would float: the tabs wait behind the back button.
        .toolbar(.hidden, for: .tabBar)
        .navigationBarTitleDisplayMode(.inline)
        .navigationDestination(for: DiffRoute.self) { route in DiffScreen(client: client, route: route) }
        .navigationDestination(for: ReportRoute.self) { route in ReportScreen(route: route) }
        .navigationDestination(for: ThreadScreenRoute.self) { route in ThreadScreen(client: client, sessionId: route.sessionId, targetSeq: route.targetSeq) }
        .navigationDestination(item: $launchPush) { push in
            switch push {
            case .diff(let route): DiffScreen(client: client, route: route)
            case .agent(let route): ThreadScreen(client: client, sessionId: route.sessionId, targetSeq: route.targetSeq)
            }
        }
        .onChange(of: thread.fold.lastSeq, initial: true) {
            guard launchPush == nil, let open = TestHooks.open, targetSeq == nil else { return }
            if open == "diff", let edit = thread.fold.items.lazy.compactMap({ entry -> ChangeCard? in
                guard case .tool(let tool) = entry.item, let path = Board.editPath(tool) else { return nil }
                return Board.wholeChange(path: path, edits: [tool])
            }).first {
                launchPush = .diff(DiffRoute(sessionId: sessionId, card: edit))
            } else if open == "agent", let child = Fleet.children(of: sessionId, in: client.sessions).first {
                launchPush = .agent(ThreadScreenRoute(sessionId: child.id))
            }
        }
        .onAppear {
            model.visible = true
            Task { await client.openThread(sessionId) }
            client.markSeen(sessionId)
        }
        .onDisappear {
            model.visible = false
            client.markSeen(sessionId)
            client.closeThread(sessionId)
        }
        .onChange(of: thread.fold.lastSeq) { client.markSeen(sessionId) }
        .onChange(of: segment, initial: true) { _, now in
            model.saw(now, thread: thread)
            if page != now { withAnimation(Motion.drawer) { page = now } }
        }
        .onChange(of: page) { _, now in
            if let now, now != segment { model.choose(now) }
        }
        .task(id: "\(session?.planPath ?? "")|\(phase.running)") {
            await model.poll(client: client, path: session?.planPath, running: phase.running)
        }
        .task(id: thread.isLoading) {
            // DEBUG only: the proof asks for one action once the rows are in.
            guard let action = TestHooks.action, !thread.isLoading, !thread.rows.isEmpty, !acted, let session else { return }
            acted = true
            await perform(action, session: session, thread: thread)
        }
        .onChange(of: thread.isLoading, initial: true) {
            if TestHooks.sheet == "start", session?.threadType == .planning, !thread.isLoading, !starting { starting = true }
        }
    }

    /// The proof's action through the same calls the buttons make.
    private func perform(_ action: String, session: SessionMeta, thread: ThreadState) async {
        let parts = action.split(separator: ":", maxSplits: 1).map(String.init)
        let argument = parts.count > 1 ? parts[1] : ""
        switch parts[0] {
        case "send":
            try? await client.send(sessionId, text: argument)
        case "stop":
            try? await client.stop(sessionId)
        case "approve", "deny":
            if let approval = thread.fold.items.lazy.compactMap({ entry -> ApprovalItem? in
                if case .approval(let a) = entry.item, a.allowed == nil { return a } else { return nil }
            }).last {
                try? await client.approve(sessionId, requestId: approval.request.requestId, allow: parts[0] == "approve")
            }
        case "answer":
            if let question = thread.fold.items.lazy.compactMap({ entry -> QuestionItem? in
                if case .question(let q) = entry.item, !q.resolved { return q } else { return nil }
            }).last {
                try? await client.answer(sessionId, requestId: question.request.requestId, answers: question.request.questions.map { _ in [argument] })
            }
        case "start-build":
            let tasks = PlanDoc.tasks(PlanDoc.sections(model.document ?? "")).count
            let draft = ThreadDraft.build(from: session, type: .implementation, provider: session.provider, model: session.model, reasoning: session.reasoning, tasks: tasks)
            if let built = try? await client.createThread(draft) { pushed = ThreadScreenRoute(sessionId: built.id) }
        case "rename":
            try? await client.rename(sessionId, title: argument)
        case "pin":
            try? await client.setPinned(sessionId, true)
        case "archive":
            try? await client.setArchived(sessionId, true)
        default:
            break
        }
    }

    private func pager(segments: [Segment], session: SessionMeta?, thread: ThreadState, phase: ThreadPhase) -> some View {
        ScrollView(.horizontal) {
            LazyHStack(spacing: 0) {
                ForEach(segments) { segment in
                    body(for: segment, session: session, thread: thread, phase: phase)
                        .containerRelativeFrame(.horizontal)
                        .id(segment)
                }
            }
            .scrollTargetLayout()
        }
        .scrollTargetBehavior(.paging)
        .scrollPosition(id: $page)
        .scrollIndicators(.hidden)
    }

    @ViewBuilder
    private func body(for segment: Segment, session: SessionMeta?, thread: ThreadState, phase: ThreadPhase) -> some View {
        switch segment {
        case .chat, .log:
            transcript(session: session, thread: thread)
        case .board:
            ImplementationBoardView(client: client, sessionId: sessionId, session: session, thread: thread, document: model.document)
        case .plan:
            PlanView(sessionId: sessionId, document: model.document, running: phase.running)
        case .fleet:
            FleetView(client: client, sessionId: sessionId, session: session, thread: thread)
        case .sources:
            SourcesView(client: client, sessionId: sessionId, session: session, thread: thread, document: model.document)
        }
    }

    private func transcript(session: SessionMeta?, thread: ThreadState) -> some View {
        TranscriptView(client: client, sessionId: sessionId, thread: thread, targetSeq: targetSeq)
    }
}

/// What the proof opens on launch (DEBUG, `TC_TEST_OPEN`).
enum LaunchPush: Hashable, Identifiable {
    case diff(DiffRoute)
    case agent(ThreadScreenRoute)

    var id: Self { self }
}

/// Routes the thread screens push. A subagent's detail is the same screen
/// over the child's own transcript.
struct ThreadScreenRoute: Hashable {
    let sessionId: String
    var targetSeq: Int? = nil
}

// MARK: - segments

enum Segment: String, CaseIterable, Identifiable {
    case board, chat, plan, fleet, log, sources

    var id: String { rawValue }

    var title: String {
        switch self {
        case .board: "Board"
        case .chat: "Chat"
        case .plan: "Plan"
        case .fleet: "Fleet"
        case .log: "Log"
        case .sources: "Sources"
        }
    }

    /// The two segments a type has; a chat or a subagent has the transcript alone.
    static func segments(for session: SessionMeta?) -> [Segment] {
        guard let session, session.parentId == nil else { return [.chat] }
        switch session.threadType {
        case .implementation?: return [.board, .chat]
        case .planning?: return [.plan, .chat]
        case .orchestration?: return [.fleet, .log]
        case .research?: return [.sources, .chat]
        default: return [.chat]
        }
    }
}

/// What the thread is up to, as the segment rules read it.
struct ThreadPhase: Equatable {
    var type: ThreadType?
    var status: SessionStatus?
    var running: Bool
    var hasBoard: Bool
    var hasAgents: Bool
    var planHasContent: Bool
    var reportComplete: Bool
    /// The newest undecided approval or question.
    var undecidedSeq: Int?

    init(session: SessionMeta?, thread: ThreadState, document: String?) {
        type = session?.threadType
        status = session?.status
        running = status == .running || status == .starting
        let board = thread.fold.board
        hasAgents = !board.agents.isEmpty
        hasBoard = !board.todos.isEmpty || board.rounds.contains { !$0.isEmpty } || hasAgents
        let text = document?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        planHasContent = !text.isEmpty
        reportComplete = !text.isEmpty && PlanDoc.report(document ?? "").isComplete
        undecidedSeq = thread.fold.items.last { $0.item.needsUser }?.seq
    }

    /// A planning thread stopped on a question shows the question.
    var questionForcesChat: Bool { type == .planning && status == .waiting && undecidedSeq != nil }

    /// The segment the desktop makes the hero, by type and phase.
    func defaultSegment(in segments: [Segment]) -> Segment {
        switch type {
        case .implementation?: hasBoard ? .board : .chat
        case .planning?: planHasContent ? .plan : .chat
        case .orchestration?: hasAgents ? .fleet : .log
        case .research?: reportComplete ? .sources : .chat
        default: segments.first ?? .chat
        }
    }
}

/// Per-screen state: the segment chosen (remembered per thread), the plan or
/// report file polled while the screen shows, and what the user has seen on
/// each segment for the dot.
@Observable
final class ThreadScreenModel {
    let sessionId: String
    private(set) var chosen: Segment?
    var visible = false
    private(set) var document: String?
    private var seenCard: [Segment: Int] = [:]

    init(sessionId: String) {
        self.sessionId = sessionId
        chosen = TestHooks.segment ?? UserDefaults.standard.string(forKey: Self.key(sessionId)).flatMap(Segment.init(rawValue:))
    }

    private static func key(_ id: String) -> String { "thread.segment.\(id)" }

    func segment(in segments: [Segment], phase: ThreadPhase) -> Segment {
        if phase.questionForcesChat, segments.contains(.chat) { return .chat }
        if let chosen, segments.contains(chosen) { return chosen }
        return phase.defaultSegment(in: segments)
    }

    func choose(_ segment: Segment) {
        guard chosen != segment else { return }
        chosen = segment
        UserDefaults.standard.set(segment.rawValue, forKey: Self.key(sessionId))
    }

    /// Everything on this segment so far is seen.
    func saw(_ segment: Segment, thread: ThreadState) {
        seenCard[segment] = thread.fold.lastSeq
    }

    /// The inactive transcript segment holding an undecided card the user
    /// has not looked at. A board shows its cards inline, so it needs none.
    func dot(in segments: [Segment], phase: ThreadPhase, thread: ThreadState) -> Segment? {
        guard let card = phase.undecidedSeq, !segments.contains(.board) else { return nil }
        let home: Segment = segments.contains(.log) ? .log : .chat
        guard segments.contains(home), segment(in: segments, phase: phase) != home else { return nil }
        return card > (seenCard[home] ?? 0) ? home : nil
    }

    /// The plan or report file through `file.read`, polled like the desktop:
    /// 1.5 s while running, 8 s idle, only while the screen shows. A report
    /// that completes while the screen is open moves the user to Sources; one
    /// that was already complete when the screen opened leaves their choice.
    func poll(client: EnvironmentClient, path: String?, running: Bool) async {
        guard let path else {
            document = nil
            return
        }
        while !Task.isCancelled {
            if visible, let text = try? await client.request(Methods.FileRead.self, .init(path: path)), text != document {
                let wasComplete = document.map { PlanDoc.report($0).isComplete }
                document = text
                if wasComplete == false, PlanDoc.report(text).isComplete { choose(.sources) }
            }
            try? await Task.sleep(for: .milliseconds(running ? 1_500 : 8_000))
        }
    }
}

/// The two segments, with a dot on the inactive one that holds a new needs-you card.
private struct SegmentControl: View {
    let segments: [Segment]
    let selected: Segment
    let dot: Segment?
    let onSelect: (Segment) -> Void

    var body: some View {
        Picker("Segment", selection: Binding(get: { selected }, set: { onSelect($0) })) {
            ForEach(segments) { segment in
                Text(segment.title).tag(segment)
            }
        }
        .pickerStyle(.segmented)
        .overlay {
            HStack(spacing: 0) {
                ForEach(segments) { segment in
                    ZStack(alignment: .topTrailing) {
                        Color.clear
                        if segment == dot {
                            Circle()
                                .fill(Tint.warning)
                                .frame(width: 6, height: 6)
                                .padding(.top, 5)
                                .padding(.trailing, 8)
                                .transition(.opacity)
                                .accessibilityLabel("Needs you")
                        }
                    }
                    .frame(maxWidth: .infinity)
                }
            }
            .allowsHitTesting(false)
            .animation(Motion.crossFade, value: dot)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
    }
}

// MARK: - header

/// Title over a line with the type label tinted, the model, and the elapsed
/// running time while live. A subagent shows its role instead of a type.
private struct ThreadHeader: View {
    let session: SessionMeta?

    var body: some View {
        VStack(spacing: 1) {
            Text(title)
                .font(.headline)
                .lineLimit(1)
            HStack(spacing: 4) {
                if let session {
                    if session.parentId != nil {
                        Text(session.agentType.label)
                    } else if let type = session.threadType {
                        Text(type.label)
                            .foregroundStyle(type.tint)
                    }
                    Text("·")
                    Text(ModelName.short(session.model))
                    if session.status == .running || session.status == .starting {
                        Text("·")
                        TimelineView(.periodic(from: .now, by: 1)) { context in
                            Text(TimeFormat.elapsed(since: session.busySince ?? session.updatedAt, now: context.date))
                                .monospacedDigit()
                                .contentTransition(.numericText())
                        }
                    } else if session.status == .paused, let frozen = session.frozenActiveElapsed {
                        Text("·")
                        Text(TimeFormat.duration(ms: frozen))
                            .monospacedDigit()
                    }
                }
            }
            .font(.caption)
            .foregroundStyle(.secondary)
            .lineLimit(1)
        }
        .accessibilityElement(children: .combine)
    }

    private var title: String {
        guard let session else { return "Thread" }
        if session.title.isEmpty { return session.parentId == nil ? "Untitled" : "Subagent" }
        return session.title
    }
}
