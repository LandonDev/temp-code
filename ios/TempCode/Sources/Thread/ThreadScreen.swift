import SwiftUI
import TempCodeClient
import TempCodeContract

/// Where every thread opens. One header for every type (Frame/); below it
/// the kind decides the body: a transcript for chats and subagents, two
/// swipeable segments for the board types. At the bottom the chat bar
/// floats over the content (Composer.swift, WorkingStrip.swift). The
/// rules (which segments, which shows, the dot, the pill, the subtitle) are
/// the client package's `ThreadFrame`; this file routes and wires.
struct ThreadScreen: View {
    let client: EnvironmentClient
    let sessionId: String
    var targetSeq: Int?
    /// DEBUG proof: only the screen the launch route opened performs `TC_TEST_ACTION`; a screen this one pushed never does.
    var performsLaunchAction = true
    @Environment(NavigationRouter.self) private var router
    @Environment(AppModel.self) private var app
    @Environment(\.shellPose) private var pose
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var model: ThreadScreenModel
    /// The row this screen opens on (`TranscriptLanding`), else nil for the bottom.
    @State private var landingSeq: Int?
    @State private var page: ThreadSegment?
    @State private var launchPush: LaunchPush?
    /// A thread this screen created (a build from the plan), pushed over it.
    @State private var pushed: ThreadScreenRoute?
    @State private var starting = false
    @State private var acted = false
    /// The pager's offset in pages, for the segment bar's pill; nil before the first layout.
    @State private var pageProgress: CGFloat?
    /// The segments the pager was last laid out for: a new list lands on its segment with nothing moving.
    @State private var pagedSegments: [ThreadSegment] = []
    @State private var showAgents = false
    /// The title is a field in the header while this is on.
    @State private var renaming = false
    @State private var draftTitle = ""
    @State private var failure: String?
    /// The last title the session had, kept for the header once the thread is gone.
    @State private var lastTitle: String?

    init(client: EnvironmentClient, sessionId: String, targetSeq: Int? = nil, performsLaunchAction: Bool = true) {
        self.client = client
        self.sessionId = sessionId
        // Decided once: a screen the launch restored from the saved stacks opens at the bottom
        // even when its route named a row; a later re-init never brings the row back.
        _landingSeq = State(initialValue: TranscriptLanding.onOpen(targetSeq: targetSeq, restoredAtLaunch: LaunchRestore.active).seq)
        self.targetSeq = targetSeq
        self.performsLaunchAction = performsLaunchAction
        _model = State(initialValue: ThreadScreenModel(sessionId: sessionId))
    }

