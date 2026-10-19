import Foundation
import Testing
import TempCodeContract
@testable import TempCodeClient

/// The desktop's grouping cases (src/renderer/src/lib/workspaceSessions.test.ts)
/// ported, plus the phone's pinned-first rule and Home's derivations.
private func ws(_ id: String, _ path: String) -> WorkspaceMeta {
    WorkspaceMeta(id: id, name: id, path: path, git: true, accountPins: nil, githubRepo: nil, githubRepoCheckedAt: nil, createdAt: 1)
}

private func project(_ id: String, _ workspaceId: String, archived: Bool = false, createdAt: Int = 10) -> ProjectMeta {
    ProjectMeta(id: id, workspaceId: workspaceId, name: id, mode: .worktree, branch: "tc/\(id)", cwd: "/wt/\(id)", archived: archived, accountPins: nil, createdAt: createdAt)
}

private func meta(_ id: String, parentId: String? = nil, projectId: String? = nil, workspaceId: String? = nil, cwd: String = "/repo/a", status: SessionStatus = .idle, archived: Bool = false, pinned: Bool = false, agentType: AgentType = .implementer, createdAt: Int = 1, updatedAt: Int = 100, pausedAt: Int? = nil, treeHasLiveWork: Bool? = nil) -> SessionMeta {
    SessionMeta(id: id, parentId: parentId, projectId: projectId, workspaceId: workspaceId, threadType: .chat, planPath: nil, provider: .claude, model: "claude-sonnet-5-5", reasoning: .low, agentType: agentType, title: id, cwd: cwd, status: status, pinned: pinned, archived: archived, permission: .edits, fast: false, ultrafast: false, context1m: false, busySince: nil, pausedAt: pausedAt, frozenActiveElapsed: nil, nativeId: nil, account: nil, activity: nil, activityKind: nil, tasks: nil, goal: nil, context: nil, canContinue: nil, treeCanContinue: nil, treeHasLiveWork: treeHasLiveWork, treeHasPaused: nil, treeFrozenActiveElapsed: nil, threadRules: nil, createdAt: createdAt, updatedAt: updatedAt)
}

private let workspaces = [ws("wa", "/repo/a"), ws("wb", "/repo/b")]
private let projects = [project("p1", "wa"), project("p2", "wa"), project("pb", "wb")]

@Suite struct ThreadGroupsTests {
    @Test func `places threads by project, workspace id, then cwd, and drops other workspaces`() {
        let metas = [
            meta("t-project", projectId: "p1", cwd: "/wt/p1"),
            meta("t-loose", workspaceId: "wa"),
            meta("t-legacy", cwd: "/repo/a/"),
            meta("t-other", workspaceId: "wb"),
            meta("t-other-project", projectId: "pb", cwd: "/wt/pb"),
            meta("t-child", parentId: "t-project", projectId: "p1")
        ]
        let out = ThreadGroups.group(metas, projects: projects, workspaces: workspaces, workspaceId: "wa")
        #expect(out.projects.first { $0.id == "p1" }?.threads.map(\.id) == ["t-project"])
        #expect(out.chats.map(\.id).sorted() == ["t-legacy", "t-loose"])
        #expect(out.archived.isEmpty)
    }

    @Test func `the home holds the chats outside every workspace and no projects`() {
        let metas = [
            meta("t-project", projectId: "p1", cwd: "/wt/p1"),
            meta("t-loose", workspaceId: "wa"),
            meta("t-legacy", cwd: "/repo/a/"),
            meta("t-home", cwd: "/home/me"),
            meta("t-elsewhere", cwd: "/tmp/scratch"),
            meta("t-home-child", parentId: "t-home", cwd: "/home/me")
        ]
        let out = ThreadGroups.group(metas, projects: projects, workspaces: workspaces, workspaceId: nil)
        #expect(out.projects.isEmpty)
        #expect(out.archived.isEmpty)
        #expect(out.chats.map(\.id).sorted() == ["t-elsewhere", "t-home"])
    }

    @Test func `nests children under their root, ranked, and skips archived ones`() {
        let metas = [
            meta("root", projectId: "p1", cwd: "/wt/p1"),
            meta("loose", workspaceId: "wa"),
            meta("c-done", parentId: "root", projectId: "p1", status: .idle, agentType: .explorer, createdAt: 1),
            meta("c-wait", parentId: "root", projectId: "p1", status: .waiting, agentType: .implementer, createdAt: 3),
            meta("c-run", parentId: "root", projectId: "p1", status: .running, createdAt: 2),
            meta("c-gone", parentId: "root", projectId: "p1", archived: true),
            meta("c-loose", parentId: "loose", workspaceId: "wa", agentType: .reviewer)
        ]
        let out = ThreadGroups.group(metas, projects: projects, workspaces: workspaces, workspaceId: "wa")
        let root = out.projects.first { $0.id == "p1" }?.threads.first
        #expect(root?.id == "root")
        #expect(root?.children.map(\.id) == ["c-wait", "c-run", "c-done"])
        #expect(root?.children.first?.meta.agentType == .implementer)
        #expect(out.chats.map(\.id) == ["loose"])
        #expect(out.chats.first?.children.map(\.id) == ["c-loose"])
    }

