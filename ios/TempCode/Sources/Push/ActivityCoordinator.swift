import ActivityKit
import Foundation
import Observation
import TempCodeClient
import TempCodeContract
import os

/// The Live Activity for the threads the person started or is watching:
/// ONE per host. The first thread starts it with today's single-thread card;
/// a second thread on the same host joins it instead of stacking a second
/// activity, and from then on it is a group card (`ThreadActivityContent
/// .threads`) listing every thread it covers, needs-you first. Its push
/// token is handed to the host for every thread it covers (the host sees one
/// token on several threads and pushes the group's state, remote/push.ts
/// `activityGroupState`); while the socket is up the app updates it from the
/// session metas itself, by the same rules (`ThreadActivityGroup`). It ends
/// when nothing it covers works or is paused, with the final state showing
/// briefly. A queued thread (created, not yet booted) never starts or keeps
/// one: a turn sent into it is remembered and it joins when the host says it
/// runs.
@MainActor @Observable
final class ActivityCoordinator {
    /// A host's activity: its id, the threads it covers in the order they joined, and its push token once Apple gave one.
    private struct HostActivity {
        var id: String
        var members: [String]
        var token: String?
    }

    private var hosts: [String: HostActivity] = [:]
    /// The last shape applied per host, so a meta that changes nothing the card shows costs nothing.
    private var shapes: [String: ThreadActivityAttributes.ContentState.Shape] = [:]
    /// Threads the person sent into while they were queued: they join when their meta turns live.
    private var sentInto: Set<ThreadKey> = []
    /// Threads a turn just left for, drawn working until their meta catches up.
    private var justSent: Set<ThreadKey> = []
    private var tokenTasks: [String: Task<Void, Never>] = [:]
    private let log = Logger(subsystem: "dev.landon.tempcode", category: "activity")
    /// How long the final state stays on the lock screen.
    static let lingerSeconds: TimeInterval = 120

    /// A master's batch as the host counts it: children done of total and the engine's running step.
    /// The client package does not decode the `batch` push on this master, so callers pass nil today and
    /// a master's card keeps the tally the host last pushed (`apply`).
    struct BatchTally: Sendable, Hashable {
        var done: Int
        var total: Int
        var step: String?
    }

    /// What a thread's meta says the card shows: the host's own mapping (remote/push.ts `activityState`).
    /// `reason` is the needs-you line when the caller knows it (the fold of a loaded thread, or the state a push left).
    /// Nil for a queued thread: it is not live and has no card.
    static func state(_ meta: SessionMeta, reason: String? = nil, batch: BatchTally? = nil, now: Date = .now) -> ThreadActivityAttributes.ContentState? {
        let phase: ThreadActivityAttributes.Phase? = switch meta.status {
        case .starting, .running, .watching: .working
        case .paused: .paused
        case .waiting: .waiting
        case .error: .failed
        case .stopped: .stopped
        case .queued: nil
        default: .finished
        }
        guard let phase else { return nil }
        let final = meta.archived ? ThreadActivityAttributes.Phase.finished : phase
        var state = ThreadActivityAttributes.ContentState(
            phase: final,
            since: meta.busySince ?? meta.updatedAt,
            ts: Int(now.timeIntervalSince1970 * 1000),
            title: meta.title,
            reason: final == .waiting ? reason.map { Self.oneLine($0, max: 160) } : nil
        )
        if let batch {
            let open = batch.total - batch.done
            state.task = Self.oneLine(batch.step ?? "Waiting on \(open) \(open == 1 ? "thread" : "threads")", max: 120)
            state.done = batch.done
            state.total = batch.total
            state.unit = .threads
        } else {
            let tasks = meta.tasks
            let task = tasks?.current.flatMap { $0.isEmpty ? nil : $0 } ?? (final == .working ? meta.activity : nil)
            state.task = task.map { Self.oneLine($0, max: 120) }
            state.done = (tasks?.total ?? 0) > 0 ? tasks?.done : nil
            state.total = (tasks?.total ?? 0) > 0 ? tasks?.total : nil
        }
        return state
    }

    /// The needs-you line of a waiting thread, from its fold when the thread is loaded: the latest undecided approval or unanswered question.
    static func reason(_ client: EnvironmentClient, _ meta: SessionMeta) -> String? {
        guard meta.status == .waiting, let fold = client.threads[meta.id]?.fold else { return nil }
        for entry in fold.items.reversed() {
            switch entry.item {
            case .approval(let approval) where approval.allowed == nil:
                let request = approval.request
                if request.toolName == "ExitPlanMode" || request.toolName == "exit_plan_mode" { return "Plan ready to approve" }
                let face = request.title.map { "\(request.toolName) — \($0)" } ?? request.toolName
                return "Needs approval: \(face)"
            case .question(let question) where !question.resolved:
                let asked = question.request.questions.map(\.question)
                return "Asked: " + (asked.first ?? "") + (asked.count > 1 ? " and \(asked.count - 1) more" : "")
            default:
                continue
            }
        }
        return nil
    }