    var body: some View {
        let session = client.session(sessionId)
        let thread = client.threads[sessionId] ?? ThreadState()
        let kind = ThreadKind(session)
        let segments = ThreadSegment.segments(for: kind)
        let phase = ThreadPhase(session: session, thread: thread, document: model.document)
        let segment = model.segment(in: segments, phase: phase)
        let gone = goneReason(session: session, thread: client.threads[sessionId])
        let children = Fleet.children(of: sessionId, in: client.sessions)
        let hostName = app.registry.ordered.count > 1 ? client.environment.name : nil
        VStack(spacing: 0) {
            StatusLine(client: client)
            if let gone {
                GoneLine(reason: gone)
            } else {
                if thread.isLoadingHistory || thread.historyError != nil {
                    Text(thread.historyError ?? "Loading earlier board history…")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, Layout.textEdge)
                        .padding(.vertical, 8)
                        .accessibilityIdentifier("board-history-status")
                }
                if segments.count > 1 {
                    SegmentBar(segments: segments, selected: segment, dot: model.dot(in: segments, phase: phase, shown: segment), progress: pageProgress ?? CGFloat(segments.firstIndex(of: segment) ?? 0)) { select($0) }
                    pager(segments: segments, kind: kind, session: session, thread: thread, phase: phase)
                } else {
                    transcript(session: session, thread: thread)
                }
            }
        }
        .background(Surface.background)
        .animation(Motion.rowAppear, value: gone)
        .tcBottomBar {
            if gone == nil {
                BottomDock(client: client, sessionId: sessionId, session: session, thread: thread)
                    #if DEBUG
                    .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { TestHooks.recordDock(height: $0, focused: TestHooks.open == "composer") }
                    #endif
            }
        }
        .toolbar {
            ToolbarItem(placement: .principal) {
                ThreadHeader(client: client, session: session, fallbackTitle: lastTitle, hostName: hostName, renaming: $renaming, draft: $draftTitle, onCommit: commitRename, onBeginRename: { beginRename(session) })
            }
            ToolbarItem(placement: .topBarTrailing) {
                // The field takes the whole bar while renaming; nothing acts on a thread that is gone.
                HStack(spacing: 0) {
                    if let session, !renaming, gone == nil {
                        trailing(session: session, phase: phase, children: children, segments: segments)
                            .transition(.opacity)
                    }
                }
                .animation(Motion.crossFade, value: renaming)
            }
        }
        .alert("Couldn't do that", isPresented: Binding(get: { failure != nil }, set: { if !$0 { failure = nil } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(failure ?? "")
        }
        .navigationDestination(isPresented: $showAgents) {
            SubagentListScreen(client: client, rootSessionId: sessionId)
        }
        .sheet(isPresented: $starting) {
            if let session {
                StartBuildSheet(client: client, plan: session) { built in
                    pushed = ThreadScreenRoute(sessionId: built.id)
                }
            }
        }
        .navigationDestination(item: $pushed) { route in ThreadScreen(client: client, sessionId: route.sessionId, performsLaunchAction: false) }
        // Return flow (thread 14): the Start sheet survives a kill.
        .onChange(of: starting) { NavigationMemory.rememberSheet(starting ? .startBuild(environmentId: client.environment.id, sessionId: sessionId) : nil) }
        .onChange(of: router.restoredSheet, initial: true) {
            guard case .startBuild(let environmentId, let id)? = router.restoredSheet, environmentId == client.environment.id, id == sessionId else { return }
            router.restoredSheet = nil
            starting = true
        }
        .environment(\.markdownScope, MarkdownScope(environmentId: client.environment.id, sessionId: sessionId))
        // Compact: the composer docks where the tab bar would float, the tabs wait behind the back
        // button. Split: the bar stays, since hiding it would hide the vertical rail for every tab.
        .toolbar(pose.isSplit ? .automatic : .hidden, for: .tabBar)
        .navigationBarTitleDisplayMode(.inline)
        .tcNavigationBar()
        .navigationDestination(for: DiffRoute.self) { route in DiffScreen(client: client, route: route) }
        .navigationDestination(for: HtmlRenderRoute.self) { route in HtmlRenderScreen(render: route.render, client: client) }
        .navigationDestination(for: ReportRoute.self) { route in
            ReportScreen(route: route)
                .environment(\.markdownScope, MarkdownScope(environmentId: client.environment.id, sessionId: route.sessionId))
        }
        .navigationDestination(for: ThreadScreenRoute.self) { route in ThreadScreen(client: client, sessionId: route.sessionId, targetSeq: route.targetSeq) }
        .navigationDestination(item: $launchPush) { push in
            switch push {
            case .diff(let route): DiffScreen(client: client, route: route)
            case .page(let route): HtmlRenderScreen(render: route.render, client: client)
            case .agent(let route): ThreadScreen(client: client, sessionId: route.sessionId, targetSeq: route.targetSeq)
            }
        }
        .onChange(of: TestHooks.open == nil ? "" : "\(thread.fold.lastSeq)|\(thread.rows.count)|\(thread.isLoading)", initial: true) {
            guard launchPush == nil, let open = TestHooks.open, targetSeq == nil else { return }
            if open == "diff", let edit = thread.fold.items.lazy.compactMap({ entry -> ChangeCard? in
                guard case .tool(let tool) = entry.item, let path = Board.editPath(tool) else { return nil }
                return Board.wholeChange(path: path, edits: [tool])
            }).first {
                launchPush = .diff(DiffRoute(sessionId: sessionId, card: edit))
            } else if open == "page", let page = thread.fold.items.lazy.compactMap({ entry -> HtmlRender? in
                guard case .tool(let tool) = entry.item else { return nil }
                return tool.htmlRender
            }).first {
                launchPush = .page(HtmlRenderRoute(render: page))
            } else if open == "agent", let child = children.first {
                launchPush = .agent(ThreadScreenRoute(sessionId: child.id))
            } else if open == "agents", !children.isEmpty, !showAgents {
                showAgents = true
            } else if open == "rename", session != nil, !thread.isLoading, !renaming {
                beginRename(session)
            }
        }
        .onChange(of: session?.title, initial: true) {
            if let title = session?.title, !title.isEmpty { lastTitle = title }
        }
        .onAppear {
            model.visible = true
            router.visible = ThreadKey(environmentId: client.environment.id, sessionId: sessionId)
            Task { await client.openThread(sessionId) }
            client.markSeen(sessionId)
        }
        .onDisappear {
            model.visible = false
            if router.visible == ThreadKey(environmentId: client.environment.id, sessionId: sessionId) { router.visible = nil }
            client.markSeen(sessionId)
            client.closeThread(sessionId)
        }
        .onChange(of: thread.fold.lastSeq) {
            client.markSeen(sessionId)
            // A card that lands on the segment in view is seen as it lands; the dot is for the other one.
            model.saw(segment, thread: thread)
        }
        // A running thread the person is watching gets the Live Activity.
        .onChange(of: session?.status, initial: true) {
            if let session, session.parentId == nil { app.activities.watch(client, session, registry: app.registry) }
        }
        .task(id: "\(thread.isLoading)|\(thread.isLoadingHistory)|\(thread.moreBefore)|\(thread.rows.count)") {
            TestHooks.recordHistory(thread)
        }
        .onChange(of: segment, initial: true) { _, now in
            model.saw(now, thread: thread)
            let fresh = pagedSegments != segments
            pagedSegments = segments
            guard page != now else { return }
            if fresh {
                // The first paint of a pager (or of a new segment list once the meta lands) moves nothing.
                Motion.withoutAnimation { page = now }
            } else {
                withAnimation(reduceMotion ? nil : Motion.drawer) { page = now }
            }
        }
        .onChange(of: segments, initial: true) {
            if landingSeq != nil { model.choose(segments.contains(.log) ? .log : .chat) }
        }
        .onChange(of: page) { _, now in
            if let now, now != segment { model.choose(now) }
        }
        .task(id: "\(session?.planPath ?? "")|\(phase.running)") {
            await model.poll(client: client, path: session?.planPath, running: phase.running)
        }
        .task(id: "\(thread.isLoading)|\(thread.isLive)") {
            // DEBUG only: the proof asks for one action once the thread is loaded and live (a fresh thread has no rows yet).
            guard performsLaunchAction, let action = TestHooks.action, !thread.isLoading, thread.isLive, !acted, let session else { return }
            // With the agent detail pushed, the action is the agent's, not the root's.
            guard TestHooks.open != "agent" || session.parentId != nil else { return }
            acted = true
            await perform(action, session: session, thread: thread)
        }
        .onChange(of: thread.isLoading, initial: true) {
            if TestHooks.sheet == "start", session?.threadType == .planning, !thread.isLoading, !starting { starting = true }
        }
    }

    /// The trailing group, left to right: slot (c) Notes (thread 18), the
    /// agents button, the menu last. A planning root's Start and Build live
    /// in the plan page's header row (PlanFlow.swift), not here.
    @ViewBuilder
    private func trailing(session: SessionMeta, phase: ThreadPhase, children: [SessionMeta], segments: [ThreadSegment]) -> some View {
        // iOS 18: a root thread's notes (NotesSheet.swift), before the agents button.
        if session.parentId == nil { NotesButton(client: client, sessionId: sessionId) }
        if SegmentRules.showsAgents(children: children.count, segments: segments) {
            AgentsButton(running: Fleet.counts(children.map(\.status)).working, total: children.count) { showAgents = true }
        }
        ThreadMenu(client: client, session: session, onRename: { beginRename(session) }, onFailure: { failure = $0 })
    }

    /// The thread is no longer on this host: the subscription was refused,
    /// or a full listing came back without it. Nothing is shown until the
    /// first listing and the thread's first page, so a cold open never
    /// flashes the line.
    private func goneReason(session: SessionMeta?, thread: ThreadState?) -> String? {
        if thread?.goneReason != nil { return "This thread was moved or deleted" }
        if session == nil, client.hasShell, let thread, !thread.isLoading { return "This thread was moved or deleted" }
        return nil
    }

    /// A tap on the segment bar: the page moves with the drawer curve (a jump under reduced motion) and the pill rides with it.
    private func select(_ segment: ThreadSegment) {
        model.choose(segment)
        withAnimation(reduceMotion ? nil : Motion.drawer) { page = segment }
    }

    /// Rename from the title's long-press or the menu: the title becomes a
    /// field in place. A key that cannot act sees the reason instead.
    private func beginRename(_ session: SessionMeta?) {
        guard let session else { return }
        if let block = client.operateBlock {
            failure = block.text(now: Date().timeIntervalSince1970 * 1000)
            return
        }
        draftTitle = session.title
        renaming = true
    }

    /// Done on the keyboard or the field losing focus with a changed, non-empty draft.
    private func commitRename() {
        let title = draftTitle.trimmingCharacters(in: .whitespacesAndNewlines)
        renaming = false
        guard !title.isEmpty else { return }
        Task {
            do {
                try await client.rename(sessionId, title: title)
            } catch {
                failure = (error as? ActionError)?.message ?? String(describing: error)
            }
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
        case "start-now":
            try? await client.start(sessionId)
        case "resume":
            try? await client.resume(sessionId)
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
        case "start-build" where session.threadType == .planning:
            if let built = try? await client.implementPlan(sessionId, type: .implementation, provider: session.provider, model: session.model, reasoning: session.reasoning) { pushed = ThreadScreenRoute(sessionId: built.id) }
        case "rename":
            try? await client.rename(sessionId, title: argument)
        case "pin":
            try? await client.setPinned(sessionId, true)
        case "archive":
            try? await client.setArchived(sessionId, true)
        case "archive-remove":
            try? await client.archive(sessionId, removeResources: true)
        case "remove-resources":
            _ = try? await client.removeResources(sessionId)
        case "stop-step":
            if let step = client.batchState(sessionId).map(BatchSteps.liveSteps)?.first(where: { $0.status == .running }) {
                _ = try? await client.stopBatchStep(sessionId, stepId: step.id)
            }
        case "set-master":
            try? await client.setMaster(sessionId, session.isMaster != true)
        default:
            break
        }
    }

    private func pager(segments: [ThreadSegment], kind: ThreadKind, session: SessionMeta?, thread: ThreadState, phase: ThreadPhase) -> some View {
        ScrollView(.horizontal) {
            LazyHStack(spacing: 0) {
                ForEach(segments) { segment in
                    body(for: segment, kind: kind, session: session, thread: thread, phase: phase)
                        .containerRelativeFrame(.horizontal)
                        .id(segment)
                }
            }
            .scrollTargetLayout()
        }
        .scrollTargetBehavior(.paging)
        .scrollPosition(id: $page)
        .scrollIndicators(.hidden)
        // A scroll view shows its content under the safe area: in the Duo's split the next page peeked
        // into the trailing column beside the detail. Clip the sides only; the transcript still runs
        // under the bars above and below.
        .mask { Rectangle().padding(.vertical, -4000) }
        // The segment bar's pill rides on this: the offset in pages, every frame of a swipe.
        .onScrollGeometryChange(for: CGFloat.self) { geometry in
            geometry.containerSize.width > 0 ? geometry.contentOffset.x / geometry.containerSize.width : 0
        } action: { _, progress in
            pageProgress = progress
        }
    }

    @ViewBuilder
    private func body(for segment: ThreadSegment, kind: ThreadKind, session: SessionMeta?, thread: ThreadState, phase: ThreadPhase) -> some View {
        switch segment {
        case .chat, .log:
            transcript(session: session, thread: thread)
        case .board:
            if kind == .master {
                MasterView(client: client, sessionId: sessionId, session: session, thread: thread)
            } else {
                ImplementationBoardView(client: client, sessionId: sessionId, session: session, thread: thread, document: model.document)
            }
        case .plan:
            if kind == .projectPlan {
                ProjectPlanView(client: client, sessionId: sessionId, session: session, document: model.document, running: phase.running)
            } else {
                // The plan flow's header row (the state line and Start or the build chip) exists only once the plan is complete.
                let flow = session.map { PlanFlowState.of($0, session: { client.session($0) }) } ?? .open
                if flow == .open {
                    PlanView(sessionId: sessionId, document: model.document, running: phase.running)
                } else {
                    PlanView(sessionId: sessionId, document: model.document, running: phase.running) {
                        PlanStatusLine(state: flow)
                    } action: {
                        PlanAction(client: client, state: flow, onStart: { starting = true }, onOpen: { pushed = ThreadScreenRoute(sessionId: $0) })
                    }
                }
            }
        case .fleet:
            FleetView(client: client, sessionId: sessionId, session: session, thread: thread)
        case .sources:
            SourcesView(client: client, sessionId: sessionId, session: session, thread: thread, document: model.document)
        }
    }

    private func transcript(session: SessionMeta?, thread: ThreadState) -> some View {
        TranscriptView(client: client, sessionId: sessionId, thread: thread, targetSeq: landingSeq)
    }
}

/// What the proof opens on launch (DEBUG, `TC_TEST_OPEN`).
enum LaunchPush: Hashable, Identifiable {
    case diff(DiffRoute)
    case page(HtmlRenderRoute)
    case agent(ThreadScreenRoute)

