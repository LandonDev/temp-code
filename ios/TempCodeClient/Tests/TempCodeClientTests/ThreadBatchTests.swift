import Foundation
import Testing
import TempCodeContract
@testable import TempCodeClient

/// Mirrors src/renderer/src/lib/threadBatch.test.ts: the same roots, the same rules, the same words.
private let now = 1_000_000_000
private let old = now - ThreadBatch.archiveDoneAgeMs - 1
private let host = BatchScope.host(name: "the box")
private let project = BatchScope.project(id: "p1", name: "temp-code", cwd: "/repo/a")

private func meta(_ id: String, parentId: String? = nil, projectId: String? = "p1", workspaceId: String? = nil, cwd: String = "/wt/p1", status: SessionStatus = .idle, archived: Bool = false, updatedAt: Int = old, treeHasLiveWork: Bool? = nil, treeHasPaused: Bool? = nil, treeCanContinue: Bool? = nil, canContinue: Bool? = nil, masterId: String? = nil, activity: String? = nil, title: String? = nil) -> SessionMeta {
    SessionMeta(id: id, parentId: parentId, projectId: projectId, workspaceId: workspaceId, threadType: .chat, planPath: nil, provider: .claude, model: "claude-sonnet-5-5", reasoning: .low, agentType: .implementer, title: title ?? id, cwd: cwd, status: status, pinned: false, archived: archived, permission: .edits, fast: false, ultrafast: false, context1m: false, busySince: nil, pausedAt: nil, frozenActiveElapsed: nil, nativeId: nil, account: nil, activity: activity, activityKind: nil, tasks: nil, goal: nil, context: nil, canContinue: canContinue, treeCanContinue: treeCanContinue, treeHasLiveWork: treeHasLiveWork, treeHasPaused: treeHasPaused, treeFrozenActiveElapsed: nil, threadRules: nil, masterId: masterId, createdAt: 1, updatedAt: updatedAt)
}

private func selection(_ scope: BatchScope = host, seen: [String: SeenMark] = [:], floor: Int = now) -> BatchSelection {
    BatchSelection(scope: scope, seen: seen, floor: floor, now: now)
}

private func ids(_ action: BatchAction, _ metas: [SessionMeta], _ sel: BatchSelection = selection()) -> [String] {
    ThreadBatch.targets(action, metas, sel).map(\.id)
}

@Suite struct ThreadBatchRuleTests {
    @Test func `pause takes every root with a running turn, not a paused or archived one, never a subagent`() {
        let metas = [
            meta("running", status: .running),
            meta("starting", status: .starting),
            meta("waiting", status: .waiting),
            meta("idle-with-live-child", status: .idle, treeHasLiveWork: true),
            meta("paused", status: .paused),
            meta("watching", status: .watching),
            meta("archived", status: .running, archived: true),
            meta("child", parentId: "running", status: .running),
            meta("idle", status: .idle)
        ]
        #expect(ids(.pause, metas) == ["running", "starting", "waiting", "idle-with-live-child"])
        #expect(ThreadBatch.hasRunningTurn(meta("watching", status: .watching)) == false, "a watching master is not live by itself")
    }

    @Test func `stop takes the running turns and the queued roots`() {
        let metas = [meta("running", status: .running), meta("queued", status: .queued), meta("idle"), meta("paused", status: .paused)]
        #expect(ids(.stop, metas) == ["running", "queued"])
    }

    @Test func `resume takes paused trees and stopped threads`() {
        let metas = [
            meta("paused", status: .paused),
            meta("idle-with-paused-child", status: .idle, treeHasPaused: true),
            meta("stopped", status: .stopped),
            meta("running", status: .running),
            meta("queued", status: .queued)
        ]
        #expect(ids(.resume, metas) == ["paused", "idle-with-paused-child", "stopped"])
    }

