import SwiftUI
import TempCodeClient
import TempCodeContract

/// The project plans' state per host and project (`projectPlan.get`), as
/// the Home chip reads it: loaded once per key, refreshed after every action
/// from the chip and when a thread of the project settles, asked again when
/// a host's socket reopens.
@MainActor @Observable
final class ProjectPlanStates {
    /// By `"<environmentId>/<projectId>"`; `.some(nil)` once asked and the project has no plan.
    private(set) var states: [String: ProjectPlanState?] = [:]
    @ObservationIgnored private var inflight: Set<String> = []

    static func key(_ environmentId: String, _ projectId: String) -> String {
        "\(environmentId)/\(projectId)"
    }

    /// `nil` until asked; `.some(nil)` when the project has no plan.
    func state(_ environmentId: String, _ projectId: String) -> ProjectPlanState?? {
        states[Self.key(environmentId, projectId)]
    }

    /// The first ask for a key; later calls are free while the answer is held.
    func load(_ client: EnvironmentClient, projectId: String) async {
        let key = Self.key(client.environment.id, projectId)
        guard states[key] == nil else { return }
        await fetch(client, projectId: projectId, key: key)
    }

    /// Asks again whatever is held.
    func refresh(_ client: EnvironmentClient, projectId: String) async {
        await fetch(client, projectId: projectId, key: Self.key(client.environment.id, projectId))
    }

    func set(_ client: EnvironmentClient, projectId: String, _ state: ProjectPlanState?) {
        states[Self.key(client.environment.id, projectId)] = .some(state)
    }

    private func fetch(_ client: EnvironmentClient, projectId: String, key: String) async {
        guard !inflight.contains(key) else { return }
        inflight.insert(key)
        defer { inflight.remove(key) }
        do {
            let state = try await client.request(Methods.ProjectPlanGet.self, .init(projectId: projectId))
            states[key] = .some(state)
        } catch {
            // An older host, or the link is down: the chip stays as it was.
        }
    }
}

extension ThreadCaches {
    /// The project plans' store; one per process.
    static let projectPlans = ProjectPlanStates()
}

/// The project header's plan chip on Home: "Plan", or the count "3/7" beside its flag once the
/// plan is kept as the project's. Opens the thread that wrote the plan; a
/// long press holds the options card's four options. Nothing until the
/// state is loaded, and nothing for a project with no plan file and no plan
/// thread.
struct ProjectPlanChip: View {
    let client: EnvironmentClient
    let project: ProjectMeta

    @Environment(NavigationRouter.self) private var router
    @State private var model = ProjectPlanModel()
    @State private var sheet: MilestoneStartTarget?
    @State private var revising = false
    /// A refusal from the menu's actions; the chip has no footer, so it alerts.
    @State private var failure: String?
    @ScaledMetric(relativeTo: .caption2) private var height: CGFloat = 28
    /// In the project screen's bar the system draws the label; in the row it is the capsule.
    @Environment(\.inBar) private var inBar

    private var states: ProjectPlanStates { ThreadCaches.projectPlans }
    private var state: ProjectPlanState? { states.state(client.environment.id, project.id) ?? nil }

    /// The plan thread, when this host lists it (archived threads may not be here).
    private var plan: SessionMeta? {
        state?.sessionId.flatMap { client.session($0) }
    }

    /// The first milestone not ticked, from the state's own list.
    private var next: ProjectPlanMilestone? {
        state?.milestones.first { !$0.done }
    }

    /// The statuses of the project's root threads that move the plan: the
    /// plan thread (plan_complete at the end of its turn) and every build
    /// (a landed one ticks the file).
    private var settled: [String: SessionStatus] {
        var out: [String: SessionStatus] = [:]
        for session in client.sessions where session.projectId == project.id && session.parentId == nil {
            switch session.threadType {
            case .projectPlan?, .implementation?, .orchestration?: out[session.id] = session.status
            default: break
            }
        }
        return out
    }

    var body: some View {
        // A ZStack, not a Group: the task below must run while the chip draws nothing yet.
        ZStack {
            if let state, state.exists || state.sessionId != nil {
                chip(state)
            }
        }
        .task(id: project.id) { await states.load(client, projectId: project.id) }
        .onChange(of: client.status.transport) { _, transport in
            // A reconnect asks again, keeping the chip drawn meanwhile.
            guard transport == .open else { return }
            Task { await states.refresh(client, projectId: project.id) }
        }
        .onChange(of: settled) { before, now in
            let settledNow: (SessionStatus?) -> Bool = { $0 == .idle || $0 == .done }
            let moved = now.contains { id, status in settledNow(status) && !settledNow(before[id]) && before[id] != nil }
            guard moved else { return }
            Task { await states.refresh(client, projectId: project.id) }
        }
    }