    var id: Self { self }
}

/// Routes the thread screens push. A subagent's detail is the same screen
/// over the child's own transcript.
struct ThreadScreenRoute: Hashable {
    let sessionId: String
    var targetSeq: Int? = nil
}

/// Per-screen state: the segment chosen (remembered per thread), the plan or
/// report file polled while the screen shows, and what the user has seen on
/// each segment for the dot. Every rule is `SegmentRules`; this holds state.
@Observable
final class ThreadScreenModel {
    let sessionId: String
    private(set) var chosen: ThreadSegment?
    var visible = false
    private(set) var document: String?
    private var seenCard: [ThreadSegment: Int] = [:]

    init(sessionId: String) {
        self.sessionId = sessionId
        chosen = TestHooks.segment ?? UserDefaults.standard.string(forKey: Self.key(sessionId)).flatMap(ThreadSegment.init(rawValue:))
    }

    private static func key(_ id: String) -> String { "thread.segment.\(id)" }

    func segment(in segments: [ThreadSegment], phase: ThreadPhase) -> ThreadSegment {
        SegmentRules.segment(chosen: chosen, in: segments, phase: phase)
    }

    func choose(_ segment: ThreadSegment) {
        guard chosen != segment else { return }
        chosen = segment
        UserDefaults.standard.set(segment.rawValue, forKey: Self.key(sessionId))
    }

    /// Everything on this segment so far is seen.
    func saw(_ segment: ThreadSegment, thread: ThreadState) {
        seenCard[segment] = thread.fold.lastSeq
    }

    /// The inactive transcript segment holding an undecided card the user has not looked at.
    func dot(in segments: [ThreadSegment], phase: ThreadPhase, shown: ThreadSegment) -> ThreadSegment? {
        SegmentRules.dot(in: segments, phase: phase, shown: shown, seen: seenCard)
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