    private static func oneLine(_ text: String, max: Int) -> String { ThreadActivityText.cut(text, max) }

    /// A thread has a live activity here: a foreground notice for it needs no banner.
    func isLive(_ key: ThreadKey) -> Bool { hosts[key.environmentId]?.members.contains(key.sessionId) == true }

    /// Activities left by an earlier run: one per host is kept when a thread it covers still runs on a
    /// connected host (an earlier build's second activity on that host is folded into it), the rest end.
    func reconcile(_ registry: ClientRegistry) {
        #if DEBUG
        if applyTestHooks() { return }
        #endif
        for activity in Activity<ThreadActivityAttributes>.activities {
            let environmentId = activity.attributes.environmentId
            guard hosts[environmentId]?.id != activity.id else { continue }
            let covered = activity.content.state.threads?.map(\.id) ?? [activity.attributes.sessionId]
            guard let client = registry.client(environmentId),
                  covered.contains(where: { client.session($0).flatMap { Self.state($0) }?.phase.isLive == true }) else {
                let id = activity.id
                Task { await Self.end(id: id, final: nil, linger: 0) }
                continue
            }
            if var host = hosts[environmentId] {
                host.members += covered.filter { !host.members.contains($0) }
                hosts[environmentId] = host
                let id = activity.id
                Task { await Self.end(id: id, final: nil, linger: 0) }
                registerToken(client, registry: registry)
                refresh(client, registry: registry)
            } else {
                hosts[environmentId] = HostActivity(id: activity.id, members: covered)
                adopt(activity, client: client, registry: registry)
                refresh(client, registry: registry)
            }
        }
    }

    /// The thread on screen runs: show it on the lock screen. A queued thread has no card yet.
    func watch(_ client: EnvironmentClient, _ session: SessionMeta, registry: ClientRegistry) {
        guard let state = Self.state(session, reason: Self.reason(client, session)), state.phase.isLive else { return }
        follow(client, session, state: state, registry: registry)
    }

    /// A turn just left the phone: the thread shows working now, before the host says running.
    /// Into a queued thread it joins later, when the host boots it (`apply`).
    func sent(_ client: EnvironmentClient, _ session: SessionMeta, registry: ClientRegistry) {
        let key = ThreadKey(environmentId: client.environment.id, sessionId: session.id)
        if session.status == .queued {
            sentInto.insert(key)
            return
        }
        justSent.insert(key)
        let now = Int(Date.now.timeIntervalSince1970 * 1000)
        let tasks = session.tasks
        follow(client, session, state: .init(phase: .working, since: now, ts: now, title: session.title, done: (tasks?.total ?? 0) > 0 ? tasks?.done : nil, total: (tasks?.total ?? 0) > 0 ? tasks?.total : nil), registry: registry)
    }

    /// The host's activity takes the thread: started with it when there is none, joined otherwise.
    private func follow(_ client: EnvironmentClient, _ session: SessionMeta, state: ThreadActivityAttributes.ContentState, registry: ClientRegistry) {
        let environmentId = client.environment.id
        guard var host = hosts[environmentId] else {
            start(client, session, state: state, registry: registry)
            return
        }
        guard !host.members.contains(session.id) else { return }
        host.members.append(session.id)
        hosts[environmentId] = host
        if let token = host.token {
            Task { await registry.push.setActivityToken(client, sessionId: session.id, token: token) }
        }
        refresh(client, registry: registry)
    }

    private func start(_ client: EnvironmentClient, _ session: SessionMeta, state: ThreadActivityAttributes.ContentState, registry: ClientRegistry) {
        let environmentId = client.environment.id
        guard hosts[environmentId] == nil, ActivityAuthorizationInfo().areActivitiesEnabled else { return }
        let attributes = ThreadActivityAttributes(environmentId: environmentId, sessionId: session.id, title: session.title, threadType: session.threadType ?? .chat)
        do {
            let activity = try Activity.request(attributes: attributes, content: ActivityContent(state: state, staleDate: nil), pushType: .token)
            hosts[environmentId] = HostActivity(id: activity.id, members: [session.id])
            shapes[environmentId] = state.shape
            adopt(activity, client: client, registry: registry)
        } catch {
            log.error("could not start the activity: \(error.localizedDescription, privacy: .public)")
        }
    }