    @ViewBuilder
    private func chip(_ state: ProjectPlanState) -> some View {
        let done = state.milestones.filter(\.done).count
        let total = state.milestones.count
        let text = ProjectPlan.chipText(done: done, total: total, pinned: state.pinned)
        let accessibility = total > 0 ? "Project plan, \(done) of \(total) milestones done" : "Project plan"
        let label = Group {
            if inBar {
                // A bar item with a symbol: the vertical rail leaves a title-only item out.
                Label(text, systemImage: "flag.checkered")
                    .numeric(done)
            } else {
                HStack(spacing: 4) {
                    Image(systemName: "flag.checkered")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(Tint.violet)
                    Text(text)
                        .textStep(.stamp)
                        .numeric(done)
                }
                .padding(.horizontal, 8)
                .frame(height: height)
                .background(Surface.fill, in: Capsule())
                .frame(minHeight: Layout.rowHeight)
                .contentShape(Rectangle())
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibility)

        // A Button through the router, not a NavigationLink: a link inside a
        // List row turns the row into a link cell and takes its other buttons' taps.
        Group {
            if let sessionId = state.sessionId, inBar {
                Button { open(sessionId) } label: { label }
            } else if let sessionId = state.sessionId {
                Button { open(sessionId) } label: { label }
                    .buttonStyle(.pressable)
            } else {
                label
            }
        }
        .contextMenu { options(state) }
        .sheet(item: $sheet) { target in
            if let plan {
                MilestoneStartSheet(client: client, plan: plan, milestone: target.milestone, kind: target.kind) { built, linkError in
                    Task { await states.refresh(client, projectId: project.id) }
                    failure = linkError
                    open(built.id)
                }
            }
        }
        .reviseAlert(isPresented: $revising) { ask in
            guard let sessionId = state.sessionId else { return }
            Task {
                await model.revise(client, sessionId: sessionId, ask: ask)
                failure = model.error
                await states.refresh(client, projectId: project.id)
            }
        }
        .alert(failure ?? "", isPresented: Binding(get: { failure != nil }, set: { if !$0 { failure = nil } })) {
            Button("OK", role: .cancel) {}
        }
    }

    /// The Home stack pushes the thread the way a notification tap does.
    private func open(_ sessionId: String) {
        router.pending = .thread(environmentId: client.environment.id, sessionId: sessionId, seq: nil)
    }

    /// The options card's four options, as menu rows. A read key reads why
    /// first and the rows that need operate are off.
    @ViewBuilder
    private func options(_ state: ProjectPlanState) -> some View {
        let blocked = client.operateBlock?.text(now: Date().timeIntervalSince1970 * 1000)
        if let blocked {
            Button(blocked) {}
                .disabled(true)
            Divider()
        }
        let locked = blocked != nil || model.busy != nil
        Button {
            start(.planning, state)
        } label: {
            Label(next.map { "Plan the next milestone: \($0.index). \($0.title)" } ?? "Plan the next milestone", systemImage: "map")
        }
        .disabled(locked || next == nil || plan == nil)
        Button {
            start(.orchestration, state)
        } label: {
            Label(next.map { "Start an orchestration thread for milestone \($0.index)" } ?? "Start an orchestration thread", systemImage: "arrow.triangle.branch")
        }
        .disabled(locked || next == nil || plan == nil)
        Button {
            revising = true
        } label: {
            Label("Revise the plan", systemImage: "pencil")
        }
        .disabled(locked || state.sessionId == nil)
        Button {
            model.adopt(state)
            Task {
                await model.pin(client, projectId: project.id)
                failure = model.error
            }
        } label: {
            Label(state.pinned ? "Stop keeping as the project's plan" : "Keep as the project's plan", systemImage: state.pinned ? "pin.slash" : "pin")
        }
        .disabled(locked)
    }

    /// The sheet shows scope and done-when: read the file once, as the
    /// state carries only index, title and done.
    private func start(_ kind: ThreadDraft.MilestoneKind, _ state: ProjectPlanState) {
        guard let next else { return }
        Task {
            let text = try? await client.request(Methods.FileRead.self, .init(path: state.path))
            let milestone = text.flatMap { $0 }.flatMap { ProjectPlan.milestone(next.index, in: $0) }
                ?? ProjectPlan.Milestone(index: next.index, title: next.title, done: next.done)
            sheet = MilestoneStartTarget(kind: kind, milestone: milestone)
        }
    }
}