    @Test func `treats a thread whose project is unknown as a loose chat`() {
        let out = ThreadGroups.group([meta("orphan", projectId: "gone", workspaceId: "wa")], projects: projects, workspaces: workspaces, workspaceId: "wa")
        #expect(out.chats.map(\.id) == ["orphan"])
    }

    @Test func `sorts threads newest first and projects by latest activity, empty ones by createdAt`() {
        let list = [project("old", "wa", createdAt: 50), project("busy", "wa", createdAt: 5), project("fresh", "wa", createdAt: 500)]
        let metas = [
            meta("a", projectId: "busy", updatedAt: 100),
            meta("b", projectId: "busy", updatedAt: 300),
            meta("c", projectId: "old", updatedAt: 200)
        ]
        let out = ThreadGroups.group(metas, projects: list, workspaces: workspaces, workspaceId: "wa")
        #expect(out.projects.map(\.id) == ["fresh", "busy", "old"])
        #expect(out.projects[1].threads.map(\.id) == ["b", "a"])
        #expect(out.projects[1].latest == 300)
        #expect(out.projects[0].latest == 500)
    }

    @Test func `pinned threads sort first within their project and among chats`() {
        let metas = [
            meta("a", projectId: "p1", updatedAt: 300),
            meta("b", projectId: "p1", pinned: true, updatedAt: 100),
            meta("c", projectId: "p1", updatedAt: 200),
            meta("x", workspaceId: "wa", updatedAt: 3),
            meta("y", workspaceId: "wa", pinned: true, updatedAt: 1)
        ]
        let out = ThreadGroups.group(metas, projects: projects, workspaces: workspaces, workspaceId: "wa")
        #expect(out.projects.first { $0.id == "p1" }?.threads.map(\.id) == ["b", "a", "c"])
        #expect(out.projects.first { $0.id == "p1" }?.latest == 300)
        #expect(out.chats.map(\.id) == ["y", "x"])
    }

    @Test func `splits archived projects out with their threads and counts archived threads`() {
        let list = [project("live", "wa"), project("gone", "wa", archived: true)]
        let metas = [
            meta("x", projectId: "gone"),
            meta("y", projectId: "live"),
            meta("z", projectId: "live", archived: true)
        ]
        let out = ThreadGroups.group(metas, projects: list, workspaces: workspaces, workspaceId: "wa")
        #expect(out.projects.map(\.id) == ["live"])
        #expect(out.projects[0].threads.map(\.id) == ["y"])
        #expect(out.projects[0].archivedCount == 1)
        #expect(out.archived.map(\.id) == ["gone"])
        #expect(out.archived[0].threads.map(\.id) == ["x"])
        #expect(ThreadGroups.archivedThreads(metas, projectId: "live").map(\.id) == ["z"])
    }

    @Test func `sorts loose chats newest first`() {
        let metas = [
            meta("a", workspaceId: "wa", updatedAt: 1),
            meta("b", workspaceId: "wa", updatedAt: 3),
            meta("c", workspaceId: "wa", updatedAt: 2)
        ]
        let out = ThreadGroups.group(metas, projects: projects, workspaces: workspaces, workspaceId: "wa")
        #expect(out.chats.map(\.id) == ["b", "c", "a"])
    }
}

@Suite struct UnseenTests {
    @Test func `marks idle and done threads unseen only when newer than the seen mark`() {
        let seen = ["a": SeenMark(at: 100, seq: 1), "b": SeenMark(at: 50, seq: 1)]
        #expect(!ThreadGroups.isUnseen(meta("a", updatedAt: 100), seen: seen, floor: 0))
        #expect(ThreadGroups.isUnseen(meta("b", status: .done, updatedAt: 100), seen: seen, floor: 0))
        #expect(ThreadGroups.isUnseen(meta("c", updatedAt: 100), seen: seen, floor: 0))
    }

    @Test func `treats a thread with no mark as seen up to the floor`() {
        #expect(!ThreadGroups.isUnseen(meta("old", updatedAt: 100), seen: [:], floor: 150))
        #expect(ThreadGroups.isUnseen(meta("new", updatedAt: 200), seen: [:], floor: 150))
        #expect(!ThreadGroups.isUnseen(meta("seen", updatedAt: 200), seen: ["seen": SeenMark(at: 300, seq: 9)], floor: 150))
    }

