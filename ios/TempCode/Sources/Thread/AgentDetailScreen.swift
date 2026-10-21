import SwiftUI
import TempCodeClient
import TempCodeContract

/// A subagent's detail (the desktop's AgentDetail): its identity under the
/// bar, its own transcript, and one line at the bottom that steers it while
/// it runs or sends when it is idle. A waiting agent's approval or question
/// card sits at the end of its transcript, where the screen opens. Pushed
/// from any fleet row.
struct AgentDetailScreen: View {
    let client: EnvironmentClient
    let agentId: String
    var parentCwd: String?
    @Environment(NavigationRouter.self) private var router

    var body: some View {
        let session = client.session(agentId)
        let thread = client.threads[agentId] ?? ThreadState()
        VStack(spacing: 0) {
            StatusLine(client: client)
            if let session {
                AgentIdentity(agent: session, thread: thread, parentCwd: parentCwd)
            }
            TranscriptView(client: client, sessionId: agentId, thread: thread)
        }
        .background(Surface.background)
        .safeAreaInset(edge: .bottom, spacing: 0) {
            AgentSendBar(client: client, agentId: agentId, session: session)
        }
        .toolbar {
            ToolbarItem(placement: .principal) {
                AgentTitle(agent: session)
            }
        }
        .toolbar(.hidden, for: .tabBar)
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(Surface.background, for: .navigationBar)
        .toolbarBackground(.visible, for: .navigationBar)
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

/// The identity strip (the desktop detail's header): the mark and the
/// agent's state in words, the meta with its worktree, and the figures;
/// the stats on their own line when there are any. A hairline closes it.
private struct AgentIdentity: View {
    let agent: SessionMeta
    let thread: ThreadState
    var parentCwd: String?

    var body: some View {
        let live = Fleet.isLive(agent.status)
        let line = Fleet.line(status: agent.status, items: thread.fold.items, compacting: thread.fold.board.compacting)
        let stats = Fleet.stats(items: thread.fold.items, tasks: agent.tasks, board: thread.fold.board, context: agent.context)
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .top, spacing: 12) {
                AgentStatusMark(status: agent.status)
                    .padding(.top, 2)
                VStack(alignment: .leading, spacing: 3) {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        AgentMetaLine(agent: agent, branch: Fleet.branch(cwd: agent.cwd, parentCwd: parentCwd))
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
            .padding(.horizontal, 16)
            .padding(.top, 10)
            .padding(.bottom, 10)
            Hairline()
                .padding(.leading, 44)
        }
        .background(Surface.background)
        .accessibilityElement(children: .combine)
    }
}

/// The one-line field under the transcript (the desktop detail's footer):
/// Steer this agent… while it runs, Send to this agent… once it is idle,
/// one filled button that sends. While the key cannot act or the host is
/// away, the field carries the reason in place of its placeholder.
private struct AgentSendBar: View {
    let client: EnvironmentClient
    let agentId: String
    let session: SessionMeta?
    @State private var text = ""
    @State private var busy = false
    @State private var failure: String?
    @State private var sentCount = 0
    @FocusState private var focused: Bool
    @Environment(\.displayScale) private var scale
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var live: Bool { Fleet.isLive(session?.status) }
    private var trimmed: String { text.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var block: ActionBlock? {
        guard let block = client.operateBlock, !block.isTransient else { return nil }
        return block
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .bottom, spacing: 8) {
                TextField(placeholder, text: $text, axis: .vertical)
                    .font(.body)
                    .lineLimit(1...4)
                    .focused($focused)
                    .disabled(block != nil || session == nil)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 7)
                    .frame(minHeight: 36)
                    .background(Surface.chrome, in: RoundedRectangle(cornerRadius: Radius.field, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: Radius.field, style: .continuous).strokeBorder(Surface.hairline, lineWidth: 1 / scale))
                    .onChange(of: text) { failure = nil }
                    .onSubmit(send)
                    .accessibilityLabel(block.map { $0.text(now: Date().timeIntervalSince1970 * 1000) } ?? (live ? "Steer this agent" : "Send to this agent"))
                Button(action: send) {
                    ZStack {
                        Circle()
                            .fill(Color.primary)
                            .opacity(enabled ? 1 : 0.3)
                        Image(systemName: "arrow.up")
                            .font(.system(size: 14, weight: .bold))
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
                    .font(.footnote)
                    .foregroundStyle(Tint.destructive)
                    .padding(.horizontal, 12)
                    .transition(.opacity)
            }
        }
        .padding(.horizontal, 12)
        .padding(.top, 6)
        .padding(.bottom, 8)
        .background(.bar)
        .animation(Motion.crossFade, value: failure)
        .animation(Motion.crossFade, value: placeholder)
        .sensoryFeedback(.impact(weight: .light), trigger: sentCount)
    }

    private var enabled: Bool { block == nil && session != nil && !busy && !trimmed.isEmpty }

    private var placeholder: String {
        if let block { return block.text(now: Date().timeIntervalSince1970 * 1000) }
        return live ? "Steer this agent…" : "Send to this agent…"
    }

    private func send() {
        let body = trimmed
        guard !body.isEmpty, !busy, block == nil else { return }
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