    private func adopt(_ activity: Activity<ThreadActivityAttributes>, client: EnvironmentClient, registry: ClientRegistry) {
        let environmentId = client.environment.id
        log.notice("activity \(activity.id, privacy: .public) running for a host")
        report()
        tokenTasks[environmentId]?.cancel()
        tokenTasks[environmentId] = Task { [weak self, weak registry] in
            // Every token Apple hands out goes to the host, once for each thread the activity covers.
            for await data in activity.pushTokenUpdates {
                guard let self, let registry, !Task.isCancelled else { return }
                self.hosts[environmentId]?.token = data.map { String(format: "%02x", $0) }.joined()
                self.registerToken(client, registry: registry)
            }
        }
    }

    private func registerToken(_ client: EnvironmentClient, registry: ClientRegistry) {
        guard let host = hosts[client.environment.id], let token = host.token else { return }
        Task {
            for member in host.members { await registry.push.setActivityToken(client, sessionId: member, token: token) }
        }
    }

    /// Session metas from a host: its activity follows the threads it covers and ends when none works
    /// or is paused. A thread the person sent into while queued joins the moment its meta turns live.
    func apply(_ client: EnvironmentClient, _ metas: [SessionMeta], registry: ClientRegistry) {
        let environmentId = client.environment.id
        for meta in metas {
            let key = ThreadKey(environmentId: environmentId, sessionId: meta.id)
            if meta.status != .queued, meta.status != .idle, meta.status != .done { justSent.remove(key) }
            guard sentInto.contains(key), let state = Self.state(meta) else { continue }
            // Sent into while queued: it joins when the host boots it; a thread that left the queue any other way is forgotten.
            sentInto.remove(key)
            if state.phase.isLive { follow(client, meta, state: state, registry: registry) }
        }
        guard let host = hosts[environmentId], metas.contains(where: { host.members.contains($0.id) }) else { return }
        refresh(client, registry: registry)
    }

    /// Recomputes the host's card from its threads' metas: a thread's own state while it is the only one,
    /// the group's rows from the second on; updates it when the shape moved, ends it when nothing runs.
    private func refresh(_ client: EnvironmentClient, registry: ClientRegistry) {
        let environmentId = client.environment.id
        guard let host = hosts[environmentId] else { return }
        let current = Self.currentState(id: host.id)
        let next: ThreadActivityAttributes.ContentState?
        if host.members.count == 1, current?.threads == nil {
            next = live(client, sessionId: host.members[0], keep: current)
        } else {
            let now = Int(Date.now.timeIntervalSince1970 * 1000)
            let rows = host.members.enumerated().compactMap { index, id in row(client, sessionId: id, current: current, first: index == 0) }
            next = ThreadActivityGroup.state(rows: rows, now: now)
        }
        guard let next else {
            // Nothing it covers runs any more (a queued thread runs nothing): it ends like a finished one.
            var final = current ?? .init(phase: .finished, since: Int(Date.now.timeIntervalSince1970 * 1000), ts: 0)
            final.phase = .finished
            final.ts = Int(Date.now.timeIntervalSince1970 * 1000)
            end(client, final: final, registry: registry)
            return
        }
        if next.phase.isLive {
            guard shapes[environmentId] != next.shape else { return }
            shapes[environmentId] = next.shape
            let id = host.id
            Task { await Self.update(id: id, state: next) }
        } else {
            end(client, final: next, registry: registry)
        }
    }

    /// One thread's state, as the host computes it, with what the app cannot see kept from the card:
    /// a waiting thread's reason a push left, and a master's batch tally (the client does not decode the batch push).
    private func live(_ client: EnvironmentClient, sessionId: String, keep current: ThreadActivityAttributes.ContentState?) -> ThreadActivityAttributes.ContentState? {
        guard let meta = client.session(sessionId), var state = Self.state(meta, reason: Self.reason(client, meta)) else { return nil }
        let key = ThreadKey(environmentId: client.environment.id, sessionId: sessionId)
        if justSent.contains(key), state.phase.isSettled {
            let now = Int(Date.now.timeIntervalSince1970 * 1000)
            state.phase = .working
            state.since = now
        }
        if state.phase == .waiting, state.reason == nil { state.reason = current?.reason }
        if meta.isMaster == true, let current, current.unit == .threads {
            state.task = current.task
            state.done = current.done
            state.total = current.total
            state.unit = current.unit
        }
        return state
    }

    /// A thread's row on the group card. What it keeps comes from its own row, or, the moment the card
    /// turns into a group, from the single state when that was this thread's.
    private func row(_ client: EnvironmentClient, sessionId: String, current: ThreadActivityAttributes.ContentState?, first: Bool) -> ThreadActivityRow? {
        guard let meta = client.session(sessionId), meta.parentId == nil else { return nil }
        let before: ThreadActivityAttributes.ContentState?
        if let current, let rows = current.threads {
            before = rows.first(where: { $0.id == sessionId }).map { current.state(of: $0) }
        } else {
            before = first ? current : nil
        }
        guard let state = live(client, sessionId: sessionId, keep: before) else { return nil }
        return ThreadActivityRow(id: sessionId, type: meta.threadType?.rawValue, state: state, updatedAt: meta.updatedAt)
    }

