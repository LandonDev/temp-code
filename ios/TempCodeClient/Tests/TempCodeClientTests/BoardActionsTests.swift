import Foundation
import Testing
import TempCodeContract
@testable import TempCodeClient

private func rows(_ metas: [SessionMeta], remote: [MasterBoard.RemoteChild] = []) -> [MasterBoard.Row] {
    MasterBoard.foldRows(children: metas, all: metas, masterId: "m", remote: remote)
}

@Suite struct BoardActionsTests {
    @Test("which rows each switch reaches; a far row is never paused from here") func switches() {
        let metas = [
            meta("run", status: .running, createdAt: 1, masterId: "m"),
            meta("idle", status: .idle, createdAt: 2, masterId: "m"),
            meta("done", status: .done, createdAt: 3, masterId: "m"),
            meta("paused", status: .paused, createdAt: 4, masterId: "m"),
            meta("stopped", status: .stopped, createdAt: 5, masterId: "m")
        ]
        let far = MasterBoard.RemoteChild(child: BatchState.Children(sessionId: "f", environmentId: "env_mac", title: "Far", status: "running", threadType: nil, provider: "claude", model: "m"), meta: nil)
        let all = rows(metas, remote: [far])
        #expect(BoardActions.doneRows(all).map(\.key) == ["idle", "done"])
        #expect(BoardActions.pausedRows(all).map(\.key) == ["paused"])
        #expect(BoardActions.pausableRows(all).map(\.key) == ["run"])
        #expect(BoardActions.localIds(all).count == 5)
    }

    @Test("the archive and pause confirms say what happens") func copy() {
        let done1 = BoardActions.archiveCopy(.done, count: 1, resources: nil)
        #expect(done1.title == "Archive 1 done thread?")
        #expect(done1.body == "They leave the board and stay in the archive list. The master stays.")
        #expect(done1.cleanup == nil)
        #expect(done1.confirmLabel == "Archive 1")
        #expect(BoardActions.archiveCopy(.done, count: 3, resources: 0).title == "Archive 3 done threads?")
        #expect(BoardActions.archiveCopy(.done, count: 3, resources: 0).cleanup == nil)
        let all = BoardActions.archiveCopy(.all, count: 7, resources: 2)
        #expect(all.title == "Archive all 7 threads?")
        #expect(all.body == "A running thread is stopped first. Every one leaves the board and stays in the archive list. The master stays.")
        #expect(all.cleanup == "and remove their 2 worktrees and simulators")
        #expect(BoardActions.archiveCopy(.all, count: 7, resources: 1).cleanup == "and remove their 1 worktree or simulator")
        let pause = BoardActions.pauseCopy(count: 3)
        #expect(pause.title == "Pause 3 running threads?")
        #expect(pause.body == "Each thread keeps its place and picks up where it was when you resume it.")
        #expect(pause.confirmLabel == "Pause 3")
        #expect(BoardActions.pauseCopy(count: 1).title == "Pause 1 running thread?")
    }

    @Test("the threads the batch may adopt: this project's free roots, oldest first") func adopt() {
        let master = meta("m", isMaster: true, projectId: "p")
        let metas = [
            master,
            meta("b", createdAt: 20, projectId: "p"),
            meta("a", createdAt: 10, projectId: "p"),
            meta("other", createdAt: 1, projectId: "q"),
            meta("gone", archived: true, createdAt: 2, projectId: "p"),
            meta("sub", parentId: "a", createdAt: 3, projectId: "p"),
            meta("taken", createdAt: 4, projectId: "p", masterId: "m2"),
            meta("boss", createdAt: 5, isMaster: true, projectId: "p")
        ]
        #expect(BoardActions.adoptCandidates(metas, master: master).map(\.id) == ["a", "b"])
        #expect(BoardActions.adoptCandidates(metas, master: meta("loose", isMaster: true)).isEmpty)
    }

    @Test("After lists every child oldest first; the add sheet's types and the 1M rule") func addSheet() {
        let metas = [meta("b", createdAt: 2, masterId: "m"), meta("a", createdAt: 1, masterId: "m")]
        #expect(BoardActions.afterChoices(rows(metas)).map(\.key) == ["a", "b"])
        #expect(BoardActions.addTypes == [.implementation, .planning, .orchestration, .research, .projectPlan])
        let big = ModelInfo(id: "claude-fable-5-1", label: "Fable", reasoning: [], context: 1_000_000)
        let small = ModelInfo(id: "claude-haiku-5-5", label: "Haiku", reasoning: [], context: 200_000)
        #expect(BoardActions.supportsContext1m(provider: .claude, model: big))
        #expect(!BoardActions.supportsContext1m(provider: .claude, model: small))
        #expect(!BoardActions.supportsContext1m(provider: .codex, model: big))
        #expect(!BoardActions.supportsContext1m(provider: .claude, model: nil))
    }
}

@Suite struct HomeMasterTests {
    @Test("a batch child waiting on a question is a Needs-you row like any root") func needsYou() {
        let child = meta("c", status: .waiting, masterId: "m")
        #expect(HomeModel.needsYou([child]).map(\.meta.id) == ["c"])
    }

    @Test("a watching master and a queued child are not Running") func notLive() {
        #expect(!HomeModel.isLive(meta("m", status: .watching, isMaster: true)))
        #expect(!HomeModel.isLive(meta("q", status: .queued, masterId: "m")))
    }
}
