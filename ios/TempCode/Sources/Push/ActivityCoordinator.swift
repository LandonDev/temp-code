import ActivityKit
import Foundation
import Observation
import TempCodeClient
import TempCodeContract
import os

/// The Live Activity for a running thread the person started or is watching:
/// started here, its push token handed to the host (which updates it by push
/// while the phone is away), updated from the host's session metas while the
/// socket is up, ended when the thread goes idle, waiting or errored with
/// the final state showing briefly. One activity per thread. The state is
/// the host's (`activityState` in remote/push.ts): the title, the task in
/// progress, the tally, and why the thread waits.
@MainActor @Observable
final class ActivityCoordinator {
    /// The running activity's id per thread; the object itself is looked up when it is updated or ended.
    private var activities: [ThreadKey: String] = [:]
    /// The last shape applied per thread, so a meta that changes nothing the card shows costs nothing.
    private var shapes: [ThreadKey: ThreadActivityAttributes.ContentState.Shape] = [:]
    private var tokenTasks: [ThreadKey: Task<Void, Never>] = [:]
    private let log = Logger(subsystem: "dev.landon.tempcode", category: "activity")
    /// How long the final state stays on the lock screen.
    static let lingerSeconds: TimeInterval = 120

    /// What a thread's meta says the card shows: the host's own mapping (remote/push.ts `activityState`).
    /// `reason` is the needs-you line when the caller knows it (the fold of a loaded thread, or the state a push left).
    static func state(_ meta: SessionMeta, reason: String? = nil, now: Date = .now) -> ThreadActivityAttributes.ContentState {
        let phase: ThreadActivityAttributes.Phase = switch meta.status {
        // A queued thread runs nothing yet (return flow, thread 14): it ends an activity like a finished one.
        case .starting, .running, .watching: .working
        case .paused: .paused
        case .waiting: .waiting
        case .error: .failed
        default: .finished
        }
        let final = meta.archived ? ThreadActivityAttributes.Phase.finished : phase
        let tasks = meta.tasks
        let task = tasks?.current.flatMap { $0.isEmpty ? nil : $0 } ?? (final == .working ? meta.activity : nil)
        return .init(
            phase: final,
            since: meta.busySince ?? meta.updatedAt,
            ts: Int(now.timeIntervalSince1970 * 1000),
            title: meta.title,
            task: task.map { Self.oneLine($0, max: 120) },
            done: (tasks?.total ?? 0) > 0 ? tasks?.done : nil,
            total: (tasks?.total ?? 0) > 0 ? tasks?.total : nil,
            reason: final == .waiting ? reason.map { Self.oneLine($0, max: 160) } : nil
        )
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
                return "Asked: " + question.request.questions.map(\.question).joined(separator: " · ")
            default:
                continue
            }
        }
        return nil
    }

    private static func oneLine(_ text: String, max: Int) -> String {
        let flat = text.split(whereSeparator: \.isWhitespace).joined(separator: " ")
        return flat.count <= max ? flat : String(flat.prefix(max - 1)) + "…"
    }

    /// A thread has a live activity here: a foreground notice for it needs no banner.
    func isLive(_ key: ThreadKey) -> Bool { activities[key] != nil }

    /// Activities left by an earlier run: kept when their thread still runs on a connected host, ended otherwise.
    func reconcile(_ registry: ClientRegistry) {
        #if DEBUG
        if applyTestHooks() { return }
        #endif
        for activity in Activity<ThreadActivityAttributes>.activities {
            let key = ThreadKey(environmentId: activity.attributes.environmentId, sessionId: activity.attributes.sessionId)
            if let client = registry.client(key.environmentId), let session = client.session(key.sessionId), Self.state(session).phase.isLive, activities[key] == nil {
                adopt(activity, key: key, client: client, registry: registry)
            } else if activities[key] == nil {
                let id = activity.id
                Task { await Self.end(id: id, final: nil, linger: 0) }
            }
        }
    }

    /// The thread on screen runs: show it on the lock screen.
    func watch(_ client: EnvironmentClient, _ session: SessionMeta, registry: ClientRegistry) {
        guard Self.state(session).phase.isLive else { return }
        start(client, session, state: Self.state(session, reason: Self.reason(client, session)), registry: registry)
    }

    /// A turn just left the phone: the activity starts now, before the host says running.
    func sent(_ client: EnvironmentClient, _ session: SessionMeta, registry: ClientRegistry) {
        let now = Int(Date.now.timeIntervalSince1970 * 1000)
        let tasks = session.tasks
        start(client, session, state: .init(phase: .working, since: now, ts: now, title: session.title, done: (tasks?.total ?? 0) > 0 ? tasks?.done : nil, total: (tasks?.total ?? 0) > 0 ? tasks?.total : nil), registry: registry)
    }

    private func start(_ client: EnvironmentClient, _ session: SessionMeta, state: ThreadActivityAttributes.ContentState, registry: ClientRegistry) {
        let key = ThreadKey(environmentId: client.environment.id, sessionId: session.id)
        guard activities[key] == nil, ActivityAuthorizationInfo().areActivitiesEnabled else { return }
        let attributes = ThreadActivityAttributes(environmentId: key.environmentId, sessionId: key.sessionId, title: session.title, threadType: session.threadType ?? .chat)
        do {
            let activity = try Activity.request(attributes: attributes, content: ActivityContent(state: state, staleDate: nil), pushType: .token)
            shapes[key] = state.shape
            adopt(activity, key: key, client: client, registry: registry)
        } catch {
            log.error("could not start the activity: \(error.localizedDescription, privacy: .public)")
        }
    }

    private func adopt(_ activity: Activity<ThreadActivityAttributes>, key: ThreadKey, client: EnvironmentClient, registry: ClientRegistry) {
        activities[key] = activity.id
        log.notice("activity \(activity.id, privacy: .public) running for a thread")
        report()
        tokenTasks[key]?.cancel()
        tokenTasks[key] = Task { [weak self, weak registry] in
            // Every token Apple hands out for the activity goes to the host; it relays updates through the hub.
            for await data in activity.pushTokenUpdates {
                guard let self, let registry, !Task.isCancelled else { return }
                let hex = data.map { String(format: "%02x", $0) }.joined()
                await registry.push.setActivityToken(client, sessionId: key.sessionId, token: hex)
            }
        }
    }

    /// Session metas from a host: the thread's activity follows, and ends when the thread settles.
    func apply(_ client: EnvironmentClient, _ metas: [SessionMeta], registry: ClientRegistry) {
        for meta in metas {
            let key = ThreadKey(environmentId: client.environment.id, sessionId: meta.id)
            guard let id = activities[key] else { continue }
            // A waiting thread that is not loaded has no fold to read: a reason a push left stays.
            let reason = Self.reason(client, meta) ?? (meta.status == .waiting ? Self.currentState(id: id)?.reason : nil)
            let state = Self.state(meta, reason: reason)
            if state.phase.isLive {
                guard shapes[key] != state.shape else { continue }
                shapes[key] = state.shape
                Task { await Self.update(id: id, state: state) }
            } else {
                end(key, id: id, final: state, client: client, registry: registry)
            }
        }
    }

    private func end(_ key: ThreadKey, id: String, final: ThreadActivityAttributes.ContentState, client: EnvironmentClient, registry: ClientRegistry) {
        tokenTasks[key]?.cancel()
        tokenTasks[key] = nil
        activities[key] = nil
        shapes[key] = nil
        ended += 1
        log.notice("activity \(id, privacy: .public) ended as \(final.phase.rawValue, privacy: .public)")
        report()
        Task {
            await Self.end(id: id, final: final, linger: Self.lingerSeconds)
            await registry.push.setActivityToken(client, sessionId: key.sessionId, token: nil)
        }
    }

    private var ended = 0

    /// DEBUG: the proof reads how many activities ran and ended (Documents/activity-report.json).
    private func report() {
        #if DEBUG
        guard let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first,
              let data = try? JSONEncoder().encode(["active": activities.count, "ended": ended, "system": Activity<ThreadActivityAttributes>.activities.count]) else { return }
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
    /// `TC_TEST_ACTIVITY=<phase>[,notasks]` starts one activity with a host-shaped
    /// state and no host, so the lock screen and the island can be screenshotted in
    /// every phase; `TC_TEST_ACTIVITY_GALLERY=1` opens the gallery of every state
    /// over the app. Answers true when a hook ran, so the real reconcile is skipped.
    private func applyTestHooks() -> Bool {
        let env = ProcessInfo.processInfo.environment
        if env["TC_TEST_ACTIVITY_GALLERY"] == "1" {
            ActivityGallery.present()
            return true
        }
        guard let spec = env["TC_TEST_ACTIVITY"], !spec.isEmpty else { return false }
        let parts = spec.split(separator: ",").map(String.init)
        guard let phase = ThreadActivityAttributes.Phase(rawValue: parts[0]) else { return false }
        let state = ActivityGallery.sample(phase: phase, tasks: !parts.contains("notasks"))
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