    private func end(_ client: EnvironmentClient, final: ThreadActivityAttributes.ContentState, registry: ClientRegistry) {
        let environmentId = client.environment.id
        guard let host = hosts.removeValue(forKey: environmentId) else { return }
        tokenTasks.removeValue(forKey: environmentId)?.cancel()
        shapes[environmentId] = nil
        for member in host.members {
            let key = ThreadKey(environmentId: environmentId, sessionId: member)
            sentInto.remove(key)
            justSent.remove(key)
        }
        ended += 1
        log.notice("activity \(host.id, privacy: .public) ended as \(final.phase.rawValue, privacy: .public)")
        report()
        let id = host.id
        Task {
            await Self.end(id: id, final: final, linger: Self.lingerSeconds)
            for member in host.members { await registry.push.setActivityToken(client, sessionId: member, token: nil) }
        }
    }

    private var ended = 0

    /// DEBUG: the proof reads how many activities ran and ended (Documents/activity-report.json).
    private func report() {
        #if DEBUG
        guard let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first,
              let data = try? JSONEncoder().encode(["active": hosts.count, "ended": ended, "system": Activity<ThreadActivityAttributes>.activities.count]) else { return }
        try? data.write(to: documents.appending(path: "activity-report.json"), options: .atomic)
        #endif
    }

    // ActivityKit's calls take the activity found by id here, off the main actor.
    nonisolated private static func currentState(id: String) -> ThreadActivityAttributes.ContentState? {
        Activity<ThreadActivityAttributes>.activities.first(where: { $0.id == id })?.content.state
    }

    nonisolated private static func update(id: String, state: ThreadActivityAttributes.ContentState) async {
        guard let activity = Activity<ThreadActivityAttributes>.activities.first(where: { $0.id == id }) else { return }
        await activity.update(ActivityContent(state: state, staleDate: nil))
    }

    nonisolated private static func end(id: String, final: ThreadActivityAttributes.ContentState?, linger: TimeInterval) async {
        guard let activity = Activity<ThreadActivityAttributes>.activities.first(where: { $0.id == id }) else { return }
        let content = final.map { ActivityContent(state: $0, staleDate: nil) }
        await activity.end(content, dismissalPolicy: linger > 0 ? .after(.now.addingTimeInterval(linger)) : .immediate)
    }

    // MARK: - DEBUG hooks for the simulator proof

    #if DEBUG
    /// `TC_TEST_ACTIVITY=<phase>[,notasks][,threads][,group]` starts one activity with a
    /// host-shaped state and no host, so the lock screen and the island can be
    /// screenshotted in every phase (`threads`: a master's batch tally; `group`:
    /// four threads of one host, settled when the phase is);
    /// `TC_TEST_ACTIVITY_GALLERY=1` opens the gallery of every state over the app.
    /// Answers true when a hook ran, so the real reconcile is skipped.
    private func applyTestHooks() -> Bool {
        let env = ProcessInfo.processInfo.environment
        if let gallery = env["TC_TEST_ACTIVITY_GALLERY"], gallery == "1" || ThreadActivityAttributes.Phase(rawValue: gallery) != nil {
            ActivityGallery.present()
            return true
        }
        guard let spec = env["TC_TEST_ACTIVITY"], !spec.isEmpty else { return false }
        let parts = spec.split(separator: ",").map(String.init)
        guard let first = parts.first, let phase = ThreadActivityAttributes.Phase(rawValue: first) else { return false }
        let state = parts.contains("group")
            ? ActivityGallery.groupSample(settled: phase.isSettled)
            : ActivityGallery.sample(phase: phase, tasks: !parts.contains("notasks"), threads: parts.contains("threads"))
        for activity in Activity<ThreadActivityAttributes>.activities {
            let id = activity.id
            Task { await Self.end(id: id, final: nil, linger: 0) }
        }
        guard ActivityAuthorizationInfo().areActivitiesEnabled else { return true }
        do {
            let activity = try Activity.request(attributes: ActivityGallery.attributes, content: ActivityContent(state: state, staleDate: nil), pushType: nil)
            log.notice("test activity \(activity.id, privacy: .public) in \(phase.rawValue, privacy: .public)")
        } catch {
            log.error("could not start the test activity: \(error.localizedDescription, privacy: .public)")
        }
        return true
    }
    #endif
}