    @Test func `archive done takes idle, read threads older than ten minutes with nothing pending`() {
        let seen: [String: SeenMark] = ["done": SeenMark(at: old, seq: 1), "unread": SeenMark(at: old - 1, seq: 1)]
        let metas = [
            meta("done", status: .done),
            meta("idle", status: .idle),
            meta("unread", status: .idle),
            meta("recent", status: .idle, updatedAt: now - 1000),
            meta("failed", status: .error),
            meta("waiting", status: .waiting),
            meta("paused-child", status: .idle, treeHasPaused: true),
            meta("live-child", status: .idle, treeHasLiveWork: true),
            meta("can-continue", status: .idle, canContinue: true),
            meta("tree-can-continue", status: .idle, treeCanContinue: true),
            meta("archived", status: .idle, archived: true)
        ]
        #expect(ids(.archiveDone, metas, selection(seen: seen)) == ["done", "idle"], "a thread with no seen entry counts as read up to the floor")
        #expect(ids(.archiveDone, metas, selection(seen: seen, floor: 0)) == ["done"], "below the floor it is unread")
    }

    @Test func `a queued thread: Pause and Resume leave it, Stop and Archive done take it`() {
        let metas = [meta("queued", status: .queued, updatedAt: now)]
        #expect(ids(.pause, metas).isEmpty)
        #expect(ids(.resume, metas).isEmpty)
        #expect(ids(.stop, metas) == ["queued"])
        #expect(ids(.archiveDone, metas) == ["queued"], "whatever its age or seen mark")
        #expect(ThreadBatch.isQueued(metas[0]))
    }

    @Test func `scope: project by id, the legacy cwd rule, host takes every root`() {
        let metas = [
            meta("in-project", status: .running),
            meta("other-project", projectId: "p2", status: .running),
            meta("legacy", projectId: nil, workspaceId: nil, cwd: "/repo/a/", status: .running),
            meta("loose", projectId: nil, workspaceId: "wa", cwd: "/repo/a", status: .running),
            meta("elsewhere", projectId: nil, workspaceId: nil, cwd: "/repo/b", status: .running)
        ]
        #expect(ids(.pause, metas, selection(project)) == ["in-project", "legacy"])
        #expect(ids(.pause, metas, selection(host)) == metas.map(\.id))
        #expect(ThreadBatch.inScope(meta("x", projectId: nil, workspaceId: nil, cwd: "/repo/a"), .project(id: "p1", name: "n", cwd: "/repo/a/")))
    }

    @Test func `counts has every action`() {
        let metas = [meta("running", status: .running), meta("paused", status: .paused), meta("done", status: .done), meta("queued", status: .queued)]
        let counts = ThreadBatch.counts(metas, selection())
        #expect(counts == [.pause: 1, .resume: 1, .stop: 2, .archiveDone: 2])
        #expect(Set(counts.keys) == Set(BatchAction.allCases))
    }

    @Test func `the menu rows: labels, symbols, which need a confirm, and the wire action`() {
        #expect(BatchAction.allCases.map(ThreadBatch.label) == ["Pause all", "Resume all", "Stop all", "Archive done"])
        #expect(BatchAction.allCases.map(ThreadBatch.symbol) == ["pause", "play", "stop", "archivebox"])
        #expect(BatchAction.allCases.map(ThreadBatch.needsConfirm) == [true, false, true, true])
        #expect(BatchAction.archiveDone.wire == .archive)
        #expect(BatchAction.pause.wire == .pause)
    }
}

@Suite struct ThreadBatchCopyTests {
    @Test func `the confirm names the count and the host`() {
        let copy = ThreadBatch.confirm(.pause, count: 15, scope: host)
        #expect(copy.title == "Pause 15 running threads on the box?")
        #expect(copy.body == "Each thread keeps its place and picks up where it was when you resume it.")
        #expect(copy.confirmLabel == "Pause 15")
        #expect(copy.danger == false)
        #expect(copy.cleanup == nil)
    }

    @Test func `stop and archive are dangerous, singular reads right, a project scope says in`() {
        let stop = ThreadBatch.confirm(.stop, count: 1, scope: project)
        #expect(stop.title == "Stop 1 running thread in temp-code?")
        #expect(stop.body == "Their turns end now. A stopped thread keeps its history and takes a new message.")
        #expect(stop.danger)
        #expect(stop.confirmLabel == "Stop 1")
        let archive = ThreadBatch.confirm(.archiveDone, count: 6, scope: project)
        #expect(archive.title == "Archive 6 finished threads in temp-code?")
        #expect(archive.body == "Idle for more than ten minutes, read, and waiting on nothing. Archived threads stay in the archive list.")
        #expect(archive.danger)
        #expect(archive.confirmLabel == "Archive 6")
    }

