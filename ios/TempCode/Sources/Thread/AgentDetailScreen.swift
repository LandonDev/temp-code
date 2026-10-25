import SwiftUI
import TempCodeClient
import TempCodeContract

/// A subagent's detail (the desktop's AgentDetail): its identity under the
/// bar, its own transcript, and one line at the bottom that steers it while
/// it runs or sends when it is idle. A waiting agent's approval or question
/// card sits at the end of its transcript, where the screen opens. Pushed
/// from any fleet row. `client` is the agent's own host's client, so an
/// agent on the Mac reads from the Mac and the field carries the Mac key's
/// standing; its meta line carries that host's glyph.
struct AgentDetailScreen: View {
    let client: EnvironmentClient
    let agentId: String
    var parentCwd: String?
    @Environment(NavigationRouter.self) private var router
    /// DEBUG proof: the launch action ran once on this screen.
    @State private var acted = false

    var body: some View {
        let session = client.session(agentId)
        let thread = client.threads[agentId] ?? ThreadState()
        VStack(spacing: 0) {
            StatusLine(client: client)
            if let session {
                AgentIdentity(agent: session, thread: thread, parentCwd: parentCwd, environmentId: client.environment.id)
            }
            // A lone transcript: the reading measure (640 pt, centred) at any width, and the reader's place kept through a size change.
            TranscriptView(client: client, sessionId: agentId, thread: thread, measured: true)
        }
        .background(Surface.background)
        .safeAreaInset(edge: .bottom, spacing: 0) {
            AgentSendBar(client: client, agentId: agentId, session: session)
                .frame(maxWidth: ReadingMeasure.cap + 2 * ReadingMeasure.edge)
                .frame(maxWidth: .infinity)
                .background(.bar)
        }
        .toolbar {
            ToolbarItem(placement: .principal) {
                AgentTitle(agent: session)
            }
        }
        .toolbar(.hidden, for: .tabBar)
        .navigationBarTitleDisplayMode(.inline)
        .tcNavigationBar()
        .environment(\.markdownScope, MarkdownScope(environmentId: client.environment.id, sessionId: agentId))
        .onAppear {
            router.visible = ThreadKey(environmentId: client.environment.id, sessionId: agentId)
            Task { await client.openThread(agentId) }
            client.markSeen(agentId)
        }
        .onDisappear {
            if router.visible == ThreadKey(environmentId: client.environment.id, sessionId: agentId) { router.visible = nil }
            client.markSeen(agentId)
            client.closeThread(agentId)
        }
        .onChange(of: thread.fold.lastSeq) { client.markSeen(agentId) }
        .task(id: "\(thread.isLoading)|\(thread.isLive)") {
            // DEBUG only: with the agent's detail pushed, the proof's action is the agent's. Once, through the calls the buttons make.
            guard let action = TestHooks.action, TestHooks.open == "agent" || TestHooks.open == "agent-detail",
                  !thread.isLoading, thread.isLive, !acted, session != nil else { return }
            acted = true
            await perform(action, thread: thread)
        }
    }

    private func perform(_ action: String, thread: ThreadState) async {
        let parts = action.split(separator: ":", maxSplits: 1).map(String.init)
        let argument = parts.count > 1 ? parts[1] : ""
        switch parts[0] {
        case "send":
            try? await client.send(agentId, text: argument)
        case "approve", "deny":
            if let approval = thread.fold.items.lazy.compactMap({ entry -> ApprovalItem? in
                if case .approval(let a) = entry.item, a.allowed == nil { return a } else { return nil }
            }).last {
                try? await client.approve(agentId, requestId: approval.request.requestId, allow: parts[0] == "approve")
            }
        case "answer":
            if let question = thread.fold.items.lazy.compactMap({ entry -> QuestionItem? in
                if case .question(let q) = entry.item, !q.resolved { return q } else { return nil }
            }).last {
                try? await client.answer(agentId, requestId: question.request.requestId, answers: question.request.questions.map { _ in [argument] })
            }
        default:
            break
        }
    }
}

/// Title over the role, as the thread header reads for a subagent.
private struct AgentTitle: View {
    let agent: SessionMeta?

    var body: some View {
        VStack(spacing: 1) {
            Text(agent.map { $0.title.isEmpty ? "Subagent" : $0.title } ?? "Subagent")
                .font(.headline)
                .lineLimit(1)
            if let agent {
                Text(agent.agentType.label)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .accessibilityElement(children: .combine)
    }
}

/// The identity strip (the desktop detail's header): the mark, the meta
/// with its worktree and host, the figures (ticking only while live), the
/// activity line, the stats on their own line when there are any. A
/// hairline closes it.
private struct AgentIdentity: View {
    let agent: SessionMeta
    let thread: ThreadState
    var parentCwd: String?
    let environmentId: String

    var body: some View {
        let live = Fleet.isLive(agent.status)
        let emphasized = live || agent.status == .waiting || agent.status == .error || agent.status == .stopped
        let line = Fleet.line(status: agent.status, items: thread.fold.items, compacting: thread.fold.board.compacting, activity: agent.activity)
        let stats = Fleet.stats(items: thread.fold.items, tasks: agent.tasks, board: thread.fold.board, context: agent.context)
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .top, spacing: Layout.rowGap) {
                AgentStatusMark(status: agent.status, weight: emphasized ? .medium : .regular)
                    .padding(.top, 1)
                VStack(alignment: .leading, spacing: 3) {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        AgentMetaLine(agent: agent, branch: Fleet.branch(cwd: agent.cwd, parentCwd: parentCwd), environmentId: environmentId)
                        Spacer(minLength: 8)
                        if live {
                            TimelineView(.periodic(from: .now, by: 1)) { context in
                                AgentFigures(elapsedMs: Fleet.elapsedMs(agent, now: Int(context.date.timeIntervalSince1970 * 1000)), cost: thread.fold.board.cost)
                            }
                        } else {
                            AgentFigures(elapsedMs: Fleet.elapsedMs(agent, now: Int(Date.now.timeIntervalSince1970 * 1000)), cost: thread.fold.board.cost)
                        }
                    }
                    ActivityLine(line: line, live: live)
                    if !stats.isEmpty {
                        AgentStatsLine(stats: stats)
                    }
                }
            }
            .padding(.horizontal, Layout.textEdge)
            .padding(.vertical, 10)
            Hairline(inset: FleetLayout.textInset)
        }
        .background(Surface.background)
        .accessibilityElement(children: .combine)
    }
}

