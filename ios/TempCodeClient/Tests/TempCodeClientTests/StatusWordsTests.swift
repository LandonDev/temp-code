import Foundation
import Testing
import TempCodeContract
@testable import TempCodeClient

private func meta(_ id: String, parentId: String? = nil, status: SessionStatus = .idle, archived: Bool = false, treeHasPaused: Bool? = nil, masterId: String? = nil, activity: String? = nil) -> SessionMeta {
    SessionMeta(id: id, parentId: parentId, projectId: "p1", workspaceId: nil, threadType: .chat, planPath: nil, provider: .claude, model: "claude-sonnet-5-5", reasoning: .low, agentType: .implementer, title: id, cwd: "/repo", status: status, pinned: false, archived: archived, permission: .edits, fast: false, ultrafast: false, context1m: false, busySince: nil, pausedAt: nil, frozenActiveElapsed: nil, nativeId: nil, account: nil, activity: activity, activityKind: nil, tasks: nil, goal: nil, context: nil, canContinue: nil, treeCanContinue: nil, treeHasLiveWork: nil, treeHasPaused: treeHasPaused, treeFrozenActiveElapsed: nil, threadRules: nil, masterId: masterId, createdAt: 1, updatedAt: 1)
}

@Suite struct StatusWordsTests {
    @Test func `a queued root's words are Queued, with the host's reason as the detail when it gave one`() {
        #expect(StatusWords.queuedLine(meta("q", status: .queued, activity: "Queued · waiting for Backfill the rollups (paused)")) == StripWords(title: "Queued", detail: "Waiting for Backfill the rollups (paused)"))
        #expect(StatusWords.queuedLine(meta("q", status: .queued, activity: nil)) == StripWords(title: "Queued"))
        #expect(StatusWords.queuedLine(meta("q", status: .queued, activity: "")) == StripWords(title: "Queued"))
        #expect(StatusWords.queuedLine(meta("q", status: .queued, activity: "Thinking")) == StripWords(title: "Queued"), "a stale activity line never shows on a queued row")
    }

    @Test func `the stopped line`() {
        #expect(StatusWords.stopped == StripWords(title: "Stopped", detail: "The harness is gone"))
        #expect(StatusWords.stoppedShort == "Stopped")
    }

    @Test func `the paused master counts the roots of its batch paused with it`() {
        let master = meta("m", status: .paused)
        let metas = [
            master,
            meta("a", status: .paused, masterId: "m"),
            meta("b", status: .idle, treeHasPaused: true, masterId: "m"),
            meta("running", status: .running, masterId: "m"),
            meta("archived", status: .paused, archived: true, masterId: "m"),
            meta("child", parentId: "a", status: .paused, masterId: "m"),
            meta("other", status: .paused, masterId: "n"),
            meta("loose", status: .paused)
        ]
        #expect(StatusWords.batchPaused(master: master, in: metas) == 2)
        #expect(StatusWords.batchPaused(master: meta("m", status: .idle, treeHasPaused: true), in: metas) == 2, "a master paused in its tree folds its batch too")
        #expect(StatusWords.batchPaused(master: meta("m", status: .running), in: metas) == 0, "zero when the master is not paused")
        #expect(StatusWords.batchPausedClause(master: master, in: metas) == ", and 2 batch threads with it")
    }

    @Test func `the batch clause: singular, plural, empty`() {
        #expect(StatusWords.batchPausedClause(count: 1) == ", and 1 batch thread with it")
        #expect(StatusWords.batchPausedClause(count: 3) == ", and 3 batch threads with it")
        #expect(StatusWords.batchPausedClause(count: 0) == "")
    }

    @Test func `the restart note`() {
        #expect(StatusWords.bootResume(count: 1) == "1 thread resumed after restart")
        #expect(StatusWords.bootResume(count: 7) == "7 threads resumed after restart")
    }
}
