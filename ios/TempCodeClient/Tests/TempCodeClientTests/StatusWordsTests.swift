import Foundation
import Testing
import TempCodeContract
@testable import TempCodeClient

private func meta(_ id: String, parentId: String? = nil, status: SessionStatus = .idle, archived: Bool = false, treeHasPaused: Bool? = nil, masterId: String? = nil, activity: String? = nil, statusDetail: String? = nil) -> SessionMeta {
    SessionMeta(id: id, parentId: parentId, projectId: "p1", workspaceId: nil, threadType: .chat, planPath: nil, provider: .claude, model: "claude-sonnet-5-5", reasoning: .low, agentType: .implementer, title: id, cwd: "/repo", status: status, pinned: false, archived: archived, permission: .edits, fast: false, ultrafast: false, context1m: false, busySince: nil, pausedAt: nil, frozenActiveElapsed: nil, nativeId: nil, account: nil, activity: activity, statusDetail: statusDetail, activityKind: nil, tasks: nil, goal: nil, context: nil, canContinue: nil, treeCanContinue: nil, treeHasLiveWork: nil, treeHasPaused: treeHasPaused, treeFrozenActiveElapsed: nil, threadRules: nil, masterId: masterId, createdAt: 1, updatedAt: 1)
}

@Suite struct StatusWordsTests {
    @Test func `a queued root's words are Queued, with the host's reason as the detail when it gave one`() {
        #expect(StatusWords.queuedLine(meta("q", status: .queued, activity: "Queued · waiting for Backfill the rollups (paused)")) == StripWords(title: "Queued", detail: "Waiting for Backfill the rollups (paused)"))
        #expect(StatusWords.queuedLine(meta("q", status: .queued, activity: nil)) == StripWords(title: "Queued"))
        #expect(StatusWords.queuedLine(meta("q", status: .queued, activity: "")) == StripWords(title: "Queued"))
        #expect(StatusWords.queuedLine(meta("q", status: .queued, activity: "Thinking")) == StripWords(title: "Queued"), "a stale activity line never shows on a queued row")
    }

    @Test func `a queued root takes the host's statusDetail before its legacy activity`() {
        #expect(StatusWords.queuedLine(meta("q", status: .queued, activity: "Queued  waiting for memory", statusDetail: "Waiting for memory")) == StripWords(title: "Queued", detail: "Waiting for memory"))
        #expect(StatusWords.queuedLine(meta("q", status: .queued, activity: "Queued  something else", statusDetail: "120 of 120 running")) == StripWords(title: "Queued", detail: "120 of 120 running"), "the host's detail wins")
        #expect(StatusWords.queuedLine(meta("q", status: .queued, activity: "Queued  waiting for memory")) == StripWords(title: "Queued", detail: "Waiting for memory"), "an older host's two spaces")
    }
}

@Suite struct StatusDetailTests {
    @Test func `statusDetail is taken as written: trimmed, a trailing full stop dropped, its case kept`() {
        #expect(StatusDetail.of(meta("s", status: .queued, activity: "Queued  waiting for memory", statusDetail: " Waiting for memory. ")) == "Waiting for memory")
        #expect(StatusDetail.of(meta("s", status: .watching, activity: "Waiting on 3 subagents", statusDetail: "3 subagents")) == "3 subagents")
        #expect(StatusDetail.of(meta("s", status: .running, activity: "sleep 45 seconds", statusDetail: "sleep 45 seconds")) == "sleep 45 seconds", "a command keeps its lower case")
        #expect(StatusDetail.of(meta("s", status: .watching, activity: "Blocked: A errored", statusDetail: "Blocked, A errored")) == "Blocked, A errored")
        #expect(StatusDetail.of(meta("s", status: .running, statusDetail: "Gate running since 12:08")) == "Gate running since 12:08")
    }

    @Test func `an older host's activity is read past its lead, sentence-cased`() {
        #expect(StatusDetail.of(meta("s", status: .queued, activity: "Queued  waiting for memory")) == "Waiting for memory", "two spaces")
        #expect(StatusDetail.of(meta("s", status: .queued, activity: "Queued · waiting for memory")) == "Waiting for memory", "the old dot")
        #expect(StatusDetail.of(meta("s", status: .queued, activity: "Queued: waiting for memory")) == "Waiting for memory", "a colon")
        #expect(StatusDetail.of(meta("s", status: .queued, activity: "Queued  120 of 120 running")) == "120 of 120 running", "a count keeps its form")
        #expect(StatusDetail.of(meta("s", status: .queued, activity: "Queued")) == nil)
        #expect(StatusDetail.of(meta("s", status: .queued, activity: "Queuedish")) == nil)
        #expect(StatusDetail.of(meta("s", status: .queued, activity: "Thinking")) == nil, "not the host's queued line")
        #expect(StatusDetail.of(meta("s", status: .watching, activity: "Waiting on 3 subagents")) == "3 subagents")
        #expect(StatusDetail.of(meta("s", status: .watching, activity: "Waiting on the batch's steps")) == "The batch's steps")
        #expect(StatusDetail.of(meta("s", status: .watching, activity: "Blocked: A errored")) == "Blocked, A errored")
        #expect(StatusDetail.of(meta("s", status: .watching, activity: "Blocked: a ended its turn without completing")) == "Blocked, A ended its turn without completing")
        #expect(StatusDetail.of(meta("s", status: .running, activity: "Editing Rail.tsx")) == "Editing Rail.tsx")
        #expect(StatusDetail.of(meta("s", status: .running, activity: "  ")) == nil)
        #expect(StatusDetail.of(meta("s", status: .running)) == nil)
    }

    @Test func `no produced detail carries a dash, a dot or a run of spaces`() {
        let lines = [
            (SessionStatus.queued, "Queued  waiting for memory"), (.queued, "Queued · 3rd in line"), (.queued, "Queued: waiting for X"),
            (.watching, "Waiting on 3 subagents, a monitor"), (.watching, "Blocked: A errored")
        ]
        for (status, line) in lines {
            let detail = StatusDetail.of(meta("s", status: status, activity: line)) ?? ""
            #expect(!detail.isEmpty && !detail.contains("  ") && !detail.contains("·") && !detail.contains("—"), "\(line)")
        }
    }

    @Test func `one plain string is Word: Detail, or the word alone`() {
        #expect(StatusDetail.plain(word: "Queued", detail: "Waiting for memory") == "Queued: Waiting for memory")
        #expect(StatusDetail.plain(word: "Watching", detail: "3 subagents.") == "Watching: 3 subagents")
        #expect(StatusDetail.plain(word: "Queued", detail: nil) == "Queued")
        #expect(StatusDetail.plain(word: "Queued", detail: "   ") == "Queued")
    }

    @Test func `sentenceStart raises only a plain lower-case first word`() {
        #expect(StatusDetail.sentenceStart("waiting for memory") == "Waiting for memory")
        #expect(StatusDetail.sentenceStart("rail.tsx changed") == "rail.tsx changed")
        #expect(StatusDetail.sentenceStart("3 subagents") == "3 subagents")
        #expect(StatusDetail.sentenceStart("Waiting") == "Waiting")
        #expect(StatusDetail.sentenceStart(nil) == nil)
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