/// The one-line field under the transcript (the desktop detail's footer):
/// "Steer this agent…" while it runs, "Send to this agent…" once it is idle,
/// one filled button that sends. A stopped agent reads "Resume to send"
/// and a queued one "Starts when its turn comes", both off. While the key
/// cannot act or the host is away, the field carries the reason in place
/// of its placeholder: a read-only key or a halt at once, a dropped link
/// once it has stayed down past the composer's grace, so a blink of the
/// socket never flips the field. A failed send puts the text back with its
/// reason.
private struct AgentSendBar: View {
    let client: EnvironmentClient
    let agentId: String
    let session: SessionMeta?
    @State private var text = ""
    @State private var busy = false
    @State private var failure: String?
    @State private var sentCount = 0
    /// The block as the field shows it (see `settleBlock`).
    @State private var block: ActionBlock?
    @FocusState private var focused: Bool

    private var live: Bool { Fleet.isLive(session?.status) }
    private var trimmed: String { text.trimmingCharacters(in: .whitespacesAndNewlines) }

    /// Why the field is off, in the field's own words, or nil when it may send.
    private var held: String? {
        if let block { return block.text(now: Date().timeIntervalSince1970 * 1000) }
        switch session?.status {
        case .stopped?: return "Resume to send"
        case .queued?: return "Starts when its turn comes"
        case nil: return "Send to this agent…"
        default: return nil
        }
    }

    private var placeholder: String { held ?? (live ? "Steer this agent…" : "Send to this agent…") }
    private var enabled: Bool { held == nil && !busy && !trimmed.isEmpty }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .bottom, spacing: 8) {
                TextField(placeholder, text: $text, axis: .vertical)
                    .font(.body)
                    .lineLimit(1...4)
                    .focused($focused)
                    .disabled(held != nil)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 7)
                    .frame(minHeight: 36)
                    .background(Surface.chrome, in: RoundedRectangle.fieldCorner)
                    .hairlineBorder(RoundedRectangle.fieldCorner)
                    .onChange(of: text) { failure = nil }
                    .onSubmit { send() }
                    .accessibilityLabel(held ?? (live ? "Steer this agent" : "Send to this agent"))
                Button(action: send) {
                    ZStack {
                        Circle()
                            .fill(Color(.label))
                            .opacity(enabled ? 1 : 0.3)
                        Image(systemName: "arrow.up")
                            .font(.subheadline.weight(.bold))
                            .foregroundStyle(Color(.systemBackground))
                    }
                    .frame(width: 28, height: 28)
                    .contentShape(Circle())
                }
                .buttonStyle(.pressable)
                .disabled(!enabled)
                .animation(Motion.crossFade, value: enabled)
                .padding(.bottom, 4)
                .accessibilityLabel(live ? "Steer" : "Send")
            }
            if let failure {
                Text(failure)
                    .font(TextStep.meta.font)
                    .foregroundStyle(Tint.destructive)
                    .padding(.horizontal, 12)
                    .transition(.opacity)
            }
        }
        .padding(.horizontal, 12)
        .padding(.top, 6)
        .padding(.bottom, 8)
        .animation(Motion.crossFade, value: failure)
        .sensoryFeedback(.impact(weight: .light), trigger: sentCount)
        .task(id: client.operateBlock) { await settleBlock() }
    }

    /// The composer's rule: a read-only key or a halt shows at once; a
    /// dropped link only once it has stayed down past the grace.
    private func settleBlock() async {
        let now = client.operateBlock
        if now == nil || now?.isTransient == false {
            block = now
            return
        }
        if block != nil {
            block = now
            return
        }
        try? await Task.sleep(for: .milliseconds(ComposerBar.blockGraceMs))
        guard !Task.isCancelled else { return }
        block = client.operateBlock
    }

    private func send() {
        let body = trimmed
        guard !body.isEmpty, enabled else { return }
        busy = true
        text = ""
        sentCount += 1
        Task {
            defer { busy = false }
            do {
                try await client.send(agentId, text: body)
            } catch {
                // The text comes back so nothing typed is lost.
                text = body
                failure = (error as? ActionError)?.message ?? String(describing: error)
            }
        }
    }
}