    @Test func `queued threads are removed from the queue, alone or beside the stopped ones`() {
        let mixed = ThreadBatch.confirm(.stop, count: 5, scope: host, queued: 2)
        #expect(mixed.title == "Stop 3 running threads and remove 2 from the queue on the box?")
        #expect(mixed.body.hasSuffix("A queued thread leaves the queue for the archive list."))
        #expect(mixed.confirmLabel == "Stop 5")
        let alone = ThreadBatch.confirm(.stop, count: 2, scope: host, queued: 2)
        #expect(alone.title == "Remove 2 threads from the queue on the box?")
        #expect(alone.body == "They have not started, so nothing is lost. Removed threads stay in the archive list.")
        #expect(alone.confirmLabel == "Remove 2")
        let one = ThreadBatch.confirm(.archiveDone, count: 1, scope: host, queued: 1)
        #expect(one.title == "Remove 1 thread from the queue on the box?")
        #expect(one.confirmLabel == "Remove 1")
        let archive = ThreadBatch.confirm(.archiveDone, count: 4, scope: host, queued: 1)
        #expect(archive.title == "Archive 3 finished threads and remove 1 from the queue on the box?")
        #expect(archive.body.hasSuffix("A queued thread leaves the queue with them."))
    }

    @Test func `the cleanup clause appears only for archive done with resources to release`() {
        #expect(ThreadBatch.confirm(.archiveDone, count: 6, scope: host, resources: 6).cleanup == "and remove their 6 worktrees and simulators")
        #expect(ThreadBatch.confirm(.archiveDone, count: 1, scope: host, resources: 1).cleanup == "and remove their 1 worktree or simulator")
        #expect(ThreadBatch.confirm(.archiveDone, count: 6, scope: host, resources: 0).cleanup == nil)
        #expect(ThreadBatch.confirm(.archiveDone, count: 6, scope: host, resources: nil).cleanup == nil)
        #expect(ThreadBatch.confirm(.stop, count: 6, scope: host, resources: 6).cleanup == nil)
    }

    @Test func `nothing to do says so and is never dangerous`() {
        let copy = ThreadBatch.confirm(.pause, count: 0, scope: host)
        #expect(copy.title == "Nothing to pause on the box")
        #expect(copy.body == "No running threads on the box right now.")
        #expect(copy.confirmLabel == "Pause")
        #expect(copy.danger == false)
        #expect(copy.cleanup == nil)
        #expect(ThreadBatch.confirm(.archiveDone, count: 0, scope: project).title == "Nothing to archive in temp-code")
    }

    @Test func `the toast counts the successes, then names the first failure on its own line`() {
        #expect(ThreadBatch.toast(.pause, succeeded: 14, failed: []).summary == "Paused 14")
        #expect(ThreadBatch.toast(.pause, succeeded: 14, failed: []).failureLine == nil)
        let one = ThreadBatch.toast(.pause, succeeded: 14, failed: [BatchFailure(sessionId: "a", title: "Search", error: "harness not responding")])
        #expect(one.headline == "Paused 14")
        #expect(one.failureLine == "1 failed: Search (harness not responding)")
        #expect(one.summary == "Paused 14. 1 failed: Search (harness not responding)", "VoiceOver reads the two lines as sentences")
        #expect(one.succeeded == 14)
        #expect(one.failed.count == 1)
        let three = ThreadBatch.toast(.archiveDone, succeeded: 2, failed: [
            BatchFailure(sessionId: "a", title: "Search", error: "x"),
            BatchFailure(sessionId: "b", title: "B", error: "y"),
            BatchFailure(sessionId: "c", title: "C", error: "z")
        ])
        #expect(three.headline == "Archived 2")
        #expect(three.failureLine == "3 failed: Search (x) and 2 more")
        #expect(ThreadBatch.toast(.resume, succeeded: 0, failed: []).summary == "Resumed 0")
        #expect(ThreadBatch.toast(.stop, succeeded: 1, failed: []).summary == "Stopped 1")
    }
}