    @Test(arguments: [SessionStatus.starting, .running, .waiting, .paused, .error])
    func `never marks a live, waiting, paused, or failed thread unseen`(status: SessionStatus) {
        #expect(!ThreadGroups.isUnseen(meta("t", status: status, updatedAt: 100), seen: [:], floor: 0))
    }

    @Test func `grouping carries the unseen flag onto roots and children`() {
        let metas = [meta("root", projectId: "p1", updatedAt: 200), meta("kid", parentId: "root", projectId: "p1", updatedAt: 200)]
        let out = ThreadGroups.group(metas, projects: projects, workspaces: workspaces, workspaceId: "wa", seen: ["root": SeenMark(at: 200, seq: 4)], floor: 0)
        let root = out.projects.first { $0.id == "p1" }?.threads.first
        #expect(root?.unseen == false)
        #expect(root?.children.first?.unseen == true)
    }
}

@Suite struct HomeModelTests {
    @Test func `needs you lists waiting threads, failed and paused roots, longest waiting first`() {
        let metas = [
            meta("wait", status: .waiting, updatedAt: 300),
            meta("kid-wait", parentId: "run", status: .waiting, updatedAt: 100),
            meta("fail", status: .error, updatedAt: 200),
            meta("kid-fail", parentId: "run", status: .error, updatedAt: 50),
            meta("pause", status: .paused, updatedAt: 400, pausedAt: 150),
            meta("run", status: .running, updatedAt: 500),
            meta("gone", status: .waiting, archived: true, updatedAt: 10),
            meta("idle", updatedAt: 600)
        ]
        let out = HomeModel.needsYou(metas)
        #expect(out.map(\.id) == ["kid-wait", "pause", "fail", "wait"])
        #expect(out.map(\.kind) == [.waiting, .paused, .error, .waiting])
        #expect(out[1].since == 150)
    }

    @Test func `running lists live roots and roots whose subagents still work, newest first`() {
        let metas = [
            meta("a", status: .running, updatedAt: 100),
            meta("b", status: .starting, updatedAt: 300),
            meta("c", status: .idle, updatedAt: 200, treeHasLiveWork: true),
            meta("kid", parentId: "c", status: .running, updatedAt: 250),
            meta("d", status: .running, archived: true, updatedAt: 900),
            meta("e", status: .waiting, updatedAt: 800, treeHasLiveWork: true),
            meta("f", status: .paused, updatedAt: 700, treeHasLiveWork: true)
        ]
        #expect(HomeModel.running(metas).map(\.id) == ["b", "c", "a"])
    }

    private func row(_ seq: Int, _ event: AgentEvent) -> EventRow {
        EventRow(sessionId: "s", seq: seq, ts: seq, event: event)
    }

    @Test func `the needs-you line names the undecided approval, the open question, or the error`() {
        let approval = row(3, .approvalRequest(ApprovalRequestEvent(requestId: "r1", toolName: "Bash", input: nil, title: "run bun test\nin the repo", callId: nil)))
        let settled = row(4, .approvalResolved(ApprovalResolvedEvent(requestId: "r1", allow: true, auto: nil)))
        let question = row(5, .questionRequest(QuestionRequestEvent(requestId: "q1", questions: [QuestionRequestEvent.Question(question: "Which email?", header: nil, multiSelect: nil, allowFreeform: nil, options: [])])))
        #expect(HomeModel.line(for: .waiting, rows: [approval]) == "Approve: run bun test")
        #expect(HomeModel.cue(for: .waiting, rows: [approval]).seq == 3)
        #expect(HomeModel.cue(for: .waiting, rows: [approval, settled]).seq == nil)
        #expect(HomeModel.line(for: .waiting, rows: [approval, settled]) == "Waiting for you")
        #expect(HomeModel.line(for: .waiting, rows: [approval, settled, question]) == "Question: Which email?")
        #expect(HomeModel.line(for: .waiting, rows: []) == "Waiting for you")
        #expect(HomeModel.line(for: .error, rows: [row(1, .error(ErrorEvent(message: "rate limited\ndetails", stopped: nil, limit: nil)))]) == "Error: rate limited")
        #expect(HomeModel.line(for: .error, rows: [row(1, .error(ErrorEvent(message: "x", stopped: true, limit: nil)))]) == "Stopped")
        #expect(HomeModel.line(for: .error, rows: []) == "Failed")
        #expect(HomeModel.line(for: .paused, rows: []) == "Paused")
    }
}
